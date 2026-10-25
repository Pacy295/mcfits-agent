/**
 * 失败交互分类专项验证（真实用户体验问题修复 · P1）。
 *
 * 覆盖任务书要求：5 类失败各有可行操作，主界面不露 MCP 工具名/错误码/堆栈（只进工程台/诊断详情）：
 * ① 门店菜单不可查 ② 网络失败 ③ 模型解析降级 ④ 无符合条件方案 ⑤ 价格验证失败
 * 并且：禁止只改文案不修真实失败（真实失败路径的修复由 verify-budget-range / store-health 端到端验证覆盖）。
 *
 * 运行：node scripts/verify-failure-ux.mjs
 * 可选：FAILUX_BASE_URL=http://127.0.0.1:5211 时追加真实接口断言（不设则跳过联网部分）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'public', 'product.js'), 'utf8');

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

/** 抽取 humanizeError 函数体做纯文本断言 */
function sliceOf(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  assert.ok(a >= 0 && b > a, `源码中找不到片段：${startMarker}`);
  return src.slice(a, b);
}

console.log('\n[1/2] 源码断言：5 类失败的文案、可行操作与技术信息隔离');

expect('① 门店菜单不可查：人话标题 + 换门店/重试操作 + 诊断进折叠区', () => {
  const fn = sliceOf('function humanizeError', 'function renderError');
  assert.ok(/menu_unavailable/.test(fn), '应识别 menu_unavailable');
  assert.ok(/当前门店暂时无法获取菜单/.test(fn), '主文案应为门店菜单人话');
  assert.ok(/没有符合你要求的套餐/.test(fn), '应明确区分「不是没有符合的套餐」');
  const re = sliceOf('function renderError', '/* ---------------- 门店切换');
  assert.ok(/switch-store/.test(re), '应有换门店入口');
  assert.ok(/<details class="data-note">/.test(re), '诊断详情应折叠');
});

expect('② 网络失败：人话标题 + 重试操作', () => {
  const fn = sliceOf('function humanizeError', 'function renderError');
  assert.ok(/网络不太稳定/.test(fn), '网络类应有人话标题');
  assert.ok(/mcp_network|mcp_http|'network'/.test(fn), '应识别网络类错误');
  const re = sliceOf('function renderError', '/* ---------------- 门店切换');
  assert.ok(/data-act="retry"/.test(re), '应有重试按钮');
});

expect('③ 模型解析降级：说明降级 + 改条件/重试解析两个可行操作', () => {
  const block = sliceOf('if (r.degraded)', '} else if (humanizeWarnings');
  assert.ok(/模型暂时不可用，已按规则理解/.test(block), '应说明已按规则理解');
  assert.ok(/data-act="edit-constraints"/.test(block), '应有「改条件」操作');
  assert.ok(/data-act="reparse"/.test(block), '应有「重试解析」操作');
  // 解析失败路径不再把原始 err.message 直接透出
  const ask = sliceOf('async function ask()', 'function applyParsed');
  assert.ok(!/没听懂<\/span>\$\{esc\(err\.message\)\}/.test(ask), 'ask() 失败不得直接输出 err.message');
  assert.ok(/humanizeError\(err\)/.test(ask), 'ask() 失败应走统一人话分类');
});

expect('④ 无符合条件方案：放宽预算/改条件操作 + 不编造方案', () => {
  assert.ok(/data-act="loosen"/.test(src), '应有「放宽预算」操作');
  assert.ok(/这些条件凑不出一餐/.test(src), '应有不可行人话标题');
  assert.ok(/不是猜的/.test(src), '应声明基于真实已核价候选');
  assert.ok(/系统不会声称已满足/.test(src), '无法验证项不得声称满足');
});

expect('⑤ 价格验证失败：不拿旧价格冒充 + 重试核价操作', () => {
  const block = sliceOf('} catch (err) {', '/* ---------------- 事件绑定');
  assert.ok(/retry-rebuild/.test(block), '应有「重试核价」操作');
  assert.ok(/不会拿旧价格冒充新搭配/.test(block), '应声明旧价格不冒充');
  assert.ok(/没有写回/.test(block), '应声明改动不写回');
  assert.ok(/humanizeError\(err\)/.test(block), '核价失败应走统一人话分类');
  // 失败对象保留分类字段（分类渲染依赖）
  assert.ok(/err\.code = e\.code/.test(src) && /err\.category = e\.category/.test(src), '核价失败错误对象应带分类字段');
});

expect('主界面人话文案不含工具名/错误码/字段名/堆栈', () => {
  const fn = sliceOf('function humanizeError', 'function renderError');
  const literals = [...fn.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] || m[2]).filter((s) => /[一-龥]/.test(s));
  for (const s of literals) {
    assert.ok(!/code=|traceId|query-|mcp_|budgetMax|budgetMin|calories|proteinMin|工具|堆栈|JSON/i.test(s), `人话文案泄露技术细节：${s}`);
  }
});

expect('诊断信息（工具名/业务码/traceId/门店证据）只进折叠区', () => {
  const re = sliceOf('function renderError', '/* ---------------- 门店切换');
  // detailBits 拼接只出现在 <details> 模板里
  const detailsIdx = re.indexOf('<details class="data-note">');
  const bitsIdx = re.indexOf('detailBits.join');
  assert.ok(detailsIdx >= 0 && bitsIdx > detailsIdx, '诊断拼接必须位于 details 折叠区内');
  assert.ok(/工具 \$\{d\.tool\}|业务码|traceId \$\{d\.traceId\}/.test(re), '折叠区内应保留完整诊断证据');
});

/* ---------------- 可选：真实接口断言 ---------------- */
const BASE = process.env.FAILUX_BASE_URL || '';
if (!BASE) {
  console.log('\n[2/2] 真实接口断言：跳过（未设置 FAILUX_BASE_URL）');
} else {
  console.log(`\n[2/2] 真实接口断言：${BASE}`);
  await (async () => {
    try {
      const res = await fetch(`${BASE}/api/recommend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '预算35到45块', constraints: {} }),
      });
      const json = await res.json();
      if (res.status === 503 && json?.error?.code === 'menu_unavailable') {
        const e = json.error;
        expect('接口 503：message 是人话，不含工具名/业务码', () => {
          assert.ok(!/query-|600057|code=|mcp_/i.test(e.message || ''), `message 泄露技术细节：${e.message}`);
          assert.ok(/无法获取菜单|无法.*核价/.test(e.message || ''), `message 应说明菜单不可查：${e.message}`);
        });
        expect('接口 503：技术证据只在 diagnosis，且带分类与操作建议', () => {
          assert.equal(e.category, 'outside_business_hours');
          assert.ok((e.actions || []).includes('switch_store'), `actions 应含 switch_store：${e.actions}`);
          assert.ok(e.diagnosis && e.diagnosis.traceId, 'diagnosis 应含 traceId（供工程台）');
        });
      } else {
        expect('接口返回（门店营业时的正常路径）', () => {
          assert.ok(res.status === 200, `status=${res.status}`);
        });
      }
    } catch (err) {
      expect('真实接口断言（连接失败）', () => {
        assert.fail(`无法连接 ${BASE}：${err.message}`);
      });
    }
  })();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n================ 汇总：${results.length - failed.length}/${results.length} 通过 ================`);
if (failed.length) process.exitCode = 1;
