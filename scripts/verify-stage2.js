/**
 * 第二阶段验收：真实 MCP + 真实 LLM 端到端（不使用任何手写商品数据）。
 * 用法: node scripts/verify-stage2.js
 * 输出: 控制台报告 + cache/verify-report-stage2.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR, config, tokenStatus } from '../src/config.js';
import { llmStatus, probe } from '../src/llm/provider.js';
import { parseRequirement } from '../src/parse/llm-parser.js';
import { recommendPlans } from '../src/services/recommend-service.js';
import { dominates, buildDimensions } from '../src/optimize/objectives.js';
import { comparePlans } from '../src/optimize/compare.js';

const results = [];
const evidence = {};

function check(id, title, fn) {
  const t0 = Date.now();
  try {
    const d = fn();
    const pass = d?.pass !== false;
    results.push({ id, title, pass, ms: Date.now() - t0, detail: d?.text ?? '' });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(5)} ${title}${d?.text ? ` — ${d.text}` : ''}`);
    return d?.data;
  } catch (err) {
    results.push({ id, title, pass: false, ms: Date.now() - t0, detail: `异常: ${err.message}` });
    console.log(`FAIL  ${id.padEnd(5)} ${title} — 异常: ${err.message}`);
    return null;
  }
}

async function checkAsync(id, title, fn) {
  const t0 = Date.now();
  try {
    const d = await fn();
    const pass = d?.pass !== false;
    results.push({ id, title, pass, ms: Date.now() - t0, detail: d?.text ?? '' });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(5)} ${title}${d?.text ? ` — ${d.text}` : ''}`);
    return d?.data;
  } catch (err) {
    results.push({ id, title, pass: false, ms: Date.now() - t0, detail: `异常: ${err.message}` });
    console.log(`FAIL  ${id.padEnd(5)} ${title} — 异常: ${err.message}`);
    return null;
  }
}

console.log('='.repeat(80));
console.log(`麦门营养决策官 · 第二阶段验收（真实 MCP + 真实 LLM）  门店 ${config.store.defaultStoreCode}`);
console.log(`执行时间 ${new Date().toLocaleString('zh-CN')}  Node ${process.version}  Token ${JSON.stringify(tokenStatus())}`);
console.log('='.repeat(80));

/* ---------------- 0. LLM 运行时可用性 ---------------- */
console.log('\n[0] 运行时 LLM 接入');
const llmProbe = await checkAsync('0.1', 'LLM 端点真实可用（非仅 WorkBuddy 对话能力）', async () => {
  const p = await probe({ maxAgeMs: 0 });
  evidence.llm = { ...llmStatus(), probed: p };
  return { pass: p.ok, text: p.ok ? `${p.model} 可用（${p.ms} ms）` : `不可用：${p.error}` };
});

/* ---------------- A / B / I / 解析 ---------------- */
console.log('\n[A/B/I] 自然语言解析');
let constraintsA = null;
let constraintsB = null;
let constraintsI = null;
const parseA = await checkAsync('A', '「40元以内，尽量高蛋白」不生成蛋白质阈值', async () => {
  const r = await parseRequirement('40元以内，尽量高蛋白');
  const c = r.constraints;
  constraintsA = c;
  evidence.parseA = { source: r.source, model: r.llm?.model, budgetMax: c.budgetMax, proteinMin: c.proteinMin, objectives: c.objectives };
  return {
    pass: c.budgetMax === 40 && c.proteinMin === null && c.objectives.some((o) => o.metric === 'protein' && o.direction === 'max'),
    text: `source=${r.source} 预算=${c.budgetMax} 蛋白下限=${c.proteinMin} 目标=${JSON.stringify(c.objectives)}`,
  };
});

const parseB = await checkAsync('B', '三个硬约束同时正确解析', async () => {
  const r = await parseRequirement('40元以内，蛋白质至少30g，热量不超过750 kcal');
  const c = r.constraints;
  constraintsB = c;
  evidence.parseB = { source: r.source, budgetMax: c.budgetMax, proteinMin: c.proteinMin, caloriesMax: c.caloriesMax, caloriesMin: c.caloriesMin };
  return {
    pass: c.budgetMax === 40 && c.proteinMin === 30 && c.caloriesMax === 750 && c.caloriesMin === null,
    text: `预算=${c.budgetMax} 蛋白≥${c.proteinMin} 热量≤${c.caloriesMax}（下限=${c.caloriesMin}）`,
  };
});

