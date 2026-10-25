/**
 * 不可行分析（确定性程序给量化结果，LLM 只负责翻译成人话）。
 *
 * 输出三件事：
 * 1. 每个硬约束单独放宽后，已核价候选里能剩多少可行解（用真实核价结果，不重新猜）。
 * 2. 最接近可行的候选，逐项给出「超出多少」，并标记违反了哪些要求。
 * 3. 搜索范围说明 —— 只搜了部分候选时，禁止断言"全店不存在"。
 */

import { priceFenOf, snapshotOf, nutritionOf } from './shape.js';

export function violates(cand, c) {
  const out = [];
  const price = priceFenOf(cand);
  const { kcal, protein } = nutritionOf(cand);

  if (c.budgetMax != null) {
    if (price == null) out.push({ key: 'budgetMax', verified: false, detail: '未核价，无法判断' });
    else if (price > c.budgetMax * 100) out.push({ key: 'budgetMax', verified: true, excessFen: price - c.budgetMax * 100, detail: `超预算 ¥${((price - c.budgetMax * 100) / 100).toFixed(2)}` });
  }
  if (c.caloriesMax != null && kcal != null && kcal > c.caloriesMax) {
    out.push({ key: 'caloriesMax', verified: true, excess: kcal - c.caloriesMax, detail: `超热量 ${(kcal - c.caloriesMax).toFixed(0)} kcal` });
  }
  if (c.caloriesMin != null && kcal != null && kcal < c.caloriesMin) {
    out.push({ key: 'caloriesMin', verified: true, shortfall: c.caloriesMin - kcal, detail: `热量差 ${(c.caloriesMin - kcal).toFixed(0)} kcal` });
  }
  if (c.proteinMin != null && protein != null && protein < c.proteinMin) {
    out.push({ key: 'proteinMin', verified: true, shortfall: c.proteinMin - protein, detail: `蛋白质差 ${(c.proteinMin - protein).toFixed(1)} g` });
  }
  if ((c.requiredCategories || []).length) {
    const roles = new Set(cand.roles || []);
    const missing = c.requiredCategories.filter((r) => !roles.has(r));
    if (missing.length) out.push({ key: 'requiredCategories', verified: true, missing, detail: `缺少${missing.join('/')}` });
  }
  return out;
}

export function shortfallScore(cand, c) {
  let score = 0;
  const price = priceFenOf(cand) ?? 0;
  const n = nutritionOf(cand);
  const kcal = n.kcal ?? 0;
  const protein = n.protein ?? 0;
  if (c.budgetMax != null && price > c.budgetMax * 100) score += (price - c.budgetMax * 100) / (c.budgetMax * 100);
  if (c.caloriesMax != null && kcal > c.caloriesMax) score += (kcal - c.caloriesMax) / c.caloriesMax;
  if (c.caloriesMin != null && kcal < c.caloriesMin) score += (c.caloriesMin - kcal) / c.caloriesMin;
  if (c.proteinMin != null && protein < c.proteinMin) score += (c.proteinMin - protein) / c.proteinMin;
  if ((c.requiredCategories || []).length) {
    const roles = new Set(cand.roles || []);
    const missing = c.requiredCategories.filter((r) => !roles.has(r));
    score += missing.length * 0.5;
  }
  return score;
}

const LABEL = {
  budgetMax: '预算上限',
  caloriesMax: '热量上限',
  caloriesMin: '热量下限',
  proteinMin: '蛋白质下限',
  requiredCategories: '必含类别',
};

/**
 * @param {Array} verified 已核价候选
 * @param {object} constraints
 * @param {{searchScope:object, maxAlternatives?:number}} opts
 */
/** 用参考价估算的差距分（预筛阶段使用），仅用于排序，不作为结论 */
export function estimatedShortfall(cand, c) {
  const price = priceFenOf(cand);
  const cloned = { ...cand, priced: price == null ? null : { priceFen: price } };
  return shortfallScore(cloned, c);
}

