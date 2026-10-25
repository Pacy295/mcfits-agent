/**
 * 性能专项 · 修复效果针对性复验（A/B 全量对照暴露的 3 个问题 + 输出上限模式感知）。
 *
 * 复验目标：
 * 1. 「百元以内」中文数字反幻觉盲区修复 → budgetMax=100 不再被清空
 * 2. budgetIntent 有限条件回退（词面证据纠正模型误判）→
 *    「越便宜越好，20块以内」→ minimize；「60元左右」不越级为 minimize（双向保护）
 * 3. 错误分类结构化（禁止 undefined 充当错误原因）→ 网络失败 kind='network'（非 undefined）
 * 4. 输出上限模式感知 → 关思考默认 600 / 开思考默认 900（isThinkingDisabled）
 *
 * 用法：node scripts/verify-perf-fixes.mjs
 * 输出：逐项 PASS/FAIL + 退出码（任一失败为 1）。
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWithLlm } from '../src/parse/llm-parser.js';
import { normalizeConstraints, numbersInText } from '../src/parse/schema.js';
import { isThinkingDisabled } from '../src/llm/provider.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
function mark(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---- 0. 离线：中文数字反幻觉覆盖 ----
{
  const nums = numbersInText('百元以内吃顿好的');
  mark('中文数字「百元以内」识别 100', nums.has(100), `numbersInText=${[...nums].join(',')}`);
  const n2 = numbersInText('三百块预算');
  mark('「三百块」识别 300', n2.has(300), `numbersInText=${[...n2].join(',')}`);
  const n3 = numbersInText('百货商场百分百满意');
  mark('「百货/百分百」不误入计数', !n3.has(100), `numbersInText=${[...n3].join(',')}`);
}

// ---- 0b. 离线：输出上限模式感知 ----
{
  const def = isThinkingDisabled(); // 默认（未设 MCFIT_LLM_THINKING）→ 关思考 → true
  process.env.MCFIT_LLM_THINKING = 'enabled';
  const enabled = isThinkingDisabled();
  delete process.env.MCFIT_LLM_THINKING;
  mark('模式感知：默认关思考→600 档', def === true, `isThinkingDisabled()=${def}`);
  mark('模式感知：enabled→900 档', enabled === false, `isThinkingDisabled()=${enabled}`);
}

// ---- 1+2. 端到端（B 模式，绕过应用层缓存直接走模型层）----
const CASES = [
  { t: '百元以内吃顿好的。', expect: (c) => c.budgetMax === 100, desc: 'budgetMax=100' },
  { t: '越便宜越好，20块以内。', expect: (c) => c.budgetMax === 20 && c.budgetIntent === 'minimize', desc: 'budgetMax=20 & budgetIntent=minimize' },
  { t: '60元左右，推荐一顿饭。', expect: (c) => c.budgetMax === 60 && c.budgetIntent !== 'minimize', desc: 'budgetMax=60 & budgetIntent≠minimize（不越级）' },
  { t: '大概五六十块钱吧。', expect: (c) => c.budgetIntent !== 'minimize', desc: 'budgetIntent≠minimize（目标价保护）' },
];

process.env.MCFIT_LLM_THINKING = 'disabled';
for (const item of CASES) {
  try {
    const r = await parseWithLlm(item.t);
    const n = normalizeConstraints(r.raw, item.t, { parseSource: 'llm' });
    const c = n.constraints;
    mark(`解析「${item.t}」→ ${item.desc}`, item.expect(c),
      `budgetMax=${c.budgetMax} budgetIntent=${c.budgetIntent} model=${r.model}`);
  } catch (err) {
    mark(`解析「${item.t}」→ ${item.desc}`, false, `调用失败：${err.kind || 'error'}: ${err.message}`);
  }
}

// ---- 3. 错误分类结构化（强制网络失败）----
// 注意：config.llm.allowLocalConfig 在模块加载时求值，运行中改 env 无效，
// 故用子进程在加载前注入 env（仅不可达候选、禁用本地 fallback），chat() 必失败。
{
  const child = `
    import { chat, llmErrorLog } from './src/llm/provider.js';
    try {
      await chat({ messages: [{ role: 'user', content: 'x' }], maxTokens: 8, timeoutMs: 5000 });
      console.log(JSON.stringify({ threw: false }));
    } catch (err) {
      const log = llmErrorLog();
      console.log(JSON.stringify({ threw: true, kind: err.kind ?? null, message: err.message, logKinds: log.map((e) => e.kind) }));
    }
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', child], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      MCFIT_LLM_ALLOW_LOCAL: '0',
      MCFIT_LLM_BASE_URL: 'http://127.0.0.1:9/v1', // 不可达端口，快速连接失败
      MCFIT_LLM_API_KEY: 'verify-not-a-real-key',
    },
  });
  const r = JSON.parse(out.trim().split('\n').pop());
  // 单候选失败时 chat() 按分类法抛 all_failed（内层 network 在消息/日志中结构化呈现）；
  // 直接来自 post() 的则是 network/timeout。三者均属结构化 kind，重点是不得出现 undefined。
  const kindOk = r.threw && ['network', 'timeout', 'all_failed'].includes(r.kind);
  const noUndefined = r.threw && r.kind != null && !String(r.message).includes('undefined')
    && (r.kind !== 'all_failed' || /\((network|timeout|http)\)/.test(r.message));
  mark('网络失败抛结构化 LlmError', kindOk && noUndefined, `threw=${r.threw} kind=${r.kind} message=${r.message}`);
  mark('错误日志 kind 已填充（无 undefined）',
    r.threw && Array.isArray(r.logKinds) && r.logKinds.length > 0 && r.logKinds.every((k) => k != null && String(k) !== 'undefined'),
    `logKinds=${JSON.stringify(r.logKinds)}`);
}

// ---- 汇总 ----
const failed = results.filter((r) => !r.ok);
console.log(`\n复验完成：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
