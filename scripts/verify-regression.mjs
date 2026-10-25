/**
 * 专项修复回归矩阵（任务 #12）：
 * A. 预算 7 场景 ×（规则 / 最终输出（模型优先+交叉校验））两路核对，语义一致不报冲突。
 * B. MCP 异常 7 场景：分类正确、人话无技术词、诊断留证、不硬编码 600057=关闭。
 * C. 用户体验 6 场景：问题原话语义 / 忌冰 / 区间不花满 / 温度不声称 / 1主推+≤2备选 / 模式路由不退化。
 *
 * 运行：node scripts/verify-regression.mjs（A 部分含真实 LLM 调用）
 */
import assert from 'node:assert/strict';
import { preferenceHintsFromText, resolveIntent, classifyBudget } from '../src/parse/intent.js';
import { parseByRules } from '../src/parse/rule-parser.js';
import { normalizeConstraints } from '../src/parse/schema.js';
import { parseRequirement } from '../src/parse/llm-parser.js';
import { classifyMenuFailure, MENU_FAILURE_CATEGORY, isWithinBusinessHours } from '../src/services/store-health.js';
import { scoreDaily, selectDailyPlans } from '../src/optimize/daily.js';

const results = [];
async function expectAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}
function expect(name, fn) {
  return expectAsync(name, async () => fn());
}

/* ================= A. 预算 7 场景（规则 / 最终输出） ================= */
console.log('\n[A] 预算 7 场景 × 规则 / 最终输出（模型优先+交叉校验）');

const BUDGET_CASES = [
  { t: '预算35到45块', min: 35, max: 45, intent: 'range' },
  { t: '35～45元', min: 35, max: 45, intent: 'range' },
  { t: '35-45块', min: 35, max: 45, intent: 'range' },
  { t: '35至45元', min: 35, max: 45, intent: 'range' },
  { t: '三十五到四十五元', min: 35, max: 45, intent: 'range' },
  { t: '最多45元', min: null, max: 45, intent: 'max' },
  { t: '45元左右', min: null, max: 45, intent: 'target' },
];

for (const c of BUDGET_CASES) {
  await expectAsync(`预算「${c.t}」→ ${c.intent} / 上限 ${c.max}${c.min ? ` / 起点 ${c.min}` : ''}`, async () => {
    // 规则路径
    const rule = normalizeConstraints(parseByRules(c.t), c.t).constraints;
    assert.equal(rule.budgetMax, c.max, `规则 budgetMax=${rule.budgetMax}，应为 ${c.max}`);
    assert.equal(rule.budgetMin, c.min, `规则 budgetMin=${rule.budgetMin}，应为 ${c.min}`);
    assert.equal(rule.budgetIntent, c.intent, `规则 budgetIntent=${rule.budgetIntent}，应为 ${c.intent}`);
    if (c.intent === 'range') assert.notEqual(rule.budgetMax, c.min, '区间起点绝不允许当上限');

    // 最终输出（模型优先 + 交叉校验）
    const fin = await parseRequirement(c.t);
    assert.equal(fin.status, 'ok', `最终输出 status=${fin.status}`);
    const fc = fin.constraints;
    assert.equal(fc.budgetMax, c.max, `最终 budgetMax=${fc.budgetMax}，应为 ${c.max}`);
    assert.equal(fc.budgetMin, c.min, `最终 budgetMin=${fc.budgetMin}，应为 ${c.min}`);
    assert.equal(fc.budgetIntent, c.intent, `最终 budgetIntent=${fc.budgetIntent}，应为 ${c.intent}`);

    // 语义一致 → 不得出现冲突警告/阻塞反问（交叉校验保留但不误报）
    const allText = [...(fin.warnings || []), ...(fc.clarifications || []).map((x) => x.question + x.reason)].join(' | ');
    assert.ok(!/num_conflict|分歧/.test(allText), `语义一致仍报冲突：${allText}`);
    assert.ok(!fin.clarification, `不应有阻塞式反问：${JSON.stringify(fin.clarification)}`);
  });
}

/* ================= B. MCP 异常 7 场景 ================= */
console.log('\n[B] MCP 异常 7 场景：分类 / 人话 / 留证 / 不硬编码');

const bizErr = (code, msg = '工具 query-meals 业务失败') => ({ kind: 'business', message: msg, detail: { tool: 'query-meals', code, traceId: 'trace-abc123' } });
const CLOSED = { storeCode: '3350241', businessStatus: false, businessStartTime: '07:00', businessEndTime: '00:00' };
const OPEN = { storeCode: '3350241', businessStatus: true, businessStartTime: '07:00', businessEndTime: '00:00' };

function assertNoTech(userText) {
  assert.ok(!/query-|600057|code=|mcp_|traceId|工具/i.test(userText), `用户文案泄露技术细节：${userText}`);
}