const parseI = await checkAsync('I', '「不吃辣」被标记为无法验证', async () => {
  const r = await parseRequirement('40元以内，不吃辣，要有主食');
  const d = r.constraints.dietaryRestrictions[0];
  constraintsI = r.constraints;
  evidence.parseI = { restrictions: r.constraints.dietaryRestrictions };
  return {
    pass: d && d.type === 'spicy' && d.verified === false,
    text: `${d?.text} · type=${d?.type} · verified=${d?.verified}`,
  };
});

/* ---------------- 真实推荐（可行） ---------------- */
console.log('\n[C/D/F/G/H] 真实推荐：可行路径');
const t0 = Date.now();
const rec = await recommendPlans(constraintsB, { maxVerify: 40, planCount: 4 });
const recMs = Date.now() - t0;
evidence.recommend = {
  status: rec.status,
  elapsedMs: recMs,
  searchScope: rec.searchScope,
  timing: rec.timing,
  plans: (rec.plans || []).map((p) => ({
    id: p.id,
    name: p.productName,
    kind: p.kind,
    priceFen: p.price.fen,
    checkedAt: p.price.checkedAt,
    traceId: p.mcp.traceId,
    kcal: p.nutrition.energyKcal,
    protein: p.nutrition.protein,
    components: p.components.map((c) => `${c.name}`),
    advantages: p.advantages,
    tradeoffs: p.tradeoffs,
  })),
};

await checkAsync('C1', '可行路径返回 2–4 套方案', async () => ({
  pass: rec.status === 'ok' && rec.plans.length >= 2 && rec.plans.length <= 4,
  text: `${rec.plans.length} 套（basis=${rec.selection.basis}，策略=${rec.selection.strategy}）`,
}));

/**
 * 下面两个检查刻意独立重算：只用返回 JSON 里的价格/营养数字重新构造对象，
 * 不读取 plan.pareto 等自定义属性。这样即使引擎里的标注写错，也能被发现。
 */
const dimsB = buildDimensions(constraintsB);
const asPoint = (p) => ({ id: p.id, price: { fen: p.price.fen }, nutrition: p.nutrition, prefScore: p.prefScore });

await checkAsync('C2', '严格非支配：独立重算后非支配方案都处于最低价，且标注与重算一致', async () => {
  const pts = rec.plans.map(asPoint);
  const recomputed = pts.map((me) => ({
    id: me.id,
    priceFen: me.price.fen,
    dominators: pts.filter((o) => o.id !== me.id && dominates(o, me, dimsB)).map((o) => o.id),
    declared: rec.plans.find((p) => p.id === me.id).pareto?.nonDominated,
  }));
  const expectedNonDom = recomputed.filter((x) => x.dominators.length === 0).map((x) => x.id);
  const declaredNonDom = recomputed.filter((x) => x.declared === true).map((x) => x.id);
  const same = JSON.stringify(expectedNonDom) === JSON.stringify(declaredNonDom);
  const cheapest = Math.min(...recomputed.map((x) => x.priceFen));
  const onlyCheapest = expectedNonDom.every((id) => recomputed.find((x) => x.id === id).priceFen === cheapest);
  return {
    pass: same && onlyCheapest && expectedNonDom.length >= 1,
    text:
      `维度=${dimsB.map((d) => d.label).join('+') || '无'}｜重算非支配=${JSON.stringify(expectedNonDom)}｜声明非支配=${JSON.stringify(declaredNonDom)}｜最低价 ¥${(cheapest / 100).toFixed(2)}` +
      (same ? '' : '｜标注与重算不一致'),
  };
});

