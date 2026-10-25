/**
 * 生产环境行为测试：确认不会默默使用开发者本机配置。
 *
 * 场景：NODE_ENV=production，只显式提供 MCD_MCP_TOKEN（模拟部署方配置），不提供任何 LLM 配置。
 * 期望：
 * - 不读取 ~/.workbuddy/models.json → /api/llm/status.configured=false、sourceKind=null
 * - 自然语言解析降级为规则解析，且不伪造模型信息
 * - MCP 数据链路正常（推荐/核价仍可用）
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOrSkipClosed } from './helpers/store-gate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT_PROD || 5202);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child;
let token = '';


before(async () => {
  token = process.env.MCD_MCP_TOKEN || '';
  if (!token) {
    console.warn('[production.test] 无可用 MCP Token，跳过生产环境测试');
    return;
  }
  child = spawn(process.execPath, ['src/http/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      MCFIT_PREWARM: '0',
      MCD_MCP_TOKEN: token, // 部署方显式配置（测试里从本机读取后注入，仅服务端）
      MCFIT_LLM_BASE_URL: '',
      MCFIT_LLM_API_KEY: '',
      MCFIT_LLM_MODEL: '',
      MCFIT_LLM_ALLOW_LOCAL: '',
      MCFIT_ALLOW_LOCAL_MCP: '',
    },
    stdio: 'ignore',
  });
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) break;
    } catch {}
    if (Date.now() - t0 > 60000) throw new Error('生产模式服务启动超时');
    await sleep(400);
  }
});

after(() => {
  if (child) child.kill();
});

const post = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('生产环境不读取开发者本机模型配置', async (t) => {
  if (!token) return t.skip('无 Token');
  const j = await (await fetch(`${BASE}/api/llm/status`)).json();
  assert.equal(j.allowLocalConfig, false, '生产环境应关闭本机模型配置');
  assert.equal(j.configured, false, '未显式配置即视为没有模型');
  assert.equal(j.sourceKind, null);
  assert.ok(j.quotaNote.includes('降级'));
  assert.ok(!/sk-|Bearer|apiKey/i.test(JSON.stringify(j)));
});

test('生产环境无模型时解析降级为规则解析，不伪造 AI 结果', async (t) => {
  if (!token) return t.skip('无 Token');
  const r = await post('/api/parse', { text: '40元以内，蛋白质至少30g' });
  const j = await r.json();
  assert.equal(j.source, 'rule');
  assert.equal(j.degraded, true);
  assert.equal(j.llm, null);
  assert.equal(j.constraints.budgetMax, 40);
  assert.equal(j.constraints.proteinMin, 30);
  assert.ok(j.fallbackReason);
});

test('生产环境用显式 MCP Token 仍能出真实推荐与核价', async (t) => {
  if (!token) return t.skip('无 Token');
  const r = await post('/api/recommend', { constraints: { budgetMax: 40, proteinMin: 25 }, maxVerify: 10, planCount: 2 });
  const { closed, json: j } = await readOrSkipClosed(r, t);
  if (closed) return;
  assert.ok(['ok', 'infeasible'].includes(j.status));
  if (j.status === 'ok') {
    assert.ok(j.plans.length >= 1);
    for (const p of j.plans) {
      assert.ok(p.mcp.traceId, '必须是真实 MCP 核价');
      assert.equal(p.price.status, 'valued');
    }
  }
  assert.ok(j.searchScope);
});

test('生产环境响应里不含任何密钥', async (t) => {
  if (!token) return t.skip('无 Token');
  const [health, status, home] = await Promise.all([fetch(`${BASE}/api/health`).then((r) => r.text()), fetch(`${BASE}/api/llm/status`).then((r) => r.text()), fetch(`${BASE}/`).then((r) => r.text())]);
  for (const body of [health, status, home]) {
    assert.ok(!body.includes(token), '不得回显 MCP Token');
    assert.ok(!/Bearer\s+[A-Za-z0-9._-]{10,}/.test(body));
  }
});
