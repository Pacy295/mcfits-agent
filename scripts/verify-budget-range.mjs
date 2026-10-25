/**
 * 预算区间解析专项验证（真实用户体验问题修复 · P0）。
 *
 * 覆盖任务书要求：
 * 1. 区间优先识别：「35到45块」「35～45元」「35-45块」「35至45元」「三十五到四十五元」一致 → 目标区间 35–45、上限 45。
 * 2. 起点绝不当上限（budgetMax 不得为 35）。
 * 3. 语义分类：「最多45元」= max 硬上限；「45元左右」= target 软目标；「越便宜越好45元以内」= minimize。
 * 4. 模型+规则+最终输出三路一致；语义一致不产生冲突警告（不删交叉校验，只消除无意义分歧）。
 * 5. 真冲突提示只用自然语言（「我暂时按 45 元以内理解，你可以修改预算。」），不暴露字段名/技术细节。
 *
 * 运行：node scripts/verify-budget-range.mjs（含真实 LLM 端到端调用）
 */
import assert from 'node:assert/strict';
import { parseBudgetRange, classifyBudget } from '../src/parse/intent.js';
import { parseByRules } from '../src/parse/rule-parser.js';
import { normalizeConstraints } from '../src/parse/schema.js';
import { parseRequirement, conflictQuestion } from '../src/parse/llm-parser.js';

