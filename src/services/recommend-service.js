/**
 * 推荐服务：把优化引擎与真实数据管线（catalog / meal / pricing / data-service）接起来。
 *
 * 职责边界：
 * - 负责"取真实数据"和"调用真实核价"，不含任何优化算法（算法在 src/optimize/）。
 * - 引擎通过 deps 注入获得数据，因此可以脱离 MCP 单测。
 */
import { config } from '../config.js';
import { dataService } from './data-service.js';
import { priceItems } from '../data/pricing.js';
import { roleOf, roleOfName } from '../optimize/classify.js';
import { buildPlan, recommend as runEngine } from '../optimize/engine.js';
import { violates } from '../optimize/infeasible.js';
import { DataServiceError } from './data-service.js';
import { mapLimit } from '../util/limit.js';

const POOL_TTL_MS = 5 * 60 * 1000;
const poolCache = new Map(); // storeCode -> {at, pool}

/**
 * 构建优化池：真实在售商品 → 角色分类 → 营养可用性判定。
 * 只有营养状态为 official 的单品、以及至少有一套完整营养组合的套餐才进入池子。
 */
export async function buildPool(storeCode, { refresh = false } = {}) {
  const hit = poolCache.get(storeCode);
  if (!refresh && hit && Date.now() - hit.at < POOL_TTL_MS) return hit.pool;

  const catalog = await dataService.getCatalog(storeCode, { refresh });
  const products = [...catalog.products.values()];

  /* 1) 组件营养解析（套餐内部件往往不在菜单里，需要单独解析；结果缓存复用） */
  const componentCodes = new Set();
  for (const p of products) {
    if (!p.isMeal) continue;
    for (const r of p.rounds || []) for (const ch of r.choices || []) componentCodes.add(ch.code);
  }
  const nutMap = new Map();
  for (const [code, p] of catalog.products) {
    if (!p.isMeal && p.nutrition?.status === 'official') nutMap.set(code, p.nutrition);
  }
  const missing = [...componentCodes].filter((c) => !nutMap.has(c));
  const resolved = await mapLimit(missing, 6, async (code) => {
    const r = await dataService.resolveNutrition(storeCode, code);
    return [code, r.nutrition];
  });
  for (const item of resolved) {
    if (item?.ok && item.value) nutMap.set(item.value[0], item.value[1]);
  }
  const nutritionOf = (code) => nutMap.get(String(code)) || null;

  /* 2) 单品按角色分池，只保留营养 official 的 */
  const singles = { main: [], side: [], drink: [], dessert: [] };
  let unknownExcluded = 0;
  let containerCount = 0;

  // 2a) 普通单品
  for (const p of products) {
    if (p.isMeal) continue;
    const role = roleOf(p);
    if (role === 'other' || !singles[role]) {
      if (p.nutrition?.status !== 'official') unknownExcluded += 1;
      continue;
    }
    if (p.nutrition?.status !== 'official') {
      unknownExcluded += 1;
      continue;
    }
    singles[role].push({ code: p.code, name: p.name, role, nutrition: p.nutrition, priceKey: `single:${p.code}` });
  }

  /* 3) 套餐与"容器型"商品
   *    - 含主食部件的套餐 → 作为一顿正餐候选（角色 main，内部再做 rounds 变体）
   *    - 只含饮料/甜品/小食部件的容器（如「可乐」选规格、「派」选口味）→ 归入对应角色的单品池，
   *      用「默认选项」作为一个可选单品参与组合，价格按套餐 roundList 核价。
   *      这类商品如果被当成"正餐"参与组合，就会出现"一杯饮料冒充一顿饭"的错误，因此必须分开。 */
  const meals = [];
  const containers = [];
  for (const p of products) {
    if (!p.isMeal) continue;
    if (!p.rounds?.length) continue;
    const role = roleOf(p);
    const hasComplete = p.rounds.every((r) => (r.choices || []).some((ch) => nutritionOf(ch.code)?.status === 'official'));
    if (!hasComplete) {
      unknownExcluded += 1;
      continue;
    }
    if (role === 'main') {
      meals.push({ code: p.code, name: p.name, role: 'main', rounds: p.rounds, supportModify: p.supportModify });
      continue;
    }
    // 容器：取每个 round 的默认选项拼成"默认配置"
    const defaultCombo = p.rounds.map((r) => {
      const ch = r.choices.find((c) => c.isDefault) || r.choices[0];
      return { round: r.id, roundName: r.name, code: ch.code, name: ch.name, diffPriceFen: ch.diffPriceFen ?? 0 };
    });
    const nut = nutritionOf(defaultCombo[0]?.code);
    if (!nut || nut.status !== 'official') {
      unknownExcluded += 1;
      continue;
    }
    containerCount += 1;
    containers.push({
      code: p.code,
      name: p.name,
      role,
      container: defaultCombo,
      nutrition: { ...nut, matchMethod: `${nut.matchMethod || ''}（容器默认选项）` },
      priceKey: `meal:${p.code}`,
      displayName: `${p.name}（默认 ${defaultCombo[0]?.name || ''}）`.trim(),
    });
    (singles[role] || singles.side).push({
      code: p.code,
      name: `${p.name}（默认 ${defaultCombo[0]?.name || ''}）`.trim(),
      role,
      nutrition: nut,
      priceKey: `meal:${p.code}`,
      container: defaultCombo,
    });
  }

  const pool = {
    storeCode,
    meals,
    singles,
    containers,
    nutritionOf,
    stats: {
      nutritionUnknownExcluded: unknownExcluded,
      containerProducts: containerCount,
      componentResolved: nutMap.size,
      officialTableRows: catalog.nutritionRows?.length ?? null,
      builtAt: Date.now(),
    },
  };
  poolCache.set(storeCode, { at: Date.now(), pool });
  return pool;
}

