/**
 * MiMo-V2.6-Pro 响应速度专项 · A/B 性能对照测试（独立脚本）。
 *
 * A = 原始调用（默认深度思考）：MCFIT_LLM_THINKING=enabled（不传 thinking 字段）
 * B = 关闭深度思考：MCFIT_LLM_THINKING=disabled（默认）
 *
 * 设计要点（任务书第七节）：
 * - 直接调用 parseWithLlm（模型层），不经过应用层 LRU 缓存 → 杜绝缓存命中污染
 * - 顺序请求、低并发，遵守 API 服务限制
 * - 每模式多轮（PERF_ROUNDS，默认 2）
 * - 同一输入与同一校验标准；统计 P50/P95/min/max、有效 JSON 率、结构化解析正确率、
 *   失败率、token 用量、截断次数
 * - 30+ 输入覆盖 7 类场景，并包含任务书第六节全部 10 条保护输入
 *
 * 输出：cache/perf-llm-ab.json + 控制台汇总表（无密钥信息）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWithLlm } from '../src/parse/llm-parser.js';
import { normalizeConstraints } from '../src/parse/schema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'cache', 'perf-llm-ab.json');

/** 校验谓词：expect 中每项对应一个断言 */
function check(c, raw, expect) {
  const fails = [];
  for (const [k, v] of Object.entries(expect || {})) {
    switch (k) {
      case 'budgetMax': if (c.budgetMax !== v) fails.push(`budgetMax=${c.budgetMax}≠${v}`); break;
      case 'budgetIntent': if (c.budgetIntent !== v) fails.push(`budgetIntent=${c.budgetIntent}≠${v}`); break;
      case 'budgetIntentIn': if (!v.includes(c.budgetIntent)) fails.push(`budgetIntent=${c.budgetIntent}∉${v}`); break;
      case 'budgetIntentNot': if (c.budgetIntent === v) fails.push(`budgetIntent 不应为 ${v}`); break;
      case 'proteinMin': if (c.proteinMin !== v) fails.push(`proteinMin=${c.proteinMin}≠${v}`); break;
      case 'caloriesMax': if (c.caloriesMax !== v) fails.push(`caloriesMax=${c.caloriesMax}≠${v}`); break;
      case 'caloriesMinNull': if (v && c.caloriesMin !== null) fails.push(`caloriesMin 应为 null`); break;
      case 'caloriesMaxNull': if (v && c.caloriesMax !== null) fails.push(`caloriesMax 应为 null`); break;
      case 'objectivesHas': if (!c.objectives.some((o) => o.metric === v.metric && o.direction === v.direction)) fails.push(`objectives 缺 ${v.metric}/${v.direction}`); break;
      case 'avoidSpicy': if (c.preferences?.avoidSpicy !== v) fails.push(`avoidSpicy=${c.preferences?.avoidSpicy}≠${v}`); break;
      case 'prefHas': if (!c.preferences?.[v]) fails.push(`preferences.${v} 未设置`); break;
      case 'excludedHas': if (!c.excludedFoods.some((f) => f.includes(v))) fails.push(`excludedFoods 缺「${v}」`); break;
      case 'excludedEmpty': if (v && c.excludedFoods.length) fails.push(`excludedFoods 应为空（口味偏好≠忌口）`); break;
      case 'preferredHas': if (![...c.preferredFoods, ...c.preferredCategories].some((f) => String(f).includes(v))) fails.push(`preferred 缺「${v}」`); break;
      case 'requiredHas': if (!c.requiredCategories.includes(v)) fails.push(`requiredCategories 缺 ${v}`); break;
      case 'requiredEmpty': if (v && c.requiredCategories.length) fails.push(`requiredCategories 应为空（软偏好不进硬约束）`); break;
      case 'dietHas': if (!c.dietaryRestrictions.some((d) => d.type === v)) fails.push(`dietaryRestrictions 缺 type=${v}`); break;
      case 'noMedicalClaims': {
        const blob = JSON.stringify([c.notes, ...c.softPreferences, ...c.hardConstraints]);
        if (/养胃|好消化|适合胃|治疗|治愈|调理|药效/.test(blob)) fails.push('出现医学/健康功效断言');
        break;
      }
      case 'noInventedThreshold': if (c.proteinMin != null || c.caloriesMax != null) fails.push('生成了未给出的数值阈值'); break;
      default: break;
    }
  }
  return fails;
}

