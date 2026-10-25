/**
 * 第三阶段接口测试：套餐重建（真实核价）、非法 rounds、约束复核、限流、输入长度、模型来源披露。
 * 独立起一个服务（端口 5201），限流阈值调小以便验证。
 *
 * 关于样例套餐（重要）：
 * 门店菜单随时段变化（早餐 / 正餐的商品不同），写死某个套餐会在某些时段 404。
 * 因此这里按「当前菜单」动态挑一个三轮套餐（主食 + 小食 + 饮料）作为样例：
 * 期望的营养与差价全部由官方选项数据推算，不写死历史数字；
 * 断言的行为不变——营养必须等于官方求和、差价必须等于官方 rounds 差价、
 * 约束超限必须报准数字、特制不得给伪精确值。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOrSkipClosed, isClosedOutsideHours, CLOSED_SKIP_REASON } from './helpers/store-gate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT_3 || 5201);
const BASE = `http://127.0.0.1:${PORT}`;
// 前面的用例会消耗重建配额，所以阈值留足；限流用例放在最后并循环到触发为止
const REBUILD_LIMIT = 25;
let child;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const round1 = (x) => Math.round(x * 10) / 10;
const dip = (c) => (Number.isFinite(c?.diffPriceFen) ? c.diffPriceFen : 0);

/** 动态样例：当前菜单里可作重建校验的三轮套餐 */
let FX = null;
let STORE_CLOSED = false;

async function resolveFixture() {
  const poolRes = await fetch(`${BASE}/api/optimize/pool`);
  const pool = await poolRes.json();
  if (poolRes.status === 503) {
    STORE_CLOSED = isClosedOutsideHours(pool);
    return null;
  }
  for (const meal of pool.meals || []) {
    const r = await fetch(`${BASE}/api/products/${meal.code}/rounds`);
    if (!r.ok) continue;
    const d = await r.json();
    const rounds = d.rounds || [];
    if (rounds.length < 2) continue;

    const defaultOf = (rd) => rd.choices.find((c) => c.code === (d.defaultCombo || []).find((x) => x.round === rd.id)?.code) || rd.choices[0];
    const picks = rounds.map((rd) => ({ round: rd.id, roundName: rd.name, choice: defaultOf(rd) }));
    if (picks.some((x) => !x.choice || x.choice.nutrition?.status !== 'official' || !Number.isFinite(x.choice.nutrition.energyKcal))) continue;

    // 可换轮的选项：官方营养齐、且营养或差价与默认不同（用来验证「规格替换」）
    const swaps = rounds
      .map((rd) => {
        const base = defaultOf(rd);
        if (!base) return null;
        const alt = rd.choices.find(
          (c) =>
            c.code !== base.code &&
            c.nutrition?.status === 'official' &&
            Number.isFinite(c.nutrition.energyKcal) &&
            (c.nutrition.energyKcal !== base.nutrition.energyKcal || dip(c) !== dip(base)),
        );
        if (!alt) return null;
        return {
          round: rd.id,
          roundName: rd.name,
          base: { round: rd.id, roundName: rd.name, code: base.code, name: base.name },
          alt: { round: rd.id, roundName: rd.name, code: alt.code, name: alt.name },
          baseKcal: base.nutrition.energyKcal,
          altKcal: alt.nutrition.energyKcal,
          baseDip: dip(base),
          altDip: dip(alt),
        };
      })
      .filter(Boolean);
    if (swaps.length < 2) continue;

    return {
      mealCode: meal.code,
      mealName: meal.name,
      defaults: picks.map((x) => ({ round: x.round, roundName: x.roundName, code: x.choice.code, name: x.choice.name })),
      baseKcal: picks.reduce((a, x) => a + x.choice.nutrition.energyKcal, 0),
      baseProtein: round1(picks.reduce((a, x) => a + (x.choice.nutrition.protein || 0), 0)),
      swaps: swaps.slice(0, 2),
    };
  }
  return null;
}

/** 样例不可用时如实跳过（营业时间外 / 菜单里暂时找不到合适套餐） */
function skipNoFixture(t) {
  if (FX) return false;
  t.skip(STORE_CLOSED ? CLOSED_SKIP_REASON : '当前菜单找不到可作重建校验的三轮套餐，需换个时段复测');
  return true;
}

