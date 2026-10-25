/**
 * LLM 语义解析：自然语言 → 结构化约束。
 *
 * 安全边界：
 * - 模型只做"语言 → 结构"，不产出任何价格/营养/商品数据。
 * - 模型输出必须通过 schema 的数值反幻觉核对；核对不过的数字会被清空并记录信息。
 * - 模型调用失败时**不伪造结果**，由上层降级到规则解析并明确标注 degraded。
 */
import { chat, extractJson, LlmError, llmStatus, isThinkingDisabled } from '../llm/provider.js';
import { numbersInText, normalizeConstraints, ROLES, ROLE_LABEL } from './schema.js';
import { parseByRules } from './rule-parser.js';
import { resolveIntent, intentChips, singleClarification, parseBudgetRange } from './intent.js';
import { analyzeMealTime } from './meal-time.js';

const SCHEMA_DOC = `{
  "budgetMax": number|null,            // 预算上限，单位：元（区间表达时取区间终点，如「35到45块」→45）
  "budgetMin": number|null,            // 预算区间下限，仅当用户明确说了区间（「35到45块」→35）；单值预算为 null
  "budgetIntent": "max|target|target_with_cap|range|minimize|unspecified",
                                       // max=上限（60以内/最多60）；target=目标价（60左右）；
                                       // target_with_cap=目标价带原则上限（推荐一个60元的套餐）；
                                       // range=目标区间（35到45块/35～45元/三十五到四十五元）；
                                       // minimize=越便宜越好；unspecified=没提预算
  "caloriesMax": number|null,          // 热量上限，单位 kcal
  "caloriesMin": number|null,          // 热量下限，单位 kcal
  "proteinMin": number|null,           // 蛋白质下限，单位 g
  "preferences": {                     // 口味偏好与用餐背景（软，不影响硬约束）
    "avoidSpicy": "hard|soft|null",    // hard=明确不能吃辣；soft=不太喜欢/怕辣；null=没提
    "avoidIce": true|null,             // 不想喝冰饮/不吃冰（注意：想要冷饮不算，见 preferColdDrink）
    "preferColdDrink": true|null,      // 想喝冷饮/来杯冰的（正向诉求，与 avoidIce 互斥）
    "preferCoolFood": true|null,       // 想吃凉的餐食（食物温度，与冷饮分开；菜单无温度数据，不声称）
    "lightMeal": true|null,            // 不太饿/随便吃点/想吃少点（小份优先，不为凑预算加餐）
    "avoidOily": true|null,            // 不喜欢油腻、想清淡
    "stomachContext": true|null        // 肚子/胃不舒服等身体状态背景（只做背景，不做医学判断）
  },
  "preferredFoods": string[],          // 用户希望包含的餐品关键词，如 ["麦香鱼","无糖可乐"]
  "excludedFoods": string[],           // 只放"硬排除"：不吃/不能吃/忌口/过敏明确不要的餐品
  "dietaryRestrictions": [{"type":"spicy|allergen|vegetarian|pork|other","text":"原文表述"}],
  "requiredCategories": string[],      // 必须是这些类别之一：main(主食) side(小食) drink(饮料) dessert(甜品)
  "preferredCategories": string[],     // 希望有但非必须
  "objectives": [{"metric":"price|protein|calories|taste","direction":"min|max|satisfy"}],
  "clarifications": [{"question":"仅在自相矛盾、必须用户拍板时才写","reason":"为什么矛盾"}],
  "notes": string|null                 // 语义背景备注，不得包含数字推断
}`;
// 性能专项：hardConstraints/softPreferences 不再要求模型输出——
// schema.js 一律用结构化字段重新派生覆盖，模型自述是纯冗余输出。

