/**
 * 用餐意图模型：把"约束"与"原话"还原成普通人点餐的意图。
 *
 * 这里解决四件事：
 * 1. 预算到底是上限 / 目标价 / 目标价带上限 / 越便宜越好。
 * 2. 口味偏好与用餐背景（辣、冰、油、胃不舒服）不是一律塞进"无法验证的限制"。
 * 3. 这顿饭是"日常随便吃一餐"还是"冲着营养指标去的"（mode: daily / nutrition）。
 * 4. 不因为一句"60元"就反问用户。
 */

/** 可解释的预算意图 */
export const BUDGET_INTENT = {
  /** 严格上限：60以内/最多60/不超过60 */
  MAX: 'max',
  /** 目标价：60左右，希望接近这个数，但不是上限 */
  TARGET: 'target',
  /** 目标价+原则上限：推荐一个60元的套餐，最好不超过60，但不必最便宜 */
  TARGET_WITH_CAP: 'target_with_cap',
  /** 目标区间：35到45块/35～45元/三十五到四十五元——目标价位 35–45，上限取区间终点 45 */
  RANGE: 'range',
  /** 明确要便宜 */
  MINIMIZE: 'minimize',
  /** 没提预算 */
  UNSPECIFIED: 'unspecified',
};

/** 中文数字 → 数值（口语形式，≤999）：三十五→35、十五→15、一百五→150、两百→200 */
export function cnToNumber(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (/^\d+(?:\.\d+)?$/.test(str)) return Number(str);
  // 注意：汉字码位不连续（五=U+4E94 不在「一-九」U+4E00–U+4E5D 区间内），必须显式列举
  const D = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const hm = str.match(/^([一二三四五六七八九两])?百(.*)$/);
  if (hm) {
    const head = hm[1] ? D[hm[1]] : 1;
    if (head == null) return null;
    let v = head * 100;
    let rest = hm[2];
    if (rest.startsWith('零')) {
      rest = rest.slice(1);
      if (rest === '') return v;
      return D[rest] != null ? v + D[rest] : null;
    }
    const sm = rest.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
    if (sm) return v + (sm[1] ? D[sm[1]] : 1) * 10 + (sm[2] ? D[sm[2]] : 0);
    if (rest === '') return v;
    if (/^[一二三四五六七八九]$/.test(rest)) return v + D[rest] * 10; // 口语「一百五」= 150
    return null;
  }
  const m2 = str.match(/^([一二三四五六七八九两])?十([一二三四五六七八九])?$/);
  if (m2) return (m2[1] ? D[m2[1]] : 1) * 10 + (m2[2] ? D[m2[2]] : 0);
  if (str.length === 1 && D[str] != null) return D[str];
  return null;
}

const NUM_TOKEN = '(\\d+(?:\\.\\d+)?|[一二两三四五六七八九十百]+)';
const RANGE_SEP = '(?:到|至|~|～|—|－|-)';
// 区间单位后不允许紧跟普通词（「3到5块麦乐鸡」是数量不是钱），但允许 的/左右/以内 等收尾
const RANGE_END = '(?=$|左右|上下|以内|以下|之内|封顶|的|预算|价格|[\\s，,。；;！!？?、）)])';

/**
 * 预算区间识别（确定性，区间优先于单值）。
 * 覆盖：「35到45块」「35～45元」「35-45块」「35至45元」「三十五到四十五元」「预算 35 到 45」。
 * @returns {{min:number,max:number}|null} max=区间终点=预算上限，绝不用起点当上限
 */
