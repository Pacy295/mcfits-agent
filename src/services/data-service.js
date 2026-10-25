/**
 * 最小数据服务（第一阶段任务 E）。
 *
 * 对外暴露 6 类能力，供网页与后续优化引擎直接调用，全部返回带状态的数据：
 *   1. getAvailableProducts  当前门店可用商品
 *   2. getNutrition          商品标准营养（official / unknown，绝不为 0）
 *   3. getMealRounds         套餐 rounds 与合法替换项
 *   4. composeNutrition      合法组合的营养总和
 *   5. priceCombo            对真实组合调用 calculate-price
 *   6. getCoverage           营养匹配覆盖率与人工确认清单
 *
 * 设计要点：
 * - 目录级缓存（catalog）只做 60s 级去抖，真正的时效由 menu/detail 缓存 TTL 控制。
 * - 组件营养解析优先用商品自身详情名，其次用套餐 round 选项名，并记录 resolvedBy 以便审计。
 */
import { config } from '../config.js';
import { buildCatalog } from '../data/catalog.js';
import { composeNutrition as sumNutrition, comboToRoundList, defaultCombo, describeMeal, enumerateCombos } from '../data/meal.js';
import { matchNutrition, toNutritionStatus } from '../data/nutrition-matcher.js';
import { priceItems } from '../data/pricing.js';
import { getDetail } from '../data/store.js';
import { mcp } from '../mcp/client.js';

const CATALOG_DEBOUNCE_MS = 60 * 1000;

class DataServiceError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'DataServiceError';
    this.code = code;
    this.extra = extra;
  }
}

export class DataService {
  constructor() {
    /** @type {Map<string, {catalog:object, at:number}>} */
    this.catalogs = new Map();
  }