const SYSTEM_PROMPT = `你是麦当劳配餐需求的语义解析器。把用户的中文口语需求转成 JSON 结构化约束，供确定性优化器使用。用户是来点一餐饭的，不是来填问卷的——能自己判断的就自己判断，不要反问。

【铁律】
1. 只抽取用户明确说出的信息。没说的一律 null 或空数组，不要"合理推测"。
2. 绝对禁止推断阈值：
   - 「高蛋白」「多补点蛋白」「练完胸想吃点东西」→ 只能产出 objectives 里 protein=max，proteinMin 必须为 null。
   - 「低卡」「减脂」→ objectives 里 calories=min，caloriesMax 必须为 null。
   - 「便宜点」「性价比」→ objectives 里 price=min，budgetMax 必须为 null。
   - 只有当原文出现「至少 / 不低于 / ≥ / 不少于 + 数字 + 克」或「不超过 + 数字 + 大卡」这类明确表述时，才填对应的数值字段。
3. 预算要看语气（budgetIntent），不要一律当上限：
   - 「60以内/最多60/不超过60」→ max；「60左右/60上下/大概60」→ target；
   - 「推荐一个60元的套餐/来个30元的」→ target_with_cap（目标是这个价位的套餐，不是拼命省钱）；
   - 「35到45块/35～45元/35-45块/35至45元/三十五到四十五元」→ range：budgetMin=区间起点，budgetMax=区间终点（上限）。
     绝不能把区间起点当 budgetMax（「35到45块」是 budgetMin=35、budgetMax=45，不是 budgetMax=35）；
   - 「越便宜越好/便宜点/省钱」→ minimize（budgetMax 留 null 除非给了数字）；没提预算 → unspecified。
4. 硬约束 vs 软偏好的区分：
   - 「必须有饮料」「一定要有个喝的」「要一顿正餐」→ requiredCategories（硬）。
   - 「最好来杯无糖可乐」「想吃麦香鱼」「希望能有饮料」→ preferredFoods / preferredCategories（软）。
   - 「40元以内」「不超过 750 大卡」「蛋白质至少 30g」→ 数值硬约束。
5. 口味偏好 ≠ 忌口（重要）：
   - 「不喜欢吃辣/不太喜欢吃油的/不想喝冰的/怕辣」→ preferences（avoidSpicy soft / avoidOily / avoidIce），是"尽量满足"的软偏好；
     不要写进 excludedFoods，不要写进 dietaryRestrictions。
   - 「不能吃辣/绝对不能吃/忌口/不吃猪肉/清真/素食/过敏」→ dietaryRestrictions（真限制），type 按语义选；
     其中「不能吃辣」可同时标 preferences.avoidSpicy=hard。
   - 「想喝冷饮/来杯冰可乐/最好能有杯冷的」→ preferences.preferColdDrink=true（正向要冷饮，不要标 avoidIce）；
     「想吃点凉凉的/凉爽的」→ preferences.preferCoolFood=true（食物温度，与冷饮分开）。
   - 「不太饿/随便吃点/想吃少点」→ preferences.lightMeal=true（小份优先，不要虚构热量上限）。
   - 「肚子不舒服/胃不舒服」→ preferences.stomachContext=true 并在 notes 里如实记录背景。
     绝对不要做医学判断，不要写"养胃/温和/好消化/适合胃病"之类的健康功效断言。
6. objectives 只能取 metric∈{price,protein,calories,taste}，direction∈{min,max,satisfy}。
   - 价格越低越好 → price/min；蛋白质越高越好 → protein/max；热量越低越好 → calories/min（仅当用户明确想降热量）。
7. preferredFoods / excludedFoods 用简短检索词（如「麦香鱼」「板烧」「可乐」「薯条」），不要写完整 SKU 名。
8. 不要反问。clarifications 最多 1 条，且只有"用户自相矛盾、任何餐品都无法同时满足"时才写
   （例如热量下限高于上限）。预算"是上限还是目标"不要问——用 budgetIntent 自己判断；
   辣/冰/油这类无法验证的偏好不要问——写进 preferences 尽力满足即可；
   数值偏高、预算偏低不算矛盾，不要问。
9. 只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。

【输出结构】
${SCHEMA_DOC}`;

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** 冲突提示只给自然语言（用户可读、可改），不暴露字段名/内部实现细节（导出便于单测核对措辞） */
export function conflictQuestion(field, value) {
  switch (field) {
    case 'budgetMax': return `我暂时按 ${value} 元以内理解，你可以修改预算。`;
    case 'budgetMin': return `我暂时按预算不低于 ${value} 元理解，你可以修改预算。`;
    case 'caloriesMax': return `我暂时按热量不超过 ${value} 大卡理解，你可以修改。`;
    case 'caloriesMin': return `我暂时按热量不低于 ${value} 大卡理解，你可以修改。`;
    case 'proteinMin': return `我暂时按蛋白质不低于 ${value} 克理解，你可以修改。`;
    default: return `有一处自动理解可能不准，我先按 ${value} 处理，你可以修改。`;
  }
}

/**
 * 解析缓存（P2 响应时间优化）：同一句话重复提问直接命中，不再等模型。
 *
 * 安全边界：
 * - 只缓存成功的 LLM 结果（status=ok 且 source=llm）；降级结果绝不缓存，下次必须重试模型。
 * - MCFIT_LLM_DISABLE=1 时读写全部绕过缓存——运维开关的意义是验证「模型不可用→降级规则、
 *   不伪造 AI 结果」，不能被历史缓存结果污染（test/parse.test.js 场景J 依赖此语义）。
 * - LRU 上限 + TTL 过期；同一句输入并发到达时合并为一次模型调用（inflight 去重）。
 */
