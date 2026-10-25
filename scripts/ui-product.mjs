/**
 * 产品页端到端交互测试（无头 Chrome + CDP，真实后端 + 真实 MCP + 真实 LLM）。
 * 覆盖：解析回填、改条件重新核价、热量不追最低、套餐规格替换、非法 rounds、
 *       特制营养提示、违反项标注、不可行解释、标签准确性、快速连续输入、桌面/移动端、密钥泄漏。
 *
 * 用法: node scripts/ui-product.mjs
 * 产出: .shots/product-desktop.png / product-mobile.png / product-drawer.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'http://localhost:5173/';
const PORT = 9344;
const SHOT_DIR = path.join(process.cwd(), '.shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error('未找到 Chrome/Edge');
  process.exit(0);
}

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfits-prod-'));
const proc = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, '--window-size=1440,1000', 'about:blank'],
  { stdio: 'ignore' },
);

async function wsUrl() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

const ws = new WebSocket(await wsUrl());
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true });
  ws.addEventListener('error', j, { once: true });
});

let msgId = 0;
const pending = new Map();
const pageErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
  if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description || 'exception');
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') pageErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate error';
    throw new Error(`${d} << ${String(expr).slice(0, 100)}`);
  }
  return r.result?.value;
}

async function waitFor(expr, timeout = 60000, label = expr) {
  const t0 = Date.now();
  for (;;) {
    const v = await ev(expr);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`超时：${label}`);
    await sleep(180);
  }
}

const checks = [];
const rec = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
};
async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    rec(name, false, `异常：${err.message.slice(0, 160)}`);
  }
}
async function shot(name, full = true) {
  // 抽屉是 fixed 覆盖层，整页截图会出现合成残影，所以抽屉一律按视口截
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
  const p = path.join(SHOT_DIR, name);
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
}

/* ---------------- 页面控制工具 ---------------- */
const APPLY = (cfg) => `(() => {
  const cfg = ${JSON.stringify(cfg)};
  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
  for (const [key, val] of Object.entries(cfg.nums || {})) {
    const on = document.getElementById('on-' + key);
    const inp = document.getElementById('in-' + key);
    const want = val !== null;
    if (on.checked !== want) { on.checked = want; fire(on, 'change'); }
    if (want) { inp.value = String(val); fire(inp, 'input'); }
  }
  if (cfg.objectives) {
    document.querySelectorAll('#objectiveChips input').forEach((el) => {
      const want = cfg.objectives.includes(el.value);
      if (el.checked !== want) { el.checked = want; fire(el, 'change'); }
    });
  }
  if (cfg.required) {
    document.querySelectorAll('#requiredChips input').forEach((el) => {
      const want = cfg.required.includes(el.value);
      if (el.checked !== want) { el.checked = want; fire(el, 'change'); }
    });
  }
  return true;
})()`;

/** 等最新一次 /api/recommend 满足条件且界面已出结果 */
async function waitResult(matcher = '() => true', timeout = 90000) {
  await waitFor(
    `(() => {
      const arr = window.__reqs.filter((r) => r.url.includes('/api/recommend'));
      if (!arr.length) return false;
      const body = arr[arr.length - 1].body;
      if (!(${matcher})(body)) return false;
      const busy = document.querySelector('.skeleton');
      const done = document.querySelectorAll('.pcard').length > 0 || document.querySelector('.infeasible');
      return !busy && done;
    })()`,
    timeout,
    '推荐结果',
  );
  await sleep(260);
}

/* ---------------- 启动 ---------------- */
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL_ });
await waitFor('window.__productReady === true', 30000, '产品页就绪');

await ev(`(() => {
  if (window.__reqs) return true;
  const orig = window.fetch.bind(window);
  window.__reqs = [];
  window.fetch = (u, o) => {
    const item = { url: String(u), body: null, t: Date.now() };
    try { if (o && o.body) item.body = JSON.parse(o.body); } catch {}
    window.__reqs.push(item);
    return orig(u, o);
  };
  return true;
})()`);