await checkAsync('C3', '「差异化补充」方案必须给出真实支配者，且差价算术自洽', async () => {
  const bad = [];
  let checked = 0;
  for (const p of rec.plans) {
    if (p.pareto?.nonDominated !== false) continue;
    checked += 1;
    const dom = p.pareto.dominatedBy || [];
    if (!dom.length) {
      bad.push(`${p.id} 标注为被支配却没有支配者`);
      continue;
    }
    for (const d of dom) {
      const expected = d.priceFen - p.price.fen;
      if (d.deltaFen !== expected) bad.push(`${p.id} 对 ${d.name} 差价 ${d.deltaFen} ≠ ${expected}`);
      if (d.priceFen > p.price.fen) bad.push(`${p.id} 的支配者${d.name} 反而更贵`);
    }
  }
  return {
    pass: bad.length === 0,
    text: bad.length ? bad.join('；') : `${checked} 套差异化补充方案均给出真实支配者与正确差价`,
  };
});

await checkAsync('C4', '严格前沿样本与「最低价」说法一致', async () => {
  const sample = rec.selection.strictParetoSample || [];
  const cheapest = rec.selection.strictParetoCheapestFen;
  const pts = rec.plans.map(asPoint);
  const bad = [];
  for (const s of sample) {
    if (s.priceFen !== cheapest) bad.push(`样本 ${s.name} ¥${(s.priceFen / 100).toFixed(2)} ≠ 最低价 ¥${(cheapest / 100).toFixed(2)}`);
    const asPlanLike = { price: { fen: s.priceFen }, nutrition: { energyKcal: s.kcal, protein: s.protein }, prefScore: 0 };
    if (pts.some((o) => dominates(o, asPlanLike, dimsB))) bad.push(`前沿样本 ${s.name} 实际被推荐方案支配`);
  }
  return { pass: bad.length === 0 && sample.length > 0, text: bad.length ? bad.join('；') : `${sample.length} 个前沿样本价格均为 ¥${((cheapest ?? 0) / 100).toFixed(2)} 且未被支配` };
});

await checkAsync('C5', '多维目标场景：返回的方案确实互不支配（basis=strict-front）', async () => {
  const r = await recommendPlans(constraintsA, { maxVerify: 40, planCount: 4 });
  const dims = buildDimensions(constraintsA);
  const pts = r.plans.map(asPoint);
  const pairs = [];
  for (const a of pts) for (const b of pts) if (a.id !== b.id && dominates(a, b, dims)) pairs.push(`${a.id}⊃${b.id}`);
  const allDeclared = r.plans.every((p) => p.pareto?.nonDominated === true);
  return {
    pass: r.selection.basis === 'strict-front' && pairs.length === 0 && allDeclared,
    text: `basis=${r.selection.basis}｜维度=${dims.map((d) => d.label).join('+')}｜${r.plans.length} 套，独立重算支配对=${pairs.length}${allDeclared ? '' : '｜存在被标注为非支配却实际被支配的方案'}`,
  };
});

await checkAsync('F', '营养全部来自官方值，无 0/缺失', async () => {
  const bad = rec.plans.filter((p) => !Number.isFinite(p.nutrition.energyKcal) || p.nutrition.energyKcal <= 0 || !Number.isFinite(p.nutrition.protein));
  return {
    pass: bad.length === 0 && rec.searchScope.pool.nutritionUnknownExcluded > 0,
    text: `方案营养均 >0 且有蛋白质值；池中因缺营养被排除 ${rec.searchScope.pool.nutritionUnknownExcluded} 个商品`,
  };
});

await checkAsync('G', '每套方案都由 calculate-price 真实核价且满足预算', async () => {
  const bad = rec.plans.filter((p) => !p.mcp.traceId || p.price.status !== 'valued' || p.price.fen > 40 * 100);
  return { pass: bad.length === 0, text: rec.plans.map((p) => `${p.id}=¥${p.price.yuan}(${p.mcp.traceId.slice(0, 8)})`).join(' ') };
});

await checkAsync('H', '所有方案的组件都来自合法 rounds / 官方商品', async () => {
  const ok = rec.plans.every((p) => (p.kind === 'meal' ? (p.rounds?.length ?? 0) > 0 : p.components.length > 0));
  const fit = rec.plans.every((p) => p.components.every((c) => c.code && c.name));
  return { pass: ok && fit, text: rec.plans.map((p) => `${p.id}:${p.kind}/${p.components.length}件`).join(' ') };
});

