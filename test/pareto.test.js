/**
 * 帕累托专项测试（回归本轮修复的两个缺陷）：
 *  1. valueOf 只认内部候选结构 → 对 API 方案对象取值全为 null → dominates 永远 false → "互不支配"空断言通过。
 *  2. 价格单维时严格前沿只有最低价，差异化推荐必须与严格非支配解分开标注。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { dominates, paretoFront, buildDimensions, valueOf } from '../src/optimize/objectives.js';
import { priceFenOf, nutritionOf, snapshotOf, deltaOf } from '../src/optimize/shape.js';
import { recommend } from '../src/optimize/engine.js';
import { comparePlans } from '../src/optimize/compare.js';

/* ---------------- 取值层：两种结构必须一致 ---------------- */

const CAND = { priced: { priceFen: 3150, checkedAt: 1, traceId: 'c1' }, nutrition: { energyKcal: 696, protein: 32, fat: 10, carbohydrate: 50 }, prefScore: 0 };
const PLAN = { price: { fen: 3150, checkedAt: 1, traceId: 'c1' }, nutrition: { energyKcal: 696, protein: 32, fat: 10, carbohydrate: 50 }, prefScore: 0 };

test('shape：候选结构与方案结构取到同一组数值', () => {
  assert.equal(priceFenOf(CAND), 3150);
  assert.equal(priceFenOf(PLAN), 3150, '方案结构的价格曾取不到值，这是支配判定失效的根因');
  assert.deepEqual(nutritionOf(CAND), nutritionOf(PLAN));
  assert.deepEqual(snapshotOf(CAND), snapshotOf(PLAN));
  assert.equal(valueOf(CAND, 'priceFen'), valueOf(PLAN, 'priceFen'));
  assert.equal(valueOf(CAND, 'protein'), valueOf(PLAN, 'protein'));
});

test('shape：价格缺失返回 null，不用 0 兜底', () => {
  assert.equal(priceFenOf({ nutrition: {} }), null);
  assert.equal(deltaOf({ price: { fen: null } }, { price: { fen: 100 } }).priceFen, null);
});

/* ---------------- 支配判定本身 ---------------- */

const priceOnly = () => buildDimensions({ objectives: [] });

test('支配：价格单维下贵的被便宜支配，同价互不支配', () => {
  const dims = priceOnly();
  const a = { price: { fen: 3150 } };
  const b = { price: { fen: 3850 } };
  assert.equal(dominates(a, b, dims), true);
  assert.equal(dominates(b, a, dims), false);
  assert.equal(dominates({ price: { fen: 3150 } }, { price: { fen: 3150 } }, dims), false, '价格相同不存在支配');
});

test('支配：多维时"各有优势"互不支配', () => {
  const dims = buildDimensions({ objectives: [{ metric: 'protein', direction: 'max' }] });
  const cheap = { price: { fen: 3150 }, nutrition: { protein: 32 } };
  const protein = { price: { fen: 3850 }, nutrition: { protein: 44 } };
  assert.equal(dominates(cheap, protein, dims), false);
  assert.equal(dominates(protein, cheap, dims), false);
  // 又贵又低蛋白则被支配
  const worse = { price: { fen: 4000 }, nutrition: { protein: 31 } };
  assert.equal(dominates(cheap, worse, dims), true);
});

test('支配：维度为空时不产生支配关系（不误判）', () => {
  assert.equal(dominates({ price: { fen: 1 } }, { price: { fen: 2 } }, []), false);
});

test('严格前沿：价格单维只包含最低价的那一批', () => {
  const dims = priceOnly();
  const items = [3150, 3850, 3500, 3350].map((fen, i) => ({ id: `P${i + 1}`, price: { fen } }));
  const front = paretoFront(items, dims);
  assert.equal(front.length, 1);
  assert.equal(front[0].price.fen, 3150);
  // 同价并列时都进前沿
  const ties = paretoFront([{ price: { fen: 3150 } }, { price: { fen: 3150 } }, { price: { fen: 3850 } }], dims);
  assert.equal(ties.length, 2);
});

/* ---------------- 引擎：严格非支配 vs 差异化补充 ---------------- */