before(async () => {
  child = spawn(process.execPath, ['src/http/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), MCFIT_PREWARM: '0', MCFIT_RL_REBUILD: String(REBUILD_LIMIT), MCFIT_MAX_INPUT_CHARS: '120' },
    stdio: 'ignore',
  });
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) break;
    } catch {}
    if (Date.now() - t0 > 60000) throw new Error('服务启动超时');
    await sleep(400);
  }
  FX = await resolveFixture();
});

after(() => {
  if (child) child.kill();
});

test('套餐重建：默认组合营养与价格来自服务端实算', async (t) => {
  if (skipNoFixture(t)) return;
  const r = await post('/api/plan/rebuild', { productCode: FX.mealCode, choices: FX.defaults });
  const { closed, json: j } = await readOrSkipClosed(r, t);
  if (closed) return;
  assert.equal(r.status, 200);
  assert.equal(j.status, 'ok');
  assert.equal(j.plan.nutrition.energyKcal, FX.baseKcal, '营养必须是官方选项求和，不是估算');
  assert.ok(Math.abs(j.plan.nutrition.protein - FX.baseProtein) <= 0.15, `蛋白质应等于官方求和 ${FX.baseProtein}g`);
  assert.ok(j.plan.price.fen > 0, '必须有真实核价金额');
  assert.equal(j.plan.price.status, 'valued');
  assert.ok(j.plan.price.mcpDatetime, '核价必须带 MCP 返回时间');
  assert.ok(j.plan.mcp.traceId);
  assert.ok(j.plan.price.basis, '必须说明价格依据');
});

test('规格替换：同一轮换选项，营养与差价按官方数据变化', async (t) => {
  if (skipNoFixture(t)) return;
  const sw = FX.swaps[0];
  const ra = await post('/api/plan/rebuild', { productCode: FX.mealCode, choices: FX.defaults, refreshPrice: true });
  const ga = await readOrSkipClosed(ra, t);
  if (ga.closed) return;
  const choices = FX.defaults.map((c) => (String(c.round) === String(sw.round) ? { ...c, code: sw.alt.code, name: sw.alt.name } : c));
  const rb = await post('/api/plan/rebuild', { productCode: FX.mealCode, choices, refreshPrice: true });
  const gb = await readOrSkipClosed(rb, t);
  if (gb.closed) return;
  const a = ga.json.plan;
  const b = gb.json.plan;
  assert.equal(b.nutrition.energyKcal - a.nutrition.energyKcal, sw.altKcal - sw.baseKcal, '营养差必须等于官方选项差');
  assert.equal(b.price.fen - a.price.fen, sw.altDip - sw.baseDip, '价格差必须等于官方 rounds 差价');
  assert.notEqual(b.mcp.traceId, a.mcp.traceId, '每次都要重新核价');
  assert.ok(b.price.checkedAt >= a.price.checkedAt);
});

test('规格替换：换另一轮选项，同样按官方数据变化', async (t) => {
  if (skipNoFixture(t)) return;
  const sw = FX.swaps[1];
  const ra = await post('/api/plan/rebuild', { productCode: FX.mealCode, choices: FX.defaults, refreshPrice: true });
  const ga = await readOrSkipClosed(ra, t);
  if (ga.closed) return;
  const choices = FX.defaults.map((c) => (String(c.round) === String(sw.round) ? { ...c, code: sw.alt.code, name: sw.alt.name } : c));
  const rb = await post('/api/plan/rebuild', { productCode: FX.mealCode, choices, refreshPrice: true });
  const gb = await readOrSkipClosed(rb, t);
  if (gb.closed) return;
  assert.equal(gb.json.plan.nutrition.energyKcal - ga.json.plan.nutrition.energyKcal, sw.altKcal - sw.baseKcal);
  assert.equal(gb.json.plan.price.fen - ga.json.plan.price.fen, sw.altDip - sw.baseDip);
});

test('两处同时替换：营养为官方求和，价格由 calculate-price 实算', async (t) => {
  if (skipNoFixture(t)) return;
  const [s0, s1] = FX.swaps;
  const choices = FX.defaults.map((c) => {
    const hit = [s0, s1].find((s) => String(s.round) === String(c.round));
    return hit ? { ...c, code: hit.alt.code, name: hit.alt.name } : c;
  });
  const r = await post('/api/plan/rebuild', { productCode: FX.mealCode, choices });
  const { closed, json: j } = await readOrSkipClosed(r, t);
  if (closed) return;
  assert.equal(j.status, 'ok');
  const expectedKcal = FX.baseKcal - s0.baseKcal + s0.altKcal - s1.baseKcal + s1.altKcal;
  assert.equal(j.plan.nutrition.energyKcal, expectedKcal, '两项替换后的营养仍必须是官方求和');
  assert.ok(j.plan.price.fen > 0);
  assert.ok(j.plan.mcp.traceId);
  assert.equal(j.plan.price.status, 'valued');
  assert.equal(j.plan.price.estimateMatched, null, '手动重建没有参考价，不应给出估算未命中的错误暗示');
  assert.deepEqual(
    j.plan.components.map((c) => c.name),
    choices.map((c) => c.name),
  );
});