/* ---------------- 不可行路径 ---------------- */
console.log('\n[E] 不可行路径');
// 输入显式记录，避免报告与真实入参再次对不上
const INF_BUDGET_YUAN = 12;
// 注意：这里刻意不复用 B 的约束对象，避免把 B 的热量上限悄悄带进来
// （上一版用了 { ...constraintsB }，导致报告里出现了用户没设过的"热量上限"放宽分析）
const infConstraints = {
  budgetMax: INF_BUDGET_YUAN,
  caloriesMax: null,
  caloriesMin: null,
  proteinMin: 45,
  requiredCategories: ['drink'],
  preferredFoods: [],
  excludedFoods: [],
  preferredCategories: [],
  dietaryRestrictions: [],
  objectives: [],
};
const inf = await recommendPlans(infConstraints, { maxVerify: 20 });
console.log(`输入：budgetMax=${infConstraints.budgetMax} 元, proteinMin=${infConstraints.proteinMin} g, requiredCategories=${JSON.stringify(infConstraints.requiredCategories)}`);
evidence.infeasible = { status: inf.status, analysis: inf.analysis, searchScope: inf.searchScope };

await checkAsync('E1', '不可行时不返回任何"满足要求"的方案', async () => ({
  pass: inf.status === 'infeasible' && inf.plans.length === 0,
  text: `status=${inf.status}，plans=${inf.plans.length}`,
}));

await checkAsync('E2', '单项放宽给出经过核价的量化结果', async () => {
  const rel = inf.analysis.relaxations.map((x) => `${x.label}:${x.note}`);
  return { pass: inf.analysis.relaxations.length > 0 && inf.analysis.relaxations.some((x) => x.feasibleCount > 0), text: rel.join(' | ') };
});

await checkAsync('E3', '近似替代方案标注了违反项与超出量', async () => {
  const c = inf.analysis.closest;
  return {
    pass: c.length > 0 && c.every((x) => x.violations.some((v) => v.detail)),
    text: c.map((x) => `${x.candidate.name} ¥${(x.candidate.priceFen / 100).toFixed(2)} → ${x.violations.map((v) => v.detail).join('/')}`).join(' | '),
  };
});

await checkAsync('E4', '搜索范围受限时不断言"全店无解"', async () => ({
  pass: inf.analysis.scopeNote.includes('不能断言'),
  text: inf.analysis.scopeNote,
}));

await checkAsync('E6', '放宽分析只针对用户实际启用的约束', async () => {
  const enabled = inf.analysis.enabledConstraints.map((x) => x.key).sort();
  const relaxed = inf.analysis.relaxedConstraints.slice().sort();
  const extra = relaxed.filter((k) => !enabled.includes(k));
  return {
    pass: extra.length === 0 && !relaxed.includes('caloriesMax'),
    text: `启用=[${enabled.join(',')}]｜放宽=[${relaxed.join(',')}]${extra.length ? '｜越界:' + extra.join(',') : ''}`,
  };
});

await checkAsync('E5', '预算差值算术自洽：超出额必须等于 核价 − 预算', async () => {
  const budgetFen = INF_BUDGET_YUAN * 100;
  const bad = [];
  let checkedRows = 0;
  for (const row of inf.analysis.closest) {
    const v = row.violations.find((x) => x.key === 'budgetMax');
    if (!v) continue;
    checkedRows += 1;
    const expected = row.candidate.priceFen - budgetFen;
    if (v.excessFen !== expected) bad.push(`${row.candidate.name}: excessFen=${v.excessFen} 应为 ${row.candidate.priceFen}-${budgetFen}=${expected}`);
    const yuanText = (expected / 100).toFixed(2);
    if (!String(v.detail).includes(yuanText)) bad.push(`${row.candidate.name}: 文案「${v.detail}」与算术值 ¥${yuanText} 不一致`);
  }
  return {
    pass: bad.length === 0 && checkedRows > 0,
    text: bad.length
      ? bad.join('；')
      : `${checkedRows} 条近似方案的超预算额均等于 核价−${INF_BUDGET_YUAN} 元（例：${inf.analysis.closest[0].candidate.name} ¥${(inf.analysis.closest[0].candidate.priceFen / 100).toFixed(2)} → 超 ¥${((inf.analysis.closest[0].candidate.priceFen - budgetFen) / 100).toFixed(2)}）`,
  };
});