const results = [];
function expect(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

const RANGE_TEXTS = ['预算35到45块', '35～45元', '35-45块', '35至45元', '三十五到四十五元'];
const SEMANTIC_CASES = [
  { t: '最多45元', max: 45, min: null, intent: 'max' },
  { t: '45元左右', max: 45, min: null, intent: 'target' },
  { t: '越便宜越好45元以内', max: 45, min: null, intent: 'minimize' },
];
const REAL_SENTENCE = '今晚不太饿，想吃点凉凉的，别太油腻，预算35到45块，最好能有杯冷饮。';

/* ---------------- 离线断言（确定性） ---------------- */
console.log('\n[1/3] 离线断言：区间识别 / 规则解析 / 意图分类 / 冲突措辞');

for (const t of RANGE_TEXTS) {
  expect(`区间识别「${t}」→ 35–45（上限=终点）`, () => {
    assert.deepEqual(parseBudgetRange(t), { min: 35, max: 45 });
    const rule = normalizeConstraints(parseByRules(t), t).constraints;
    assert.equal(rule.budgetMin, 35, `budgetMin=${rule.budgetMin}，应为 35`);
    assert.equal(rule.budgetMax, 45, `budgetMax=${rule.budgetMax}，应为区间终点 45，绝不允许起点 35 当上限`);
    assert.equal(rule.budgetIntent, 'range', `budgetIntent=${rule.budgetIntent}，应为 range`);
    assert.equal(classifyBudget(t, 45).intent, 'range');
    assert.deepEqual(rule.hardConstraints.filter((h) => /预算/.test(h)), ['预算 ≤ ¥45']);
    assert.ok(rule.softPreferences.some((s) => s.includes('¥35–45')), '软偏好应含目标价位区间');
  });
}

for (const c of SEMANTIC_CASES) {
  expect(`语义分类「${c.t}」→ ${c.intent} / 上限 ${c.max}`, () => {
    const rule = normalizeConstraints(parseByRules(c.t), c.t).constraints;
    assert.equal(rule.budgetMax, c.max);
    assert.equal(rule.budgetMin, c.min);
    assert.equal(rule.budgetIntent, c.intent, `budgetIntent=${rule.budgetIntent}，应为 ${c.intent}`);
    assert.equal(classifyBudget(c.t, c.max).intent, c.intent);
  });
}

expect('区间误伤防护：「3到5块麦乐鸡」不是预算区间', () => {
  assert.equal(parseBudgetRange('3到5块麦乐鸡'), null);
  assert.equal(parseByRules('3到5块麦乐鸡').budgetMax, null);
});

expect('区间误伤防护：「大概五六十块钱吧。」不是区间', () => {
  assert.equal(parseBudgetRange('大概五六十块钱吧。'), null);
});

expect('冲突提示自然语言化（不暴露字段名/技术细节）', () => {
  const q = conflictQuestion('budgetMax', 45);
  assert.equal(q, '我暂时按 45 元以内理解，你可以修改预算。');
  for (const [f, v] of [['budgetMax', 45], ['budgetMin', 35], ['caloriesMax', 800], ['caloriesMin', 500], ['proteinMin', 30]]) {
    const text = conflictQuestion(f, v);
    assert.ok(!/budgetMax|budgetMin|calories|proteinMin|模型|规则|JSON|num_conflict/i.test(text), `提示泄露技术细节：${text}`);
  }
});

/* ---------------- 真实 LLM 端到端（模型 + 规则 + 最终输出） ---------------- */
console.log('\n[2/3] 真实 LLM 端到端：模型 + 规则 + 最终输出三路核对');

async function llmScenario(t, expectObj) {
  await (async () => {
    try {
      const llm = await parseRequirement(t); // 模型优先 + 交叉校验 + 最终输出
      const rule = await parseRequirement(t, { mode: 'rule' }); // 纯规则
      assert.equal(llm.status, 'ok', `最终输出 status=${llm.status}`);
      const fc = llm.constraints;
      const rc = rule.constraints;

      // 三路一致（规则 / 最终）：区间与上限
      assert.equal(fc.budgetMax, expectObj.max, `最终 budgetMax=${fc.budgetMax}，应为 ${expectObj.max}`);
      assert.equal(rc.budgetMax, expectObj.max, `规则 budgetMax=${rc.budgetMax}，应为 ${expectObj.max}`);
      assert.notEqual(fc.budgetMax, expectObj.min ?? -1, '区间起点绝不允许当上限');
      if (expectObj.min != null) {
        assert.equal(fc.budgetMin, expectObj.min, `最终 budgetMin=${fc.budgetMin}，应为 ${expectObj.min}`);
        assert.equal(rc.budgetMin, expectObj.min, `规则 budgetMin=${rc.budgetMin}，应为 ${expectObj.min}`);
      }

      // 意图一致
      assert.equal(fc.budgetIntent, expectObj.intent, `最终 budgetIntent=${fc.budgetIntent}，应为 ${expectObj.intent}`);

      // 语义一致 → 不得出现冲突警告/待确认（交叉校验仍在，只是不误报）
      const allText = [...(llm.warnings || []), ...(fc.clarifications || []).map((x) => x.question + x.reason), fc.notes || ''].join(' | ');
      assert.ok(!/num_conflict|分歧/.test(allText), `语义一致仍出现冲突提示：${allText}`);
      assert.ok(!llm.clarification, `不应有阻塞式反问：${JSON.stringify(llm.clarification)}`);

      // 冲突/警告内容不得以技术形态进入最终用户可见文本（notes/clarification）
      const userText = [...(fc.clarifications || []).map((x) => x.question), fc.notes || ''].join(' | ');
      assert.ok(!/budgetMax|budgetMin|模型给|规则给|num_conflict/i.test(userText), `用户可见文本泄露技术细节：${userText}`);

      console.log(`  ✓ 端到端「${t.slice(0, 18)}…」→ budgetMin=${fc.budgetMin} budgetMax=${fc.budgetMax} intent=${fc.budgetIntent}`);
      results.push({ name: `端到端「${t.slice(0, 18)}…」`, ok: true });
    } catch (err) {
      console.log(`  ✗ 端到端「${t.slice(0, 18)}…」\n    ${err.message}`);
      results.push({ name: `端到端「${t.slice(0, 18)}…」`, ok: false, err });
    }
  })();
}

for (const t of RANGE_TEXTS) await llmScenario(t, { min: 35, max: 45, intent: 'range' });
for (const c of SEMANTIC_CASES) await llmScenario(c.t, { min: c.min, max: c.max, intent: c.intent });
await llmScenario(REAL_SENTENCE, { min: 35, max: 45, intent: 'range' });

/* ---------------- 汇总 ---------------- */
console.log('\n[3/3] 汇总');
const failed = results.filter((r) => !r.ok);
console.log(`通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.name}: ${f.err?.message}`);
  process.exit(1);
}
console.log('预算区间解析专项验证全部通过');