const nut = (kcal, protein) => ({ status: 'official', energyKcal: kcal, protein, fat: 10, carbohydrate: 50, sodium: 500, calcium: 100, matchMethod: 'test' });

function makePool() {
  return {
    storeCode: 'TEST',
    meals: [],
    singles: {
      main: [
        { code: 'M1', name: '测试牛肉堡', role: 'main', nutrition: nut(500, 20), priceKey: 'single:M1' },
        { code: 'M2', name: '测试双层堡', role: 'main', nutrition: nut(700, 40), priceKey: 'single:M2' },
        { code: 'M3', name: '测试鸡肉堡', role: 'main', nutrition: nut(620, 28), priceKey: 'single:M3' },
      ],
      side: [{ code: 'S1', name: '测试薯条', role: 'side', nutrition: nut(289, 4), priceKey: 'single:S1' }],
      drink: [{ code: 'D1', name: '测试可乐', role: 'drink', nutrition: nut(147, 0), priceKey: 'single:D1' }],
      dessert: [],
    },
    nutritionOf: () => null,
    stats: { nutritionUnknownExcluded: 0 },
  };
}
const PRICES = { 'single:M1': 1500, 'single:M2': 3500, 'single:M3': 2200, 'single:S1': 1000, 'single:D1': 600 };

function makeDeps(pool) {
  return {
    buildPool: async () => pool,
    priceProducts: async (items) => {
      const map = new Map();
      for (const it of items) {
        const fen = PRICES[`${it.kind}:${it.code}`];
        if (fen != null) map.set(`${it.kind}:${it.code}`, { fen, checkedAt: Date.now(), traceId: 't' });
      }
      return map;
    },
    priceCandidate: async (cand) => {
      const fen = cand.components.reduce((a, c) => a + (PRICES[`single:${c.code}`] || 0), 0);
      return { status: 'valued', priceFen: fen, checkedAt: Date.now(), traceId: `t-${cand.productCode}` };
    },
  };
}

const base = (over = {}) => ({
  budgetMax: null,
  caloriesMax: null,
  caloriesMin: null,
  proteinMin: null,
  preferredFoods: [],
  excludedFoods: [],
  dietaryRestrictions: [],
  requiredCategories: [],
  preferredCategories: [],
  objectives: [],
  hardConstraints: [],
  softPreferences: [],
  clarifications: [],
  raw: '',
  ...over,
});

test('只给蛋白质下限（不要求最大化）：严格非支配只有最低价方案，其余标为差异化补充', async () => {
  const r = await recommend(base({ proteinMin: 20 }), { maxVerify: 20, planCount: 4 }, makeDeps(makePool()));
  assert.equal(r.status, 'ok');
  assert.equal(r.selection.basis, 'ladder');
  assert.deepEqual(r.selection.dimensions.map((d) => d.key), ['priceFen'], '没有"高蛋白"倾向时不应把蛋白质作为维度');

  const dims = [{ key: 'priceFen', dir: 'min', label: '价格' }];
  const pts = r.plans.map((p) => ({ id: p.id, price: { fen: p.price.fen }, nutrition: p.nutrition }));

  // 独立重算：不读 p.pareto
  const recomputedNonDom = pts.filter((me) => !pts.some((o) => o.id !== me.id && dominates(o, me, dims))).map((x) => x.id);
  const declaredNonDom = r.plans.filter((p) => p.pareto.nonDominated).map((p) => p.id);
  assert.deepEqual(declaredNonDom, recomputedNonDom, '标注必须与独立重算一致');
  assert.equal(recomputedNonDom.length, 1, '价格单维应只有最低价方案非支配');
  assert.equal(r.plans.find((p) => p.id === recomputedNonDom[0]).price.fen, Math.min(...pts.map((x) => x.price.fen)));

  // 差异化方案必须给出真实支配者与正确差价
  const diversified = r.plans.filter((p) => p.pareto.nonDominated === false);
  assert.ok(diversified.length >= 1, '应保留差异化方案（产品原则：不能只给最低价）');
  for (const p of diversified) {
    assert.equal(p.pareto.label, '差异化补充');
    assert.ok(p.pareto.dominatedBy.length > 0, `${p.id} 应给出支配者`);
    for (const d of p.pareto.dominatedBy) {
      assert.equal(d.deltaFen, d.priceFen - p.price.fen);
      assert.ok(d.priceFen < p.price.fen, '支配者必须更便宜（价格单维）');
    }
  }
  assert.equal(r.selection.nonDominatedSelected + r.selection.diversifiedSelected, r.plans.length);
  assert.ok(r.selection.note.includes('差异化补充'), r.selection.note);
  assert.ok(r.selection.note.includes('严格非支配'));
});

