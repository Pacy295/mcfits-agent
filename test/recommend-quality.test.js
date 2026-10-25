/**
 * 推荐质量定点测试（离线，注入假依赖）：针对赛后实测的三个真实问题。
 *
 * 1) 高蛋白「一顿饭」不能用单份小食（如一份油条）代表，蛋白必须真正起作用；
 * 2) 日常点餐的目标价格区间必须参与排序，组成要求不能被忽略；
 * 3) 「饮料最好无糖」只能按名称证据满足，没有证据时如实标注无法核实；
 * 4) 方案数量不强制凑满。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { recommend } from '../src/optimize/engine.js';

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

const PRICES = {
  'C1': 850, // 测试油条（单件）
  'M1': 2100, // 测试牛堡 33g
  'M2': 3200, // 测试双层牛堡 42g
  'S1': 1200,
  'D1': 500, // 测试红茶
  'D2': 500, // 无糖可乐
};

function makePool({ withSugarFree = true } = {}) {
  const singles = {
    main: [
      { code: 'C1', name: '测试油条', role: 'main', nutrition: nut(202, 5), priceKey: 'single:C1' },
      { code: 'M1', name: '测试牛堡', role: 'main', nutrition: nut(570, 33), priceKey: 'single:M1' },
      { code: 'M2', name: '测试双层牛堡', role: 'main', nutrition: nut(600, 42), priceKey: 'single:M2' },
    ],
    side: [{ code: 'S1', name: '测试薯条', role: 'side', nutrition: nut(289, 4), priceKey: 'single:S1' }],
    drink: [
      { code: 'D1', name: '测试红茶', role: 'drink', nutrition: nut(147, 0), priceKey: 'single:D1' },
      ...(withSugarFree ? [{ code: 'D2', name: '无糖可乐', role: 'drink', nutrition: nut(0, 0), priceKey: 'single:D2' }] : []),
    ],
    dessert: [],
  };
  const nutritionOf = (code) => {
    const all = [...singles.main, ...singles.side, ...singles.drink];
    return all.find((x) => x.code === code)?.nutrition ?? null;
  };
  return { storeCode: 'TEST', singles, meals: [], nutritionOf, stats: { nutritionUnknownExcluded: 0 } };
}

function makeDeps(pool) {
  const priceOf = (code) => PRICES[code];
  return {
    buildPool: async () => pool,
    priceProducts: async (items) => {
      const map = new Map();
      for (const it of items) {
        const fen = priceOf(it.code);
        if (fen != null) map.set(`${it.kind}:${it.code}`, { fen, checkedAt: Date.now(), traceId: 't', mcpDatetime: 't' });
      }
      return map;
    },
    priceCandidate: async (cand) => ({
      status: 'valued',
      priceFen: cand.components.reduce((a, c) => a + (priceOf(c.code) || 0), 0),
      checkedAt: Date.now(),
      traceId: 't',
      mcpDatetime: 't',
    }),
  };
}

const baseConstraints = (over = {}) => ({
  budgetMax: null,
  budgetMin: null,
  caloriesMax: null,
  caloriesMin: null,
  proteinMin: null,
  budgetIntent: null,
  preferences: null,
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

test('高蛋白「一顿饭」：不允许单份油条进入代表方案，首位必须是蛋白最高的一餐', async () => {
  const raw = '刚结束力量训练，想吃一顿高蛋白的麦当劳，预算控制在40元以内，总热量不超过750大卡';
  const c = baseConstraints({
    budgetMax: 40,
    caloriesMax: 750,
    objectives: [{ metric: 'protein', direction: 'max' }],
    raw,
  });
  const r = await recommend(c, { maxVerify: 20, rawText: raw }, makeDeps(makePool()));

  assert.equal(r.status, 'ok');
  assert.ok(r.plans.length >= 1);
  // 每一套都必须是"一顿饭"（≥2 件），且蛋白不能明显掉队
  for (const p of r.plans) assert.ok(p.components.length >= 2, `不应出现单件方案：${p.productName}`);
  assert.equal(r.plans[0].nutrition.protein, 42, '首位应是蛋白最高的可行方案');
  const best = Math.max(...r.plans.map((p) => p.nutrition.protein));
  for (const p of r.plans) assert.ok(p.nutrition.protein >= best * 0.4, `蛋白 ${p.nutrition.protein}g 明显偏离主目标`);
  assert.ok(!r.plans.some((p) => p.components.some((x) => x.code === 'C1') && p.components.length === 1));
  assert.equal(r.selection.mealOnly, true);
});

test('日常点餐：35–45 区间参与排序，主推落在区间内且组成完整', async () => {
  const raw = '现在有点饿，想吃一顿有主食、有饮料的套餐，预算35到45元，不太喜欢油腻的食物';
  const c = baseConstraints({
    budgetMin: 35,
    budgetMax: 45,
    budgetIntent: 'range',
    requiredCategories: ['main', 'drink'],
    preferences: { avoidOily: true },
    raw,
  });
  const r = await recommend(c, { maxVerify: 20, rawText: raw }, makeDeps(makePool()));

  assert.equal(r.status, 'ok');
  const primary = r.plans[0];
  assert.ok(primary.price.fen >= 3500 && primary.price.fen <= 4500, `主推应落在 35–45：实际 ¥${primary.price.fen / 100}`);
  assert.ok(primary.components.some((x) => x.code === 'D1' || x.code === 'D2'), '必须包含饮料');
  assert.ok(primary.components.length >= 2);
  assert.ok((primary.daily?.reasons || []).some((t) => t.includes('落在你说的')), '理由里必须说明价位命中');
});

test('无糖偏好：只有名称写明的饮品才算无糖，并实际优先', async () => {
  const raw = '想吃一顿有主食有饮料的套餐，饮料最好无糖，预算35到45元';
  const c = baseConstraints({
    budgetMin: 35,
    budgetMax: 45,
    budgetIntent: 'range',
    requiredCategories: ['main', 'drink'],
    preferences: { sugarFree: true },
    raw,
  });
  const r = await recommend(c, { maxVerify: 20, rawText: raw }, makeDeps(makePool({ withSugarFree: true })));
  assert.equal(r.status, 'ok');
  const primary = r.plans[0];
  assert.ok(primary.components.some((x) => x.code === 'D2'), '应优先名称写明无糖的饮品');
  assert.ok((primary.daily?.reasons || []).some((t) => t.includes('无糖')), '理由里要说明是无糖证据');
  assert.equal(r.selection.sugarFree.verified, true);
});

test('无糖偏好：菜单没有无糖标识时必须如实说无法核实，不得冒充', async () => {
  const raw = '想吃一顿有主食有饮料的套餐，饮料最好无糖，预算35到45元';
  const c = baseConstraints({
    budgetMin: 35,
    budgetMax: 45,
    budgetIntent: 'range',
    requiredCategories: ['main', 'drink'],
    preferences: { sugarFree: true },
    raw,
  });
  const r = await recommend(c, { maxVerify: 20, rawText: raw }, makeDeps(makePool({ withSugarFree: false })));
  assert.equal(r.status, 'ok');
  assert.equal(r.selection.sugarFree.verified, false);
  assert.match(r.selection.note, /无法核实/);
  const cautions = r.plans[0].daily?.cautions || [];
  assert.ok(cautions.some((t) => /含糖量|无糖/.test(t)), '必须提示含糖量未核实');
});

test('方案数量不强制凑满：只有一两套有意义时就少给', async () => {
  const raw = '刚结束力量训练，想吃一顿高蛋白的麦当劳，预算控制在30元以内，总热量不超过750大卡';
  const c = baseConstraints({
    budgetMax: 30,
    caloriesMax: 750,
    objectives: [{ metric: 'protein', direction: 'max' }],
    raw,
  });
  const r = await recommend(c, { maxVerify: 20, rawText: raw }, makeDeps(makePool()));
  assert.equal(r.status, 'ok');
  assert.ok(r.plans.length >= 1 && r.plans.length <= 2, `不应凑满 4 套，实际 ${r.plans.length}`);
  assert.equal(r.plans[0].nutrition.protein, 33);
});
