/**
 * 数值取值的唯一入口（single source of truth）。
 *
 * 背景：内部候选（candidate）与对外方案（plan）是两种结构：
 *   candidate: { priced:{priceFen,checkedAt,traceId}, nutrition:{energyKcal,...}, prefScore }
 *   plan:      { price:{fen,yuan,checkedAt,traceId}, nutrition:{energyKcal,...}, prefScore }
 * 之前 objectives.valueOf 只认 candidate，导致对 plan 做支配判定时取值全是 null，
 * dominates() 因"数据缺失"直接返回 false —— 于是"两两互不支配"变成永远成立的空断言。
 *
 * 所有需要读数值的地方（支配判定、方案对比、不可行分析、验收脚本）都必须走这里，
 * 不允许在各自模块里重新写一遍取值逻辑或重新推算数字。
 */

/** 价格（分）。优先已核价，其次对外字段，最后才是参考价。 */
export function priceFenOf(x) {
  if (!x) return null;
  if (Number.isFinite(x.priced?.priceFen)) return x.priced.priceFen;
  if (Number.isFinite(x.price?.fen)) return x.price.fen;
  if (Number.isFinite(x.priceFen)) return x.priceFen;
  if (Number.isFinite(x.estimatedPriceFen)) return x.estimatedPriceFen;
  return null;
}

/** 是否已核价（有真实价格与时间戳） */
export function isPriced(x) {
  if (!x) return false;
  if (Number.isFinite(x.priced?.priceFen) && x.priced?.checkedAt != null) return true;
  return x.price?.status === 'valued' && Number.isFinite(x.price?.fen);
}

const num = (v) => (Number.isFinite(v) ? v : null);

/** 营养四项。字段名在两种结构里一致（energyKcal / protein / fat / carbohydrate）。 */
export function nutritionOf(x) {
  const n = x?.nutrition || {};
  return {
    kcal: num(n.energyKcal ?? n.kcal),
    protein: num(n.protein),
    fat: num(n.fat),
    carbohydrate: num(n.carbohydrate),
    sodium: num(n.sodium),
    calcium: num(n.calcium),
  };
}

/** 偏好命中分（dominance 维度之一，两个结构都带 prefScore） */
export function prefScoreOf(x) {
  return Number.isFinite(x?.prefScore) ? x.prefScore : 0;
}

/** 统一快照：方案 / 候选 / 不可行近似方案都用这个结构对外，避免各写一套 */
export function snapshotOf(x, extra = {}) {
  const n = nutritionOf(x);
  return {
    id: x?.id ?? null,
    name: x?.productName ?? x?.name ?? null,
    kind: x?.kind ?? null,
    priceFen: priceFenOf(x),
    kcal: n.kcal,
    protein: n.protein,
    fat: n.fat,
    carbohydrate: n.carbohydrate,
    sodium: n.sodium,
    calcium: n.calcium,
    checkedAt: x?.priced?.checkedAt ?? x?.price?.checkedAt ?? null,
    traceId: x?.priced?.traceId ?? x?.mcp?.traceId ?? x?.price?.traceId ?? null,
    ...extra,
  };
}

/** 差值（B−A），两边任一缺失则为 null，绝不用 0 兜底 */
export function deltaOf(a, b) {
  const pa = priceFenOf(a);
  const pb = priceFenOf(b);
  const na = nutritionOf(a);
  const nb = nutritionOf(b);
  const d = (x, y) => (x == null || y == null ? null : Math.round((y - x) * 10) / 10);
  return { priceFen: pa == null || pb == null ? null : pb - pa, kcal: d(na.kcal, nb.kcal), protein: d(na.protein, nb.protein) };
}
