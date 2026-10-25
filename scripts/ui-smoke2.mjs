/**
 * 第二阶段 UI 冒烟：解析需求 → 回填可编辑约束 → 生成方案 → 两两对比。
 * 用法: node scripts/ui-smoke2.mjs [url]
 * 产出: .shots/s2-flow.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'http://localhost:5173/console.html';
const PORT = 9333;
const SHOT_DIR = path.join(process.cwd(), '.shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error('未找到 Chrome/Edge，跳过 UI 冒烟测试');
  process.exit(0);
}

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfits-cdp-'));
const proc = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDir}`,
    '--window-size=1440,1400',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 端口还没起来 */
    }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

const wsUrl = await getWsUrl();
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true });
  ws.addEventListener('error', j, { once: true });
});

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params.exceptionDetails?.exception?.description || 'unknown exception');
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  }
});

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed');
  return r.result?.value;
}

async function waitFor(expression, timeoutMs = 25000, label = expression) {
  const t0 = Date.now();
  for (;;) {
    const v = await evaluate(expression);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`);
    await sleep(200);
  }
}

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: URL_ });


const checks = [];
const record = (name, pass, detail) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
};

// 0) 等待第二阶段脚本就绪
await waitFor('window.__s2ready === true', 30000, 'stage2 脚本就绪');
// 1) 解析需求
await evaluate("document.getElementById('parseBtn').click(); true");
await waitFor("(() => { const f=document.getElementById('constraintForm'); return f && !f.classList.contains('hidden'); })()", 60000, '约束表单出现');
const budget = await evaluate("document.getElementById('fBudget').value");
const protein = await evaluate("document.getElementById('fProteinMin').value");
const kcalMax = await evaluate("document.getElementById('fKcalMax').value");
record('解析后回填可编辑约束', budget === '40' && protein === '30' && kcalMax === '750', `预算=${budget} 蛋白下限=${protein} 热量上限=${kcalMax}`);

// 2) 生成方案
await evaluate("document.getElementById('recBtn').click(); true");
const planCount = await waitFor("(() => { const n=document.querySelectorAll('.plan').length; return n>0 ? n : (document.querySelector('.infeasible') ? 'infeasible' : 0); })()", 90000, '方案渲染');
record('生成多套方案', planCount !== 'infeasible' && Number(planCount) >= 2, `${planCount} 套方案`);

// 3) 校验每套方案都有真实核价 traceId 与营养
const planInfo = await evaluate(
  "Array.from(document.querySelectorAll('.plan')).map((p) => ({ id: p.dataset.id, price: (p.querySelector('.plan-price')?.childNodes[0]?.textContent || '').trim(), macros: Array.from(p.querySelectorAll('.plan-macros b')).map((b) => b.textContent), trace: (/traceId (\\w+)/.exec(p.querySelector('footer')?.textContent || '') || [])[1] }))",
);
const allPriced = planInfo.every((p) => /¥\d/.test(p.price) && Boolean(p.trace) && p.macros.length === 4);
record('每套方案都有核价金额/traceId/四项营养', allPriced, JSON.stringify(planInfo).slice(0, 220));

// 4) 两两对比
await evaluate("(() => { const b=document.querySelectorAll('.pick'); b[0]?.click(); b[1]?.click(); return true; })()");
await waitFor("(() => { const c=document.getElementById('compareOut'); return c && !c.classList.contains('hidden') && c.querySelector('table.cmp'); })()", 30000, '对比表出现');
const cmpText = await evaluate("document.querySelector('.cmp-summary')?.textContent");
record('两方案差异对比（真实数值相减）', Boolean(cmpText), cmpText);

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
fs.writeFileSync(path.join(SHOT_DIR, 's2-flow.png'), Buffer.from(shot.data, 'base64'));
console.log('截图：' + path.join(SHOT_DIR, 's2-flow.png'));
record('页面无 JS 运行时错误', consoleErrors.length === 0, consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : '无');

ws.close();
proc.kill();
await sleep(400);
try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
const failed = checks.filter((c) => !c.pass).length;
console.log(`\n第二阶段 UI 冒烟：${checks.length - failed}/${checks.length} 通过`);
process.exit(failed ? 1 : 0);