/* ---------- 1) 自然语言 → 需求理解 → 直接出推荐 ---------- */
await step('1) 解析结果正确回填到条件面板', async () => {
  await ev(`(() => { document.getElementById('q').value = '预算 40 元，想吃高蛋白，热量不超过 750 大卡，最好有无糖饮料'; document.getElementById('askBtn').click(); return true; })()`);
  // 第五阶段：默认视图是「需求理解」，高级条件面板收起在「微调条件」后面
  await waitFor("!document.getElementById('understanding').classList.contains('hidden')", 60000, '需求理解出现');
  await ev(`document.getElementById('advToggle').click()`);
  await waitFor("!document.getElementById('constraintsPanel').classList.contains('hidden')", 10000, '高级面板可展开');
  await ev(`document.getElementById('advToggle').click()`);
  await waitResult('(b) => b.constraints.budgetMax === 40');
  const f = await ev(`(() => ({
    budget: document.getElementById('in-budgetMax').value,
    budgetOn: document.getElementById('on-budgetMax').checked,
    kcal: document.getElementById('in-caloriesMax').value,
    protein: document.getElementById('in-proteinMin').value,
    objectives: Array.from(document.querySelectorAll('#objectiveChips input:checked')).map((x) => x.value),
    prefs: Array.from(document.querySelectorAll('#prefChips .chip-static')).map((x) => x.textContent.replace('×', '').trim()),
  }))()`);
  const cards = await ev("Array.from(document.querySelectorAll('.pcard')).map((c) => +c.dataset.price)");
  rec(
    '1) 解析结果正确回填到条件面板',
    f.budget === '40' && f.budgetOn && f.kcal === '750' && f.protein === '' && f.objectives.includes('protein:max') && cards.length >= 2,
    `预算=${f.budget} 热量上限=${f.kcal} 蛋白下限=${f.protein || '未设置'} 目标=${f.objectives.join(',')} 偏好=${f.prefs.join(',')} 方案=${cards.length}套`,
  );
});

/* ---------- 2) 收紧预算 → 重新搜索（不是筛旧结果） ---------- */
await step('2) 改预算后重新搜索并核价', async () => {
  const before = await ev("Array.from(document.querySelectorAll('.pcard')).map((c) => +c.dataset.price)");
  await ev(APPLY({ nums: { budgetMax: 22 } }));
  await waitResult('(b) => b.constraints.budgetMax === 22');
  const after = await ev("Array.from(document.querySelectorAll('.pcard')).map((c) => +c.dataset.price)");
  const infeasible = await ev("!!document.querySelector('.infeasible')");
  rec(
    '2) 改预算后重新搜索并核价（不是过滤旧推荐）',
    Math.max(...before) > 2200 && (infeasible || (after.length > 0 && Math.max(...after) <= 2200)),
    `改前最高 ${Math.max(...before) / 100} 元 → 改后 ${infeasible ? '该预算下无可行方案' : `最高 ${Math.max(...after) / 100} 元`}`,
  );
});

/* ---------- 3) 蛋白质目标变化 → 可行性变化 ---------- */
await step('3) 改蛋白质下限后结果随之更新', async () => {
  await ev(APPLY({ nums: { budgetMax: 45, proteinMin: 35 } }));
  await waitResult('(b) => b.constraints.budgetMax === 45 && b.constraints.proteinMin === 35');
  const r = await ev(`(() => ({
    infeasible: !!document.querySelector('.infeasible'),
    proteins: Array.from(document.querySelectorAll('.pcard')).map((c) => +c.dataset.protein),
  }))()`);
  rec(
    '3) 蛋白下限 35g 后所有方案达标（或明确告知不可行）',
    r.infeasible || (r.proteins.length > 0 && r.proteins.every((p) => p >= 35)),
    r.infeasible ? '判定不可行并给出解释' : `方案蛋白=${JSON.stringify(r.proteins)}`,
  );
});

/* ---------- 4) 热量上限 ≠ 追求最低热量 ---------- */
await step('4) 只设热量上限时不会把"更低热量"当优化目标', async () => {
  await ev(APPLY({ nums: { proteinMin: null, caloriesMax: 800 }, objectives: ['protein:max'] }));
  await waitResult('(b) => b.constraints.caloriesMax === 800');
  const dims = await ev(`(() => { const a = window.__reqs.filter((r) => r.url.includes('/api/recommend')); return a[a.length-1].body.constraints.objectives.map((o) => o.metric + ':' + o.direction); })()`);
  rec('4) 只设热量上限时不会把"更低热量"当优化目标', !dims.some((d) => d === 'calories:min'), `请求 objectives=${JSON.stringify(dims)}`);
});