const CACHE_TTL_MS = num(process.env.MCFIT_PARSE_CACHE_TTL_MS, 10 * 60 * 1000);
const CACHE_MAX = num(process.env.MCFIT_PARSE_CACHE_MAX, 200);
const parseCache = new Map(); // key -> {at, result}
const inflight = new Map(); // key -> Promise<result>
const cacheCounters = { hit: 0, miss: 0, dedup: 0, stored: 0 };

function cacheGet(key) {
  const e = parseCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) {
    parseCache.delete(key);
    return null;
  }
  parseCache.delete(key); // LRU：命中后移到最新
  parseCache.set(key, e);
  return e;
}

function cachePut(key, result) {
  parseCache.set(key, { at: Date.now(), result });
  while (parseCache.size > CACHE_MAX) parseCache.delete(parseCache.keys().next().value);
  cacheCounters.stored += 1;
}

/** 缓存运行状态（观测用） */
export function parseCacheStats() {
  return { ...cacheCounters, size: parseCache.size, ttlMs: CACHE_TTL_MS, max: CACHE_MAX };
}

/**
 * 用 LLM 解析。
 * @param {string} text
 * @returns {Promise<{raw:object, model:string, ms:number, usage:object|null}>}
 */
export async function parseWithLlm(text) {
  const res = await chat({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `用户原话："""${String(text).slice(0, 500)}"""\n\n请输出 JSON：` },
    ],
    // 性能专项：输出上限可配置 + 模式感知（截断由 finish_reason=length 监控）。
    // 实测：关思考 completion max=159、开思考 max=818 逼近旧上限 900。
    // 关思考默认 600（留约 4 倍余量），开思考保持 900；MCFIT_LLM_MAX_TOKENS 可覆盖。
    maxTokens: num(process.env.MCFIT_LLM_MAX_TOKENS, isThinkingDisabled() ? 600 : 900),
    temperature: 0,
    // P2：超时从 40s 收紧到 20s（可用 MCFIT_LLM_TIMEOUT_MS 覆盖）。
    // 实测正常解析 6~15s，20s 足够；超过就降级规则解析，把最坏等待砍半。
    timeoutMs: num(process.env.MCFIT_LLM_TIMEOUT_MS, 20000),
  });
  return {
    raw: extractJson(res.content),
    model: res.model,
    ms: res.ms,
    usage: res.usage,
    finishReason: res.finishReason ?? null,
    reasoningTokens: res.reasoningTokens ?? null,
    reasoningLen: res.reasoningLen ?? 0,
  };
}

/**
 * 解析编排：LLM 优先，失败降级规则；数值做双向交叉校验。
 * @param {string} text
 * @param {{mode?:'auto'|'llm'|'rule'}} opts
 */
async function parseRequirementCore(text, { mode = 'auto' } = {}) {
  const raw = String(text || '').trim();
  if (!raw) {
    return {
      status: 'error',
      source: null,
      constraints: null,
      warnings: ['输入为空'],
      error: { code: 'empty_input', message: '请输入需求描述' },
    };
  }

  const ruleRaw = parseByRules(raw);
  const ruleNorm = normalizeConstraints(ruleRaw, raw, { parseSource: 'rule' });

  if (mode === 'rule') {
    return assembleResult({
      status: 'ok',
      source: 'rule',
      constraints: { ...ruleNorm.constraints, parseSource: 'rule' },
      warnings: ruleNorm.warnings,
      llm: null,
      degraded: false,
      available: llmStatus(),
    });
  }

  // ---- P2：解析缓存 + 并发去重（只作用于模型路径；规则解析是纯计算，无需缓存） ----
  const useCache = process.env.MCFIT_LLM_DISABLE !== '1';
  // P0 预算区间修复后解析语义有变，缓存键升到 v2，避免旧解析结果被复用
  const key = `v2:${raw}`;
  const finish = (result, cacheStatus, extra = {}) => {
    cacheCounters[cacheStatus] += 1;
    return { ...result, ...extra, cacheStatus, available: llmStatus() };
  };
  if (useCache) {
    const hit = cacheGet(key);
    if (hit) return finish(hit.result, 'hit', { cacheAgeMs: Date.now() - hit.at });
    const pending = inflight.get(key);
    if (pending) return finish(await pending, 'dedup');
  }

  const run = llmParsePipeline(raw, ruleNorm);
  if (useCache) inflight.set(key, run);
  let result;
  try {
    result = await run;
  } finally {
    if (useCache) inflight.delete(key);
  }
  // 只缓存成功的 LLM 结果；降级结果不缓存，下次必须重试模型
  if (useCache && result.status === 'ok' && result.source === 'llm') cachePut(key, result);
  return finish(result, 'miss');
}

