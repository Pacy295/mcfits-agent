/**
 * 运行时 LLM 接入（OpenAI 兼容 /chat/completions）。
 *
 * 事实依据（第一阶段任务 A 的延伸验证）：
 * - WorkBuddy 自身能理解自然语言，但那不构成独立应用的 LLM 能力。
 * - 本机 ~/.workbuddy/models.json 中存放了 WorkBuddy 已授权的模型端点与密钥，
 *   其中 mimo-v2.6-pro（https://token-plan-cn.xiaomimimo.com/v1）实测 HTTP 200 可用；
 *   qwen3.8-flash 返回 403 AccessDenied.Unpurchased，不可用。
 *
 * 安全约束：
 * - 密钥只从服务端读取（环境变量优先，其次 ~/.workbuddy/models.json），不写仓库、不写日志、不出现在响应中。
 * - 端点不可用时返回 {ok:false}，上层必须降级到规则解析并如实告知，禁止伪造"AI 解析"。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, redact } from '../config.js';

const MODELS_FILE = path.join(os.homedir(), '.workbuddy', 'models.json');

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

function fromEnv() {
  const url = process.env.MCFIT_LLM_BASE_URL;
  const apiKey = process.env.MCFIT_LLM_API_KEY;
  if (!url || !apiKey) return null;
  return {
    id: process.env.MCFIT_LLM_MODEL || 'mimo-v2.6-pro',
    url: url.replace(/\/$/, ''),
    apiKey,
    source: 'env',
  };
}

// 性能专项：models.json 只在进程内低频重读（此前每次调用/每次 llmStatus 都读盘）
const MODELS_CACHE_MS = num(process.env.MCFIT_LLM_CONFIG_TTL_MS, 30000);
let modelsCache = { at: 0, list: [] };

function fromWorkBuddyModels() {
  // 生产环境默认不读取开发者本机配置（避免公开部署消耗个人额度）
  if (!config.llm.allowLocalConfig) return [];
  if (Date.now() - modelsCache.at < MODELS_CACHE_MS) return modelsCache.list;
  let list = [];
  if (fs.existsSync(MODELS_FILE)) {
    try {
      list = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'))
        .filter((m) => m && m.url && m.apiKey && m.id)
        .map((m) => ({ id: m.id, url: String(m.url).replace(/\/$/, ''), apiKey: m.apiKey, source: 'workbuddy-models' }));
    } catch {
      list = [];
    }
  }
  modelsCache = { at: Date.now(), list };
  return list;
}

/** 候选提供方列表（按优先级） */
export function providerCandidates() {
  // 运维开关：强制关闭模型调用，用于验证「LLM 不可用时不伪造 AI 解析」
  if (process.env.MCFIT_LLM_DISABLE === '1') return [];
  const env = fromEnv();
  const list = [...(env ? [env] : []), ...fromWorkBuddyModels()];
  const prefer = process.env.MCFIT_LLM_MODEL;
  if (prefer) {
    list.sort((a, b) => (b.id === prefer ? 1 : 0) - (a.id === prefer ? 1 : 0));
  }
  return list;
}

/** 对外可展示的状态（无密钥） */
export function llmStatus() {
  const list = providerCandidates();
  const localUsed = list.some((p) => p.source === 'workbuddy-models');
  return {
    configured: list.length > 0,
    providers: list.map((p) => ({ model: p.id, baseUrl: p.url, source: p.source })),
    sourceKind: list.length === 0 ? null : localUsed ? 'developer-local' : 'deployment-env',
    allowLocalConfig: config.llm.allowLocalConfig,
    quotaNote: localUsed
      ? '当前使用开发者本机 WorkBuddy 已授权模型，调用额度计入该授权账号；公开部署请改为配置部署方自己的端点与密钥。'
      : list.length
        ? '当前使用部署环境显式配置的模型端点，额度计入该配置对应的账号。'
        : '无可用模型：自然语言解析会降级为确定性规则解析，不会伪造 AI 结果。',
    note: list.length
      ? '密钥仅在服务端使用；实际可用性由 /api/parse 的探测结果决定'
      : '未找到可用模型配置：请设置 MCFIT_LLM_BASE_URL / MCFIT_LLM_API_KEY',
  };
}