export function analyzeInfeasible(verified, constraints, opts = {}) {
  const c = constraints;
  const maxAlt = opts.maxAlternatives ?? 3;

  /**
   * 用户实际启用的硬约束（只有这些才允许出现在"放宽"分析里）。
   * 未设置的约束（null / 空数组）一律不参与，更不能出现在面向用户的解释中。
   */
  const RELAXABLE = ['budgetMax', 'caloriesMax', 'caloriesMin', 'proteinMin', 'requiredCategories'];
  const enabledKeys = RELAXABLE.filter((k) => {
    const v = c[k];
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  });

  // 1) 单约束放宽（仅限 enabledKeys）
  const relaxations = [];
  for (const key of enabledKeys) {
    const relaxed = { ...c, [key]: null };
    const feasible = verified.filter((v) => violates(v, relaxed).filter((x) => x.verified !== false).length === 0);
    if (!feasible.length) {
      relaxations.push({ constraint: key, label: LABEL[key], feasibleCount: 0, note: `即使去掉「${LABEL[key]}」，已核价候选中仍无可行解` });
      continue;
    }
    const cheapest = feasible.reduce((a, b) => ((priceFenOf(a) ?? Infinity) <= (priceFenOf(b) ?? Infinity) ? a : b));
    const best = feasible.reduce((a, b) => ((nutritionOf(a).protein ?? 0) >= (nutritionOf(b).protein ?? 0) ? a : b));
    const sc = snapshotOf(cheapest);
    const sb = snapshotOf(best);
    relaxations.push({
      constraint: key,
      label: LABEL[key],
      feasibleCount: feasible.length,
      cheapest: { name: sc.name, priceFen: sc.priceFen, kcal: sc.kcal, protein: sc.protein },
      bestProtein: { name: sb.name, priceFen: sb.priceFen, kcal: sb.kcal, protein: sb.protein },
      note: `去掉「${LABEL[key]}」后，已核价候选中 ${feasible.length} 个可行；最便宜 ¥${((sc.priceFen ?? 0) / 100).toFixed(2)}`,
    });
  }

  // 2) 最接近的候选
  const ranked = [...verified]
    .map((v) => ({ cand: v, score: shortfallScore(v, c), violations: violates(v, c) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, maxAlt);

  // 3) 逐项统计：哪个约束最"卡"
  const counts = new Map();
  for (const v of verified) {
    for (const x of violates(v, c)) {
      if (x.verified === false) continue;
      counts.set(x.key, (counts.get(x.key) || 0) + 1);
    }
  }
  const blocking = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => ({ constraint: key, label: LABEL[key], violatedBy: n, ofTotal: verified.length }));

  const unverifiable = (c.dietaryRestrictions || []).filter((d) => !d.verified).map((d) => ({ text: d.text, reason: d.note }));

  return {
    enabledConstraints: enabledKeys.map((k) => ({ key: k, label: LABEL[k], value: c[k] })),
    relaxedConstraints: relaxations.map((x) => x.constraint),
    reason: blocking.length ? `在已核价的 ${verified.length} 个候选中，全部不满足硬约束，最常被违反的是「${blocking[0].label}」` : `已核价的 ${verified.length} 个候选全部不满足硬约束`,
    blocking,
    relaxations,
    closest: ranked.map((r) => ({
      // 用统一快照：与推荐方案/对比读的是同一份数值，避免各模块各算一遍
      candidate: { ...snapshotOf(r.cand), components: r.cand.components },
      violations: r.violations,
      shortfallScore: Number(r.score.toFixed(4)),
    })),
    unverifiable,
    scopeNote:
      opts.searchScope?.completeness === 'full'
        ? '本次已覆盖搜索范围内的全部候选'
        : '本次只核价了部分候选（见 searchScope），因此不能断言"全店不存在符合条件的组合"',
  };
}
