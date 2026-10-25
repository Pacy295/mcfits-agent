/**
 * UI 冒烟测试：用无头 Chrome + CDP 真实点击「核价」按钮，验证前端到后端到 MCP 的完整链路。
 * 用法: node scripts/ui-smoke.mjs [url]
 * 产出: .shots/ui-price.png + 控制台断言结果
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

const kcal = await waitFor("(() => { const v=document.getElementById('kcalValue')?.textContent; return v && v!=='—' ? v : ''; })()", 30000, '营养合计渲染');
record('前端渲染营养合计（默认组合）', true, `${kcal} kcal`);

const priceCells = await evaluate("document.querySelectorAll('#productRows tr').length");
record('商品表渲染', priceCells > 50, `${priceCells} 行`);

// 切到大薯条（round 2）
await evaluate(`(() => {
  const sel = document.querySelector('select[data-round="2"]');
  const opt = [...sel.options].find(o => o.textContent.includes('大薯条'));
  sel.value = opt.value;
  sel.dispatchEvent(new Event('change'));
  return opt.textContent;
})()`);
const kcal2 = await waitFor(
  `(() => { const v=document.getElementById('kcalValue')?.textContent; return v && v!=='—' && v!=='${kcal}' ? v : ''; })()`,
  15000,
  '换大薯条后重算',
);
record('切换大薯条后营养重算（应为 851）', String(kcal2) === '851', `${kcal} → ${kcal2} kcal`);

// 再切换到大杯可乐（round 3），单测 838
await evaluate(`(() => {
  const sel2 = document.querySelector('select[data-round="2"]');
  const mid = [...sel2.options].find(o => o.textContent.includes('中薯条'));
  sel2.value = mid.value; sel2.dispatchEvent(new Event('change'));
  const sel3 = document.querySelector('select[data-round="3"]');
  const big = [...sel3.options].find(o => o.textContent.includes('可乐大杯'));
  sel3.value = big.value; sel3.dispatchEvent(new Event('change'));
  return true;
})()`);
const kcal3 = await waitFor(
  `(() => { const v=document.getElementById('kcalValue')?.textContent; return v && v==='838' ? v : ''; })()`,
  15000,
  '换成大杯可乐后重算',
);
record('切换大杯可乐后营养重算（应为 838）', String(kcal3) === '838', `838 kcal`);

// 切回默认组合，便于截图展示基线
await evaluate(`(() => {
  const s3 = document.querySelector('select[data-round="3"]');
  const mid = [...s3.options].find(o => o.textContent.includes('可乐中杯'));
  s3.value = mid.value; s3.dispatchEvent(new Event('change'));
  return true;
})()`);
await waitFor(`(() => document.getElementById('kcalValue')?.textContent === '761' ? '1' : '')`, 15000, '回到默认组合');

// 点击核价
await evaluate("document.getElementById('priceBtn').click(); true");
const priceText = await waitFor(
  "(() => { const t=document.getElementById('priceOut')?.innerText || ''; return /¥|失败/.test(t) ? t : ''; })()",
  25000,
  '核价结果',
);
const valued = /¥\d/.test(priceText);
record('点击核价拿到 MCP 实算价格', valued, priceText.replace(/\s+/g, ' ').slice(0, 120));

// 截图
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
const shotPath = path.join(SHOT_DIR, 'ui-price.png');
fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
console.log(`截图：${shotPath}`);

record('页面无 JS 运行时错误', consoleErrors.length === 0, consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : '无');

ws.close();
proc.kill();
await sleep(400);
try {
  fs.rmSync(userDir, { recursive: true, force: true });
} catch {
  /* ignore */
}
const failed = checks.filter((c) => !c.pass).length;
console.log(`\nUI 冒烟：${checks.length - failed}/${checks.length} 通过`);
process.exit(failed ? 1 : 0);