/** 模型解析主流程：调 LLM → 失败降级规则 → 数值交叉校验（不含缓存逻辑，幂等可共享） */
async function llmParsePipeline(raw, ruleNorm) {
  let llmResult = null;
  let llmError = null;
  try {
    llmResult = await parseWithLlm(raw);
  } catch (err) {
    llmError = err instanceof LlmError ? err.toJSON?.() || { kind: err.kind, message: err.message } : { kind: 'unknown', message: err.message };
  }

  if (!llmResult) {
    return assembleResult({
      status: 'degraded',
      source: 'rule',
      constraints: { ...ruleNorm.constraints, parseSource: 'rule' },
      warnings: [...ruleNorm.warnings, `LLM 不可用（${llmError?.kind || 'error'}：${llmError?.message || '未知错误'}），已降级为确定性规则解析；未伪造任何 AI 解析结果`],
      llm: null,
      llmError,
      degraded: true,
      fallbackReason: llmError?.message || 'LLM 调用失败',
      available: llmStatus(),
    });
  }

  const llmNorm = normalizeConstraints(llmResult.raw, raw, { parseSource: 'llm' });
  const warnings = [...llmNorm.warnings];
  const c = llmNorm.constraints;

  // 数值交叉校验：原文里存在明确表达、但模型漏掉的，用规则结果补齐（规则结果可复核）。
  // 交叉校验保留（不允许通过删除它来掩盖分歧）；但语义一致不报冲突——
  // 「35到45块」的起点/上限歧义（35 vs 45）是同义，统一到区间语义（上限45）即可。
  const numericFields = ['budgetMax', 'budgetMin', 'caloriesMax', 'caloriesMin', 'proteinMin'];
  const range = parseBudgetRange(raw);
  for (const f of numericFields) {
    const rv = ruleNorm.constraints[f];
    const lv = c[f];
    if (rv != null && lv == null) {
      c[f] = rv;
      warnings.push(`${f}：模型漏抽（原文明确为 ${rv}），已用规则解析结果补齐`);
    } else if (rv != null && lv != null && rv !== lv) {
      // 预算区间语义等价：一方给起点、一方给终点，统一为「下限=起点、上限=终点」，不算冲突
      const endpoints = range ? new Set([range.min, range.max]) : null;
      if (endpoints && endpoints.has(rv) && endpoints.has(lv)) {
        c.budgetMax = range.max;
        c.budgetMin = range.min;
        continue;
      }
      // 两者都通过原文数字核对但取值不同：保留模型结果（语义更准），并提示用户确认。
      // 提示只用自然语言，不暴露字段名/模型/规则等技术细节（工程细节只进 warnings）。
      warnings.push(`${f}：模型给 ${lv}，规则给 ${rv}，已采用模型结果，请在约束表单中确认`);
      c.clarifications = c.clarifications || [];
      c.clarifications.push({
        id: `num_conflict_${f}`,
        field: f,
        question: conflictQuestion(f, lv),
        reason: '同一句话存在两种抽取结果',
      });
    }
  }
  // 硬/软清单重新派生一次，保持与最终数值一致
  const reNorm = normalizeConstraints(c, raw, { parseSource: 'llm', strictNumbers: false });
  const final = reNorm.constraints;
  // 保留模型给的 clarifications（reNorm 会保留）与 notes
  final.notes = c.notes || ruleNorm.constraints.notes || final.notes;

  // 第五阶段：语义提示补齐（模型漏给时用规则结果补），再统一汇总意图
  if (!final.budgetIntent) final.budgetIntent = ruleNorm.constraints.budgetIntent || null;
  if (!final.preferences) final.preferences = ruleNorm.constraints.preferences || null;

  return assembleResult({
    status: 'ok',
    source: 'llm',
    constraints: final,
    warnings: [...new Set([...warnings, ...reNorm.warnings])],
    llm: { model: llmResult.model, ms: llmResult.ms, usage: llmResult.usage, finishReason: llmResult.finishReason, reasoningTokens: llmResult.reasoningTokens },
    degraded: false,
    available: llmStatus(),
  });
}

/** 给前端的意图汇总：模式/预算意图/偏好/标签/至多一个关键确认（不反问） */
function assembleResult(result) {
  const c = result.constraints;
  if (!c) return result;
  const intent = resolveIntent(c, c.raw);
  return {
    ...result,
    intent,
    chips: intentChips(c, intent),
    clarification: singleClarification(c, intent),
  };
}

/**
 * 对外入口：在解析结果上附带「计划用餐时段 vs 本次实际查询时段」的比对。
 * 没提到时段时 mealTime=null，行为与之前完全一致。
 */
export async function parseRequirement(text, opts) {
  const result = await parseRequirementCore(text, opts);
  if (!result || result.status !== 'ok') return result;
  const mealTime = analyzeMealTime(String(text || ''));
  return mealTime ? { ...result, mealTime } : result;
}

export { ROLES, ROLE_LABEL, numbersInText };