// ---- 输入集：7 类 × ≥30 条，含任务书第六节 10 条保护输入（标记 protected） ----
const INPUTS = [
  // 简单预算
  { t: '52块钱预算，今天想吃点温和的。', cat: '简单预算', protected: 1, e: { budgetMax: 52, budgetIntentIn: ['max', 'target', 'target_with_cap'], budgetIntentNot: 'minimize', noMedicalClaims: true } },
  { t: '60元左右，推荐一顿饭。', cat: '简单预算', protected: 2, e: { budgetMax: 60, budgetIntentIn: ['target', 'target_with_cap'], budgetIntentNot: 'minimize' } },
  { t: '推荐一个60元的套餐。', cat: '简单预算', protected: 7, e: { budgetMax: 60, budgetIntent: 'target_with_cap' } },
  { t: '越便宜越好，20块以内。', cat: '简单预算', protected: 8, e: { budgetMax: 20, budgetIntent: 'minimize' } },
  { t: '预算30块，来份午餐。', cat: '简单预算', e: { budgetMax: 30 } },
  { t: '80以内随便来点。', cat: '简单预算', e: { budgetMax: 80 } },
  // 模糊预算
  { t: '便宜点就行。', cat: '模糊预算', e: { budgetIntent: 'minimize' } },
  { t: '大概五六十块钱吧。', cat: '模糊预算', e: { budgetIntentIn: ['target', 'max', 'target_with_cap'], budgetIntentNot: 'minimize' } },
  { t: '预算不太够，越省越好。', cat: '模糊预算', e: { budgetIntent: 'minimize' } },
  { t: '百元以内吃顿好的。', cat: '模糊预算', e: { budgetMax: 100 } },
  // 日常口味
  { t: '不喜欢油腻的，不想吃辣，不喝冰的。', cat: '日常口味', protected: 5, e: { avoidSpicy: 'soft', prefHas: 'avoidOily', prefHas2: 'avoidIce', excludedEmpty: true } },
  { t: '想吃麦香鱼。', cat: '日常口味', e: { preferredHas: '麦香鱼' } },
  { t: '今天想吃点辣的过瘾。', cat: '日常口味', e: {} },
  { t: '来杯无糖可乐最好。', cat: '日常口味', e: { preferredHas: '可乐' } },
  { t: '最好有无糖饮料，但不是必须。', cat: '日常口味', protected: 9, e: { requiredEmpty: true } },
  // 复杂口语
  { t: '今天来例假了，想吃点温和的食物，52块钱预算。', cat: '复杂口语', protected: 6, e: { budgetMax: 52, noMedicalClaims: true } },
  { t: '不吃麦辣，想喝热饮。', cat: '复杂口语', protected: 10, e: { excludedHas: '麦辣' } },
  { t: '练完胸想吃点东西。', cat: '复杂口语', e: { proteinMin: null } },
  { t: '刚健身完，尽量高蛋白。', cat: '复杂口语', e: { proteinMin: null, objectivesHas: { metric: 'protein', direction: 'max' } } },
  { t: '晚上不想吃太多，随便垫垫。', cat: '复杂口语', e: {} },
  { t: '帮我配个工作餐，赶紧的。', cat: '复杂口语', e: {} },
  // 营养目标
  { t: '热量不超过750大卡，蛋白质至少30克。', cat: '营养目标', protected: 4, e: { caloriesMax: 750, proteinMin: 30 } },
  { t: '40元以内，尽量高蛋白。', cat: '营养目标', protected: 3, e: { budgetMax: 40, budgetIntent: 'max', proteinMin: null, objectivesHas: { metric: 'protein', direction: 'max' } } },
  { t: '低卡一点，最近在减脂。', cat: '营养目标', e: { caloriesMaxNull: true, objectivesHas: { metric: 'calories', direction: 'min' } } },
  { t: '蛋白质尽量高点，预算45。', cat: '营养目标', e: { proteinMin: null, budgetMax: 45 } },
  // 混合约束
  { t: '60元以内，要一杯喝的，不要辣。', cat: '混合约束', e: { budgetMax: 60, requiredHas: 'drink', avoidSpicy: 'soft' } },
  { t: '50块预算，高蛋白，不要冰饮。', cat: '混合约束', e: { budgetMax: 50, proteinMin: null, prefHas: 'avoidIce' } },
  { t: '35元以内来份套餐，最好有咖啡。', cat: '混合约束', e: { budgetMax: 35 } },
  { t: '今天吃素，预算50，别太油。', cat: '混合约束', e: { dietHas: 'vegetarian', budgetMax: 50 } },
  // 不可验证限制
  { t: '不要花生过敏。', cat: '不可验证限制', e: { dietHas: 'allergen' } },
  { t: '不吃猪肉。', cat: '不可验证限制', e: { dietHas: 'pork' } },
  { t: '我减肥，热量别太高，最好低卡。', cat: '不可验证限制', e: { caloriesMaxNull: true, noInventedThreshold: true } },
  { t: '想吃点清淡的，最近肠胃不太舒服。', cat: '不可验证限制', e: { noMedicalClaims: true } },
];

