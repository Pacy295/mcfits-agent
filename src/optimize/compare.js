/**
 * 方案对比：所有差值都由真实数值相减得到，不让模型猜。
 * 取值统一走 shape.js（与支配判定、不可行分析同一份数据源），不在本模块重新推算。
 */
import { deltaOf, nutritionOf, priceFenOf, snapshotOf } from './shape.js';

const yuan = (fen) => (fen == null ? null : Number((fen / 100).toFixed(2)));

export function comparePlans(a, b) {
  if (!a || !b) throw new Error('compare 需要两个方案');
  const sa = snapshotOf(a);
  const sb = snapshotOf(b);
  const d = deltaOf(a, b);

  const delta = {
    priceFen: d.priceFen,
    priceYuan: d.priceFen == null ? null : yuan(d.priceFen),
    kcal: d.kcal,
    protein: d.protein,
  };

  const say = [];
  if (delta.priceYuan != null) {
    const v = Math.abs(delta.priceYuan).toFixed(2);
    say.push(delta.priceYuan === 0 ? '两者价格相同' : delta.priceYuan > 0 ? `B 比 A 多花 ¥${v}` : `B 比 A 省 ¥${v}`);
  }
  if (delta.protein != null) {
    const v = Math.abs(delta.protein).toFixed(1);
    say.push(delta.protein === 0 ? '蛋白质相同' : delta.protein > 0 ? `蛋白质增加 ${v} g` : `蛋白质减少 ${v} g`);
  }
  if (delta.kcal != null) {
    const v = Math.abs(delta.kcal).toFixed(0);
    say.push(delta.kcal === 0 ? '热量相同' : delta.kcal > 0 ? `热量增加 ${v} kcal` : `热量减少 ${v} kcal`);
  }
  if (delta.priceYuan && delta.protein) {
    const perYuan = delta.protein / delta.priceYuan;
    if (delta.priceYuan > 0 && perYuan > 0) say.push(`每多花 ¥1 换到 ${perYuan.toFixed(1)} g 蛋白质`);
  }

  const betterOn = [];
  if (delta.priceFen != null && delta.priceFen !== 0) betterOn.push(delta.priceFen < 0 ? 'B 更便宜' : 'A 更便宜');
  if (delta.protein != null && delta.protein !== 0) betterOn.push(delta.protein > 0 ? 'B 蛋白质更高' : 'A 蛋白质更高');
  if (delta.kcal != null && delta.kcal !== 0) betterOn.push(delta.kcal < 0 ? 'B 热量更低' : 'A 热量更低');

  return {
    a: { ...sa, priceYuan: yuan(sa.priceFen), nutrition: nutritionOf(a) },
    b: { ...sb, priceYuan: yuan(sb.priceFen), nutrition: nutritionOf(b) },
    delta,
    summary: say.join('，') || '两者在可比指标上没有差异',
    betterOn: [...new Set(betterOn)],
    // 明确出处：两边价格是否都是已核价
    provenance: {
      a: { priceFen: priceFenOf(a), traceId: sa.traceId, checkedAt: sa.checkedAt },
      b: { priceFen: priceFenOf(b), traceId: sb.traceId, checkedAt: sb.checkedAt },
    },
    note: '所有差值均为两个方案真实核价/官方营养值的算术差，不含任何推测',
  };
}
