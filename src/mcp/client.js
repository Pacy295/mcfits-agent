/**
 * 麦当劳 MCP 客户端（Streamable HTTP / JSON-RPC 2.0）。
 *
 * 关键设计点（对应第一阶段任务 A）：
 * 1. 不依赖 WorkBuddy 对话内的工具调用 —— 进程自己用 fetch 向 https://mcp.mcd.cn 发 JSON-RPC 请求，
 *    因此独立运行的网页后端与 WorkBuddy 拥有完全相同的真实数据能力。
 * 2. 只读白名单：非白名单工具（create-order / cancel-order / auto-bind-coupons / draw-lottery 等）
 *    在客户端层直接抛错，杜绝任何"改账户状态"的调用可能。
 * 3. 统一错误模型：网络错误 / HTTP 错误 / JSON-RPC 错误 / 业务 success=false 分开，且全部经过 Token 打码。
 * 4. 并发与重试：令牌桶限流 + 指数退避，避免 600 次/分钟限流误伤。
 */
import { config, redact, resolveToken } from '../config.js';

export class McpError extends Error {
  constructor(kind, message, detail = {}) {
    super(redact(message));
    this.name = 'McpError';
    this.kind = kind; // 'no_token' | 'network' | 'http' | 'rpc' | 'business' | 'blocked' | 'parse'
    this.detail = detail;
  }
  toJSON() {
    return { kind: this.kind, message: this.message, ...this.detail };
  }
}

class TokenBucket {
  constructor(ratePerSec) {
    this.capacity = Math.max(1, ratePerSec);
    this.tokens = this.capacity;
    this.rate = ratePerSec;
    this.last = Date.now();
  }
  async take() {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.rate);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await new Promise((r) => setTimeout(r, Math.ceil(((1 - this.tokens) / this.rate) * 1000)));
    }
  }
}

class Semaphore {
  constructor(n) {
    this.n = n;
    this.active = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active < this.n) {
      this.active += 1;
      return;
    }
    await new Promise((r) => this.queue.push(r));
    this.active += 1;
  }
  release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

/** 从 MCP tools/call 结果里提取业务信封 {success,code,message,datetime,traceId,data} */
function extractEnvelope(result) {
  const sc = result?.structuredContent;
  if (sc && typeof sc === 'object') {
    // 有些实现把信封包一层 { content: ... }
    if (sc.success !== undefined) return sc;
    if (sc.result && sc.result.success !== undefined) return sc.result;
  }
  const texts = (result?.content || []).filter((c) => c?.type === 'text').map((c) => c.text);
  for (const t of texts) {
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* 非 JSON 文本，忽略 */
    }
  }
  if (texts.length) return { success: true, data: texts.join('\n') };
  return null;
}

/** 解析 Streamable HTTP 响应体：可能是纯 JSON，也可能是 SSE（data: {...}） */
function parseRpcBody(raw, contentType) {
  const text = raw.trim();
  if (!text) return null;
  if (!/text\/event-stream/i.test(contentType || '') && !text.startsWith('data:')) {
    return JSON.parse(text);
  }
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    if (!dataLines.length) continue;
    const payload = dataLines.join('\n');
    if (!payload || payload === '[DONE]') continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      /* 跳过无法解析的事件 */
    }
  }
  if (!events.length) throw new McpError('parse', 'SSE 响应中未找到可解析的 JSON 事件');
  return events[events.length - 1];
}

export class McpClient {
  constructor(opts = {}) {
    this.url = opts.url || config.mcp.url;
    this.timeoutMs = opts.timeoutMs || config.mcp.timeoutMs;
    this.maxRetries = opts.maxRetries ?? config.mcp.maxRetries;
    this.bucket = new TokenBucket(config.mcp.concurrency);
    this.sem = new Semaphore(config.mcp.concurrency);
    this.nextId = 1;
    /** 调用审计：只记录工具名、耗时、traceId，不记录入参中的敏感字段（本系统入参无敏感字段） */
    this.metrics = { calls: 0, errors: 0, byTool: {}, totalMs: 0 };
    this.lastCall = null;
  }