/* ---------- 准备：含饮料的正餐场景，确保有套餐方案 ---------- */
await step('准备套餐场景', async () => {
  await ev(APPLY({ nums: { budgetMax: 45, proteinMin: null, caloriesMax: null }, objectives: [], required: ['drink'] }));
  await waitResult('(b) => b.constraints.budgetMax === 45 && b.constraints.requiredCategories.includes("drink") && b.constraints.objectives.length === 0');
  const hasMeal = await ev("Array.from(document.querySelectorAll('.pcard')).some((c) => c.dataset.kind === 'meal')");
  if (!hasMeal) throw new Error('当前结果里没有套餐方案');
});

/* ---------- 5/6) 套餐规格替换 ---------- */
const snapDrawer = () =>
  ev(`(() => ({
    price: document.querySelector('#drawerContent .price-line b')?.textContent,
    kcal: document.querySelectorAll('#drawerContent .nutri-grid b')[0]?.textContent,
    trace: (document.querySelector('#drawerContent .prov')?.textContent || '').slice(0, 26),
  }))()`);

/**
 * 在推荐列表里逐套打开套餐，找到含指定选项的那一轮并切换。
 * 门店的轮次名称不统一（有「选择套餐内饮料」也有「粉区」「红区」），所以按选项文本找。
 */