/** 参考价：套餐按默认组合核价，单品按单件核价（均为真实 calculate-price，缓存 5 分钟） */
async function priceProducts(storeCode, items) {
  const out = new Map();
  const results = await mapLimit(items, 6, async (item) => {
    if (item.kind === 'meal' || item.defaultChoices) {
      // 套餐：默认组合；容器型商品：用它自己的默认选项
      const combo = item.defaultChoices
        ? item.defaultChoices.map((c) => ({ round: c.round, code: c.code }))
        : (item.meal.rounds || []).map((r) => ({
            round: r.id,
            code: (r.choices.find((c) => c.isDefault) || r.choices[0])?.code,
          }));
      const priced = await dataService.priceCombo(storeCode, { productCode: item.code, choices: combo });
      return [item, priced];
    }
    const priced = await priceItems(storeCode, [{ productCode: item.code, quantity: 1 }]);
    return [item, priced];
  });
  for (const r of results) {
    if (!r?.ok) continue;
    const [item, priced] = r.value;
    if (priced?.status === 'valued' && Number.isFinite(priced.priceFen)) {
      out.set(`${item.kind}:${item.code}`, {
        fen: priced.priceFen,
        checkedAt: priced.checkedAt,
        traceId: priced.traceId,
        mcpDatetime: priced.mcpDatetime,
      });
    }
  }
  return out;
}

/**
 * 预热参考价：把池内全部套餐默认价 + 单品价拉一遍（只读 calculate-price）。
 * 目的：让用户请求不承担冷启动的限速成本；价格仍按 5 分钟 TTL 过期，
 * 且最终推荐一律再核一次，不会拿预热价当最终价。
 */
export async function warmPrices(storeCode, { refresh = false } = {}) {
  const pool = await buildPool(storeCode, { refresh });
  const targets = [
    ...pool.meals.map((m) => ({ kind: 'meal', code: m.code, meal: m })),
    ...['main', 'side', 'drink', 'dessert'].flatMap((role) =>
      (pool.singles[role] || []).map((p) => ({ kind: p.priceKey?.startsWith('meal:') ? 'meal' : 'single', code: p.code, defaultChoices: p.container || null })),
    ),
  ];
  const t0 = Date.now();
  const priced = await priceProducts(storeCode, targets);
  return { targets: targets.length, priced: priced.size, ms: Date.now() - t0 };
}

/** 单个候选的真实核价 */
async function priceCandidate(storeCode, cand) {
  if (cand.kind === 'meal') {
    return dataService.priceCombo(storeCode, {
      productCode: cand.productCode,
      choices: cand.combo.map((x) => ({ round: x.round, code: x.code })),
    });
  }
  // 单品组合：容器型组件带上 roundList，普通单品直接按 productCode 计价
  return priceItems(
    storeCode,
    cand.components.map((c) => {
      const item = { productCode: c.code, quantity: c.quantity ?? 1 };
      if (c.container?.length) {
        item.roundList = c.container.map((x) => ({ round: x.round, comboItemList: [{ code: x.code, quantity: 1 }] }));
      }
      return item;
    }),
  );
}

