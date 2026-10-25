/**
 * 全局配置与凭证加载。
 *
 * 安全约束（第一阶段强规则）：
 * - MCP Token 只允许存在于服务端进程内存，来源为环境变量或仓库外的本地文件。
 * - 本模块导出的 tokenStatus() 只返回 {configured, source}，永不返回 Token 本体。
 * - 任何日志、HTTP 响应、错误堆栈都不得包含 Token。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_DIR = path.join(ROOT_DIR, 'cache');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const DATA_DIR = path.join(ROOT_DIR, 'data');

// Load this repository's .env; existing process environment takes precedence.
const envFile = path.join(ROOT_DIR, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
process.env.NODE_ENV ||= 'production';

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const config = {
  port: num(process.env.PORT, 5173),
  mcp: {
    url: process.env.MCD_MCP_URL || 'https://mcp.mcd.cn',
    timeoutMs: num(process.env.MCD_MCP_TIMEOUT_MS, 20000),
    maxRetries: num(process.env.MCD_MCP_MAX_RETRIES, 2),
    /** 官方限流 600 次/分钟，这里保守取 8 并发 + 令牌桶 8/s */
    concurrency: num(process.env.MCD_MCP_CONCURRENCY, 10),
    /** 只读白名单之外的工具一律拒绝（防止误触下单/领券/抽奖） */
    readOnlyAllowlist: new Set([
      'now-time-info',
      'query-nearby-stores',
      'query-meals',
      'query-meal-detail',
      'list-nutrition-foods',
      'calculate-price',
      'query-promotions',
      'query-store-coupons',
      'available-coupons',
      'query-my-account',
      'order-list',
      'query-order',
      'query-party-city',
      'query-party-store',
      'query-party-store-date',
      'query-party-store-session',
      'query-meal-assistance',
      'mall-points-products',
      'mall-product-detail',
      'mall-order-list',
      'mall-order-detail',
      'campaign-calendar',
      'delivery-query-stores',
    ]),
  },
  /**
   * 模型配置来源策略（任务 F）：
   * - 正式部署必须显式配置 MCFIT_LLM_BASE_URL / MCFIT_LLM_API_KEY；
   * - 开发者本机 ~/.workbuddy/models.json 仅显式设置 MCFIT_LLM_ALLOW_LOCAL=1 时才允许读取，
   *   避免公开部署时悄悄消耗开发者个人额度。
   */
  llm: {
    allowLocalConfig:
      process.env.MCFIT_LLM_ALLOW_LOCAL === '1',
    maxInputChars: num(process.env.MCFIT_MAX_INPUT_CHARS, 500),
    rateLimit: {
      parse: { limit: num(process.env.MCFIT_RL_PARSE, 20), windowMs: 60 * 1000 },
      recommend: { limit: num(process.env.MCFIT_RL_RECOMMEND, 30), windowMs: 60 * 1000 },
      rebuild: { limit: num(process.env.MCFIT_RL_REBUILD, 60), windowMs: 60 * 1000 },
    },
  },
  /**
   * MCP 凭证来源策略：生产环境默认不读取 WorkBuddy 开发者本机配置，
   * 默认必须显式配置 MCD_MCP_TOKEN；本机文件仅在 MCFIT_ALLOW_LOCAL_MCP=1 时允许读取。
   */
  mcpLocalConfig: {
    allowWorkBuddyFile:
      process.env.MCFIT_ALLOW_LOCAL_MCP === '1',
  },
  store: {
    defaultStoreCode: process.env.MCFIT_STORE_CODE || '3350241',
    storeName: process.env.MCFIT_STORE_NAME || '麦当劳济南凤鸣广场餐厅',
    /** beType 1=到店取餐，orderType 1=到店（含自取/得来速） */
    beType: 1,
    orderType: 1,
    /** 备选门店搜索（query-nearby-stores）用的城市/关键词，换部署地时用环境变量覆盖 */
    searchCity: process.env.MCFIT_STORE_SEARCH_CITY || '济南',
    searchKeyword: process.env.MCFIT_STORE_SEARCH_KEYWORD || '凤鸣广场',
  },
  /**
   * 缓存 TTL。原则：
   * - 商品详情（名称/rounds/modification）默认 12h，但可被 ?refresh=1 强制刷新
   * - 营养表是官方静态表，24h
   * - 价格必须视为短时效数据，5min，且对外暴露 checkedAt，超过 TTL 不冒充实时价
   */
  ttl: {
    menuMs: num(process.env.MCFIT_TTL_MENU_MS, 30 * 60 * 1000),
    detailMs: num(process.env.MCFIT_TTL_DETAIL_MS, 12 * 60 * 60 * 1000),
    nutritionMs: num(process.env.MCFIT_TTL_NUTRITION_MS, 24 * 60 * 60 * 1000),
    priceMs: num(process.env.MCFIT_TTL_PRICE_MS, 5 * 60 * 1000),
  },
};

const SOURCE_LABEL = {
  env: '环境变量 MCD_MCP_TOKEN',
  localfile: '本地文件 ~/.mcd_mcp_env',
  workbuddy: 'WorkBuddy 服务端配置 ~/.workbuddy/mcp.json',
};

let cachedToken;

function readLocalTokenFile() {
  const p = path.join(os.homedir(), '.mcd_mcp_env');
  if (!fs.existsSync(p)) return null;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('TOKEN=')) {
      const v = line.split('=').slice(1).join('=').trim();
      if (v) return v;
    }
  }
  return null;
}

function readWorkBuddyMcpConfig() {
  const p = path.join(os.homedir(), '.workbuddy', 'mcp.json');
  if (!fs.existsSync(p)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const auth = cfg?.mcpServers?.['mcd-mcp']?.headers?.Authorization || '';
    const m = /Bearer\s+(.+)/i.exec(auth);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * 按优先级解析 Token。仅在服务端进程内使用。
 * @returns {{token: string|null, source: string|null}}
 */
export function resolveToken() {
  if (cachedToken !== undefined) return cachedToken;
  let token = (process.env.MCD_MCP_TOKEN || '').trim() || null;
  let source = token ? 'env' : null;
  if (!token && config.mcpLocalConfig.allowWorkBuddyFile) {
    token = readLocalTokenFile();
    source = token ? 'localfile' : null;
  }
  if (!token && config.mcpLocalConfig.allowWorkBuddyFile) {
    token = readWorkBuddyMcpConfig();
    source = token ? 'workbuddy' : null;
  }
  cachedToken = { token, source };
  return cachedToken;
}

/** 对外可安全暴露的状态描述（不含 Token） */
export function tokenStatus() {
  const { token, source } = resolveToken();
  return {
    configured: Boolean(token),
    source: source ? SOURCE_LABEL[source] : null,
    /** 仅为提示字段是否存在，绝不输出 Token 片段 */
    valuePresent: Boolean(token),
  };
}

/** 把任何字符串里的疑似 Token 打码，用于日志与错误信息 */
export function redact(text) {
  if (typeof text !== 'string') return text;
  const { token } = resolveToken();
  let out = text;
  if (token && token.length > 6) {
    out = out.split(token).join('***REDACTED***');
  }
  const modelKey = process.env.MCFIT_LLM_API_KEY;
  if (modelKey && modelKey.length > 6) out = out.split(modelKey).join('***REDACTED***');
  return out.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***REDACTED***');
}
