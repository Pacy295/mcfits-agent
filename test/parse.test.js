/**
 * 自然语言解析层测试（确定性，不依赖网络）。
 * 对应验收场景：A / I / J，以及"不擅自推断阈值""硬软区分"等规则。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseByRules } from '../src/parse/rule-parser.js';
import { normalizeConstraints, numbersInText } from '../src/parse/schema.js';
import { parseRequirement } from '../src/parse/llm-parser.js';
import { analyzeMealTime, classifyPlannedPeriod } from '../src/parse/meal-time.js';

const ruleParse = (text) => normalizeConstraints(parseByRules(text), text).constraints;

test('场景A：「40元以内，尽量高蛋白」不得生成蛋白质下限', () => {
  const c = ruleParse('40元以内，尽量高蛋白');
  assert.equal(c.budgetMax, 40);
  assert.equal(c.proteinMin, null, '「高蛋白」只能作为优化倾向，不能变成阈值');
  assert.equal(c.caloriesMax, null);
  assert.deepEqual(c.objectives, [{ metric: 'protein', direction: 'max' }]);
  assert.ok(c.hardConstraints.some((h) => h.includes('预算')));
  assert.ok(c.softPreferences.some((s) => s.includes('高蛋白')));
});

test('场景B：三个硬约束同时正确解析（含「不超过」不被误判为下限）', () => {
  const c = ruleParse('40元以内，蛋白质至少30g，热量不超过750 kcal');
  assert.equal(c.budgetMax, 40);
  assert.equal(c.proteinMin, 30);
  assert.equal(c.caloriesMax, 750);
  assert.equal(c.caloriesMin, null, '「不超过 750」不能解析成热量下限');
});

test('硬软区分：「必须有饮料」是硬约束，「最好来杯无糖可乐」是软偏好', () => {
  const hard = ruleParse('30元以内，必须有饮料');
  assert.deepEqual(hard.requiredCategories, ['drink']);

  const soft = ruleParse('30元以内，最好来杯无糖可乐');
  assert.deepEqual(soft.requiredCategories, []);
  assert.ok(soft.preferredFoods.includes('无糖可乐'), `实际：${JSON.stringify(soft.preferredFoods)}`);
});

test('场景I：「不吃辣」标记为无法验证，不得声称已满足', () => {
  const c = ruleParse('40元以内，不吃辣');
  assert.equal(c.dietaryRestrictions.length, 1);
  assert.equal(c.dietaryRestrictions[0].type, 'spicy');
  assert.equal(c.dietaryRestrictions[0].verified, false);
  assert.ok(c.dietaryRestrictions[0].note.includes('无法验证'));
  assert.ok(c.hardConstraints.some((h) => h.includes('不吃辣')));
});

test('语义背景不能推断出数值需求（「练完胸想吃点东西」）', () => {
  const c = ruleParse('练完胸想吃点东西');
  assert.equal(c.budgetMax, null);
  assert.equal(c.caloriesMax, null);
  assert.equal(c.proteinMin, null);
  assert.deepEqual(c.objectives, [], '规则解析不据此加任何优化目标');
});

test('数值反幻觉：模型编造的数字必须被清空并留痕', () => {
  const raw = { budgetMax: 40, proteinMin: 35, caloriesMax: 800 };
  const { constraints, warnings } = normalizeConstraints(raw, '40元以内，尽量高蛋白');
  assert.equal(constraints.budgetMax, 40);
  assert.equal(constraints.proteinMin, null, '原文没有 35，必须清空');
  assert.equal(constraints.caloriesMax, null, '原文没有 800，必须清空');
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((w) => w.includes('臆造')));
});

test('数值反幻觉：原文出现的数字可通过', () => {
  const { constraints } = normalizeConstraints({ budgetMax: 40, proteinMin: 30 }, '40元以内，蛋白质至少30g');
  assert.equal(constraints.budgetMax, 40);
  assert.equal(constraints.proteinMin, 30);
});

test('自相矛盾的热量区间 → 生成待确认项，且不擅自修改用户意图', () => {
  const c = ruleParse('热量至少900大卡但不超过700大卡');
  assert.equal(c.caloriesMin, 900);
  assert.equal(c.caloriesMax, 700);
  assert.ok(c.clarifications.some((x) => x.id === 'cal_range_conflict'));
});

test('对象型输入：模型多给的优化目标若无原文依据会被剔除', () => {
  const raw = { budgetMax: 40, objectives: [{ metric: 'protein', direction: 'max' }, { metric: 'price', direction: 'min' }] };
  const { constraints } = normalizeConstraints(raw, '练完胸想吃点东西，40元以内');
  assert.deepEqual(constraints.objectives, [], '两条都没有原话依据，应全部剔除');
  // 第五阶段：这类"要不要顺便高蛋白"不再反问用户，降级为说明
  assert.ok(constraints.notes && /蛋白/.test(constraints.notes), '降级为说明而不是反问');
  assert.ok(!constraints.clarifications.some((x) => /蛋白/.test(x.question)), '不得再向用户追问蛋白目标');
  assert.ok(constraints.clarifications.length <= 1, '最多 1 个关键确认');
});

test('硬/软约束清单由结构化字段派生，不与模型自述重复', () => {
  const raw = {
    budgetMax: 40,
    proteinMin: 30,
    hardConstraints: ['总价不超过 40 元', '蛋白质至少 30g'],
    softPreferences: ['希望高蛋白'],
  };
  const { constraints } = normalizeConstraints(raw, '40元以内，蛋白质至少30g');
  assert.deepEqual(constraints.hardConstraints, ['预算 ≤ ¥40', '蛋白质 ≥ 30 g']);
  assert.deepEqual(constraints.softPreferences, []);
});

test('numbersInText 能识别中文数字词与阿拉伯数字', () => {
  const s = numbersInText('三十块以内，蛋白至少 25g');
  assert.ok(s.has(30));
  assert.ok(s.has(25));
});

test('场景J：模型不可用时降级为规则解析，且不伪造 AI 结果', async () => {
  const prev = process.env.MCFIT_LLM_DISABLE;
  process.env.MCFIT_LLM_DISABLE = '1';
  try {
    const r = await parseRequirement('40元以内，蛋白质至少30g');
    assert.equal(r.status, 'degraded');
    assert.equal(r.source, 'rule');
    assert.equal(r.degraded, true);
    assert.equal(r.llm, null, '绝不能返回伪造的 llm 字段');
    assert.ok(r.fallbackReason);
    assert.equal(r.constraints.budgetMax, 40);
    assert.equal(r.constraints.proteinMin, 30);
    assert.ok(r.constraints.parseSource === 'rule');
  } finally {
    if (prev === undefined) delete process.env.MCFIT_LLM_DISABLE;
    else process.env.MCFIT_LLM_DISABLE = prev;
  }
});

test('空输入返回结构化错误而不是空约束', async () => {
  const r = await parseRequirement('   ');
  assert.equal(r.status, 'error');
  assert.equal(r.constraints, null);
  assert.equal(r.error.code, 'empty_input');
});

/* ---------------- 用餐时段：区分「计划用餐时段」与「实际查询时段」 ---------------- */