// prefHas 两个断言的简化（check 只认单值键，这里展开）
for (const item of INPUTS) {
  if (item.e.prefHas2) {
    item.e2 = { ...item.e, prefHas: item.e.prefHas2 };
    delete item.e.prefHas2;
  }
}

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[i];
}

async function runMode(mode, rounds) {
  process.env.MCFIT_LLM_THINKING = mode;
  const rows = [];
  // 预热 1 次（不计入统计）：吸收 TLS/连接建立
  try { await parseWithLlm('预热请求，忽略。'); } catch { /* 预热失败不计 */ }
  for (let round = 1; round <= rounds; round += 1) {
    for (const item of INPUTS) {
      const t0 = Date.now();
      try {
        const r = await parseWithLlm(item.t);
        const tNorm0 = process.hrtime.bigint();
        const n = normalizeConstraints(r.raw, item.t, { parseSource: 'llm' });
        const normMs = Number(process.hrtime.bigint() - tNorm0) / 1e6;
        const fails = check(n.constraints, item.t, item.e);
        if (item.e2) fails.push(...check(n.constraints, item.t, item.e2).map((f) => `e2:${f}`));
        rows.push({
          round, cat: item.cat, protected: item.protected || null, input: item.t,
          ms: r.ms, wallMs: Date.now() - t0, normMs: Number(normMs.toFixed(2)),
          finish: r.finishReason, reasoningTokens: r.reasoningTokens,
          promptTokens: r.usage?.prompt_tokens ?? null, completionTokens: r.usage?.completion_tokens ?? null,
          validJson: true, correct: fails.length === 0, failDetails: fails, error: null,
        });
      } catch (err) {
        rows.push({
          round, cat: item.cat, protected: item.protected || null, input: item.t,
          ms: Date.now() - t0, wallMs: Date.now() - t0, normMs: null,
          finish: null, reasoningTokens: null, promptTokens: null, completionTokens: null,
          validJson: false, correct: false, failDetails: [], error: `${err.kind || 'error'}: ${err.message}`,
        });
      }
      // 顺序低并发，请求间小间隔，遵守服务限制
      await new Promise((res) => setTimeout(res, 150));
    }
    console.error(`[mode=${mode}] round ${round}/${rounds} done`);
  }
  return rows;
}

