/**
 * 纯函数单元测试（不联网）。真实数据链路的验收在 scripts/verify-stage1.js。
 * 运行: node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseNutritionTable } from '../src/data/nutrition-table.js';
import { parseDiffPrice, normalizeRounds } from '../src/data/catalog.js';
import { buildNutritionIndex, matchNutrition, toNutritionStatus } from '../src/data/nutrition-matcher.js';
import { looseKey, strictKey } from '../src/data/normalize.js';
import { composeNutrition, defaultCombo, describeMeal, enumerateCombos } from '../src/data/meal.js';

const FIXTURE_TEXT = `[4]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
  麦香鱼,null,1359,325,16,13,35,556,99
  中薯条,null,1210,289,4,12,38,165,18
  可乐中杯,null,616,147,0,0,36,0,10
  纯牛奶（盒装）,null,540,129,7,7,11,73,220`;

test('营养表解析：列名、数值、null 处理', () => {
  const { rows, declaredCount, issues } = parseNutritionTable(FIXTURE_TEXT);
  assert.equal(declaredCount, 4);
  assert.equal(rows.length, 4);
  assert.equal(issues.length, 0);
  assert.equal(rows[0].productName, '麦香鱼');
  assert.equal(rows[0].energyKcal, 325);
  assert.equal(rows[0].nutritionDescription, null);
});

test('名称规范化：全半角/空格/标点差异归一，但规格描述必须保留', () => {
  assert.equal(strictKey('纯牛奶(盒装)'), strictKey('纯牛奶（盒装）'));
  assert.equal(strictKey('100% 苹果汁(盒装)'), strictKey('100%苹果汁(盒装)'));
  assert.equal(looseKey('麦辣鸡翅2块'), looseKey('麦辣鸡翅-2块'));
  // 规格不同不能被归一掉
  assert.notEqual(strictKey('可乐中杯'), strictKey('可乐大杯'));
  assert.notEqual(looseKey('可乐中杯'), looseKey('可乐大杯'));
  // 口味描述不同不能被归一掉
  assert.notEqual(looseKey('那么大鸡排（椒盐风味）'), looseKey('那么大鸡排'));
});

test('匹配：精确命中 / 标点级命中 / 多候选拒绝自动匹配', () => {
  const { rows } = parseNutritionTable(FIXTURE_TEXT);
  const index = buildNutritionIndex(rows);

  const exact = matchNutrition('麦香鱼', index);
  assert.equal(exact.status, 'matched_exact');
  assert.equal(exact.entry.energyKcal, 325);

  const paren = matchNutrition('纯牛奶(盒装)', index);
  assert.equal(paren.status, 'matched_exact');

  // 「可乐」无规格 → 必须 ambiguous，不允许猜成中杯
  const amb = matchNutrition('可乐中杯2', index);
  assert.equal(amb.status, 'ambiguous');
  assert.equal(amb.entry, null);

  const none = matchNutrition('完全不存在的商品', index);
  assert.equal(none.status, 'unmatched');
});

test('未知营养一律 null，不能是 0', () => {
  const nut = toNutritionStatus({ status: 'unmatched', method: 'L5', candidates: [], note: null }, null);
  assert.equal(nut.status, 'unknown');
  assert.equal(nut.energyKcal, null);
  assert.notEqual(nut.energyKcal, 0);
});

test('diffPrice 解析：正负与小数', () => {
  assert.equal(parseDiffPrice('+ ¥0'), 0);
  assert.equal(parseDiffPrice('+ ¥2'), 200);
  assert.equal(parseDiffPrice('- ¥1.5'), -150);
  assert.equal(parseDiffPrice('+¥3.5'), 350);
  assert.equal(parseDiffPrice(null), null);
});

test('composeNutrition：全已知求和 / 有未知则 partial 且不给总量', () => {
  const official = (kcal, p) => ({ status: 'official', energyKcal: kcal, protein: p, fat: 1, carbohydrate: 2, sodium: 3, calcium: 4 });
  const all = composeNutrition([
    { code: '1', name: 'A', quantity: 1, nutrition: official(325, 16) },
    { code: '2', name: 'B', quantity: 1, nutrition: official(289, 4) },
    { code: '3', name: 'C', quantity: 1, nutrition: official(147, 0) },
  ]);
  assert.equal(all.status, 'derived_sum');
  assert.equal(all.totals.energyKcal, 761);
  assert.equal(all.totals.protein, 20);

  const partial = composeNutrition([
    { code: '1', name: 'A', quantity: 1, nutrition: official(325, 16) },
    { code: '9', name: 'X', quantity: 1, nutrition: { status: 'unknown', energyKcal: null } },
  ]);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.totals, null, '有未知组件时不得输出总量');
  assert.equal(partial.knownSubtotal.energyKcal, 325);
  assert.equal(partial.unknownComponents.length, 1);
});

test('composeNutrition：数量倍乘', () => {
  const nut = { status: 'official', energyKcal: 100, protein: 10, fat: 1, carbohydrate: 1, sodium: 1, calcium: 1 };
  const res = composeNutrition([{ code: '1', name: 'A', quantity: 2, nutrition: nut }]);
  assert.equal(res.totals.energyKcal, 200);
  assert.equal(res.totals.protein, 20);
});

test('套餐组合枚举：笛卡尔积数量正确且不重复', () => {
  const rounds = normalizeRounds([
    { id: 1, name: '主餐', quantity: 1, choices: [{ code: '1600', name: '麦香鱼', isDefault: 1, diffPrice: '+ ¥0' }] },
    {
      id: 2,
      name: '小食',
      quantity: 1,
      choices: [
        { code: '4810', name: '中薯条', isDefault: 1, diffPrice: '+ ¥0' },
        { code: '4820', name: '大薯条', diffPrice: '+ ¥2' },
      ],
    },
    {
      id: 3,
      name: '饮料',
      quantity: 1,
      choices: [
        { code: '3050', name: '可乐中杯', isDefault: 1, diffPrice: '+ ¥0' },
        { code: '3100', name: '可乐大杯', diffPrice: '+ ¥2' },
        { code: '3071', name: '无糖可乐中杯', diffPrice: '+ ¥0' },
      ],
    },
  ]);
  const desc = describeMeal(rounds);
  assert.equal(desc.totalCombos, 6);
  const { combos } = enumerateCombos(rounds);
  assert.equal(combos.length, 6);
  const keys = new Set(combos.map((c) => c.map((x) => x.code).join('-')));
  assert.equal(keys.size, 6);

  assert.deepEqual(
    defaultCombo(rounds).map((c) => c.code),
    ['1600', '4810', '3050'],
  );
});

test('套餐组合枚举：超限时截断并标记', () => {
  const rounds = normalizeRounds([
    { id: 1, name: 'r1', choices: Array.from({ length: 50 }, (_, i) => ({ code: `a${i}`, name: `a${i}` })) },
    { id: 2, name: 'r2', choices: Array.from({ length: 50 }, (_, i) => ({ code: `b${i}`, name: `b${i}` })) },
  ]);
  const res = enumerateCombos(rounds, { limit: 100 });
  assert.equal(res.truncated, true);
  assert.ok(res.combos.length <= 200);
});
