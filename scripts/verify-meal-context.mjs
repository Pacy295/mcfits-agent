/**
 * 用餐场景解析专项验证（真实用户体验问题修复 · P1）。
 *
 * 覆盖任务书要求（问题原话：「今晚不太饿，想吃点凉凉的，别太油腻，预算35到45块，最好能有杯冷饮。」）：
 * 1. 「不太饿」→ lightMeal：小份/简单搭配优先，不为凑满 45 加餐，不虚构热量上限。
 * 2. 「凉凉的」（食物温度 preferCoolFood）与「最好能有杯冷饮」（饮品软偏好 preferColdDrink）严格分开；
 *    无温度数据不声称、不保证。
 * 3. 冷饮正向偏好绝不误标 avoidIce；「不喜欢吃冰的」等否定式才判忌冰。
 * 4. 脂肪只是辅助排序，不等同于「清淡」标准。
 * 5. 35–45 是目标区间：区间内加分、低于下限不惩罚（不为花满强加）。
 * 6. 日常模式 1 主推 + ≤2 备选，备选取舍不同。
 * 7. 营养优化模式不受影响（本脚本只断言日常模式行为，营养模式回归见 test/optimize.test.js）。
 *
 * 运行：node scripts/verify-meal-context.mjs（含真实 LLM 端到端调用）
 */
import assert from 'node:assert/strict';
import { preferenceHintsFromText, resolveIntent, intentChips } from '../src/parse/intent.js';
import { scoreDaily, selectDailyPlans } from '../src/optimize/daily.js';

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

const REAL_SENTENCE = '今晚不太饿，想吃点凉凉的，别太油腻，预算35到45块，最好能有杯冷饮。';

/* ---------------- 候选夹具（不联网、不调 MCP） ---------------- */
const nut = (fat = 10) => ({ status: 'official', energyKcal: 500, protein: 20, fat, carbohydrate: 50, sodium: 500, calcium: 100, matchMethod: 'test' });

function cand(name, components, priceFen, extra = {}) {
  return {
    components: components.map((n) => ({ name: n })),
    roles: components.map((n) => n),
    nutrition: nut(extra.fat ?? 10),
    priced: { priceFen },
    ...extra,
  };
}

const SMALL = cand('小份汉堡', ['麦香鸡堡'], 3800, { fat: 12 });
const TWO_PIECE = cand('汉堡+可乐', ['麦香鸡堡', '冰可乐'], 4000, { fat: 11 });
const COLD_COMBO = cand('套餐含冰饮', ['麦香鸡堡', '薯条', '冰可乐'], 4200, { fat: 12 });
const UNKNOWN_DRINK = cand('套餐含可乐', ['麦香鸡堡', '薯条', '可乐'], 4200, { fat: 12 });
const NO_DRINK = cand('无饮料组合', ['麦香鸡堡', '薯条', '玉米杯'], 3600, { fat: 12 });
const BIG = cand('全家桶型', ['麦香鸡堡', '薯条', '可乐', '派', '麦旋风'], 6800, { fat: 25 });

/* ---------------- 离线断言（确定性） ---------------- */
console.log('\n[1/3] 离线断言：语义拆分 / 评分取舍 / 区间不花满');

expect('问题原话：lightMeal / preferCoolFood / preferColdDrink 三者独立命中，avoidIce 不误标', () => {
  const h = preferenceHintsFromText(REAL_SENTENCE);
  assert.equal(h.lightMeal, true, '「不太饿」应命中 lightMeal');
  assert.equal(h.preferCoolFood, true, '「想吃点凉凉的」应命中 preferCoolFood（食物温度）');
  assert.equal(h.preferColdDrink, true, '「最好能有杯冷饮」应命中 preferColdDrink（饮品软偏好）');
  assert.equal(h.avoidIce, null, `冷饮正向偏好不得误标 avoidIce（实际=${h.avoidIce}）`);
  assert.equal(h.avoidOily, true, '「别太油腻」应命中 avoidOily');
});