  #headers() {
    const { token } = resolveToken();
    if (!token) {
      throw new McpError('no_token', '未配置 MCP Token：请设置环境变量 MCD_MCP_TOKEN 或 ~/.mcd_mcp_env');
    }
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    };
  }

  async #rpc(method, params, attempt = 0) {
    const body = { jsonrpc: '2.0', id: this.nextId++, method, params };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err?.name === 'AbortError' ? `MCP 请求超时（${this.timeoutMs}ms）` : `MCP 网络错误：${err?.message || err}`;
      if (attempt < this.maxRetries) {
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
        return this.#rpc(method, params, attempt + 1);
      }
      throw new McpError('network', msg);
    }
    clearTimeout(timer);

    const ct = res.headers.get('content-type') || '';
    const raw = await res.text();

    if (!res.ok) {
      const retriable = res.status === 429 || res.status >= 500;
      if (retriable && attempt < this.maxRetries) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        return this.#rpc(method, params, attempt + 1);
      }
      throw new McpError('http', `MCP HTTP ${res.status} ${res.statusText}`, {
        status: res.status,
        bodyPreview: redact(raw.slice(0, 300)),
      });
    }

    let json;
    try {
      json = parseRpcBody(raw, ct);
    } catch (err) {
      throw new McpError('parse', `MCP 响应解析失败：${err.message}`, { bodyPreview: redact(raw.slice(0, 300)) });
    }
    if (!json) throw new McpError('parse', 'MCP 返回空响应体');
    if (json.error) {
      throw new McpError('rpc', `JSON-RPC 错误 ${json.error.code}: ${json.error.message}`, { rpcCode: json.error.code });
    }
    // 服务端可能在初始化要求时返回 401/会话错误，已在 !res.ok 分支处理
    return json.result;
  }

  async listTools() {
    const r = await this.#rpc('tools/list', {});
    return r?.tools || [];
  }

  /**
   * 调用工具。返回业务信封的 data，并把 datetime/traceId 一并回传给调用方作为数据溯源证据。
   * @param {string} name
   * @param {object} args
   * @returns {Promise<{data:any, datetime:string|null, traceId:string|null, tool:string, ms:number}>}
   */
  async callTool(name, args = {}) {
    if (!config.mcp.readOnlyAllowlist.has(name)) {
      throw new McpError('blocked', `工具 ${name} 不在只读白名单内，已拒绝调用（第一阶段禁止任何写操作）`, { tool: name });
    }
    await this.sem.acquire();
    await this.bucket.take();
    const t0 = Date.now();
    try {
      const result = await this.#rpc('tools/call', { name, arguments: args });
      const ms = Date.now() - t0;
      const env = extractEnvelope(result);
      if (!env) throw new McpError('parse', `工具 ${name} 未返回可解析的数据信封`);

      this.metrics.calls += 1;
      this.metrics.totalMs += ms;
      this.metrics.byTool[name] = (this.metrics.byTool[name] || 0) + 1;
      this.lastCall = { tool: name, ms, datetime: env.datetime || null, traceId: env.traceId || null };

      if (env.success === false) {
        this.metrics.errors += 1;
        throw new McpError('business', `工具 ${name} 业务失败 code=${env.code}：${env.message || '未知原因'}`, {
          tool: name,
          code: env.code,
          traceId: env.traceId || null,
        });
      }
      return {
        data: env.data,
        datetime: env.datetime || null,
        traceId: env.traceId || null,
        message: env.message || null,
        tool: name,
        ms,
      };
    } catch (err) {
      if (err instanceof McpError && err.kind !== 'business') {
        this.metrics.errors += 1;
      }
      throw err;
    } finally {
      this.sem.release();
    }
  }

  snapshotMetrics() {
    return { ...this.metrics, byTool: { ...this.metrics.byTool }, lastCall: this.lastCall };
  }
}

/** 进程级单例 */
export const mcp = new McpClient();