/**
 * 对外入口。
 * @param {object} constraints 已规范化约束（可直接来自前端表单）
 * @param {object} options
 */
export async function recommendPlans(constraints, options = {}) {
  const storeCode = options.storeCode || config.store.defaultStoreCode;
  const deps = {
    buildPool: () => buildPool(storeCode, { refresh: options.refreshPool }),
    priceProducts: (items) => priceProducts(storeCode, items),
    priceCandidate: (cand) => priceCandidate(storeCode, cand),
  };
  return runEngine(constraints, options, deps);
}

/**
 * 套餐/组合"重建"：用户改动规格后，服务端重新校验、重算营养、重新核价、重判约束。
 * 前端不允许自己改营养或价格，必须走这里。
 *
 * @param {{storeCode?:string, productCode?:string, choices?:Array<{round:string,code:string}>,
 *          components?:Array<{code:string,quantity?:number}>, constraints?:object}} input
 */
export async function rebuildPlan(input = {}) {
  const storeCode = input.storeCode || config.store.defaultStoreCode;
  const c = input.constraints || {};
  const reasons = [];

  let cand;
  if (input.productCode && Array.isArray(input.choices) && input.choices.length) {
    /* ---------- 套餐：rounds 合法性由数据层校验（非法选项会抛 illegal_choice） ---------- */
    const rounds = await dataService.getMealRounds(storeCode, input.productCode);
    const byRound = new Map(rounds.rounds.map((r) => [String(r.id), r]));
    if (input.choices.length !== rounds.rounds.length) {
      throw new DataServiceError('incomplete_combo', `必须为每个 round 各选 1 项，当前 ${input.choices.length}/${rounds.rounds.length}`);
    }
    const seen = new Set();
    for (const ch of input.choices) {
      const round = byRound.get(String(ch.round));
      if (!round) throw new DataServiceError('invalid_round', `round ${ch.round} 不存在`);
      if (seen.has(String(ch.round))) throw new DataServiceError('duplicate_round', `round ${ch.round} 重复提交`);
      seen.add(String(ch.round));
      const legal = round.choices.find((x) => x.code === String(ch.code));
      if (!legal) {
        throw new DataServiceError('illegal_choice', `round ${ch.round}（${round.name}）不支持商品 ${ch.code}`, {
          legalCodes: round.choices.map((x) => x.code),
        });
      }
    }

    const chosen = input.choices.map((ch) => {
      const round = byRound.get(String(ch.round));
      const legal = round.choices.find((x) => x.code === String(ch.code));
      return { round: String(ch.round), roundName: round.name, code: legal.code, name: legal.name, diffPriceFen: legal.diffPriceFen ?? 0 };
    });

    const composed = await dataService.composeNutrition(
      storeCode,
      chosen.map((x) => ({ code: x.code, quantity: 1, fallbackName: x.name })),
    );
    const priced = await dataService.priceCombo(storeCode, {
      productCode: String(input.productCode),
      choices: chosen.map((x) => ({ round: x.round, code: x.code })),
      refresh: Boolean(input.refreshPrice),
    });
    if (priced.status !== 'valued') {
      return { status: 'price_failed', plan: null, checks: null, error: priced.error || { message: '核价失败' }, constraints: c };
    }

    const roles = new Set(['main']);
    for (const x of chosen) {
      const r = roleOfName(x.name);
      if (r !== 'other') roles.add(r);
    }
    cand = {
      kind: 'meal',
      productCode: String(input.productCode),
      productName: rounds.name,
      components: chosen.map((x) => ({ code: x.code, name: x.name, quantity: 1 })),
      combo: chosen,
      roles: [...roles],
      nutrition: composed.totals || { energyKcal: null, protein: null, fat: null, carbohydrate: null },
      nutritionStatus: composed.status,
      priced,
      priceBasis: 'calculate-price 实算（rounds 组合）',
      pickReason: null,
    };
    if (composed.status !== 'derived_sum') {
      reasons.push('部分组件的官方营养数据缺失，营养合计不完整，不能据此宣称满足营养约束');
    }
    if (composed.unknownComponents?.length) {
      reasons.push(`缺营养数据的组件：${composed.unknownComponents.map((x) => x.name || x.code).join('、')}`);
    }
  } else if (Array.isArray(input.components) && input.components.length) {
    /* ---------- 单品组合：逐项校验存在性与营养可用性 ---------- */
    const pool = await buildPool(storeCode);
    const all = Object.entries(pool.singles).flatMap(([role, list]) => list.map((p) => ({ ...p, role })));
    const picked = [];
    for (const comp of input.components) {
      const hit = all.find((p) => p.code === String(comp.code));
      if (!hit) throw new DataServiceError('product_not_found', `商品 ${comp.code} 不可用于组合（不在售或缺少官方营养数据）`);
      picked.push({ ...hit, quantity: Math.max(1, Number(comp.quantity) || 1) });
    }
    const composed = await dataService.composeNutrition(
      storeCode,
      picked.map((p) => ({ code: p.code, quantity: p.quantity, fallbackName: p.name })),
    );
    const priced = await priceItems(
      storeCode,
      picked.map((p) => ({ productCode: p.code, quantity: p.quantity })),
    );
    if (priced.status !== 'valued') {
      return { status: 'price_failed', plan: null, checks: null, error: priced.error || { message: '核价失败' }, constraints: c };
    }
    cand = {
      kind: 'single',
      productCode: picked.map((p) => p.code).join('+'),
      productName: picked.map((p) => p.name).join(' + '),
      components: picked.map((p) => ({ code: p.code, name: p.name, quantity: p.quantity, role: p.role })),
      roles: [...new Set(picked.map((p) => p.role))],
      nutrition: composed.totals || { energyKcal: null, protein: null, fat: null, carbohydrate: null },
      nutritionStatus: composed.status,
      priced,
      priceBasis: '各单品实价之和',
      pickReason: null,
    };
  } else {
    throw new DataServiceError('invalid_request', '需要 productCode+choices（套餐）或 components（单品组合）');
  }

  /* ---------- 约束复核：用真实核价与官方营养，逐项给出数字 ---------- */
  const allViolations = violates(cand, c);
  const violations = allViolations.filter((v) => v.verified !== false);
  const satisfied = [];
  if (c.budgetMax != null && !violations.some((v) => v.key === 'budgetMax')) satisfied.push(`预算 ≤ ¥${c.budgetMax}`);
  if (c.caloriesMax != null && !violations.some((v) => v.key === 'caloriesMax')) satisfied.push(`热量 ≤ ${c.caloriesMax} kcal`);
  if (c.caloriesMin != null && !violations.some((v) => v.key === 'caloriesMin')) satisfied.push(`热量 ≥ ${c.caloriesMin} kcal`);
  if (c.proteinMin != null && !violations.some((v) => v.key === 'proteinMin')) satisfied.push(`蛋白质 ≥ ${c.proteinMin} g`);
  const missingRoles = (c.requiredCategories || []).filter((r) => !(cand.roles || []).includes(r));
  if ((c.requiredCategories || []).length && !missingRoles.length) satisfied.push(`包含必须的类别`);

  const plan = buildPlan(cand, 0, [cand], c);
  plan.pareto = {
    nonDominated: null, // 单方案重建不参与前沿比较
    label: '手动调整方案',
    dimensions: [],
    dominatedBy: [],
    note: '这是你手动调整后的单套方案，不做帕累托比较；如需比较请重新生成推荐',
  };

  return {
    status: 'ok',
    plan,
    checks: {
      satisfied,
      violations,
      nutritionComplete: cand.nutritionStatus === 'derived_sum',
      modificationImpact: 'not_modeled',
      modificationNote: '去酱/去冰/加减配料后的营养变化没有官方数据，以上营养为"标准配置"值，不代表特制后的实际值。',
    },
    notes: reasons,
    constraints: c,
  };
}

/** 供测试注入假依赖 */
export function makeDepsForTest({ pool, prices, priced }) {
  return {
    buildPool: async () => pool,
    priceProducts: async (items) => {
      const map = new Map();
      for (const it of items) {
        const key = `${it.kind}:${it.code}`;
        if (prices[key] != null) map.set(key, { fen: prices[key], checkedAt: Date.now(), traceId: 'test', mcpDatetime: 'test' });
      }
      return map;
    },
    priceCandidate: async (cand) => {
      const v = priced(cand);
      return { status: 'valued', priceFen: v, checkedAt: Date.now(), traceId: 'test', mcpDatetime: 'test' };
    },
  };
}