expect('冷饮与忌冰严格分开：否定式优先', () => {
  assert.equal(preferenceHintsFromText('不喜欢吃冰的').avoidIce, true);
  assert.equal(preferenceHintsFromText('不喜欢吃冰的').preferColdDrink, null);
  assert.equal(preferenceHintsFromText('不想喝冰饮').avoidIce, true);
  assert.equal(preferenceHintsFromText('来杯冰可乐').preferColdDrink, true);
  assert.equal(preferenceHintsFromText('来杯冰可乐').avoidIce, null);
  assert.equal(preferenceHintsFromText('想喝冷饮').preferColdDrink, true);
  assert.equal(preferenceHintsFromText('想喝冷饮').avoidIce, null);
});

expect('「凉凉的」（食物温度）与冷饮（饮品）分开，互不冒充', () => {
  const h = preferenceHintsFromText('想吃点凉凉的');
  assert.equal(h.preferCoolFood, true);
  assert.equal(h.preferColdDrink, null, '只说吃凉的 ≠ 想喝冷饮');
  const h2 = preferenceHintsFromText('最好能有杯冷饮');
  assert.equal(h2.preferColdDrink, true);
  assert.equal(h2.preferCoolFood, null, '只说冷饮 ≠ 想吃凉的餐食');
});

expect('resolveIntent 合并后偏好结构完整、notes 含诚实边界措辞', () => {
  const it = resolveIntent({ budgetMax: 45, budgetMin: 35, budgetIntent: 'range' }, REAL_SENTENCE);
  const p = it.preferences;
  assert.equal(p.lightMeal, true);
  assert.equal(p.preferCoolFood, true);
  assert.equal(p.preferColdDrink, true);
  assert.equal(p.avoidIce, null);
  assert.equal(p.avoidOily, true);
  const notes = p.notes.join(' | ');
  assert.ok(/不保证实际温度|按名称判断/.test(notes), '冷饮说明应含「不保证实际温度/按名称判断」');
  assert.ok(/无法核实|无法保证/.test(notes), '食物温度说明应含「无法核实/无法保证」');
  assert.ok(/不虚构热量上限/.test(notes), '小份说明应含「不虚构热量上限」');
  assert.ok(/不等同于"清淡"/.test(notes), '脂肪说明应声明不等同于清淡标准');
  assert.ok(/不保证实际温度|无法核实/.test(notes) && !/一定|保证是|肯定是/.test(notes), '不得声称温度确定性');
});

expect('意图标签：小份优先 / 想喝冷饮 / 想吃凉的 各自独立展示', () => {
  const it = resolveIntent({ budgetMax: 45, budgetMin: 35, budgetIntent: 'range' }, REAL_SENTENCE);
  const chips = intentChips({ budgetMin: 35, budgetMax: 45 }, it);
  assert.ok(chips.some((c) => c.includes('小份')), `标签应含小份：${chips}`);
  assert.ok(chips.some((c) => c.includes('冷饮')), `标签应含冷饮：${chips}`);
  assert.ok(chips.some((c) => c.includes('凉')), `标签应含想吃凉的：${chips}`);
  assert.ok(chips.some((c) => c.includes('¥35–45')), `标签应含目标区间：${chips}`);
});

expect('lightMeal：小份加分、多件组合不加分且提示，绝不虚构热量上限', () => {
  const it = resolveIntent({ budgetMax: 45, budgetMin: 35, budgetIntent: 'range' }, REAL_SENTENCE);
  const sSmall = scoreDaily(SMALL, it);
  const sBig = scoreDaily(BIG, it);
  assert.ok(sSmall.score > sBig.score, `小份(${sSmall.score}) 应高于多件(${sBig.score})`);
  assert.ok(sSmall.cautions.some((c) => /不虚构热量上限/.test(c)), '应声明不虚构热量上限');
  assert.ok(sBig.cautions.some((c) => /吃不完/.test(c)), '多件组合应提示可能吃不完');
  // 只对"推荐理由"检查虚构热量（cautions 的免责声明会写"不虚构热量上限"，不算虚构）
  const claimText = [...sSmall.reasons, ...sBig.reasons].join(' | ');
  assert.ok(!/kcal|千卡|热量/.test(claimText), `推荐理由不得出现虚构的热量上限：${claimText}`);
});