test('有高蛋白倾向时：按价格+蛋白质双维筛，返回的方案全部是严格非支配', async () => {
  const r = await recommend(base({ budgetMax: 40, objectives: [{ metric: 'protein', direction: 'max' }] }), { maxVerify: 20, planCount: 4 }, makeDeps(makePool()));
  assert.equal(r.selection.basis, 'strict-front');
  assert.deepEqual(r.selection.dimensions.map((d) => d.key).sort(), ['priceFen', 'protein']);
  assert.ok(r.plans.length >= 2);
  assert.ok(r.plans.every((p) => p.pareto.nonDominated === true));
  assert.equal(r.selection.diversifiedSelected, 0);

  const dims = buildDimensions({ objectives: [{ metric: 'protein', direction: 'max' }] });
  const pts = r.plans.map((p) => ({ id: p.id, price: { fen: p.price.fen }, nutrition: p.nutrition }));
  for (const a of pts) for (const b of pts) {
    if (a.id === b.id) continue;
    assert.equal(dominates(a, b, dims), false, `${a.id} 不应支配 ${b.id}`);
  }
  assert.ok(r.selection.note.includes('严格非支配解'));
});

test('selection 的计数与逐方案标注自洽', async () => {
  const r = await recommend(base({ proteinMin: 20 }), { maxVerify: 20, planCount: 4 }, makeDeps(makePool()));
  const strict = r.plans.filter((p) => p.pareto.nonDominated).length;
  assert.equal(r.selection.nonDominatedSelected, strict);
  assert.equal(r.selection.strictParetoCheapestFen, Math.min(...r.plans.map((p) => p.price.fen)));
  assert.ok(r.selection.strictParetoSample.length > 0);
  assert.ok(r.selection.strictParetoSample.every((s) => s.priceFen === r.selection.strictParetoCheapestFen));
});

/* ---------------- 对比与方案同源 ---------------- */

test('对比数值与方案同源（价格/热量/蛋白/traceId）', async () => {
  const r = await recommend(base({ proteinMin: 20 }), { maxVerify: 20, planCount: 4 }, makeDeps(makePool()));
  const [a, b] = r.plans;
  const d = comparePlans(a, b);
  assert.equal(d.delta.priceFen, b.price.fen - a.price.fen);
  assert.equal(d.delta.protein, Math.round((b.nutrition.protein - a.nutrition.protein) * 10) / 10);
  assert.equal(d.delta.kcal, Math.round((b.nutrition.energyKcal - a.nutrition.energyKcal) * 10) / 10);
  assert.equal(d.a.priceFen, a.price.fen);
  assert.equal(d.a.kcal, a.nutrition.energyKcal);
  assert.equal(d.a.traceId, a.mcp.traceId);
  assert.equal(d.b.traceId, b.mcp.traceId);
});

/* ---------------- 不可行：预算差额算术 ---------------- */

test('不可行分析：超预算额必须等于 核价 − 预算（精确到分）', async () => {
  const BUDGET = 10;
  const r = await recommend(base({ budgetMax: BUDGET, proteinMin: 30 }), { maxVerify: 12 }, makeDeps(makePool()));
  assert.equal(r.status, 'infeasible');
  assert.ok(r.analysis.closest.length > 0);
  let checked = 0;
  for (const row of r.analysis.closest) {
    const v = row.violations.find((x) => x.key === 'budgetMax');
    if (!v) continue;
    checked += 1;
    assert.equal(v.excessFen, row.candidate.priceFen - BUDGET * 100);
    assert.ok(v.detail.includes(((row.candidate.priceFen - BUDGET * 100) / 100).toFixed(2)), `文案与算术不一致：${v.detail}`);
  }
  assert.ok(checked > 0, '至少应有一条带预算违反的近似方案');
});
