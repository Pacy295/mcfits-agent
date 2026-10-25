/**
 * 多目标：维度定义与帕累托非支配筛选。
 *
 * 关键取舍（对应需求 3.3）：
 * - 价格永远是「越低越好」的维度（预算是硬约束，价格本身也是用户普遍在意的成本）。
 * - 蛋白质只有在用户明确「想高蛋白」时才作为「越高越好」的维度；
 *   若只是「蛋白质 ≥ 30g」这种阈值，达到即可，不参与支配比较，避免把达标但更便宜、
 *   或者达标但蛋白更高的方案互相淘汰。
 * - 热量只在用户明确「想降热量」时才作为「越低越好」；只有上限时不追最低热量。
 * - 口味只能用可验证的偏好命中数（prefScore），不用模型主观打分。
 */

/**
 * @param {object} constraints 规范化后的约束
 * @returns {Array<{key:string, dir:'min'|'max', label:string, source:string}>}
 */
export function buildDimensions(constraints) {
  const dims = [{ key: 'priceFen', dir: 'min', label: '价格', source: 'always' }];
  const objectives = constraints?.objectives || [];
  const has = (m, d) => objectives.some((o) => o.metric === m && o.direction === d);

  if (has('protein', 'max')) dims.push({ key: 'protein', dir: 'max', label: '蛋白质', source: 'objective' });
  if (has('calories', 'min')) dims.push({ key: 'calories', dir: 'min', label: '热量', source: 'objective' });
  if (has('taste', 'max') || (constraints?.preferredFoods || []).length || (constraints?.preferredCategories || []).length) {
    dims.push({ key: 'prefScore', dir: 'max', label: '偏好命中', source: 'soft-preference' });
  }
  return dims;
}

import { nutritionOf, prefScoreOf, priceFenOf } from './shape.js';

export function valueOf(candidate, dimKey) {
  switch (dimKey) {
    // 走 shape.js 统一取值：同时支持内部候选（priced.priceFen）与对外方案（price.fen）
    case 'priceFen':
      return priceFenOf(candidate);
    case 'protein':
      return nutritionOf(candidate).protein;
    case 'calories':
      return nutritionOf(candidate).kcal;
    case 'prefScore':
      return prefScoreOf(candidate);
    default:
      return null;
  }
}

/** a 是否支配 b（所有维度不劣，且至少一个维度严格更优） */
export function dominates(a, b, dims) {
  let comparable = 0;
  let strictlyBetter = false;
  for (const d of dims) {
    const va = valueOf(a, d.key);
    const vb = valueOf(b, d.key);
    if (va == null || vb == null) return false; // 数据缺失：不做支配判定
    comparable += 1;
    if (va === vb) continue;
    const better = d.dir === 'min' ? va < vb : va > vb;
    const worse = d.dir === 'min' ? va > vb : va < vb;
    if (worse) return false;
    if (better) strictlyBetter = true;
  }
  // 没有任何维度可比较（dims 为空）时不存在支配关系
  return comparable > 0 && strictlyBetter;
}

/** 返回非支配集合（保持输入顺序稳定） */
export function paretoFront(items, dims) {
  const arr = items.filter((c) => dims.every((d) => valueOf(c, d.key) != null));
  const out = [];
  for (const a of arr) {
    let dominated = false;
    for (const b of arr) {
      if (a === b) continue;
      if (dominates(b, a, dims)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) out.push(a);
  }
  return out;
}

/** 被谁支配（用于解释"为什么这个方案没被推荐"） */
export function dominatorsOf(target, items, dims) {
  return items.filter((b) => b !== target && dominates(b, target, dims));
}

/** 两方案差异（供 /api/compare 与方案对比文案使用，全部为真实数值相减） */
export function diffOf(a, b) {
  const pick = (c) => ({
    priceFen: valueOf(c, 'priceFen'),
    kcal: c.nutrition?.energyKcal ?? null,
    protein: c.nutrition?.protein ?? null,
    fat: c.nutrition?.fat ?? null,
    carb: c.nutrition?.carbohydrate ?? null,
  });
  const A = pick(a);
  const B = pick(b);
  const delta = {};
  for (const k of Object.keys(A)) {
    delta[k] = A[k] == null || B[k] == null ? null : Math.round((B[k] - A[k]) * 10) / 10;
  }
  return { a: { id: a.id, name: a.productName, ...A }, b: { id: b.id, name: b.productName, ...B }, delta };
}