export class LlmError extends Error {
  constructor(kind, message, extra = {}) {
    let safeMessage = redact(message);
    for (const provider of providerCandidates()) {
      if (provider.apiKey && provider.apiKey.length > 6) safeMessage = safeMessage.split(provider.apiKey).join('***REDACTED***');
    }
    super(safeMessage);
    this.name = 'LlmError';
    this.kind = kind;
    this.extra = extra;
  }
}

/** 从模型输出里稳健地抠出 JSON */
export function extractJson(text) {
  if (typeof text !== 'string') throw new LlmError('bad_output', '模型返回非文本');
  let s = text.trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('{');
  if (start === -1) throw new LlmError('bad_output', '模型输出中未找到 JSON 对象');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const raw = s.slice(start, i + 1);
        try {
          return JSON.parse(raw);
        } catch (err) {
          throw new LlmError('bad_json', `模型输出不是合法 JSON：${err.message}`);
        }
      }
    }
  }
  throw new LlmError('bad_json', '模型输出的 JSON 不完整');
}

const healthCache = new Map(); // url -> {ok, at, error}

// 性能专项：401/403 是凭证/额度类错误，短时间内的重复尝试毫无意义（如未购的备用端点）
const AUTH_FAIL_COOLDOWN_MS = num(process.env.MCFIT_LLM_AUTH_COOLDOWN_MS, 5 * 60 * 1000);
const authFailUntil = new Map(); // url -> untilTs

// 结构化脱敏错误记录（环形缓冲，仅内存，不含密钥）
const errorLog = [];
const ERROR_LOG_MAX = 50;
function recordError(entry) {
  errorLog.push({ at: new Date().toISOString(), ...entry });
  if (errorLog.length > ERROR_LOG_MAX) errorLog.shift();
}
/** 最近的 LLM 调用错误（脱敏、无密钥），供诊断使用 */
export function llmErrorLog() {
  return errorLog.slice();
}

/**
 * 思考模式（性能专项）。
 * MiMo-V2.6-Pro 默认开启深度思考，实测 reasoning 拖慢首响 3~5 倍；
 * 本网关经 A/B 验证真实支持并转发 thinking 参数（reasoning_tokens 归零为证）。
 * - 默认（或 'disabled'）：显式关闭深度思考
 * - 'enabled'：不传 thinking 字段，恢复原始默认行为（回退方式）
 */
function thinkingParam() {
  const mode = String(process.env.MCFIT_LLM_THINKING || 'disabled').toLowerCase();
  return mode === 'enabled' || mode === 'default' ? null : { type: 'disabled' };
}

/** 当前是否关闭了深度思考（供输出上限等按模式调参） */
export function isThinkingDisabled() {
  return thinkingParam() != null;
}

async function post(provider, body, timeoutMs) {
  const url = `${provider.url}/chat/completions`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // 超时与网络错误分开记录（任务五：按阶段区分失败原因，禁止 undefined 充当诊断信息）
    const kind = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'network';
    throw new LlmError(kind, `LLM ${kind === 'timeout' ? '超时' : '网络错误'}（${provider.id}）：${err.message || err.name}`);
  }
  let text;
  try {
    text = await res.text();
  } catch (err) {
    // 响应体读取阶段的失败（含 body 读取超时）同样必须结构化，否则裸 Error 的 kind 会是 undefined
    const kind = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'network';
    throw new LlmError(kind, `LLM 响应体读取${kind === 'timeout' ? '超时' : '失败'}（${provider.id}）：${err.message || err.name}`);
  }
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message || msg;
    } catch {
      /* 保留原文片段 */
    }
    throw new LlmError('http', `LLM HTTP ${res.status}（${provider.id}）：${msg}`, { status: res.status });
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LlmError('bad_output', 'LLM 返回非 JSON 响应');
  }
  const content = json?.choices?.[0]?.message?.content ?? '';
  return {
    content,
    usage: json?.usage ?? null,
    model: json?.model || provider.id,
    // 性能专项：记录 finish_reason（识别截断）与推理痕迹（验证 thinking 参数真实生效）
    finishReason: json?.choices?.[0]?.finish_reason ?? null,
    reasoningLen: String(json?.choices?.[0]?.message?.reasoning_content ?? '').length,
    reasoningTokens: json?.usage?.completion_tokens_details?.reasoning_tokens ?? json?.usage?.reasoning_tokens ?? null,
  };
}