test('用餐时段：早上 07:02 说「今晚」→ 明确现在只能核实当前（早餐）菜单', () => {
  const t = analyzeMealTime('今晚不太饿，想吃点凉凉的，别太油腻，预算35到45块', new Date(2026, 9, 25, 7, 2));
  assert.equal(t.planned, 'dinner');
  assert.equal(t.current, 'breakfast');
  assert.equal(t.mismatch, true);
  assert.match(t.note, /现在只能核实/);
  assert.ok(!/一定能有|保证有|都能买到|可售/.test(t.note), '不得声称未来时段一定有货');
});

test('用餐时段：19:00 说「今晚」→ 时段一致，不打扰', () => {
  const t = analyzeMealTime('今晚想吃点凉凉的', new Date(2026, 9, 25, 19, 0));
  assert.equal(t.planned, 'dinner');
  assert.equal(t.current, 'dinner');
  assert.equal(t.mismatch, false);
  assert.equal(t.note, null);
});

test('用餐时段：「明早」→ 说明明天的菜单现在无法核实', () => {
  const t = analyzeMealTime('明早想吃个早餐', new Date(2026, 9, 25, 7, 2));
  assert.equal(t.tomorrow, true);
  assert.equal(t.mismatch, true);
  assert.match(t.note, /明天早餐/);
});

test('用餐时段：没说时段 → null，不影响正常推荐', () => {
  assert.equal(analyzeMealTime('预算40元以内，尽量高蛋白', new Date(2026, 9, 25, 7, 2)), null);
});

test('用餐时段：「中午」「早餐」「今晚」各自识别，不互相误判', () => {
  assert.equal(classifyPlannedPeriod('中午想吃点清淡的').key, 'lunch');
  assert.equal(classifyPlannedPeriod('早餐想吃点热的').key, 'breakfast');
  assert.equal(classifyPlannedPeriod('今晚来一份').key, 'dinner');
});

test('用餐时段：解析结果附带 mealTime，且不改变预算约束', async () => {
  const r = await parseRequirement('今晚不太饿，预算35到45块', { mode: 'rule' });
  assert.equal(r.status, 'ok');
  assert.equal(r.mealTime.planned, 'dinner');
  assert.equal(r.constraints.budgetMin, 35);
  assert.equal(r.constraints.budgetMax, 45);
});