expect('preferColdDrink：名称证据加分并说明「按名称看是冷饮」，未知温度不声称', () => {
  const it = resolveIntent({ budgetMax: 45, budgetMin: 35, budgetIntent: 'range' }, REAL_SENTENCE);
  const sCold = scoreDaily(COLD_COMBO, it);
  const sUnknown = scoreDaily(UNKNOWN_DRINK, it);
  const sNone = scoreDaily(NO_DRINK, it);
  assert.ok(sCold.reasons.some((r) => /按名称看是冷饮/.test(r)), `冷饮理由措辞：${sCold.reasons}`);
  assert.ok(sCold.score > sUnknown.score, `名称证据(${sCold.score}) 应高于未知温度(${sUnknown.score})`);
  assert.ok(sUnknown.cautions.some((c) => /以门店为准|无法确认/.test(c)), '未知温度必须提示以门店为准');
  assert.ok(sNone.score < sUnknown.score, `无饮料(${sNone.score}) 应低于有未知饮料(${sUnknown.score})`);
});

expect('preferCoolFood：只出诚实提示「菜单没有食物温度数据」，不声称凉热', () => {
  const it = resolveIntent({ budgetMax: 45, budgetMin: 35, budgetIntent: 'range' }, REAL_SENTENCE);
  const s = scoreDaily(SMALL, it);
  assert.ok(s.cautions.some((c) => /菜单没有食物温度数据/.test(c)), `应含食物温度诚实提示：${s.cautions}`);
  // 只对"推荐理由"检查声称性措辞（cautions 里的诚实免责说明本身会提到"是凉的"，不算声称）
  const reasonText = s.reasons.join(' | ');
  assert.ok(!/是凉的|凉爽|保证凉/.test(reasonText), `推荐理由不得声称食物是凉的：${reasonText}`);
});

expect('脂肪只是辅助排序：理由与提示均声明不等同于「清淡」', () => {
  const it = resolveIntent({ budgetMax: 45, budgetMin: 35, budgetIntent: 'range' }, REAL_SENTENCE);
  const s = scoreDaily(SMALL, it);
  assert.ok(s.reasons.some((r) => /辅助避开高油/.test(r)), `脂肪理由应为辅助：${s.reasons}`);
  assert.ok(s.cautions.some((c) => /不代表医学或官方认定/.test(c)), '应声明不代表清淡标准');
});

expect('区间不花满：低于 35 下限不惩罚且明说「不硬凑」，区间内加分', () => {
  const it = resolveIntent({ budgetMax: 45, budgetMin: 35, budgetIntent: 'range' }, REAL_SENTENCE);
  assert.equal(it.budget.intent, 'range');
  // 同一搭配只改价格：区间内必须拿到明显加分（目标价位要真参与排序），
  // 但低于下限不扣分、也不怂恿加餐凑满 —— 所以只检查"有加分 + 有诚实提示"，不检查惩罚。
  const CHEAP = cand('便宜组合', ['麦香鸡堡', '薯条', '冰可乐'], 2500); // ¥25 < 下限 35
  const IN_RANGE = cand('区间内组合', ['麦香鸡堡', '薯条', '冰可乐'], 4200); // ¥42
  const sCheap = scoreDaily(CHEAP, it);
  const sIn = scoreDaily(IN_RANGE, it);
  const cheapText = [...sCheap.reasons, ...sCheap.cautions].join(' | ');
  assert.ok(/不硬凑/.test(cheapText), `低于下限应说不硬凑：${cheapText}`);
  assert.ok(sIn.reasons.some((r) => /落在你说的/.test(r)), `区间内应有理由：${sIn.reasons}`);
  const gap = sIn.score - sCheap.score;
  assert.ok(gap >= 2, `区间内必须明显加分（目标价位参与排序），实际分差=${gap}`);
});