/**
 * 调用模型。返回 {ok, content, model, ms, usage} 或抛 LlmError。
 * @param {{messages:Array, maxTokens?:number, temperature?:number, timeoutMs?:number, jsonMode?:boolean}} opts
 */
export async function chat(opts) {
  const { messages, maxTokens = 900, temperature = 0, timeoutMs = 30000, jsonMode = true } = opts;
  const providers = providerCandidates();
  if (!providers.length) throw new LlmError('not_configured', '未配置任何 LLM 端点');

  const errors = [];
  for (const p of providers) {
    // 性能专项：401/403 冷却期内不再重复试探该端点
    const until = authFailUntil.get(p.url);
    if (until && Date.now() < until) {
      errors.push({ model: p.id, kind: 'skipped_auth_cooldown', message: '401/403 冷却期内，跳过该端点' });
      continue;
    }
    const body = { model: p.id, messages, max_tokens: maxTokens, temperature };
    if (jsonMode) body.response_format = { type: 'json_object' };
    const thinking = thinkingParam();
    if (thinking) body.thinking = thinking;
    const t0 = Date.now();
    try {
      const r = await post(p, body, timeoutMs);
      if (jsonMode && !body.__noJsonFallback && !r.content.trim()) throw new LlmError('bad_output', '模型返回空内容');
      if (r.finishReason === 'length') {
        recordError({ model: p.id, kind: 'truncated', status: null, ms: Date.now() - t0, message: `输出被 max_tokens=${maxTokens} 截断（finish_reason=length）` });
      }
      healthCache.set(p.url, { ok: true, at: Date.now(), model: p.id });
      return { ok: true, ...r, ms: Date.now() - t0, provider: p.id };
    } catch (err) {
      const kind = err.kind || 'unknown';
      errors.push({ model: p.id, kind, message: err.message || '(无错误信息)' });
      healthCache.set(p.url, { ok: false, at: Date.now(), error: err.message });
      recordError({ model: p.id, kind, status: err.extra?.status ?? null, ms: Date.now() - t0, message: err.message || '(无错误信息)' });
      // 401/403：凭证/额度问题，短时间重试无意义，进入冷却
      if (err.extra?.status === 401 || err.extra?.status === 403) {
        authFailUntil.set(p.url, Date.now() + AUTH_FAIL_COOLDOWN_MS);
      }
      // 换下一个提供方
    }
  }
  throw new LlmError('all_failed', `所有 LLM 端点均失败：${errors.map((e) => `${e.model}(${e.kind})`).join(', ')}`, { errors });
}

/** 轻量健康探测（1 次最小请求，结果缓存 60s） */
export async function probe({ maxAgeMs = 60000 } = {}) {
  const providers = providerCandidates();
  if (!providers.length) return { ok: false, reason: 'not_configured' };
  const p = providers[0];
  const cached = healthCache.get(p.url);
  if (cached && Date.now() - cached.at < maxAgeMs) return { ok: cached.ok, model: p.id, cached: true, error: cached.error };
  try {
    // 探测也要给足 token：推理型模型会先用 token 思考，30 会直接得到空 content
    const r = await chat({ messages: [{ role: 'user', content: '只输出 JSON：{"ok":true}' }], maxTokens: 256, timeoutMs: 25000 });
    return { ok: true, model: r.model, ms: r.ms };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