await checkAsync('CONSIST', '方案 / 对比 / 不可行 三处数值来自同一份结构化结果', async () => {
  const [a, b] = rec.plans;
  const d = comparePlans(a, b);
  const bad = [];
  if (d.delta.priceFen !== b.price.fen - a.price.fen) bad.push('对比价差与方案价差不一致');
  if (d.delta.protein !== Math.round((b.nutrition.protein - a.nutrition.protein) * 10) / 10) bad.push('对比蛋白差与方案不一致');
  if (d.a.priceFen !== a.price.fen || d.a.kcal !== a.nutrition.energyKcal || d.a.protein !== a.nutrition.protein) bad.push('对比的 A 方案取值与方案不一致');
  if (d.provenance.a.traceId !== a.mcp.traceId) bad.push('对比使用的 traceId 与方案不一致');
  for (const c of inf.analysis.closest) {
    if (c.candidate.priceFen == null || c.candidate.kcal == null || c.candidate.protein == null) bad.push(`不可行近似方案 ${c.candidate.name} 缺数值`);
  }
  return { pass: bad.length === 0, text: bad.length ? bad.join('；') : '对比与方案同源（价格/热量/蛋白/traceId 全部一致）' };
});


await checkAsync('I2', '无法验证的忌口不会被声称已满足', async () => {
  const r = await recommendPlans({ ...constraintsI }, { maxVerify: 20 });
  const unver = r.dataQuality.unverifiableRestrictions;
  const claimed = (r.plans || []).some((p) => p.hardSatisfied.some((h) => h.includes('不吃辣')));
  return {
    pass: unver.includes('不吃辣') && !claimed,
    text: `dataQuality.unverifiableRestrictions=${JSON.stringify(unver)}；方案中是否声称满足=${claimed}`,
  };
});

/* ---------------- 真实方案对比 ---------------- */
console.log('\n[对比] 方案差异');
await checkAsync('CMP', '两方案差异由真实数值相减', async () => {
  const [a, b] = rec.plans;
  const d = comparePlans(a, b);
  evidence.compare = d;
  return { pass: d.delta.priceFen === b.price.fen - a.price.fen, text: d.summary };
});

/* ---------------- 场景 J：模型不可用 ---------------- */
console.log('\n[J] 模型不可用时的降级');
await checkAsync('J', 'LLM 关闭时不伪造 AI 解析，规则路径仍可用', async () => {
  const prev = process.env.MCFIT_LLM_DISABLE;
  process.env.MCFIT_LLM_DISABLE = '1';
  try {
    const r = await parseRequirement('40元以内，蛋白质至少30g');
    evidence.degraded = { status: r.status, source: r.source, degraded: r.degraded, llm: r.llm, fallbackReason: r.fallbackReason };
    return {
      pass: r.status === 'degraded' && r.source === 'rule' && r.llm === null && r.constraints.proteinMin === 30,
      text: `status=${r.status} source=${r.source} llm=${r.llm} 仍在规则路径拿到 proteinMin=${r.constraints.proteinMin}`,
    };
  } finally {
    if (prev === undefined) delete process.env.MCFIT_LLM_DISABLE;
    else process.env.MCFIT_LLM_DISABLE = prev;
  }
});

/* ---------------- 汇总 ---------------- */
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n' + '='.repeat(80));
console.log(`第二阶段验收：${passed}/${results.length} 通过，${failed} 失败`);
if (failed) console.log('失败项：', results.filter((r) => !r.pass).map((r) => r.id).join(', '));
console.log(`推荐耗时：${recMs} ms（原子参考价 ${rec.timing.priceAtomsMs} ms / 候选核价 ${rec.timing.verifyMs} ms / 生成 ${rec.timing.generateMs} ms）`);
console.log('='.repeat(80));

fs.writeFileSync(
  path.join(CACHE_DIR, 'verify-report-stage2.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, summary: { total: results.length, passed, failed }, evidence, checks: results }, null, 2),
  'utf8',
);
console.log('报告已写入 cache/verify-report-stage2.json');
process.exitCode = failed ? 1 : 0;
