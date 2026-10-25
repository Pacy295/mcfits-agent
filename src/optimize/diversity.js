/**
 * 差异化选择：从非支配集合中挑出「彼此区别明显」的 2-4 个代表方案。
 *
 * 只做两件事：
 * 1. 去重：内容签名相同或只差一个配件的，视为近重复。
 * 2. 贪心最远点采样：先取主目标最优者，再反复取「离已选集合最远」的方案。
 *
 * 不强行凑数：候选差异不足时返回更少的方案（宁可 2 个也不拿 4 个近重复）。
 */
import { valueOf } from './objectives.js';

function jaccard(a, b) {
  const A = new Set((a.components || []).map((c) => c.code));
  const B = new Set((b.components || []).map((c) => c.code));
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function normalize(items, key) {
  const vals = items.map((c) => valueOf(c, key)).filter((v) => v != null);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  return (c) => {
    const v = valueOf(c, key);
    return v == null ? 0.5 : (v - min) / span;
  };
}

/** 两方案的差异度（0=几乎一样，1=完全不同） */
export function distance(a, b, dims) {
  const contentDiff = 1 - jaccard(a, b);
  let dimDiff = 0;
  let used = 0;
  for (const d of dims) {
    if (d.key === 'prefScore') continue;
    const va = valueOf(a, d.key);
    const vb = valueOf(b, d.key);
    if (va == null || vb == null) continue;
    const scale = Math.max(Math.abs(va), Math.abs(vb), 1);
    dimDiff += Math.abs(va - vb) / scale;
    used += 1;
  }
  const normDim = used ? dimDiff / used : 0;
  return 0.55 * contentDiff + 0.45 * normDim;
}

/**
 * @param {Array} front 非支配集合
 * @param {{k?:number, dims:Array, minDistance?:number, primary?:(a,b)=>number}} opts
 */
export function selectRepresentatives(front, opts) {
  const k = opts.k ?? 4;
  const dims = opts.dims || [];
  const minDistance = opts.minDistance ?? 0.12;
  const priorityKey = opts.priorityKey || 'priceFen';
  if (!front.length) return { selected: [], rejected: [], strategy: 'empty' };

  /**
   * 高蛋白场景：明显偏离主目标的点不进入代表方案（价格只能是比较维度，不能抢位）。
   * 默认允许低于最优蛋白 40% 以内，超过的视为"不是同一个目标"。
   */
  const bestProtein = Math.max(...front.map((c) => c.nutrition?.protein ?? 0));
  const proteinFloor = priorityKey === 'protein' ? bestProtein * (opts.proteinFloorRatio ?? 0.4) : -Infinity;
  const source = priorityKey === 'protein' ? front.filter((c) => (c.nutrition?.protein ?? 0) >= proteinFloor) : front;
  const frontPool = source.length ? source : front;

  // 1) 近重复去重（内容高度重合 → 只留一个）
  const pool = [];
  for (const c of [...frontPool].sort((a, b) => (a.priced?.priceFen ?? Infinity) - (b.priced?.priceFen ?? Infinity))) {
    const dup = pool.find((p) => 1 - jaccard(p, c) < 0.34); // 重合度 > 66%
    if (dup) {
      dup.mergedWith = dup.mergedWith || [];
      dup.mergedWith.push(c.signature);
      continue;
    }
    pool.push(c);
  }

  // 2) 首个：用户主目标最优（要高蛋白→蛋白最高；否则价格最低）
  const sorted = [...pool].sort((a, b) => {
    if (priorityKey !== 'priceFen') {
      const va = valueOf(a, priorityKey);
      const vb = valueOf(b, priorityKey);
      if (va !== vb) return (vb ?? 0) - (va ?? 0); // 主目标取最大（蛋白）
      return (valueOf(a, 'priceFen') ?? Infinity) - (valueOf(b, 'priceFen') ?? Infinity);
    }
    const pa = valueOf(a, 'priceFen');
    const pb = valueOf(b, 'priceFen');
    if (pa !== pb) return pa - pb;
    return (valueOf(b, 'protein') ?? 0) - (valueOf(a, 'protein') ?? 0);
  });
  const selected = [sorted[0]];

  // 3) 贪心最远点
  while (selected.length < k && selected.length < pool.length) {
    let best = null;
    let bestScore = -1;
    for (const cand of pool) {
      if (selected.includes(cand)) continue;
      const dmin = Math.min(...selected.map((s) => distance(cand, s, dims)));
      if (dmin > bestScore) {
        bestScore = dmin;
        best = cand;
      }
    }
    if (!best || bestScore < minDistance) break;
    selected.push(best);
  }

  return {
    selected,
    rest: pool.filter((c) => !selected.includes(c)),
    strategy: selected.length > 1 ? 'pareto + max-min 差异采样' : '单一非支配点',
    minDistanceUsed: minDistance,
  };
}

/**
 * 用户没有给明确优化倾向时的「价格梯度」选法：
 * 最便宜 / 蛋白性价比最高 / 蛋白最高（仍在预算内），保证 2-4 个方案各有理由。
 */
export function selectLadder(candidates, opts = {}) {
  const k = opts.k ?? 3;
  const dims = opts.dims ?? [];
  const front = opts.front ?? [];
  const pool = [...candidates].sort((a, b) => (a.priced?.priceFen ?? Infinity) - (b.priced?.priceFen ?? Infinity));
  if (!pool.length) return { selected: [], strategy: 'empty' };
  const priorityKey = opts.priorityKey || 'priceFen';
  const picks = [];
  const push = (c, reason) => {
    if (c && !picks.some((p) => p.c === c)) picks.push({ c, reason });
  };

  const byProtein = [...pool].sort((a, b) => (b.nutrition.protein ?? 0) - (a.nutrition.protein ?? 0));
  const bestProtein = byProtein[0]?.nutrition?.protein ?? 0;
  /**
   * 高蛋白场景：低于最优蛋白 70% 的候选不能用来"凑价位"。
   * 价格可以是比较维度，但不能让明显偏离主目标的单品占一个代表方案。
   */
  const proteinFloor = priorityKey === 'protein' ? bestProtein * (opts.proteinFloorRatio ?? 0.4) : -Infinity;
  const eligible = (c) => (c.nutrition?.protein ?? 0) >= proteinFloor;

  /**
   * 严格非支配解优先入选：它们本来就该被看到，不能因为"要凑差异化"被更贵的方案挤掉。
   * 但最多占一半名额，剩下的名额留给有其它优势的差异化方案。
   */
  const frontCap = Math.max(1, Math.ceil(k / 2));
  // 高蛋白场景先放主目标最优者，避免"最低价"抢到第一位
  if (priorityKey === 'protein') push(byProtein[0], '蛋白质最高');
  const frontSorted = [...front].sort((a, b) => {
    if (priorityKey !== 'priceFen') return (b.nutrition?.protein ?? 0) - (a.nutrition?.protein ?? 0);
    return (a.priced?.priceFen ?? Infinity) - (b.priced?.priceFen ?? Infinity);
  });
  for (const c of frontSorted) {
    if (picks.length >= (priorityKey === 'protein' ? frontCap + 1 : frontCap)) break;
    push(c, picks.length === 0 ? '严格非支配（最低价）' : '严格非支配（同价不同搭配）');
  }

  const byValue = [...pool]
    .filter((c) => (c.priced?.priceFen ?? 0) > 0 && eligible(c))
    .sort((a, b) => (b.nutrition.protein / (b.priced.priceFen / 100)) - (a.nutrition.protein / (a.priced.priceFen / 100)));
  push(byValue[0], '每元蛋白质最高');

  if (priorityKey !== 'protein') push(byProtein[0], '蛋白质最高');
  // 高蛋白场景的"最低价"也只在这个价位里蛋白质没掉队的候选中取
  push(pool.find(eligible), priorityKey === 'protein' ? '这个价位里蛋白质没掉队的最低价' : '价格最低');

  // 差异化补充：若前三项有重合导致数量不足，按最远点继续补，但必须与已选有明显差异
  const primary = (c) => c.components?.[0]?.code ?? c.productCode;
  while (picks.length < k) {
    let best = null;
    let bestScore = -1;
    for (const cand of pool) {
      if (picks.some((p) => p.c === cand)) continue;
      if (priorityKey === 'protein' && !eligible(cand)) continue; // 不为凑数引入偏离主目标的候选
      if (picks.some((p) => primary(p.c) === primary(cand))) continue; // 主商品不同，避免只是换配件的近重复
      const dmin = Math.min(...picks.map((p) => distance(cand, p.c, dims.length ? dims : [{ key: 'priceFen', dir: 'min' }])));
      if (dmin > bestScore) {
        bestScore = dmin;
        best = cand;
      }
    }
    if (!best || bestScore < 0.22) break;
    push(best, '与已选方案差异明显');
  }

  return { selected: picks.slice(0, k).map((p) => ({ ...p.c, pickReason: p.reason })), strategy: '价格梯度（用户未给明确优化倾向）' };
}