  async #catalog(storeCode, { refresh = false } = {}) {
    const cachedEntry = this.catalogs.get(storeCode);
    if (!refresh && cachedEntry && Date.now() - cachedEntry.at < CATALOG_DEBOUNCE_MS) {
      return cachedEntry.catalog;
    }
    const catalog = await buildCatalog(storeCode, { refresh });
    this.catalogs.set(storeCode, { catalog, at: Date.now() });
    return catalog;
  }

  async #product(storeCode, code) {
    const catalog = await this.#catalog(storeCode);
    const p = catalog.products.get(String(code));
    if (!p) throw new DataServiceError('product_not_found', `门店 ${storeCode} 的菜单中不存在商品 ${code}`);
    return { catalog, product: p };
  }

  /** 1) 当前门店可用商品 */
  async getAvailableProducts(storeCode = config.store.defaultStoreCode, { refresh = false, category = null } = {}) {
    const catalog = await this.#catalog(storeCode, { refresh });
    let list = [...catalog.products.values()].filter((p) => p.sellable.onMenu);
    if (category) list = list.filter((p) => p.categories.includes(category));
    return {
      storeCode,
      storeName: config.store.storeName,
      count: list.length,
      categories: catalog.products.size
        ? [...new Set([...catalog.products.values()].flatMap((p) => p.categories))]
        : [],
      products: list.map((p) => ({
        code: p.code,
        name: p.name,
        categories: p.categories,
        tags: p.tags,
        isMeal: p.isMeal,
        nutritionStatus: p.nutrition.status,
        energyKcal: p.nutrition.energyKcal,
        protein: p.nutrition.protein ?? null,
        fat: p.nutrition.fat ?? null,
        carbohydrate: p.nutrition.carbohydrate ?? null,
        pricingStatus: p.pricing.status,
      })),
      sources: catalog.sources,
      builtAt: catalog.builtAt,
      failures: catalog.failures,
    };
  }

  /** 2) 商品标准营养 */
  async getNutrition(storeCode, code) {
    const { product } = await this.#product(storeCode, code);
    if (product.isMeal) {
      // 套餐：按默认组合求和
      const combo = defaultCombo(product.rounds);
      const composed = await this.composeNutrition(
        storeCode,
        combo.map((c) => ({ code: c.code, quantity: 1, fallbackName: c.name, round: c.round })),
      );
      return {
        storeCode,
        code: product.code,
        name: product.name,
        isMeal: true,
        basis: 'default-composition',
        nutrition: {
          status: composed.status,
          energyKcal: composed.totals?.energyKcal ?? null,
          protein: composed.totals?.protein ?? null,
          fat: composed.totals?.fat ?? null,
          carbohydrate: composed.totals?.carbohydrate ?? null,
          sodium: composed.totals?.sodium ?? null,
          calcium: composed.totals?.calcium ?? null,
          note: composed.basis,
        },
        components: composed.items,
        unknownComponents: composed.unknownComponents,
      };
    }
    return {
      storeCode,
      code: product.code,
      name: product.name,
      isMeal: false,
      basis: 'official-standard-value',
      nutrition: product.nutrition,
    };
  }

  /** 3) 套餐 rounds 与合法替换项 */
  async getMealRounds(storeCode, code, { withNutrition = true } = {}) {
    const { catalog, product } = await this.#product(storeCode, code);
    if (!product.isMeal) {
      throw new DataServiceError('not_a_meal', `商品 ${code}（${product.name}）不是套餐，没有 rounds`, { code });
    }
    const desc = describeMeal(product.rounds);

    /**
     * 为每个选项补上营养可用性，供界面明确标注"该替换项没有官方营养数据"。
     * 只读官方表，不做任何推算；拿不到就是 unknown。
     */
    let rounds = product.rounds;
    if (withNutrition) {
      rounds = await Promise.all(
        product.rounds.map(async (r) => ({
          ...r,
          choices: await Promise.all(
            r.choices.map(async (ch) => {
              try {
                const resolved = await this.#resolveComponent(storeCode, catalog, ch.code, ch.name);
                const n = resolved.nutrition || {};
                return {
                  ...ch,
                  nutrition: {
                    status: n.status || 'unknown',
                    energyKcal: n.energyKcal ?? null,
                    protein: n.protein ?? null,
                    source: resolved.resolvedBy || null,
                  },
                };
              } catch {
                return { ...ch, nutrition: { status: 'unknown', energyKcal: null, protein: null, source: null } };
              }
            }),
          ),
        })),
      );
    }

    return {
      storeCode,
      code: product.code,
      name: product.name,
      supportModify: product.supportModify,
      ...desc,
      rounds,
      defaultCombo: defaultCombo(product.rounds),
      note: '每个 round 恰好选择 1 项；diffPriceFen 为选项相对默认价的差额，最终金额必须由 calculate-price 实算。',
    };
  }

  /** 解析单个组件营养 */
  async #resolveComponent(storeCode, catalog, code, fallbackName) {
    const product = catalog.products.get(String(code));
    if (product && !product.isMeal && product.nutrition.status === 'official') {
      return {
        code: String(code),
        name: product.name,
        nutrition: product.nutrition,
        resolvedBy: 'catalog-detail-name',
      };
    }
    // 目录里没有（套餐组件常不在菜单里）→ 单独查详情
    let detailName = product?.name ?? null;
    if (!detailName) {
      try {
        const d = await getDetail(storeCode, code);
        detailName = d.name;
      } catch (err) {
        detailName = null;
      }
    }
    if (detailName) {
      const match = matchNutrition(detailName, catalog.nutritionIndex);
      const nut = toNutritionStatus(match, match.entry);
      if (nut.status === 'official') {
        return { code: String(code), name: detailName, nutrition: nut, resolvedBy: 'query-meal-detail' };
      }
    }
    if (fallbackName) {
      const match = matchNutrition(fallbackName, catalog.nutritionIndex);
      const nut = toNutritionStatus(match, match.entry);
      return {
        code: String(code),
        name: detailName || fallbackName,
        nutrition: nut,
        resolvedBy: nut.status === 'official' ? 'round-choice-name' : 'round-choice-name-unmatched',
      };
    }
    return {
      code: String(code),
      name: detailName,
      nutrition: {
        status: 'unknown',
        energyKcal: null,
        matchMethod: 'no-name',
        matchStatus: 'unmatched',
        note: '既无详情名称也无 round 选项名，无法匹配营养',
      },
      resolvedBy: 'none',
    };
  }

  /** 4) 组合营养总和 */
  async composeNutrition(storeCode, components) {
    const catalog = await this.#catalog(storeCode);
    const resolved = [];
    for (const c of components) {
      const r = await this.#resolveComponent(storeCode, catalog, c.code, c.fallbackName);
      resolved.push({ ...r, quantity: c.quantity ?? 1 });
    }
    const composed = sumNutrition(resolved);
    return {
      storeCode,
      ...composed,
      units: { energyKcal: 'kcal', protein: 'g', fat: 'g', carbohydrate: 'g', sodium: 'mg', calcium: 'mg' },
      unitBasis: 'per_serving_inferred（官方未声明单位与基准份量，按字段名与量级推断）',
    };
  }

  /** 5) 对真实组合调用 calculate-price */
  async priceCombo(storeCode, { productCode, choices = null, items = null, refresh = false } = {}) {
    let requestItems;
    if (items) {
      requestItems = items;
    } else {
      const { product } = await this.#product(storeCode, productCode);
      if (!product.isMeal) throw new DataServiceError('not_a_meal', `商品 ${productCode} 不是套餐，请直接传 items`);
      const combo = choices?.length ? choices : defaultCombo(product.rounds);
      // 校验：每个 round 必须且只能出现一次，且 code 必须属于该 round 的合法选项
      const byRound = new Map(product.rounds.map((r) => [String(r.id), r]));
      for (const c of combo) {
        const round = byRound.get(String(c.round));
        if (!round) throw new DataServiceError('invalid_round', `round ${c.round} 不存在`);
        if (!round.choices.some((ch) => ch.code === String(c.code))) {
          throw new DataServiceError(
            'illegal_choice',
            `round ${c.round}（${round.name}）不允许选择商品 ${c.code}，合法选项：${round.choices.map((x) => x.code).join(',')}`,
          );
        }
      }
      if (combo.length !== product.rounds.length) {
        throw new DataServiceError('incomplete_combo', `必须为每个 round 各选 1 项，当前 ${combo.length}/${product.rounds.length}`);
      }
      requestItems = [
        { productCode: String(productCode), quantity: 1, roundList: comboToRoundList(combo) },
      ];
    }
    const priced = await priceItems(storeCode, requestItems, { refresh });
    return { ...priced, requestMode: items ? 'raw-items' : 'meal-combo' };
  }

  /** 6) 覆盖率与人工确认清单 */
  async getCoverage(storeCode = config.store.defaultStoreCode, { refresh = false } = {}) {
    const catalog = await this.#catalog(storeCode, { refresh });
    const products = [...catalog.products.values()];
    const singles = products.filter((p) => !p.isMeal);
    const meals = products.filter((p) => p.isMeal);

    const byStatus = { matched_exact: 0, matched_loose: 0, matched_alias: 0, ambiguous: 0, unmatched: 0 };
    const review = [];
    for (const p of singles) {
      const st = p.nutrition.matchStatus || 'unmatched';
      if (st in byStatus) byStatus[st] += 1;
      if (p.nutrition.status === 'unknown') {
        review.push({
          type: 'single-item',
          code: p.code,
          name: p.name,
          matchStatus: st,
          candidates: p.nutrition.candidates || [],
          note: p.nutrition.note || null,
        });
      }
    }

    // 套餐按默认组合试算，统计可求和率
    const mealStats = { derived: 0, partial: 0, unknown: 0, details: [] };
    for (const m of meals) {
      const combo = defaultCombo(m.rounds);
      const resolved = [];
      for (const c of combo) {
        const r = await this.#resolveComponent(storeCode, catalog, c.code, c.name);
        resolved.push({ ...r, quantity: 1 });
      }
      const composed = sumNutrition(resolved);
      if (composed.status === 'derived_sum') mealStats.derived += 1;
      else if (composed.status === 'partial') mealStats.partial += 1;
      else mealStats.unknown += 1;
      m.nutrition = {
        status: composed.status,
        energyKcal: composed.totals?.energyKcal ?? null,
        protein: composed.totals?.protein ?? null,
        fat: composed.totals?.fat ?? null,
        carbohydrate: composed.totals?.carbohydrate ?? null,
        matchMethod: 'default-composition-sum',
        matchStatus: composed.status,
        components: composed.items.map((i) => ({ code: i.code, name: i.name, nutritionStatus: i.nutritionStatus, resolvedBy: i.resolvedBy })),
        note: composed.status === 'derived_sum' ? '默认组合各组件官方值之和' : '存在无营养数据的组件，未给出总计',
      };
      if (composed.status !== 'derived_sum') {
        mealStats.details.push({ code: m.code, name: m.name, status: composed.status, unknown: composed.unknownComponents });
      }
    }

    const usableSingles = singles.filter((p) => p.nutrition.status === 'official').length;
    const usableMeals = mealStats.derived;
    const usable = usableSingles + usableMeals;

    return {
      storeCode,
      checkedAt: Date.now(),
      officialTableRows: catalog.nutritionRows.length,
      counts: {
        onMenuProducts: products.length,
        singleItems: singles.length,
        meals: meals.length,
        detailFailures: catalog.failures.length,
      },
      singleItemMatch: byStatus,
      mealComposition: { derived: mealStats.derived, partial: mealStats.partial, unknown: mealStats.unknown },
      coverage: {
        singleItems: singles.length ? Number(((usableSingles / singles.length) * 100).toFixed(1)) : 0,
        meals: meals.length ? Number(((usableMeals / meals.length) * 100).toFixed(1)) : 0,
        overall: products.length ? Number(((usable / products.length) * 100).toFixed(1)) : 0,
        usable,
        total: products.length,
      },
      needsHumanReview: review,
      reviewCount: review.length,
      mealIssues: mealStats.details,
      sources: catalog.sources,
    };
  }

  /** 供优化器直接使用：返回目录快照（只读） */
  async getCatalog(storeCode = config.store.defaultStoreCode, { refresh = false } = {}) {
    return this.#catalog(storeCode, { refresh });
  }

  /** 供优化器批量解析组件营养（内部有缓存，code 维度） */
  async resolveNutrition(storeCode, code, fallbackName) {
    const catalog = await this.#catalog(storeCode);
    return this.#resolveComponent(storeCode, catalog, code, fallbackName);
  }

  /** 健康检查（不含任何 Token 信息） */
  async health() {
    const metrics = mcp.snapshotMetrics();
    let mcpReachable = false;
    let serverTime = null;
    let error = null;
    try {
      const r = await mcp.callTool('now-time-info', {});
      mcpReachable = true;
      serverTime = r.data?.formatted ?? r.datetime;
    } catch (err) {
      error = { kind: err.kind || 'unknown', message: err.message };
    }
    return {
      ok: mcpReachable,
      service: 'mcfits-agent',
      stage: 1,
      mcp: { url: config.mcp.url, reachable: mcpReachable, serverTime, error, metrics },
      store: { code: config.store.defaultStoreCode, name: config.store.storeName, beType: config.store.beType, orderType: config.store.orderType },
      caches: config.ttl,
      uptimeSec: Math.round(process.uptime()),
    };
  }
}

export const dataService = new DataService();
export { DataServiceError };