test('同时提交两轮改动时，两个选择都被保留并一起核价', async (t) => {
  if (skipNoFixture(t)) return;
  const [s0, s1] = FX.swaps;
  const choices = FX.defaults.map((c) => {
    const hit = [s0, s1].find((s) => String(s.round) === String(c.round));
    return hit ? { ...c, code: hit.alt.code, name: hit.alt.name } : c;
  });
  const r = await post('/api/plan/rebuild', { productCode: FX.mealCode, choices });
  const { closed, json: j } = await readOrSkipClosed(r, t);
  if (closed) return;
  const byRound = Object.fromEntries((j.plan.rounds || []).map((x) => [String(x.round), x.code]));
  for (const c of choices) assert.equal(byRound[String(c.round)], c.code, `第 ${c.round} 轮的改动必须保留`);
});

test('双项替换后重新复核预算与蛋白质：超了要报超多少', async (t) => {
  if (skipNoFixture(t)) return;
  const [s0, s1] = FX.swaps;
  const choices = FX.defaults.map((c) => {
    const hit = [s0, s1].find((s) => String(s.round) === String(c.round));
    return hit ? { ...c, code: hit.alt.code, name: hit.alt.name } : c;
  });
  const base = await post('/api/plan/rebuild', { productCode: FX.mealCode, choices });
  const gb = await readOrSkipClosed(base, t);
  if (gb.closed) return;
  const price = gb.json.plan.price.fen;
  const protein = gb.json.plan.nutrition.protein;
  const budgetMax = (price - 200) / 100; // 故意压到比实际低 ¥2
  const proteinMin = round1(protein + 3); // 故意要求高 3g
  const r = await post('/api/plan/rebuild', { productCode: FX.mealCode, choices, constraints: { budgetMax, proteinMin } });
  const { closed, json: j } = await readOrSkipClosed(r, t);
  if (closed) return;
  const budget = j.checks.violations.find((v) => v.key === 'budgetMax');
  const pro = j.checks.violations.find((v) => v.key === 'proteinMin');
  assert.equal(budget.excessFen, 200, '超预算额必须等于 核价−预算');
  assert.equal(pro.shortfall, round1(proteinMin - protein), '蛋白质缺口必须等于差值');
  assert.deepEqual(j.checks.satisfied, []);
});

test('非法 rounds 选项被拒绝，并返回该轮合法选项', async (t) => {
  if (skipNoFixture(t)) return;
  const target = FX.defaults[0];
  const legalCode = target.code;
  const illegalCode = FX.defaults[FX.defaults.length - 1].code;
  const choices = FX.defaults.map((c) => (c === target ? { ...c, code: illegalCode } : c));
  const r = await post('/api/plan/rebuild', { productCode: FX.mealCode, choices });
  const { closed, json: j } = await readOrSkipClosed(r, t);
  if (closed) return;
  assert.equal(r.status, 400);
  assert.equal(j.error.code, 'illegal_choice');
  assert.ok(j.error.legalCodes.includes(legalCode), '必须返回该轮的合法选项');
  assert.ok(!j.error.legalCodes.includes(illegalCode));
});

test('缺少 round 或 round 重复都被拒绝', async (t) => {
  if (skipNoFixture(t)) return;
  const missing = await post('/api/plan/rebuild', { productCode: FX.mealCode, choices: FX.defaults.slice(0, FX.defaults.length - 1) });
  const g1 = await readOrSkipClosed(missing, t);
  if (g1.closed) return;
  assert.equal(missing.status, 400);
  assert.equal(g1.json.error.code, 'incomplete_combo');

  const dup = await post('/api/plan/rebuild', {
    productCode: FX.mealCode,
    choices: [...FX.defaults.slice(0, FX.defaults.length - 1), { ...FX.defaults[0] }],
  });
  const g2 = await readOrSkipClosed(dup, t);
  if (g2.closed) return;
  assert.equal(dup.status, 400);
  assert.equal(g2.json.error.code, 'duplicate_round');
});