export function parseBudgetRange(raw) {
  const t = String(raw || '');
  const withUnit = new RegExp(`${NUM_TOKEN}\\s*${RANGE_SEP}\\s*${NUM_TOKEN}\\s*(?:元|块钱|块)${RANGE_END}`).exec(t);
  const noUnit = withUnit ? null : new RegExp(`(?:预算|价格|价位|人均)\\s*${NUM_TOKEN}\\s*${RANGE_SEP}\\s*${NUM_TOKEN}${RANGE_END}`).exec(t);
  const m = withUnit || noUnit;
  if (!m) return null;
  const a = cnToNumber(m[1]);
  const b = cnToNumber(m[2]);
  if (a == null || b == null || a === b) return null;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

const CHEAP_RE = /越便宜越好|便宜点|便宜些|省钱|省点钱|实惠|性价比|划算|便宜就行|能省就省/;
const AROUND_RE = /左右|上下|附近|差不多|大概|接近/;
const CAP_RE = /以内|以下|之内|封顶|最多|不超过|不超|控制在|顶多|至多|上限/;
const MEAL_PRICE_RE = /推荐.*\d+.*(?:套餐|一顿|一餐)|帮我.*(?:搭|配).*顿|\d+\s*元.*(?:套餐|一顿|一餐)/;
// 无糖诉求（软偏好）：菜单没有含糖量字段，只能按名称证据判断，绝不凭"红茶/咖啡"猜无糖
const SUGAR_FREE_RE = /无糖|零糖|0\s*糖|不含糖|控糖/;

const SPICY_HARD_RE = /绝对不能吃辣|不能吃辣|一点辣|一点都不辣|忌辣|禁辣|吃不了辣/;
const SPICY_SOFT_RE = /不太喜欢(?:吃)?辣|不喜欢吃辣|不是很喜欢吃辣|不喜欢辣|不爱吃辣|不想吃辣|不要辣|别太辣|不辣|微辣|少辣|怕辣|有点辣/;
const ICE_RE = /冰饮|冰的|吃冰|喝冰|不要冰|不想喝冰|不喝冰|别加冰|少冰|去冰|冰沙|冰水|冰可乐|冰凉|不是很喜欢吃冰|不喜欢吃冰/;
// 正向冷饮诉求（P1：「最好能有杯冷饮」「来杯冰可乐」是要冷饮，不是忌冰）。
// 判定顺序：先看否定式，否定式成立一律视为「不想喝冰」；无否定式且命中想喝/来杯等表达才是「想要冷饮」。
const NEG_COLD_RE = /(?:不要|不想|不喝|不吃|不爱|不喜|不很喜欢|不是很喜欢|不能|别加|别太|别喝|别吃|忌|怕|免|去冰|少冰|常温)[^。！？，,、]{0,6}?(?:冰|冷)/;
const WANT_COLD_RE = /冷饮|冰饮|想喝[点杯瓶罐]?[冰冷]|来[一]?[杯瓶罐盒][冰冷]|来点[冰冷]的|喝[杯点][冰冷]|要点[冰冷]|要[杯瓶罐]?[冰冷]|想要[杯点]?[冰冷]|最好能有[杯]?[冰冷冷]|能有[杯]?[冰冷]|给我[来点杯]?[冰冷]|[冰冷]的喝/;
// 食物温度诉求（P1：与冷饮软偏好分开；菜单没有食物温度数据，无数据不声称）
const COOL_FOOD_RE = /凉凉的|凉爽|想吃[点]?凉|吃[点]?凉的|凉食|吃点凉|清爽的/;
// 份量诉求（P1：「不太饿」→ 小份/简单搭配优先，不为凑满预算加餐）
const LIGHT_RE = /不太饿|不怎么饿|不是很饿|不是太饿|没[是]?很饿|没胃口|没什么胃口|胃口不[是]?很|不想吃多|吃不[了是]?很|随便吃[点些]|吃[得]?少点|少[来吃]点|小份|半份|简单吃点|吃点简单的|吃点就行|吃点就好|垫[一]?垫|轻食/;
const OILY_RE = /油腻|太油|很油|不喜欢吃油|不是很喜欢吃油|不太喜欢吃油|不想吃油|不爱吃油|不喜欢油腻|清淡|少油|别太油|油大|油一点|清淡点|清淡些/;
const STOMACH_RE = /肚子不舒服|胃不舒服|胃疼|胃难受|肠胃不舒服|肠胃不好|胃不好|肚子难受|消化不好|不舒服/;

function hasAny(text, terms) {
  return terms.some((t) => text.includes(t));
}

/** 从"明确忌口"字段里识别强度（保留模型原文，不新增臆断） */
function spicyFromRestrictions(restrictions, raw) {
  const texts = (restrictions || []).filter((d) => d.type === 'spicy' || /辣/.test(d.text || '')).map((d) => d.text || '');
  const joined = texts.join(' ') + ' ' + (raw || '');
  if (SPICY_HARD_RE.test(joined)) return 'hard';
  if (SPICY_SOFT_RE.test(joined) || texts.length) return 'soft';
  return null;
}

/**
 * 预算意图分类（纯原文证据，确定性）。
 * 区间优先：「35到45块」识别为目标区间（上限=区间终点45），绝不把起点35当上限。
 * @param {string} raw 用户原话
 * @param {number|null} budgetMax 已抽取的预算数字（区间表达时应为区间终点）
 * @returns {{intent:string, amount:number|null, cap:number|null, target:number|null, range:{min:number,max:number}|null, intentSource:'raw-regex'|'fallback'}}
 */
export function classifyBudget(raw, budgetMax) {
  const t = String(raw || '');
  const range = parseBudgetRange(t);
  let intent = BUDGET_INTENT.UNSPECIFIED;
  let intentSource = 'fallback';
  if (CHEAP_RE.test(t)) { intent = BUDGET_INTENT.MINIMIZE; intentSource = 'raw-regex'; }
  else if (range) { intent = BUDGET_INTENT.RANGE; intentSource = 'raw-regex'; }
  else if (budgetMax == null && t) { intent = BUDGET_INTENT.UNSPECIFIED; }
  else if (AROUND_RE.test(t)) { intent = BUDGET_INTENT.TARGET; intentSource = 'raw-regex'; }
  else if (MEAL_PRICE_RE.test(t) && !CAP_RE.test(t)) { intent = BUDGET_INTENT.TARGET_WITH_CAP; intentSource = 'raw-regex'; }
  else if (CAP_RE.test(t)) { intent = BUDGET_INTENT.MAX; intentSource = 'raw-regex'; }
  else if (budgetMax != null) { intent = BUDGET_INTENT.MAX; }
  const amount = budgetMax ?? (range ? range.max : null);
  return {
    intent,
    amount,
    cap: intent === BUDGET_INTENT.TARGET ? null : amount,
    target: intent === BUDGET_INTENT.TARGET || intent === BUDGET_INTENT.TARGET_WITH_CAP ? amount : null,
    range: intent === BUDGET_INTENT.RANGE ? range : null,
    intentSource,
    text: amount == null ? null : t.match(/\d+(?:\.\d+)?\s*(?:元|块)/)?.[0] || null,
    evidence: intent === BUDGET_INTENT.UNSPECIFIED ? '未提及预算' : t || `budgetMax=${amount}`,
  };
}

/**
 * 口味偏好与用餐背景的原文证据（确定性正则）。
 * 只识别常见诉求，不扩展成通用语义理解。
 * 「想要冷饮」与「不想喝冰」严格分开：否定式优先，无否定式的正向冷饮表达不算忌冰。
 */
export function preferenceHintsFromText(raw, restrictions) {
  const t = String(raw || '');
  const wantCold = WANT_COLD_RE.test(t) && !NEG_COLD_RE.test(t) ? true : null;
  const avoidIce = wantCold ? null : (ICE_RE.test(t) || NEG_COLD_RE.test(t) ? true : null);
  return {
    avoidSpicy: spicyFromRestrictions(restrictions, t),
    avoidIce,
    preferColdDrink: wantCold,
    preferCoolFood: COOL_FOOD_RE.test(t) || null,
    lightMeal: LIGHT_RE.test(t) || null,
    avoidOily: OILY_RE.test(t) || null,
    stomachContext: STOMACH_RE.test(t) || null,
    sugarFree: SUGAR_FREE_RE.test(t) || null,
  };
}

/**
 * @param {object} constraints 已规范化的约束
 * @param {string} [rawText] 原始自然语言（缺省用 constraints.raw）
 * @returns {{mode:'daily'|'nutrition', budget:object, preferences:object, evidence:object}}
 */
export function deriveIntent(constraints = {}, rawText) {
  const raw = String(rawText ?? constraints?.raw ?? '');
  const c = constraints || {};

  /* ---------- 预算 ---------- */
  const budgetMax = c.budgetMax ?? null;
  const budget = classifyBudget(raw, budgetMax);

  /* ---------- 用餐模式 ---------- */
  const nutritionDriven =
    c.caloriesMax != null ||
    c.caloriesMin != null ||
    c.proteinMin != null ||
    (c.objectives || []).some((o) => o.metric === 'protein' || o.metric === 'calories');
  const mode = nutritionDriven ? 'nutrition' : 'daily';

  /* ---------- 口味与背景 ---------- */
  const hints = preferenceHintsFromText(raw, c.dietaryRestrictions);
  const avoidSpicy = hints.avoidSpicy;
  const avoidIce = hints.avoidIce || (!hints.preferColdDrink && (c.excludedFoods || []).some((x) => /冰/.test(x)) || null);
  const avoidOily = hints.avoidOily || (c.excludedFoods || []).some((x) => /油|腻|油炸/.test(x)) || null;
  const stomachContext = hints.stomachContext;

  const preferences = buildPreferences({
    avoidSpicy,
    avoidIce,
    avoidOily,
    stomachContext,
    preferColdDrink: hints.preferColdDrink,
    preferCoolFood: hints.preferCoolFood,
    lightMeal: hints.lightMeal,
    sugarFree: hints.sugarFree,
  });

  // 「一顿饭」语境：明确说一顿/一餐/正餐/套餐时，营养模式也要求像一顿饭的组成，
  // 不能用单个小食（如一份油条）代表"一顿高蛋白餐"。
  const mealContext = /一顿|一餐|正餐|套餐|当饭|吃饭/.test(raw);

  return {
    mode,
    budget,
    preferences,
    mealContext,
    evidence: { raw, budgetMax },
  };
}

/** 偏好结构 + 面向用户的简短说明（诚实边界措辞） */
function buildPreferences({ avoidSpicy, avoidIce, avoidOily, stomachContext, preferColdDrink, preferCoolFood, lightMeal, sugarFree }) {
  return {
    avoidSpicy: avoidSpicy || null, // 'hard' | 'soft' | null
    avoidIce: avoidIce || null,
    avoidOily: avoidOily || null,
    stomachContext: stomachContext || null,
    preferColdDrink: preferColdDrink || null,
    preferCoolFood: preferCoolFood || null,
    lightMeal: lightMeal || null,
    sugarFree: sugarFree || null,
    notes: [
      avoidSpicy === 'hard' ? '明确不能吃辣：含辣商品排除，其余商品辣度菜单无数据、无法逐一核实' : null,
      avoidSpicy === 'soft' ? '不太吃辣：优先不含辣字样的商品（辣度无官方数据，尽力避开）' : null,
      avoidIce ? '不想喝冰饮：优先热饮/常温（温度无官方字段，按名称判断）' : null,
      preferColdDrink ? '想喝冷饮：优先名称带「冰/冷」字样的饮品（温度无官方字段，按名称判断，不保证实际温度）' : null,
      preferCoolFood ? '想吃凉的餐食：菜单没有食物温度数据，无法核实也无法保证，只在名称有明确凉意（如沙拉）时参考' : null,
      lightMeal ? '你说不太饿：按小份、简单搭配优先，不会为了凑满预算加餐（也不虚构热量上限）' : null,
      sugarFree ? '饮料最好无糖：菜单没有含糖量字段，只按名称里明确的「无糖/零糖」判断，其余一律标注「含糖量未核实」' : null,
      avoidOily ? '不想吃油：用官方脂肪数据辅助排序，不等同于"清淡"标准' : null,
      stomachContext ? '只是身体状态背景，不做医学判断，也不承诺"养胃/温和有效"' : null,
    ].filter(Boolean),
  };
}

const BUDGET_INTENT_VALUES = new Set(Object.values(BUDGET_INTENT));

/**
 * 汇总意图（正式入口）：确定性原文证据优先，解析层给出的语义提示只做补充。
 * - 预算意图：原文正则有明确证据时以原文为准；否则采纳解析层（LLM/规则）的 budgetIntent 提示。
 * - 偏好：任一来源有证据即采纳；「不能吃辣」的 hard 强度只认原文硬证据或解析层明确标注。
 * @param {object} constraints 已规范化约束（可带 budgetIntent / preferences 提示）
 * @param {string} [rawText]
 */
export function resolveIntent(constraints = {}, rawText) {
  const intent = deriveIntent(constraints, rawText);
  const c = constraints || {};

  const hinted = typeof c.budgetIntent === 'string' && BUDGET_INTENT_VALUES.has(c.budgetIntent) ? c.budgetIntent : null;
  // 「range」必须有真实区间数字支撑；模型给了 range 但原文抽不出区间数字时降级为目标价带上限
  const hintedSafe = hinted === BUDGET_INTENT.RANGE && !intent.budget.range ? BUDGET_INTENT.TARGET_WITH_CAP : hinted;
  if (hintedSafe && intent.budget.intentSource === 'fallback') {
    intent.budget.intent = hintedSafe;
    intent.budget.intentSource = 'hint';
    intent.budget.cap = hintedSafe === BUDGET_INTENT.TARGET ? null : intent.budget.amount;
    intent.budget.target = hintedSafe === BUDGET_INTENT.TARGET || hintedSafe === BUDGET_INTENT.TARGET_WITH_CAP ? intent.budget.amount : null;
    intent.budget.evidence = `解析提示：${hintedSafe}`;
  }

  const hp = (c.preferences && typeof c.preferences === 'object') ? c.preferences : {};
  const merged = {
    avoidSpicy: intent.preferences.avoidSpicy || (hp.avoidSpicy === 'hard' ? 'hard' : hp.avoidSpicy ? 'soft' : null),
    // 「想要冷饮」与「不想喝冰」互斥：任一来源有冷饮正向证据时不采纳 avoidIce 提示
    avoidIce: intent.preferences.preferColdDrink ? null : (intent.preferences.avoidIce || Boolean(hp.avoidIce) || null),
    avoidOily: intent.preferences.avoidOily || Boolean(hp.avoidOily) || null,
    stomachContext: intent.preferences.stomachContext || Boolean(hp.stomachContext) || null,
    preferColdDrink: intent.preferences.preferColdDrink || Boolean(hp.preferColdDrink) || null,
    preferCoolFood: intent.preferences.preferCoolFood || Boolean(hp.preferCoolFood) || null,
    lightMeal: intent.preferences.lightMeal || Boolean(hp.lightMeal) || null,
    sugarFree: intent.preferences.sugarFree || Boolean(hp.sugarFree) || null,
  };
  intent.preferences = buildPreferences(merged);
  return intent;
}

/** 给界面看的、极简的需求理解标签（最多 4 个） */
export function intentChips(constraints, intent) {
  const chips = [];
  const b = intent.budget;
  if (b.intent === BUDGET_INTENT.RANGE && b.range) chips.push(`预算 ¥${b.range.min}–${b.range.max}`);
  else if (constraints.budgetMin != null && b.amount != null && b.intent !== BUDGET_INTENT.MINIMIZE) chips.push(`预算 ¥${constraints.budgetMin}–${b.amount}`);
  if (b.intent === BUDGET_INTENT.MAX && b.amount != null) chips.push(`不超过 ¥${b.amount}`);
  if (b.intent === BUDGET_INTENT.TARGET && b.amount != null) chips.push(`约 ¥${b.amount}`);
  if (b.intent === BUDGET_INTENT.TARGET_WITH_CAP && b.amount != null) chips.push(`¥${b.amount} 左右的套餐`);
  if (b.intent === BUDGET_INTENT.MINIMIZE) chips.push(b.amount != null ? `越便宜越好（¥${b.amount} 内）` : '越便宜越好');
  const p = intent.preferences;
  if (p.lightMeal) chips.push('不太饿 · 小份优先');
  if (p.avoidOily) chips.push('偏清淡');
  if (p.avoidSpicy === 'hard') chips.push('不能吃辣');
  else if (p.avoidSpicy === 'soft') chips.push('不太吃辣');
  if (p.preferColdDrink) chips.push('想喝冷饮');
  else if (p.avoidIce) chips.push('不喝冰饮');
  if (p.preferCoolFood) chips.push('想吃凉的');
  if (p.sugarFree) chips.push('饮料最好无糖');
  if (p.stomachContext) chips.push('想吃温和点');
  if (constraints.proteinMin != null) chips.push(`蛋白 ≥ ${constraints.proteinMin}g`);
  if (constraints.caloriesMax != null) chips.push(`热量 ≤ ${constraints.caloriesMax} kcal`);
  if (constraints.caloriesMin != null) chips.push(`热量 ≥ ${constraints.caloriesMin} kcal`);
  if ((constraints.requiredCategories || []).includes('drink')) chips.push('要有饮料');
  if ((constraints.requiredCategories || []).includes('main')) chips.push('要正餐');
  if ((constraints.objectives || []).some((o) => o.metric === 'protein' && o.direction === 'max')) chips.push('多补蛋白');
  if ((constraints.objectives || []).some((o) => o.metric === 'calories' && o.direction === 'min')) chips.push('控热量');
  return chips.slice(0, 5);
}

/** 不超过一个、真正需要用户确认的提示；其余一律不追问 */
export function singleClarification(constraints, intent) {
  // 价格区间自相矛盾，用户必须决定，其他情况一律不打扰
  if (constraints.caloriesMin != null && constraints.caloriesMax != null && constraints.caloriesMin > constraints.caloriesMax) {
    return {
      id: 'calorie_conflict',
      text: `热量下限 ${constraints.caloriesMin} 比上限 ${constraints.caloriesMax} 还高，是否把上限提高？`,
    };
  }
  // 明确的食物安全级过敏：提醒风险，但不因此停下配餐
  const allergen = (constraints.dietaryRestrictions || []).find((d) => d.type === 'allergen');
  if (allergen) {
    return {
      id: 'allergen_notice',
      text: '你提到了过敏限制。菜单没有配料/过敏原明细，系统无法替你判断是否安全，建议向门店确认后再决定。',
    };
  }
  return null;
}