await expect('MCP① 打烊证据成立 → outside_business_hours，理由含营业时间', () => {
  const d = classifyMenuFailure({ err: bizErr(600057), storeInfo: CLOSED, nowMinutes: 90 }); // 01:30 打烊中
  assert.equal(d.category, MENU_FAILURE_CATEGORY.OUTSIDE_BUSINESS_HOURS);
  assert.ok(/07:00–00:00/.test(d.reason), `理由应含营业时间：${d.reason}`);
  assert.ok(d.actions.includes('switch_store') && d.actions.includes('retry_later'));
  assertNoTech(d.userMessage + d.reason);
  assert.equal(d.diagnostics.code, 600057, '诊断应保留业务码');
});

await expect('MCP② 显示营业却查不到菜单 → store_unavailable，不声称「已关闭」', () => {
  const d = classifyMenuFailure({ err: bizErr(600057), storeInfo: OPEN, nowMinutes: 720 }); // 12:00 营业中
  assert.equal(d.category, MENU_FAILURE_CATEGORY.STORE_UNAVAILABLE);
  assert.ok(!/关闭|打烊/.test(d.reason), `营业中不得声称关闭：${d.reason}`);
  assert.ok(d.actions.includes('switch_store'));
  assertNoTech(d.userMessage + d.reason);
});

await expect('MCP③ 无门店证据 → business 类，只说不知道、不猜原因', () => {
  const d = classifyMenuFailure({ err: bizErr(600057), storeInfo: null, nowMinutes: 720 });
  assert.equal(d.category, MENU_FAILURE_CATEGORY.BUSINESS);
  assert.ok(/暂时查不到原因/.test(d.reason), `应如实说不知道：${d.reason}`);
  assertNoTech(d.userMessage + d.reason);
});

await expect('MCP④ 600057 不硬编码含义：同码不同证据 → 不同结论', () => {
  const closed = classifyMenuFailure({ err: bizErr(600057), storeInfo: CLOSED, nowMinutes: 90 });
  const open = classifyMenuFailure({ err: bizErr(600057), storeInfo: OPEN, nowMinutes: 720 });
  assert.notEqual(closed.category, open.category, '同一业务码在不同营业证据下必须给出不同结论');
  // 任何结论的用户文案都不出现 600057
  assertNoTech(closed.userMessage + closed.reason + open.userMessage + open.reason);
});

await expect('MCP⑤ 网络故障 → network，可重试', () => {
  const d = classifyMenuFailure({ err: { kind: 'network', message: 'fetch failed' }, storeInfo: null, nowMinutes: 720 });
  assert.equal(d.category, MENU_FAILURE_CATEGORY.NETWORK);
  assert.ok(d.actions.includes('retry'));
  assertNoTech(d.userMessage + d.reason);
});

await expect('MCP⑥ 查询限制 → rate_limited，稍后再试', () => {
  const d = classifyMenuFailure({ err: { kind: 'http', message: '429 请求过于频繁' }, storeInfo: null, nowMinutes: 720 });
  assert.equal(d.category, MENU_FAILURE_CATEGORY.RATE_LIMITED);
  assert.ok(d.actions.includes('retry_later'));
  assertNoTech(d.userMessage + d.reason);
});

await expect('MCP⑦ 传输/解析层故障（http/rpc/parse）→ network，临时故障可重试', () => {
  for (const kind of ['http', 'rpc', 'parse']) {
    const d = classifyMenuFailure({ err: { kind, message: 'upstream 502' }, storeInfo: null, nowMinutes: 720 });
    assert.equal(d.category, MENU_FAILURE_CATEGORY.NETWORK, `kind=${kind} 应归 network`);
    assert.ok(d.actions.includes('retry'));
    assertNoTech(d.userMessage + d.reason);
    assert.ok(d.diagnostics.traceId === null || typeof d.diagnostics.traceId === 'string');
  }
});

await expect('跨零点营业时间判定（07:00–00:00）正确', () => {
  assert.equal(isWithinBusinessHours(90, '07:00', '00:00'), false, '01:30 打烊');
  assert.equal(isWithinBusinessHours(720, '07:00', '00:00'), true, '12:00 营业');
  assert.equal(isWithinBusinessHours(1380, '07:00', '00:00'), true, '23:00 营业');
});

/* ================= C. 用户体验 6 场景 ================= */
console.log('\n[C] 用户体验 6 场景');

const REAL = '今晚不太饿，想吃点凉凉的，别太油腻，预算35到45块，最好能有杯冷饮。';
const nut = (fat = 10) => ({ status: 'official', energyKcal: 500, protein: 20, fat, carbohydrate: 50, sodium: 500, calcium: 100, matchMethod: 'test' });
const cand = (name, components, priceFen, extra = {}) => ({ components: components.map((n) => ({ name: n })), nutrition: nut(extra.fat ?? 10), priced: { priceFen }, ...extra });