test('不存在的商品 code 被拒绝', async (t) => {
  const r = await post('/api/plan/rebuild', { components: [{ code: '000000000', quantity: 1 }] });
  const { closed, json: j } = await readOrSkipClosed(r, t);
  if (closed) return;
  assert.equal(r.status, 404, '不存在的商品按 404 返回');
  assert.equal(j.error.code, 'product_not_found');
});

test('调整后违反硬约束：逐项给出超出量，且数字自洽', async (t) => {
  if (skipNoFixture(t)) return;
  const r = await post('/api/plan/rebuild', { productCode: FX.mealCode, choices: FX.defaults, constraints: { budgetMax: 10, proteinMin: 50 } });
  const { closed, json: j } = await readOrSkipClosed(r, t);
  if (closed) return;
  const budget = j.checks.violations.find((v) => v.key === 'budgetMax');
  const protein = j.checks.violations.find((v) => v.key === 'proteinMin');
  assert.ok(budget && protein);
  assert.equal(budget.excessFen, j.plan.price.fen - 10 * 100, '超预算额必须等于 核价−预算');
  assert.equal(protein.shortfall, round1(50 - j.plan.nutrition.protein));
  assert.equal(j.checks.nutritionComplete, true);
  assert.equal(j.checks.modificationImpact, 'not_modeled');
});

test('特制营养：不给出伪精确值，只声明未建模', async (t) => {
  if (skipNoFixture(t)) return;
  const r = await post('/api/plan/rebuild', { productCode: FX.mealCode, choices: FX.defaults });
  const { closed, json: j } = await readOrSkipClosed(r, t);
  if (closed) return;
  assert.equal(j.plan.nutrition.modificationImpact, 'not_modeled');
  assert.ok(j.checks.modificationNote.includes('没有官方数据'));
  // 标准配置的营养仍必须是官方值求和
  assert.equal(j.plan.nutrition.status, 'derived_sum');
});

test('输入超长被拒绝（服务端字符上限）', async () => {
  const r = await post('/api/parse', { text: '预'.repeat(200) });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, 'input_too_long');
});

test('限流：超过阈值的重建请求返回 429 且带 Retry-After', async (t) => {
  let got429 = null;
  const sample = FX ? { productCode: FX.mealCode, choices: FX.defaults } : { productCode: '9900005460', choices: [] };
  for (let i = 0; i < REBUILD_LIMIT + 6; i += 1) {
    const r = await post('/api/plan/rebuild', sample);
    if (r.status === 429) {
      got429 = r;
      break;
    }
  }
  assert.ok(got429, '应触发限流');
  const j = await got429.json();
  assert.equal(j.error.code, 'rate_limited');
  assert.ok(Number(got429.headers.get('retry-after')) > 0);
});

test('推荐接口的不可行分析只包含已启用约束', async (t) => {
  const r = await post('/api/recommend', {
    constraints: { budgetMax: 12, proteinMin: 45, requiredCategories: ['drink'] },
    maxVerify: 10,
  });
  const { closed, json: j } = await readOrSkipClosed(r, t);
  if (closed) return;
  assert.equal(j.status, 'infeasible');
  const enabled = j.analysis.enabledConstraints.map((x) => x.key);
  const relaxed = j.analysis.relaxedConstraints;
  assert.deepEqual([...enabled].sort(), ['budgetMax', 'proteinMin', 'requiredCategories']);
  for (const k of relaxed) assert.ok(enabled.includes(k), `放宽项 ${k} 不在已启用约束内`);
  assert.ok(!relaxed.includes('caloriesMax') && !relaxed.includes('caloriesMin'));
});

test('模型状态披露来源与额度说明，不含密钥', async () => {
  const j = await (await fetch(`${BASE}/api/llm/status`)).json();
  assert.ok('sourceKind' in j);
  assert.ok('quotaNote' in j);
  const raw = JSON.stringify(j);
  assert.ok(!/sk-|Bearer|apiKey/i.test(raw));
});

test('产品页与工程台都可用，且产品页引用自己的脚本', async () => {
  const idx = await fetch(`${BASE}/`);
  const html = await idx.text();
  assert.equal(idx.status, 200);
  assert.ok(html.includes('/product.js'));
  assert.ok(html.includes('与麦当劳官方无关'));
  const consolePage = await fetch(`${BASE}/console.html`);
  assert.equal(consolePage.status, 200);
  assert.ok((await consolePage.text()).includes('/stage2.js'));
});