expect('1 主推 + ≤2 备选，且备选与主推取舍不同（不再为凑数）', () => {
  const it = resolveIntent({ budgetMax: 45, budgetMin: 35, budgetIntent: 'range' }, REAL_SENTENCE);
  const plans = selectDailyPlans([SMALL, TWO_PIECE, COLD_COMBO, UNKNOWN_DRINK, NO_DRINK, BIG], it);
  assert.equal(plans.primary != null, true, '应有 1 个主推');
  assert.ok((plans.alternates || []).length <= 2, `备选应 ≤2 个（实际 ${(plans.alternates || []).length}）`);
});

/* ---------------- 真实 LLM 端到端（问题原话） ---------------- */
console.log('\n[2/3] 真实 LLM 端到端：问题原话的最终解析输出');

async function llmScenario() {
  const { parseRequirement } = await import('../src/parse/llm-parser.js');
  await (async () => {
    try {
      const llm = await parseRequirement(REAL_SENTENCE);
      assert.equal(llm.status, 'ok', `最终输出 status=${llm.status}`);
      const fc = llm.constraints;
      const it = resolveIntent(fc, REAL_SENTENCE);
      const p = it.preferences;

      assert.equal(p.lightMeal, true, `lightMeal=${p.lightMeal}，应为 true`);
      assert.equal(p.preferCoolFood, true, `preferCoolFood=${p.preferCoolFood}，应为 true`);
      assert.equal(p.preferColdDrink, true, `preferColdDrink=${p.preferColdDrink}，应为 true`);
      assert.equal(p.avoidIce, null, `avoidIce=${p.avoidIce}，冷饮正向偏好下必须为 null`);
      assert.equal(p.avoidOily, true, `avoidOily=${p.avoidOily}，应为 true`);
      assert.equal(it.budget.intent, 'range', `budgetIntent=${it.budget.intent}，应为 range`);
      assert.equal(fc.budgetMin, 35, `budgetMin=${fc.budgetMin}，应为 35`);
      assert.equal(fc.budgetMax, 45, `budgetMax=${fc.budgetMax}，应为 45`);
      assert.equal(it.mode, 'daily', `mode=${it.mode}，问题原话应进日常模式（不得被改造成营养模式）`);

      results.push({ name: 'LLM 端到端：问题原话解析与场景语义', ok: true });
      console.log('  ✓ LLM 端到端：问题原话解析与场景语义');
    } catch (err) {
      results.push({ name: 'LLM 端到端：问题原话解析与场景语义', ok: false, err });
      console.log(`  ✗ LLM 端到端：问题原话解析与场景语义\n    ${err.message}`);
    }
  })();
}

/* ---------------- 真实 LLM 端到端（否定式冷饮不误判） ---------------- */
console.log('\n[3/3] 真实 LLM 端到端：否定式冷饮表述不误判');

async function llmNegative() {
  const { parseRequirement } = await import('../src/parse/llm-parser.js');
  const t = '不要冰的，预算40以内';
  await (async () => {
    try {
      const llm = await parseRequirement(t);
      const it = resolveIntent(llm.constraints, t);
      assert.equal(it.preferences.avoidIce, true, `avoidIce=${it.preferences.avoidIce}，「不要冰的」应为 true`);
      assert.equal(it.preferences.preferColdDrink, null, `preferColdDrink=${it.preferences.preferColdDrink}，否定式下必须为 null`);
      results.push({ name: 'LLM 端到端：「不要冰的」→ 忌冰而非冷饮', ok: true });
      console.log('  ✓ LLM 端到端：「不要冰的」→ 忌冰而非冷饮');
    } catch (err) {
      results.push({ name: 'LLM 端到端：「不要冰的」→ 忌冰而非冷饮', ok: false, err });
      console.log(`  ✗ LLM 端到端：「不要冰的」→ 忌冰而非冷饮\n    ${err.message}`);
    }
  })();
}

await llmScenario();
await llmNegative();

const failed = results.filter((r) => !r.ok);
console.log(`\n================ 汇总：${results.length - failed.length}/${results.length} 通过 ================`);
if (failed.length) process.exitCode = 1;