await expect('UX① 问题原话：三个场景语义独立命中、冷饮不误标忌冰、区间 35–45', async () => {
  const fin = await parseRequirement(REAL);
  const it = resolveIntent(fin.constraints, REAL);
  assert.equal(it.preferences.lightMeal, true);
  assert.equal(it.preferences.preferCoolFood, true);
  assert.equal(it.preferences.preferColdDrink, true);
  assert.equal(it.preferences.avoidIce, null);
  assert.equal(it.preferences.avoidOily, true);
  assert.equal(it.budget.intent, 'range');
  assert.equal(fin.constraints.budgetMin, 35);
  assert.equal(fin.constraints.budgetMax, 45);
});

await expect('UX② 忌冰：冰品直接排除，热饮加分', () => {
  const h = preferenceHintsFromText('想吃麦当劳，不要冰的');
  assert.equal(h.avoidIce, true);
  assert.equal(h.preferColdDrink, null);
  const it = resolveIntent({ budgetMax: 40 }, '想吃麦当劳，不要冰的');
  const iceCombo = cand('冰可乐套餐', ['麦香鸡堡', '薯条', '冰可乐'], 3800);
  const hotCombo = cand('热饮套餐', ['麦香鸡堡', '薯条', '热美式'], 3800);
  assert.ok(scoreDaily(iceCombo, it).score < -50, '含冰品应被淘汰');
  assert.ok(scoreDaily(hotCombo, it).score > scoreDaily(iceCombo, it).score);
});

await expect('UX③ 区间不花满：低于下限不惩罚、明说不硬凑', () => {
  const it = resolveIntent({ budgetMin: 35, budgetMax: 45, budgetIntent: 'range' }, REAL);
  const cheap = cand('便宜组合', ['麦香鸡堡', '薯条', '冰可乐'], 2500);
  const s = scoreDaily(cheap, it);
  assert.ok(/不硬凑/.test([...s.reasons, ...s.cautions].join(' | ')));
  assert.ok(s.score > -50, '便宜不是错，不因低于下限淘汰');
});

await expect('UX④ 温度不声称：冷饮按名称判断、食物温度无数据如实说', () => {
  const it = resolveIntent({ budgetMin: 35, budgetMax: 45, budgetIntent: 'range' }, REAL);
  const s = scoreDaily(cand('套餐', ['麦香鸡堡', '薯条', '可乐'], 4200), it);
  const text = [...s.reasons, ...s.cautions].join(' | ');
  assert.ok(/以门店为准|无法确认/.test(text), '未知温度必须提示以门店为准');
  assert.ok(/菜单没有食物温度数据/.test(text), '食物温度无数据要如实说');
});

await expect('UX⑤ 日常模式 1 主推 + ≤2 备选，备选取舍不同', () => {
  const it = resolveIntent({ budgetMin: 35, budgetMax: 45, budgetIntent: 'range' }, REAL);
  const pool = [
    cand('A', ['麦香鸡堡'], 3800),
    cand('B', ['麦香鸡堡', '薯条', '冰可乐'], 4200),
    cand('C', ['麦乐鸡', '薯条', '冰可乐'], 4000),
    cand('D', ['双层堡', '薯条', '可乐'], 4500),
    cand('E', ['板烧堡', '玉米杯', '冰可乐'], 4300),
  ];
  const plans = selectDailyPlans(pool, it);
  assert.ok(plans.primary, '应有主推');
  assert.ok(plans.alternates.length <= 2, `备选应 ≤2（实际 ${plans.alternates.length}）`);
});

await expect('UX⑥ 模式路由不退化：营养约束 → nutrition，日常诉求 → daily（营养优化算法不动）', async () => {
  const daily = resolveIntent({ budgetMax: 45 }, REAL);
  assert.equal(daily.mode, 'daily');
  const nutri = resolveIntent({ proteinMin: 30, caloriesMax: 700 }, '蛋白30g以上，热量700以内');
  assert.equal(nutri.mode, 'nutrition');
  const rule = normalizeConstraints(parseByRules('蛋白30g以上'), '蛋白30g以上').constraints;
  assert.equal(rule.proteinMin, 30, '营养约束解析不退化');
  assert.equal(classifyBudget('越便宜越好45元以内', 45).intent, 'minimize', 'minimize 语义不退化');
});

const failed = results.filter((r) => !r.ok);
console.log(`\n================ 汇总：${results.length - failed.length}/${results.length} 通过 ================`);
if (failed.length) process.exitCode = 1;
