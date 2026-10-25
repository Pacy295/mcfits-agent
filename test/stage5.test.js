/**
 * 第五阶段：真实用户语义理解与日常点餐模式（纯确定性，不联网）。
 * 对应验收场景：
 *  A 日常一句话点餐  B 不适/口味偏好不被问卷化  C 营养模式保留
 *  D 预算意图区分    E 不频繁反问            F 无法验证偏好只做尽力满足+诚实提示
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyBudget, preferenceHintsFromText, resolveIntent, intentChips, singleClarification, BUDGET_INTENT } from '../src/parse/intent.js';
import { parseByRules } from '../src/parse/rule-parser.js';
import { normalizeConstraints } from '../src/parse/schema.js';
import { hasSpicyMarker, drinkTemperature, scoreDaily, selectDailyPlans } from '../src/optimize/daily.js';

const SCENARIO_B = '最近肚子有点不舒服，不是很喜欢吃油的，也不喜欢吃辣的吃冰的，你给我推荐一个60元的套餐。';

/* ================= 意图层：预算意图 ================= */

test('D1「推荐一个60元的套餐」→ target_with_cap，不产生任何反问', () => {
  const b = classifyBudget('推荐一个60元的套餐。', 60);
  assert.equal(b.intent, BUDGET_INTENT.TARGET_WITH_CAP);
  assert.equal(b.target, 60);
  assert.equal(b.cap, 60);
  assert.equal(b.intentSource, 'raw-regex');
});

test('D2「60元以内」→ max；「60元左右」→ target；「越便宜越好」→ minimize', () => {
  assert.equal(classifyBudget('60元以内', 60).intent, BUDGET_INTENT.MAX);
  const t = classifyBudget('60元左右', 60);
  assert.equal(t.intent, BUDGET_INTENT.TARGET);
  assert.equal(t.cap, null, 'target 模式不生成硬上限');
  assert.equal(classifyBudget('越便宜越好', null).intent, BUDGET_INTENT.MINIMIZE);
  assert.equal(classifyBudget('随便来点吃的', null).intent, BUDGET_INTENT.UNSPECIFIED);
});

/* ================= 意图层：偏好分级 ================= */

test('B1「不是很喜欢吃油的/辣的/冰的」是软偏好，不是硬忌口', () => {
  const p = preferenceHintsFromText(SCENARIO_B, []);
  assert.equal(p.avoidSpicy, 'soft', '「不喜欢吃辣」= 软偏好');
  assert.equal(p.avoidIce, true);
  assert.equal(p.avoidOily, true);
  assert.equal(p.stomachContext, true);
});

test('B2「不能吃辣」才是 hard；两者强度不得混淆', () => {
  assert.equal(preferenceHintsFromText('我不能吃辣，一点辣都不行', []).avoidSpicy, 'hard');
  assert.equal(preferenceHintsFromText('微辣可以，别太辣', []).avoidSpicy, 'soft');
  assert.equal(preferenceHintsFromText('来个巨无霸', []).avoidSpicy, null);
});

/* ================= 意图层：模式与汇总 ================= */

test('A1 无营养诉求 → mode=daily；有蛋白质诉求 → mode=nutrition', () => {
  const daily = resolveIntent({ budgetMax: 60, objectives: [] }, SCENARIO_B);
  assert.equal(daily.mode, 'daily');
  const nutrition = resolveIntent({ budgetMax: 40, proteinMin: 30, objectives: [] }, '40元以内，蛋白质至少30g');
  assert.equal(nutrition.mode, 'nutrition');
});

test('B3 场景B汇总：预算60套餐价 + 三个偏好 + 背景，零反问', () => {
  const c = normalizeConstraints(parseByRules(SCENARIO_B), SCENARIO_B).constraints;
  assert.equal(c.budgetMax, 60, '规则路径也能抽出 60 元套餐价');
  const intent = resolveIntent(c, SCENARIO_B);
  assert.equal(intent.budget.intent, BUDGET_INTENT.TARGET_WITH_CAP);
  assert.equal(intent.preferences.avoidSpicy, 'soft');
  assert.equal(intent.preferences.avoidIce, true);
  assert.equal(intent.preferences.avoidOily, true);
  assert.equal(intent.preferences.stomachContext, true);
  assert.equal(singleClarification(c, intent), null, '不矛盾就绝不反问');
  const chips = intentChips(c, intent);
  assert.ok(chips.some((x) => x.includes('60')), `预算标签：${JSON.stringify(chips)}`);
  assert.ok(chips.some((x) => x.includes('辣')));
  assert.ok(chips.length <= 5);
  // 偏好说明必须诚实：不做医学判断
  assert.ok(intent.preferences.notes.some((x) => x.includes('医学判断')));
  assert.ok(intent.preferences.notes.some((x) => x.includes('无法核实') || x.includes('尽力避开')));
});

test('E1 只有自相矛盾（热量区间冲突）才反问，且最多 1 条', () => {
  const c = normalizeConstraints({}, '热量至少900大卡但不超过700大卡');
  // 数值走规则解析
  const c2 = normalizeConstraints(parseByRules('热量至少900大卡但不超过700大卡'), '热量至少900大卡但不超过700大卡').constraints;
  assert.ok(c2.clarifications.length <= 1);
  assert.equal(c2.clarifications[0].id, 'cal_range_conflict');
});

