/**
 * 统一商品数据结构（第一阶段任务 B）。
 *
 * 一个 Product 记录同时承载：菜单可售性、套餐结构、特制选项、营养状态、价格状态、溯源信息。
 * 营养与价格都带显式 status，任何"未知"都是 null + status，绝不出现 0 或凭空数字。
 */
import { config } from '../config.js';
import { getMenu, getDetails, getNutritionTable } from './store.js';
import { buildNutritionIndex, matchNutrition, toNutritionStatus } from './nutrition-matcher.js';

/**
 * @typedef {object} NutritionStatus
 * @property {'official'|'derived_sum'|'partial'|'unknown'} status
 * @property {number|null} energyKcal
 */

/** 解析 "+ ¥2" / "- ¥1.5" / "+ ¥0" → 分 */
export function parseDiffPrice(text) {
  if (text == null) return null;
  const s = String(text).replace(/\s/g, '');
  const m = /([+-])?¥([0-9]+(?:\.[0-9]+)?)/.exec(s);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return Math.round(sign * Number(m[2]) * 100);
}

/** 规范化 modification 结构（保留 selectedKey/unselectedKey，价格单位统一成分） */
export function normalizeModification(mod) {
  if (!mod || !Array.isArray(mod.items)) return null;
  return {
    maxValues: mod.maxValues ?? null,
    minValues: mod.minValues ?? null,
    items: mod.items.map((g, gi) => ({
      groupIndex: gi,
      maxValues: g.maxValues ?? null,
      minValues: g.minValues ?? null,
      values: (g.values || []).map((v) => ({
        code: v.code != null ? String(v.code) : null,
        name: v.name ?? null,
        priceFen: Number.isFinite(Number(v.price)) ? Number(v.price) : null,
        maxQuantity: v.maxQuantity ?? null,
        minQuantity: v.minQuantity ?? null,
        selectedQuantity: v.selectedQuantity ?? null,
        selectedKey: v.selectedKey ?? null,
        unselectedKey: v.unselectedKey ?? null,
        /** 同一组内 code 可能重复（如可乐四档冰量同为 200002），必须用 key 传参 */
        keyIsRequired: v.selectedKey != null,
      })),
    })),
  };
}

/** 规范化 rounds，把 diffPrice 字符串解析成分 */
export function normalizeRounds(rounds) {
  return (rounds || []).map((r) => ({
    id: String(r.id),
    name: r.name ?? null,
    quantity: r.quantity ?? 1,
    minQuantity: r.minQuantity ?? null,
    maxQuantity: r.maxQuantity ?? null,
    choices: (r.choices || []).map((c) => ({
      code: String(c.code),
      name: c.name ?? null,
      quantity: c.quantity ?? 0,
      isDefault: Number(c.isDefault) === 1,
      diffPriceText: c.diffPrice ?? null,
      diffPriceFen: parseDiffPrice(c.diffPrice),
      supportModify: Boolean(c.supportModify),
      modification: normalizeModification(c.modification),
    })),
  }));
}

/**
 * 构建门店商品目录。
 * @param {string} storeCode
 * @param {{refresh?:boolean, onProgress?:Function}} opts
 */
export async function buildCatalog(storeCode = config.store.defaultStoreCode, opts = {}) {
  const menu = await getMenu(storeCode, { refresh: opts.refresh });
  const nutritionTable = await getNutritionTable({ refresh: opts.refresh });
  const index = buildNutritionIndex(nutritionTable.rows);

  const { details, failures } = await getDetails(storeCode, menu.uniqueCodes, {
    refresh: opts.refresh,
    onProgress: opts.onProgress,
  });

  const products = new Map();
  const failureList = [...failures];

  for (const code of menu.uniqueCodes) {
    const d = details.get(code);
    if (!d) {
      // 详情拉取失败：保留可售记录，但名称与营养均为 unknown（不猜测）
      products.set(code, {
        storeCode,
        code,
        name: null,
        categories: menu.codeToCategories[code] || [],
        tags: menu.categories.flatMap((c) => c.meals.filter((m) => m.code === code).flatMap((m) => m.tags)),
        sellable: { onMenu: true, status: 'on_menu', source: 'query-meals' },
        isMeal: false,
        rounds: [],
        modification: null,
        nutrition: {
          status: 'unknown',
          energyKcal: null,
          matchMethod: 'detail-unavailable',
          matchStatus: 'unmatched',
          note: '商品详情接口失败，名称与营养均不可得',
        },
        pricing: { status: 'unvalued', priceFen: null, note: '未核价' },
        error: { stage: 'query-meal-detail', message: '详情拉取失败' },
      });
      continue;
    }

    const rounds = normalizeRounds(d.rounds);
    const isMeal = rounds.length > 0;
    const match = d.name ? matchNutrition(d.name, index) : { status: 'unmatched', method: 'L5 无名称', candidates: [] };
    const nutrition = toNutritionStatus(match, match.entry);

    products.set(code, {
      storeCode,
      code,
      name: d.name,
      categories: menu.codeToCategories[code] || [],
      tags: menu.categories.flatMap((c) => c.meals.filter((m) => m.code === code).flatMap((m) => m.tags)),
      image: d.image,
      sellable: {
        onMenu: true,
        status: 'on_menu',
        source: 'query-meals',
        menuCheckedAt: menu.meta.storedAt,
      },
      isMeal,
      rounds,
      modification: normalizeModification(d.modification),
      supportModify: d.supportModify,
      // 套餐的营养需要按组成计算，这里先标记为 derived-pending
      nutrition: isMeal
        ? {
            status: 'unknown',
            energyKcal: null,
            matchMethod: 'meal-requires-composition',
            matchStatus: 'derived-pending',
            note: '套餐营养须由各 round 组件求和，不直接套用名称匹配',
          }
        : nutrition,
      pricing: { status: 'unvalued', priceFen: null, note: '未核价' },
      source: {
        detail: d.source,
        detailCache: d.meta.cache,
      },
    });
  }

  return {
    storeCode,
    builtAt: Date.now(),
    products,
    failures: failureList,
    nutritionIndex: index,
    nutritionRows: nutritionTable.rows,
    sources: { menu: menu.source, nutrition: nutritionTable.source },
    meta: { menu: menu.meta, nutrition: nutritionTable.meta },
  };
}

/** 只读快照：把 Map 转成数组并按分类分组 */
export function catalogSnapshot(catalog) {
  const list = [...catalog.products.values()];
  return {
    storeCode: catalog.storeCode,
    builtAt: catalog.builtAt,
    count: list.length,
    products: list,
    sources: catalog.sources,
  };
}
