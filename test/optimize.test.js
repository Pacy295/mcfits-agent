/**
 * 优化引擎纯逻辑测试：用注入的假依赖（不联网、不调 MCP）。
 * 对应验收场景：C（非支配保留）/ D（被支配剔除）/ F（缺营养不按 0）/ G（未核价不得宣称满足预算）/ H（非法配置不入方案）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { recommend, checkHard } from '../src/optimize/engine.js';
import { generateMealCandidates, dedupeByContent, generateSingleCandidates } from '../src/optimize/candidates.js';
import { paretoFront, dominates, buildDimensions } from '../src/optimize/objectives.js';
import { comparePlans } from '../src/optimize/compare.js';
import { normalizeRounds } from '../src/data/catalog.js';

const nut = (kcal, protein, extra = {}) => ({
  status: 'official',
  energyKcal: kcal,
  protein,
  fat: extra.fat ?? 10,
  carbohydrate: extra.carbohydrate ?? 50,
  sodium: 500,
  calcium: 100,
  matchMethod: 'test',
});

function makePool() {
  const singles = {
    main: [
      { code: 'M1', name: '测试牛肉堡', role: 'main', nutrition: nut(500, 20), priceKey: 'single:M1' },
      { code: 'M2', name: '测试双层堡', role: 'main', nutrition: nut(700, 40), priceKey: 'single:M2' },
      { code: 'M3', name: '测试鸡肉堡', role: 'main', nutrition: nut(650, 18), priceKey: 'single:M3' },
      { code: 'M9', name: '新品堡', role: 'main', nutrition: { status: 'unknown', energyKcal: null, protein: null }, priceKey: 'single:M9' },
    ],
    side: [{ code: 'S1', name: '测试薯条', role: 'side', nutrition: nut(289, 4), priceKey: 'single:S1' }],
    drink: [{ code: 'D1', name: '测试可乐', role: 'drink', nutrition: nut(147, 0), priceKey: 'single:D1' }],
    dessert: [{ code: 'DS1', name: '测试派', role: 'dessert', nutrition: nut(221, 2), priceKey: 'single:DS1' }],
  };
  const rounds = normalizeRounds([
    {
      id: 1,
      name: '主餐',
      quantity: 1,
      choices: [{ code: 'M1', name: '测试牛肉堡', isDefault: 1, diffPrice: '+ ¥0' }],
    },
    {
      id: 2,
      name: '小食',
      quantity: 1,
      choices: [
        { code: 'S1', name: '测试薯条', isDefault: 1, diffPrice: '+ ¥0' },
        { code: 'DS1', name: '测试派', diffPrice: '+ ¥2' },
      ],
    },
    {
      id: 3,
      name: '饮料',
      quantity: 1,
      choices: [
        { code: 'D1', name: '测试可乐', isDefault: 1, diffPrice: '+ ¥0' },
        { code: 'D9', name: '无营养饮料', diffPrice: '+ ¥0' },
      ],
    },
  ]);
  const meals = [{ code: 'CM1', name: '测试三件套', role: 'main', rounds, supportModify: false }];
  const nutritionOf = (code) => {
    if (code === 'M1') return nut(500, 20);
    if (code === 'S1') return nut(289, 4);
    if (code === 'D1') return nut(147, 0);
    if (code === 'DS1') return nut(221, 2);
    return null; // D9 无营养
  };
  return { storeCode: 'TEST', singles, meals, nutritionOf, stats: { nutritionUnknownExcluded: 1 } };
}

const PRICES = {
  'single:M1': 1500,
  'single:M2': 3500,
  'single:M3': 4000, // M3 比 M1 更贵、蛋白更低 → 被 M1 支配
  'single:S1': 1000,
  'single:D1': 600,
  'single:DS1': 800,
  'meal:CM1': 2000,
};

function makeDeps(pool, { failCodes = [] } = {}) {
  return {
    buildPool: async () => pool,
    priceProducts: async (items) => {
      const map = new Map();
      for (const it of items) {
        const key = `${it.kind}:${it.code}`;
        const fen = PRICES[key];
        if (fen != null) map.set(key, { fen, checkedAt: Date.now(), traceId: 't', mcpDatetime: 't' });
      }
      return map;
    },
    priceCandidate: async (cand) => {
      if (cand.components.some((c) => failCodes.includes(c.code))) {
        return { status: 'failed', error: { message: '模拟核价失败（商品不可售）' } };
      }
      if (cand.kind === 'meal') {
        return { status: 'valued', priceFen: PRICES[`meal:${cand.productCode}`] + cand.priceDeltaFen, checkedAt: Date.now(), traceId: 't-meal', mcpDatetime: 't' };
      }
      const sum = cand.components.reduce((a, c) => a + (PRICES[`single:${c.code}`] || 0), 0);
      return { status: 'valued', priceFen: sum, checkedAt: Date.now(), traceId: 't-single', mcpDatetime: 't' };
    },
  };
}

const baseConstraints = (over = {}) => ({
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

test('场景C：一个更便宜、一个蛋白更高，两套都必须保留', async () => {
  const pool = makePool();
  const r = await recommend(baseConstraints({ budgetMax: 40, objectives: [{ metric: 'protein', direction: 'max' }] }), { maxVerify: 20 }, makeDeps(pool));
  assert.equal(r.status, 'ok');
  const names = r.plans.map((p) => p.productName);
  const hasCheap = r.plans.some((p) => p.price.fen === 1500);
  const hasProtein = r.plans.some((p) => p.nutrition.protein === 40);
  assert.ok(hasCheap, `应保留便宜方案，实际：${JSON.stringify(names)}`);
  assert.ok(hasProtein, `应保留高蛋白方案，实际：${JSON.stringify(names)}`);
  assert.ok(r.plans.length >= 2);
  // 非支配性：任意两个方案互相不支配
  const dims = buildDimensions({ objectives: [{ metric: 'protein', direction: 'max' }] });
  for (const a of r.plans) {
    for (const b of r.plans) {
      if (a === b) continue;
      assert.equal(dominates(a, b, dims), false, `${a.id} 不应支配 ${b.id}`);
    }
  }
});

test('场景D：被支配的方案必须被剔除', async () => {
  const pool = makePool();
  // M3：¥40 / 18g，被 M1（¥15 / 20g）完全支配
  const r = await recommend(baseConstraints({ budgetMax: 45, objectives: [{ metric: 'protein', direction: 'max' }] }), { maxVerify: 30 }, makeDeps(pool));
  assert.equal(r.status, 'ok');
  const picked = r.plans.map((p) => p.components[0].code);
  assert.ok(!picked.includes('M3'), `被支配的 M3 不应出现，实际：${JSON.stringify(picked)}`);
  // 单测支配关系
  const dims = buildDimensions({ objectives: [{ metric: 'protein', direction: 'max' }] });
  const cheap = { nutrition: { energyKcal: 500, protein: 20 }, priced: { priceFen: 1500 } };
  const worse = { nutrition: { energyKcal: 650, protein: 18 }, priced: { priceFen: 4000 } };
  assert.equal(dominates(cheap, worse, dims), true);
  assert.deepEqual(paretoFront([cheap, worse], dims), [cheap]);
});

test('场景F：缺营养数据的商品不能按 0 参与优化', async () => {
  const pool = makePool();
  const r = await recommend(baseConstraints({ budgetMax: 40 }), { maxVerify: 30 }, makeDeps(pool));
  const all = r.plans.flatMap((p) => p.components.map((c) => c.code));
  assert.ok(!all.includes('M9'), '缺营养的商品不得出现在方案里');
  assert.ok(!all.includes('D9'), '缺营养的组件不得出现在方案里');
  for (const p of r.plans) {
    assert.ok(Number.isFinite(p.nutrition.energyKcal) && p.nutrition.energyKcal > 0);
  }
  // 直接验证候选生成阶段就把它挡掉
  const cands = generateSingleCandidates(pool.singles, {});
  assert.ok(cands.every((c) => !c.components.some((x) => x.code === 'M9')));
});

test('场景G：核价失败的候选不得出现在方案里，也不得被算作满足预算', async () => {
  const pool = makePool();
  const deps = makeDeps(pool, { failCodes: ['D1'] });
  const r = await recommend(baseConstraints({ budgetMax: 40, requiredCategories: ['drink'] }), { maxVerify: 20 }, deps);
  assert.equal(r.status, 'infeasible', '唯一带饮料的组合核价失败，应判定不可行而不是假装满足');
  assert.equal(r.plans.length, 0);
  assert.ok(r.dataQuality.pricedFailed.length > 0);
  assert.ok(r.dataQuality.pricedFailed.every((x) => x.error.includes('失败')));
});

test('场景H：套餐候选只能来自 rounds 的合法选项', () => {
  const pool = makePool();
  const { candidates } = generateMealCandidates(pool.meals, pool.nutritionOf, { perMealKeep: 10, choiceLimitPerRound: 5 });
  assert.ok(candidates.length > 0);
  const legal = new Set(['M1', 'S1', 'DS1', 'D1', 'D9']);
  for (const c of candidates) {
    for (const comp of c.components) {
      assert.ok(legal.has(comp.code), `非法组件 ${comp.code} 进入了候选`);
    }
    assert.equal(c.combo.length, 3, '每个 round 必须恰选一项');
  }
  // 含无营养组件的组合（D9）必须被剔除
  assert.ok(candidates.every((c) => !c.components.some((x) => x.code === 'D9')));
  // 每轮的选项数量受 limit 约束
  assert.ok(candidates.length <= 10);
});

test('内容签名去重：同一份食物不重复推荐', () => {
  const cands = [
    { signature: 'a', contentSignature: 'M1x1|S1x1', kind: 'single', estimatedPriceFen: 2500, components: [{ code: 'M1' }, { code: 'S1' }] },
    { signature: 'b', contentSignature: 'M1x1|S1x1', kind: 'meal', estimatedPriceFen: 2000, components: [{ code: 'M1' }, { code: 'S1' }] },
    { signature: 'c', contentSignature: 'M2x1', kind: 'single', estimatedPriceFen: 3500, components: [{ code: 'M2' }] },
  ];
  const out = dedupeByContent(cands);
  assert.equal(out.length, 2);
  assert.equal(out.find((x) => x.contentSignature === 'M1x1|S1x1').signature, 'b', '保留更便宜的套餐形态');
});

test('只给预算的日常委托进入日常模式：主推+备选互不重复、解释非空', async () => {
  const pool = makePool();
  const r = await recommend(baseConstraints({ budgetMax: 40 }), { planCount: 4 }, makeDeps(pool));
  assert.equal(r.status, 'ok');
  assert.equal(r.selection.basis, 'daily', '无营养诉求 → 日常点餐模式');
  assert.equal(r.intent.mode, 'daily');
  assert.equal(r.intent.budget.intent, 'max');
  assert.ok(r.plans.length >= 2 && r.plans.length <= 3, '主推 1 套 + 至多 2 备选');
  const sigs = r.plans.map((p) => p.components.map((c) => c.code).sort().join('|'));
  assert.equal(new Set(sigs).size, sigs.length, '不应出现内容重复的方案');
  assert.equal(r.plans.filter((p) => p.isPrimary).length, 1, '恰有 1 个主推');
  assert.ok(r.plans[0].isPrimary, '第一套是主推');
  assert.ok(r.plans[0].daily.reasons.length > 0, '主推要有可读理由');
  assert.ok(r.plans.every((p) => p.price.fen <= 4000), '全部不超预算');
});

test('营养模式单一有效维度时用价格梯度补充差异化方案', async () => {
  const pool = makePool();
  const r = await recommend(baseConstraints({ proteinMin: 25 }), { planCount: 4 }, makeDeps(pool));
  assert.equal(r.status, 'ok');
  assert.equal(r.intent.mode, 'nutrition', '有蛋白质诉求 → 营养点餐模式');
  assert.equal(r.selection.basis, 'ladder');
  assert.ok(r.selection.strategy.includes('价格梯度'));
  const sigs = r.plans.map((p) => p.components.map((c) => c.code).sort().join('|'));
  assert.equal(new Set(sigs).size, sigs.length, '不应出现内容重复的方案');
});

test('预算判定用真实核价，而不是参考价', () => {
  const cand = { nutrition: { energyKcal: 500, protein: 20 }, priced: { priceFen: 4100 }, estimatedPriceFen: 3900 };
  const fails = checkHard(cand, baseConstraints({ budgetMax: 40 }), { requirePrice: true });
  assert.equal(fails.length, 1);
  assert.equal(fails[0].key, 'budgetMax');
  // 未核价 → 直接不通过
  const noPrice = checkHard({ nutrition: { energyKcal: 500, protein: 20 } }, baseConstraints({ budgetMax: 40 }), { requirePrice: true });
  assert.equal(noPrice[0].key, 'price');
});

test('不可行分析给出量化差距与单项放宽结果', async () => {
  const pool = makePool();
  const r = await recommend(baseConstraints({ budgetMax: 5, proteinMin: 35 }), { maxVerify: 10 }, makeDeps(pool));
  assert.equal(r.status, 'infeasible');
  assert.ok(r.analysis.relaxations.length > 0);
  const relaxProtein = r.analysis.relaxations.find((x) => x.constraint === 'proteinMin');
  assert.ok(relaxProtein, '应包含「放宽蛋白质」的量化结果');
  assert.ok(r.analysis.closest.length > 0);
  for (const c of r.analysis.closest) {
    assert.ok(c.violations.length > 0, '近似方案必须标注违反了哪些要求');
    assert.ok(c.violations.some((v) => v.detail));
  }
  assert.ok(r.analysis.scopeNote.includes('不能断言'));
});

test('方案对比：差值来自真实数值相减', () => {
  const a = { id: 'P1', productName: 'A', price: { fen: 3200 }, nutrition: { energyKcal: 600, protein: 28 } };
  const b = { id: 'P2', productName: 'B', price: { fen: 3600 }, nutrition: { energyKcal: 650, protein: 35 } };
  const r = comparePlans(a, b);
  assert.equal(r.delta.priceYuan, 4);
  assert.equal(r.delta.protein, 7);
  assert.equal(r.delta.kcal, 50);
  assert.equal(r.summary, 'B 比 A 多花 ¥4.00，蛋白质增加 7.0 g，热量增加 50 kcal，每多花 ¥1 换到 1.8 g 蛋白质');
  assert.ok(r.betterOn.includes('B 蛋白质更高'));
});
