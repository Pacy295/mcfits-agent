/**
 * 门店数据仓储：菜单 → 商品详情 → 营养表，全部经由真实 MCP 调用，带分级缓存与溯源。
 *
 * 设计约束：
 * - query-meals 只返回 {code, tags}，没有名称，必须用 query-meal-detail 补全（N 次调用）。
 * - 详情缓存按 (storeCode, code) 维度隔离，换门店不会串数据。
 * - 每次返回都带 meta：{cache, storedAt, source:{tool, datetime, traceId}}，前端可展示数据来源与时间。
 */
import { config } from '../config.js';
import { mcp } from '../mcp/client.js';
import { cache } from './cache.js';
import { parseNutritionTable } from './nutrition-table.js';

const MENU_KEY = (store) => `menu:${store}`;
const DETAIL_KEY = (store, code) => `detail:${store}:${code}`;
const NUTRITION_KEY = 'nutrition:global';

/**
 * 拉取门店菜单。
 * @returns {Promise<{storeCode:string, categories:Array<{name:string, meals:Array<{code:string,tags:string[]}>}>,
 *   uniqueCodes:string[], meta:object}>}
 */
export async function getMenu(storeCode = config.store.defaultStoreCode, { refresh = false } = {}) {
  const key = MENU_KEY(storeCode);
  const load = async () => {
    const r = await mcp.callTool('query-meals', {
      storeCode,
      orderType: config.store.orderType,
      beType: config.store.beType,
    });
    const categories = (r.data?.categories || []).map((c) => ({
      // 官方分类名里含换行（如「鸡肉汉堡\n/卷」），归一为单行便于展示与筛选
      name: String(c.name || '').replace(/\s*\n\s*/g, ''),
      meals: (c.meals || []).map((m) => ({ code: String(m.code), tags: m.tags || [] })),
    }));
    const seen = new Map(); // code -> categories[]
    for (const c of categories) {
      for (const m of c.meals) {
        if (!seen.has(m.code)) seen.set(m.code, []);
        const list = seen.get(m.code);
        if (!list.includes(c.name)) list.push(c.name);
      }
    }
    return {
      storeCode,
      categories,
      uniqueCodes: [...seen.keys()],
      codeToCategories: Object.fromEntries(seen),
      source: { tool: 'query-meals', datetime: r.datetime, traceId: r.traceId },
    };
  };

  if (refresh) {
    cache.invalidate(key);
  }
  const { value, meta } = await cache.through(key, config.ttl.menuMs, load, 'mcp:query-meals');
  return { ...value, meta };
}

/**
 * 拉取单个商品详情。
 * @returns {Promise<{storeCode:string, code:string, name:string|null, rounds:any[], modification:any|null,
 *   supportModify:boolean, image:string|null, meta:object}>}
 */
export async function getDetail(storeCode, code, { refresh = false } = {}) {
  const key = DETAIL_KEY(storeCode, code);
  const load = async () => {
    const r = await mcp.callTool('query-meal-detail', {
      storeCode,
      orderType: config.store.orderType,
      beType: config.store.beType,
      code: String(code),
    });
    const d = r.data || {};
    return {
      storeCode,
      code: String(code),
      name: d.name ?? null,
      rounds: d.rounds || [],
      modification: d.modification || null,
      supportModify: Boolean(d.supportModify),
      image: d.image ?? null,
      source: { tool: 'query-meal-detail', datetime: r.datetime, traceId: r.traceId },
    };
  };
  if (refresh) cache.invalidate(key);
  const { value, meta } = await cache.through(key, config.ttl.detailMs, load, 'mcp:query-meal-detail');
  return { ...value, meta };
}

/** 批量详情（受客户端令牌桶限流保护） */
export async function getDetails(storeCode, codes, { refresh = false, onProgress } = {}) {
  const out = new Map();
  const failures = [];
  let done = 0;
  const tasks = codes.map(async (code) => {
    try {
      const d = await getDetail(storeCode, code, { refresh });
      out.set(String(code), d);
    } catch (err) {
      failures.push({ code: String(code), kind: err.kind || 'unknown', message: err.message });
    } finally {
      done += 1;
      if (onProgress) onProgress(done, codes.length);
    }
  });
  await Promise.all(tasks);
  return { details: out, failures };
}

/**
 * 官方营养表（全局，不分门店）。
 * @returns {Promise<{rows:Array<object>, declaredCount:number|null, issues:Array<object>, meta:object}>}
 */
export async function getNutritionTable({ refresh = false } = {}) {
  const load = async () => {
    const r = await mcp.callTool('list-nutrition-foods', {});
    const parsed = parseNutritionTable(r.data);
    return { ...parsed, source: { tool: 'list-nutrition-foods', datetime: r.datetime, traceId: r.traceId } };
  };
  if (refresh) cache.invalidate(NUTRITION_KEY);
  const { value, meta } = await cache.through(NUTRITION_KEY, config.ttl.nutritionMs, load, 'mcp:list-nutrition-foods');
  return { ...value, meta };
}

export function clearAllCaches() {
  for (const k of ['menu:', 'detail:', 'nutrition:', 'price:']) cache.invalidate(k);
}