function summarize(mode, rows) {
  const ok = rows.filter((r) => r.validJson);
  const lat = ok.map((r) => r.ms);
  const withExpect = rows.filter((r) => Object.keys(INPUTS.find((i) => i.t === r.input)?.e || {}).length > 0);
  return {
    mode,
    calls: rows.length,
    failures: rows.length - ok.length,
    failureRate: `${(((rows.length - ok.length) / rows.length) * 100).toFixed(1)}%`,
    validJsonRate: `${((ok.length / rows.length) * 100).toFixed(1)}%`,
    correctnessAll: `${((rows.filter((r) => r.correct).length / rows.length) * 100).toFixed(1)}%`,
    correctnessWithExpect: `${((withExpect.filter((r) => r.correct).length / Math.max(1, withExpect.length)) * 100).toFixed(1)}%`,
    latencyMs: {
      p50: pct(lat, 50), p95: pct(lat, 95), min: lat.length ? Math.min(...lat) : null, max: lat.length ? Math.max(...lat) : null,
      mean: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
    },
    normMsMean: ok.length ? Number((ok.reduce((a, r) => a + (r.normMs || 0), 0) / ok.length).toFixed(2)) : null,
    avgPromptTokens: avg(ok.map((r) => r.promptTokens)),
    avgCompletionTokens: avg(ok.map((r) => r.completionTokens)),
    avgReasoningTokens: avg(ok.map((r) => r.reasoningTokens)),
    truncated: ok.filter((r) => r.finish === 'length').length,
    wrongDetails: rows.filter((r) => !r.correct && r.validJson).map((r) => ({ input: r.input, fails: r.failDetails })),
    errors: rows.filter((r) => !r.validJson).map((r) => ({ input: r.input, error: r.error })),
  };
}

function avg(list) {
  const v = list.filter((x) => x != null);
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
}

const rounds = Number(process.env.PERF_ROUNDS || 2);
const started = new Date().toISOString();
console.error(`A/B 性能对照：${INPUTS.length} 输入 × ${rounds} 轮 × 2 模式`);

console.error('---- 模式 A：原始（默认深度思考） ----');
const rowsA = await runMode('enabled', rounds);
console.error('---- 模式 B：关闭深度思考 ----');
const rowsB = await runMode('disabled', rounds);

const report = {
  started, finished: new Date().toISOString(),
  inputCount: INPUTS.length, rounds,
  note: 'latency=模型 API 调用耗时（不含应用层缓存；本脚本直接走模型层）；normMs=JSON 校验/规范化耗时',
  a: summarize('A:thinking-enabled(原始)', rowsA),
  b: summarize('B:thinking-disabled(新)', rowsB),
  rows: { A: rowsA, B: rowsB },
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));

console.log('\n========== 汇总 ==========');
for (const s of [report.a, report.b]) {
  console.log(`\n【${s.mode}】calls=${s.calls} 失败=${s.failures}(${s.failureRate}) 有效JSON=${s.validJsonRate}`);
  console.log(`  正确率(全部/有断言) = ${s.correctnessAll} / ${s.correctnessWithExpect}  截断=${s.truncated}`);
  console.log(`  延迟: P50=${s.latencyMs.p50}ms P95=${s.latencyMs.p95}ms min=${s.latencyMs.min}ms max=${s.latencyMs.max}ms mean=${s.latencyMs.mean}ms`);
  console.log(`  token: prompt均=${s.avgPromptTokens} completion均=${s.avgCompletionTokens} reasoning均=${s.avgReasoningTokens}`);
  console.log(`  校验耗时均=${s.normMsMean}ms`);
  if (s.wrongDetails.length) console.log(`  未过断言 ${s.wrongDetails.length} 条：`, JSON.stringify(s.wrongDetails.slice(0, 8), null, 1));
  if (s.errors.length) console.log(`  错误：`, JSON.stringify(s.errors.slice(0, 5)));
}
console.log(`\n明细已写入 ${OUT}`);