async function swapInAnyMeal(optionText) {
  const n = await ev(`document.querySelectorAll('.pcard[data-kind=\"meal\"]').length`);
  for (let i = 0; i < n; i += 1) {
    await ev(`document.querySelectorAll('.pcard[data-kind=\"meal\"]')[${i}].querySelector('[data-detail]').click()`);
    try {
      await waitFor("document.querySelectorAll('#drawerContent select[data-round]').length > 0", 20000, '抽屉选项');
    } catch {
      await ev(`document.querySelector('#drawer [data-close]').click()`);
      await sleep(200);
      continue;
    }
    const hit = await ev(`(() => {
      for (const sel of document.querySelectorAll('#drawerContent select[data-round]')) {
        const opts = Array.from(sel.options);
        const target = opts.find((o) => o.textContent.trim().startsWith(` + JSON.stringify(optionText) + `));
        if (target) return { round: sel.dataset.round, current: sel.value, target: target.value, label: target.textContent, name: target.textContent };
      }
      return null;
    })()`);
    if (!hit) {
      await ev(`document.querySelector('#drawer [data-close]').click()`);
      await sleep(200);
      continue;
    }
    const before = await snapDrawer();
    // 若当前已经是目标项，先切到同轮另一个选项，再切回来，确保观察到的是一次真实变更
    if (hit.current === hit.target) {
      await ev(`(() => {
        const sel = document.querySelector('#drawerContent select[data-round="${hit.round}"]');
        const other = Array.from(sel.options).find((o) => o.value !== sel.value);
        sel.value = other.value; sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await sleep(1200);
    }
    const mid = await snapDrawer();
    await ev(`(() => {
      const sel = document.querySelector('#drawerContent select[data-round="${hit.round}"]');
      sel.value = '${hit.target}'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    const outcome = await waitFor(
      `(() => {
        const e = document.querySelector('#drawerContent .price-line b');
        const cl = document.querySelector('#checkList')?.textContent || '';
        if (e && e.textContent !== '${mid.price}') return 'changed';
        if (cl.includes('失败')) return 'error:' + cl.slice(0, 140);
        return '';
      })()`,
      30000,
      '换规格结果',
    );
    if (String(outcome).startsWith('error:')) throw new Error(String(outcome).slice(6));
    const after = await snapDrawer();
    return { before, mid, after, hit, index: i };
  }
  return null;
}

await step('5) 中杯可乐 → 大杯可乐', async () => {
  const r = await swapInAnyMeal('可乐大杯');
  if (!r) throw new Error('推荐结果里没有含可乐大杯选项的套餐');
  rec(
    '5) 中杯可乐 → 大杯可乐：营养与价格由服务端重算',
    r.after.price !== r.mid.price && Number(r.after.kcal) > Number(r.mid.kcal),
    `${r.mid.price}/${r.mid.kcal}kcal → ${r.after.price}/${r.after.kcal}kcal（${r.after.trace}）`,
  );
});

await step('6) 中薯条 → 大薯条', async () => {
  // 复用同一套套餐；如果第 5 步已切到别的套餐，这里重新打开一次
  const r = await swapInAnyMeal('大薯条');
  if (!r) throw new Error('推荐结果里没有含大薯条选项的套餐');
  rec(
    '6) 中薯条 → 大薯条：营养与价格由服务端重算',
    r.after.price !== r.mid.price && Number(r.after.kcal) > Number(r.mid.kcal),
    `${r.mid.price}/${r.mid.kcal}kcal → ${r.after.price}/${r.after.kcal}kcal`,
  );
  await shot('product-drawer.png', false);
});

/* ---------- 8) 特制营养提示 ---------- */

await step('6b) 连续改两个 round：先改的不会被后改的覆盖', async () => {
  // 在当前打开的抽屉里找两个有多个选项的轮次
  const picks = await ev(`(() => {
    const sels = Array.from(document.querySelectorAll('#drawerContent select[data-round]')).filter((x) => x.options.length > 1);
    if (sels.length < 2) return null;
    return sels.slice(0, 2).map((s) => {
      const alt = Array.from(s.options).find((o) => o.value !== s.value);
      return { round: s.dataset.round, alt: alt.value, altText: alt.textContent.trim().slice(0, 12) };
    });
  })()`);
  if (!picks) throw new Error('当前套餐没有两个可调整的轮次');

  const snap = () =>
    ev(`(() => ({
      prov: document.querySelector('#drawerContent .prov')?.textContent || '',
      price: document.querySelector('#drawerContent .price-line b').textContent,
      kcal: Number(document.querySelectorAll('#drawerContent .nutri-grid b')[0].textContent),
      sel: Object.fromEntries(Array.from(document.querySelectorAll('#drawerContent select[data-round]')).map((s) => [s.dataset.round, s.value])),
    }))()`);

  const waitProv = (prev, label) =>
    waitFor(
      `(() => {
        const p = document.querySelector('#drawerContent .prov')?.textContent || '';
        const cl = document.querySelector('#checkList')?.textContent || '';
        if (p && p !== '${prev}') return 'changed';
        if (cl.includes('失败')) return 'error:' + cl.slice(0, 120);
        return '';
      })()`,
      30000,
      label,
    );

  const change = (round, value) =>
    ev(`(() => {
      const sel = document.querySelector('#drawerContent select[data-round="${round}"]');
      sel.value = '${value}';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return sel.value;
    })()`);

  const base = await snap();
  // 第一次改动
  await change(picks[0].round, picks[0].alt);
  const o1 = await waitProv(base.prov, '第一次改规格');
  if (String(o1).startsWith('error:')) throw new Error(String(o1).slice(6));
  const s1 = await snap();

  // 第二次改动（应当保留第一次的选择）
  await change(picks[1].round, picks[1].alt);
  const o2 = await waitProv(s1.prov, '第二次改规格');
  if (String(o2).startsWith('error:')) throw new Error(String(o2).slice(6));
  const s2 = await snap();

  const kept = s2.sel[picks[0].round] === picks[0].alt;
  const secondOk = s2.sel[picks[1].round] === picks[1].alt;

  rec(
    '6b) 连续改两个 round：第一项改动被保留，两项叠加后重新核价',
    kept && secondOk,
    `${base.price}/${base.kcal}kcal → ${s1.kcal}kcal → ${s2.price}/${s2.kcal}kcal；第一项保留=${kept}（${picks[0].altText}），第二项生效=${secondOk}`,
  );
});

await step('8) 特制选项营养不可算提示', async () => {
  const box = await ev(`(() => { const b = document.querySelector('#drawerContent .mod-box'); return b ? b.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
  rec('8) 去酱/去冰等特制不显示伪精确营养，明确标注无法计算', Boolean(box && box.includes('无法计算')), box ? box.slice(0, 76) : '未出现提示');
});

/* ---------- 7) 非法 rounds ---------- */
await step('7) 非法 rounds 被后端拒绝', async () => {
  const r = await ev(`(async () => {
    const res = await fetch('/api/plan/rebuild', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      productCode: '9900005460',
      choices: [{ round: '1', code: '1600' }, { round: '2', code: '4810' }, { round: '3', code: '4820' }],
    })});
    const j = await res.json();
    return { status: res.status, code: j.error?.code };
  })()`);
  rec('7) 非法 rounds 组合被后端拒绝', r.status === 400 && r.code === 'illegal_choice', `${r.status} ${r.code}`);
});

/* ---------- 9) 违反硬约束的标注 ---------- */
await step('9) 违反硬约束时逐项标注', async () => {
  const v = await ev(`(async () => {
    const res = await fetch('/api/plan/rebuild', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      productCode: '9900005460',
      choices: [{ round: '1', code: '1600' }, { round: '2', code: '4820' }, { round: '3', code: '3100' }],
      constraints: { budgetMax: 10, proteinMin: 50 },
    })});
    const j = await res.json();
    return j.checks?.violations || [];
  })()`);
  const budget = v.find((x) => x.key === 'budgetMax');
  const protein = v.find((x) => x.key === 'proteinMin');
  rec(
    '9) 方案违反硬约束时逐项标注超出量',
    Boolean(budget && budget.excessFen > 0 && protein && protein.shortfall > 0),
    v.map((x) => x.detail).join(' / ') || '无',
  );
});

/* ---------- 10) 不可行解释只含已启用约束 ---------- */
await step('10) 不可行解释只针对已启用约束', async () => {
  await ev(`document.querySelector('#drawer [data-close]').click()`);
  await sleep(200);
  await ev(APPLY({ nums: { budgetMax: 12, proteinMin: 45, caloriesMax: null }, objectives: [], required: ['drink'] }));
  await waitResult('(b) => b.constraints.budgetMax === 12 && b.constraints.proteinMin === 45');
  const r = await ev(`(() => {
    const box = document.querySelector('.infeasible');
    if (!box) return null;
    return {
      relax: Array.from(box.querySelectorAll('.relax-item b')).map((x) => x.textContent),
      enabled: (box.textContent.match(/你启用的硬约束：([^。]+)/) || [])[1] || '',
      hasAlt: !!box.querySelector('.alt-table'),
    };
  })()`);
  await shot('product-infeasible.png');
  const badRelax = r ? r.relax.filter((t) => t.includes('热量上限')) : ['没有不可行面板'];
  rec(
    '10) 不可行解释只包含用户实际启用的限制',
    Boolean(r) && badRelax.length === 0 && r.hasAlt,
    r ? `启用=${r.enabled}｜放宽=${r.relax.join('、')}｜近似方案表=${r.hasAlt}` : '未出现不可行面板',
  );
});

/* ---------- 11) 标签准确性 ---------- */
await step('11) "最省钱"标签只给真实最低价', async () => {
  await ev(APPLY({ nums: { budgetMax: 40, proteinMin: 30, caloriesMax: null }, objectives: ['protein:max'], required: [] }));
  await waitResult('(b) => b.constraints.budgetMax === 40 && b.constraints.proteinMin === 30');
  const labels = await ev(`(() => {
    const cards = Array.from(document.querySelectorAll('.pcard'));
    const prices = cards.map((c) => +c.dataset.price);
    const min = Math.min(...prices);
    return cards.map((c) => ({ label: c.querySelector('.pcard-label').textContent.trim(), price: +c.dataset.price, min }));
  })()`);
  const cheapest = labels.filter((l) => l.label.includes('最省'));
  rec(
    '11) "最省钱"标签只出现在真实最低价方案上',
    labels.length >= 2 && cheapest.length >= 1 && cheapest.every((l) => l.price === l.min),
    labels.map((l) => `${l.label}@${l.price / 100}`).join(' | '),
  );
});

/* ---------- 比较 ---------- */
await step('比较两套方案', async () => {
  await ev("document.querySelectorAll('[data-cmp]')[0].click()"); await sleep(150); await ev("document.querySelectorAll('[data-cmp]')[1].click()");
  await waitFor("document.querySelector('.compare-bar .cmp-table')", 30000, '对比表');
  const txt = await ev("document.querySelector('.cmp-summary')?.textContent");
  const rows = await ev("document.querySelectorAll('.compare-bar .cmp-table tbody tr').length");
  rec('比较：价差 / 热量差 / 蛋白差来自真实方案', Boolean(txt) && rows === 3, `${rows} 行｜${txt}`);
  await shot('product-desktop.png');
});

/* ---------- 12) 快速连续输入 ---------- */
await step('12) 快速连续改值不出现旧结果覆盖', async () => {
  const mark = await ev('window.__reqs.length');
  for (const v of [30, 55, 45]) {
    await ev(APPLY({ nums: { budgetMax: v } }));
    await sleep(110);
  }
  await waitResult('(b) => b.constraints.budgetMax === 45');
  await sleep(1500);
  const stats = await ev(`(() => {
    const arr = window.__reqs.slice(${mark}).filter((r) => r.url.includes('/api/recommend')).map((r) => r.body.constraints.budgetMax);
    const cards = Array.from(document.querySelectorAll('.pcard')).map((c) => +c.dataset.price);
    return { sent: arr, finalInput: document.getElementById('in-budgetMax').value, maxCard: cards.length ? Math.max(...cards) : null, cards: cards.length };
  })()`);
  rec(
    '12) 快速连续改预算：最终显示与最后一次输入一致（旧响应被丢弃）',
    stats.finalInput === '45' && stats.cards > 0 && stats.maxCard <= 4500,
    `发出预算=${JSON.stringify(stats.sent)}，最终输入=${stats.finalInput}，最高价=${stats.maxCard / 100} 元`,
  );
});

/* ---------- 13) 移动端 ---------- */
await step('13) 移动端（390×844）基本流程', async () => {
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: URL_ });
  await waitFor('window.__productReady === true', 30000, '移动端就绪');
  await ev(`(() => {
    const orig = window.fetch.bind(window); window.__reqs = [];
    window.fetch = (u, o) => { const i = { url: String(u), body: null }; try { if (o && o.body) i.body = JSON.parse(o.body); } catch {} window.__reqs.push(i); return orig(u, o); };
    return true;
  })()`);
  await ev(`(() => { document.getElementById('q').value = '30 元以内，要一顿正餐，必须有饮料'; document.getElementById('askBtn').click(); return true; })()`);
  await waitFor("document.querySelectorAll('.pcard').length > 0", 90000, '移动端方案');
  await shot('product-mobile.png');
  const layout = await ev(`(() => {
    const c = document.querySelector('.pcard').getBoundingClientRect();
    return { vw: window.innerWidth, cardW: Math.round(c.width), overflow: document.documentElement.scrollWidth > window.innerWidth + 2, cards: document.querySelectorAll('.pcard').length };
  })()`);
  rec(
    '13) 移动端可完成配餐且无横向溢出',
    layout.cards > 0 && layout.cardW > 300 && !layout.overflow,
    `视口 ${layout.vw}px，卡片 ${layout.cardW}px，横向溢出=${layout.overflow}，方案 ${layout.cards} 套`,
  );
  await ev(`document.querySelector('.pcard [data-detail]').click()`);
  await waitFor("!document.getElementById('drawer').classList.contains('hidden')", 30000, '移动端抽屉');
  const sheet = await ev(`(() => { const b = document.querySelector('.drawer-body').getBoundingClientRect(); return { w: Math.round(b.width), vw: window.innerWidth }; })()`);
  rec('13b) 移动端详情为底部全宽抽屉', sheet.w >= sheet.vw - 2, `抽屉宽 ${sheet.w}px / 视口 ${sheet.vw}px`);
  await sleep(600); // 等抽屉弹出动画结束，避免截到半透明中间态
  await shot('product-mobile-drawer.png', false);
});

/* ---------- 14) 前端无密钥 ---------- */
await step('14) 前端不含 Token / 模型密钥', async () => {
  const bad = await ev(`(async () => {
    const parts = await Promise.all(['/', '/product.js', '/product.css'].map((u) => fetch(u).then((r) => r.text())));
    return /Bearer\\s+[A-Za-z0-9._-]{10,}|sk-[A-Za-z0-9]{10,}|2WSkTAsMzM5/.test(parts.join('\\n'));
  })()`);
  rec('14) 前端源码与响应不含 Token / 密钥', bad === false, bad ? '发现疑似密钥' : '未发现');
});

/* ---------- 15) 第五阶段验收：问题现场原话 → 日常推荐 ---------- */
await step('15) 场景B：肚子不舒服/不辣不冰/60元套餐 → 直接给日常推荐', async () => {
  // 回到桌面视口并重开页面，保证截图与断言环境干净（step 13 留下的是移动端+抽屉态）
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_ });
  await waitFor('window.__productReady === true', 30000, '产品页就绪');
  await ev(`(() => {
    const orig = window.fetch.bind(window); window.__reqs = [];
    window.fetch = (u, o) => { const i = { url: String(u), body: null, t: Date.now() }; try { if (o && o.body) i.body = JSON.parse(o.body); } catch {} window.__reqs.push(i); return orig(u, o); };
    return true;
  })()`);
  // 问题现场原话（验收标准原文），不做任何改写
  await ev(`(() => { document.getElementById('q').value = '最近肚子有点不舒服，不是很喜欢吃油的，也不喜欢吃辣的吃冰的，你给我推荐一个60元的套餐。'; document.getElementById('askBtn').click(); return true; })()`);
  await waitResult('(b) => typeof b.text === "string" && b.text.includes("60元")');
  const r = await ev(`(() => {
    const chips = Array.from(document.querySelectorAll('#undChips .chip-und')).map((x) => x.textContent.trim());
    const hero = document.querySelectorAll('.pcard-hero').length;
    const alts = document.querySelectorAll('.pcard:not(.pcard-hero)').length;
    const cau = document.querySelector('.daily-cautions p');
    const cautionsFont = cau ? parseFloat(getComputedStyle(cau).fontSize) : null;
    // 「大黄色警告框」检查：#results 内饱和黄底且高度 ≥40px 的块
    const yellowBoxes = Array.from(document.querySelectorAll('#results *')).filter((el) => {
      const m = getComputedStyle(el).backgroundColor.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
      if (!m) return false;
      return +m[1] > 200 && +m[2] > 150 && +m[3] < 120 && el.offsetHeight > 40;
    }).length;
    const clarify = document.getElementById('clarifyInline');
    const arr = window.__reqs.filter((x) => x.url.includes('/api/recommend'));
    const body = arr[arr.length - 1]?.body || {};
    return {
      chips, hero, alts, cautionsFont, yellowBoxes,
      clarifyShown: !!clarify && !clarify.classList.contains('hidden'),
      reqText: typeof body.text === 'string' ? body.text : '',
      budgetIntent: body.constraints?.budgetIntent || null,
      prefs: body.constraints?.preferences || null,
    };
  })()`);
  await shot('product-daily.png');
  const spicy = r.prefs?.avoidSpicy || '无';
  rec(
    '15) 问题现场原话直接得到日常推荐（标签/主推备选/小字提示/预算意图）',
    r.chips.some((t) => t.includes('60')) && r.chips.length >= 2
      && r.hero === 1 && r.alts >= 1 && r.alts <= 2
      && r.cautionsFont !== null && r.cautionsFont <= 13 && r.yellowBoxes === 0
      && !r.clarifyShown
      && r.reqText.includes('60元') && r.budgetIntent === 'target_with_cap'
      && ['soft', 'hard'].includes(spicy),
    `标签=${r.chips.join('、') || '无'}｜主推=${r.hero} 备选=${r.alts}｜提示字号=${r.cautionsFont}px 黄框=${r.yellowBoxes}｜反问=${r.clarifyShown ? '有' : '无'}｜budgetIntent=${r.budgetIntent} 辣=${spicy}`,
  );
});

rec('页面无 JS 运行时错误', pageErrors.length === 0, pageErrors.length ? pageErrors.slice(0, 2).join(' | ') : '无');

const failed = checks.filter((c) => !c.pass).length;
console.log(`\n产品页交互测试：${checks.length - failed}/${checks.length} 通过`);
ws.close();
proc.kill();
await sleep(300);
try {
  fs.rmSync(userDir, { recursive: true, force: true });
} catch {}
process.exit(failed ? 1 : 0);