test('E2 预算偏低/数值偏高不再反问，降级为说明', () => {
  const low = normalizeConstraints({ budgetMax: 3 }, '3元以内随便吃点').constraints;
  assert.ok(low.clarifications.length <= 1);
  assert.ok(!low.clarifications.some((x) => x.id === 'budget_too_low'));
  const high = normalizeConstraints({ proteinMin: 80 }, '蛋白质至少80g').constraints;
  assert.ok(!high.clarifications.some((x) => x.id === 'protein_high'));
});

test('F1 口味偏好不是硬排除：「不喜欢吃油的」不得进 excludedFoods', () => {
  const c = parseByRules(SCENARIO_B);
  assert.ok(!c.excludedFoods.some((x) => /油|辣|冰/.test(x)), `实际 excludedFoods=${JSON.stringify(c.excludedFoods)}`);
});

test('F2 胃部背景只做提示：不产生医学断言字段', () => {
  const intent = resolveIntent({ budgetMax: 60 }, SCENARIO_B);
  assert.equal(intent.preferences.stomachContext, true);
  const note = intent.preferences.notes.find((x) => x.includes('医学'));
  assert.ok(note && note.includes('不做医学判断'));
});

/* ================= 日常排序层 ================= */

const cand = (name, { role = 'main', priceFen = 2500, fat = 20, components = null } = {}) => ({
  signature: name,
  components: components || [{ code: name, name, role }],
  roles: [role],
  priced: { priceFen },
  nutrition: { fat },
  estimatedPriceFen: priceFen,
});

test('辣味/温度识别保守：只认名称明确证据', () => {
  assert.equal(hasSpicyMarker('麦辣鸡腿堡'), true);
  assert.equal(hasSpicyMarker('板烧鸡腿堡'), false);
  assert.equal(drinkTemperature('热美式中杯'), 'warm');
  assert.equal(drinkTemperature('冰可乐'), 'cold');
  assert.equal(drinkTemperature('圆筒'), 'cold');
  assert.equal(drinkTemperature('可口可乐中杯'), 'unknown', '无温度字样不得默认温热');
});

test('B4 日常排序：辣味淘汰、热饮优先、不按最便宜排', () => {
  const intent = resolveIntent({ budgetMax: 60 }, SCENARIO_B);
  const fullMeal = {
    signature: 'meal-warm',
    components: [
      { code: 'M1', name: '板烧鸡腿堡', role: 'main' },
      { code: 'S1', name: '玉米杯', role: 'side' },
      { code: 'D1', name: '热美式中杯', role: 'drink' },
    ],
    roles: ['main'],
    priced: { priceFen: 3800 },
    nutrition: { fat: 18 },
    estimatedPriceFen: 3800,
  };
  const spicyCheapest = {
    signature: 'spicy',
    components: [{ code: 'M2', name: '麦辣鸡腿堡', role: 'main' }],
    roles: ['main'],
    priced: { priceFen: 1200 },
    nutrition: { fat: 25 },
    estimatedPriceFen: 1200,
  };
  const out = selectDailyPlans([spicyCheapest, fullMeal], intent);
  assert.equal(out.primary.cand.signature, 'meal-warm', '完整一餐 + 热饮 + 无辣胜出，而非最便宜的麦辣');
  assert.equal(out.excluded.spicyOrCold, 1, '麦辣被淘汰');
  assert.ok(out.primary.reasons.length > 0);
  assert.ok(out.primary.cautions.some((x) => /辣度|辣/.test(x)), '无法验证的辣度要有简短诚实提示');
  assert.ok(out.primary.cautions.some((x) => x.includes('医学')), '胃部背景提示不缺席');
});

test('A2 日常排序理由可回指证据：价位意图参与排序', () => {
  const intent = resolveIntent({ budgetMax: 30 }, '30元以内来点吃的');
  assert.equal(intent.budget.intent, BUDGET_INTENT.MAX);
  const cheap = cand('cheap-burger', { priceFen: 1500, fat: 15 });
  const pricey = cand('pricey-burger', { priceFen: 2900, fat: 15 });
  const out = selectDailyPlans([pricey, cheap], intent);
  assert.equal(out.primary.cand.signature, 'cheap-burger', 'max 意图下便宜的排前面');
  const minIntent = resolveIntent(null, '越便宜越好');
  const out2 = selectDailyPlans([pricey, cheap], minIntent);
  assert.equal(out2.primary.cand.signature, 'cheap-burger');
  assert.ok(out2.primary.reasons.some((x) => x.includes('便宜')), '理由要说明是按用户要求挑便宜的');
});

test('A3 备选必须与主推有真实差异（主商品或价位）', () => {
  const intent = resolveIntent({ budgetMax: 60 }, '随便吃点');
  const a = cand('A', { priceFen: 2500 });
  const a2 = cand('A2', { priceFen: 2500, components: [{ code: 'A', name: 'A', role: 'main' }] });
  const b = cand('B', { priceFen: 2500 });
  const out = selectDailyPlans([a, a2, b], intent);
  assert.ok(out.alternates.length >= 1);
  assert.ok(out.alternates.every((x) => x.cand.signature !== 'A2'), '同主商品同价位的重复项不做备选');
});
