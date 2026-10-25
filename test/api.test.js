/**
 * API 集成测试：真实启动 HTTP 服务（真实 MCP），逐个接口验证返回状态与数据可信度字段。
 * 与单元测试分开：这里验证"接口契约"，不做算法断言。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOrSkipClosed } from './helpers/store-gate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || 5199);
const BASE = `http://127.0.0.1:${PORT}`;
let child;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUp(timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error('服务启动超时');
    await sleep(500);
  }
}

const post = (p, body) =>
  fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

before(async () => {
  child = spawn(process.execPath, ['src/http/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), MCFIT_PREWARM: '0' },
    stdio: 'ignore',
  });
  const h = await waitUp();
  assert.equal(h.ok, true);
  assert.equal(h.mcp.reachable, true, '测试环境必须能连上 MCP');
});

after(() => {
  if (child) child.kill();
});

test('GET /api/health：返回服务与 MCP 连通性，且不含任何密钥', async () => {
  const r = await fetch(`${BASE}/api/health`);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.mcp.reachable, true);
  const raw = JSON.stringify(j);
  assert.ok(!/Bearer\s+[A-Za-z0-9]/i.test(raw));
  assert.ok(!('token' in (j.mcp || {})));
});

test('GET /api/llm/status：只暴露端点与模型名，不暴露密钥', async () => {
  const r = await fetch(`${BASE}/api/llm/status`);
  const j = await r.json();
  assert.equal(typeof j.configured, 'boolean');
  const raw = JSON.stringify(j);
  assert.ok(!/apiKey|sk-|Bearer/i.test(raw));
});

test('POST /api/parse（规则模式）：source=rule，无 llm 字段伪装', async () => {
  const r = await post('/api/parse', { text: '40元以内，蛋白质至少30g，热量不超过750kcal', mode: 'rule' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.source, 'rule');
  assert.equal(j.llm, null);
  assert.equal(j.constraints.budgetMax, 40);
  assert.equal(j.constraints.proteinMin, 30);
  assert.equal(j.constraints.caloriesMax, 750);
  assert.equal(j.constraints.caloriesMin, null);
});

test('POST /api/parse（自动模式）：要么真模型解析，要么明确降级，不允许第三种', async () => {
  const r = await post('/api/parse', { text: '40元以内，尽量高蛋白' });
  assert.equal(r.status, 200);
  const j = await r.json();
  if (j.source === 'llm') {
    assert.ok(j.llm.model);
    assert.equal(j.degraded, false);
    assert.equal(j.constraints.proteinMin, null, '「高蛋白」不得变成阈值');
  } else {
    assert.equal(j.degraded, true);
    assert.equal(j.llm, null, '降级时不得返回伪造的模型信息');
    assert.ok(j.fallbackReason);
  }
});

test('POST /api/parse：空输入返回 400 与结构化错误码', async () => {
  const r = await post('/api/parse', { text: '  ' });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.equal(j.error.code, 'empty_input');
});

test('POST /api/recommend（结构化约束直传，不再调用模型）', async (t) => {
  const r = await post('/api/recommend', {
    text: '表单输入',
    constraints: { budgetMax: 40, proteinMin: 30, caloriesMax: 750 },
    maxVerify: 12,
    planCount: 3,
  });
  const { closed, json: j } = await readOrSkipClosed(r, t);
  if (closed) return;
  assert.equal(r.status, 200);
  assert.equal(j.parse.source, 'manual');
  assert.ok(['ok', 'infeasible'].includes(j.status));
  assert.ok(j.searchScope, '必须返回搜索范围');
  assert.ok(['full', 'partial', 'no-candidates-after-prefilter'].includes(j.searchScope.completeness));
  assert.equal(typeof j.timing.totalMs, 'number');

  if (j.status === 'ok') {
    assert.ok(j.plans.length >= 2, '至少给出 2 套方案');
    for (const p of j.plans) {
      assert.ok(Number.isFinite(p.price.fen), '每套方案必须有真实核价金额');
      assert.ok(p.mcp.traceId, '每套方案必须带 MCP traceId');
      assert.equal(p.price.status, 'valued');
      assert.ok(Number.isFinite(p.nutrition.energyKcal) && p.nutrition.energyKcal > 0, '热量不得为 0');
      assert.ok(p.price.fen <= 40 * 100, '推荐方案必须实际满足预算');
      assert.ok(p.nutrition.protein >= 30, '推荐方案必须满足蛋白质下限');
      assert.ok(p.nutrition.energyKcal <= 750, '推荐方案必须满足热量上限');
      assert.ok(p.components.length > 0);
      assert.deepEqual(p.hardSatisfied.length > 0, true);
    }
    // 内容不重复
    const sigs = j.plans.map((p) => p.components.map((c) => c.code).sort().join('|'));
    assert.equal(new Set(sigs).size, sigs.length);
  }
});

test('POST /api/recommend：不可行时给出量化分析，而不是编造方案', async (t) => {
  const r = await post('/api/recommend', {
    constraints: { budgetMax: 12, proteinMin: 45, requiredCategories: ['drink'] },
    maxVerify: 10,
  });
  const { closed, json: j } = await readOrSkipClosed(r, t);
  if (closed) return;
  assert.equal(j.status, 'infeasible');
  assert.equal(j.plans.length, 0, '不可行时不得返回任何"满足要求"的方案');
  assert.ok(j.analysis.relaxations.length > 0);
  assert.ok(j.analysis.closest.length > 0);
  for (const c of j.analysis.closest) {
    assert.ok(c.violations.some((v) => v.detail), '近似方案必须标注差距');
  }
  assert.ok(j.analysis.scopeNote);
});

test('POST /api/compare：差值来自真实方案数值', async (t) => {
  const recRes = await post('/api/recommend', { constraints: { budgetMax: 40 }, maxVerify: 10, planCount: 2 });
  const { closed, json: rec } = await readOrSkipClosed(recRes, t);
  if (closed) return;
  assert.ok(rec.plans?.length >= 2, '需要至少两套方案才能对比');
  const [a, b] = rec.plans;
  const r = await post('/api/compare', { a, b });
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.delta.priceFen, b.price.fen - a.price.fen);
  assert.equal(j.delta.protein, Math.round((b.nutrition.protein - a.nutrition.protein) * 10) / 10);
  assert.ok(j.summary.length > 0);
});

test('POST /api/compare：缺参数时返回 400', async () => {
  const r = await post('/api/compare', { a: { price: { fen: 100 } } });
  assert.equal(r.status, 400);
});

test('GET /api/optimize/pool：候选池统计可查（含缺营养排除数）', async (t) => {
  const r = await fetch(`${BASE}/api/optimize/pool`);
  const { closed, json: j } = await readOrSkipClosed(r, t);
  if (closed) return;
  assert.equal(j.ok, true);
  assert.ok(j.meals.length > 0);
  assert.ok(j.stats.nutritionUnknownExcluded >= 0);
  const totalSingles = Object.values(j.singles).reduce((a, b) => a + b.length, 0);
  assert.ok(totalSingles > 0);
});

test('未知接口返回 404 结构化错误', async () => {
  const r = await fetch(`${BASE}/api/nope`);
  assert.equal(r.status, 404);
  const j = await r.json();
  assert.equal(j.error.code, 'not_found');
});
