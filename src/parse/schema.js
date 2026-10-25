/**
 * 约束结构定义、规范化与校验。
 *
 * 这里是「LLM 输出 → 可信结构化约束」的最后一道闸门：
 * 1. 字段白名单：模型返回的多余字段直接丢弃。
 * 2. 数值反幻觉：任何数值必须能在用户原文里找到对应数字，否则置 null 并记 warning。
 * 3. 区间自洽：min/max 冲突时生成待确认项（clarification），不擅自帮用户改。
 * 4. 枚举收敛：分类/指标只接受白名单值。
 */
import { classifyBudget, parseBudgetRange, cnToNumber } from './intent.js';

export const ROLES = ['main', 'side', 'drink', 'dessert', 'other'];
export const ROLE_LABEL = { main: '主食', side: '小食', drink: '饮料', dessert: '甜品', other: '其他' };
export const METRICS = ['price', 'protein', 'calories', 'taste'];
export const DIRECTIONS = ['min', 'max', 'satisfy'];
export const BUDGET_INTENTS = ['max', 'target', 'target_with_cap', 'range', 'minimize', 'unspecified'];

export const LIMITS = {
  budgetMax: { min: 1, max: 500 },
  budgetMin: { min: 0, max: 500 },
  caloriesMin: { min: 0, max: 3000 },
  caloriesMax: { min: 50, max: 3000 },
  proteinMin: { min: 1, max: 200 },
};

export function emptyConstraints(raw = '') {
  return {
    budgetMax: null,
    /** 预算区间下限（目标区间「35到45块」=35；单值预算为 null） */
    budgetMin: null,
    caloriesMax: null,
    caloriesMin: null,
    proteinMin: null,
    /** 预算意图提示：max/target/target_with_cap/minimize/unspecified（第五阶段） */
    budgetIntent: null,
    /** 口味偏好提示：{avoidSpicy:'hard'|'soft', avoidIce, avoidOily, stomachContext}（第五阶段） */
    preferences: null,
    preferredFoods: [],
    excludedFoods: [],
    dietaryRestrictions: [],
    requiredCategories: [],
    preferredCategories: [],
    objectives: [],
    hardConstraints: [],
    softPreferences: [],
    clarifications: [],
    notes: null,
    raw,
  };
}

const NUM_WORDS = { 十: 10, 二十: 20, 三十: 30, 四十: 40, 五十: 50, 十五: 15, 二十五: 25, 三十五: 35, 四十五: 45 };
const CN_DIGIT = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/**
 * 中文「百」系数字（此前 NUM_WORDS 不含「百」，"百元以内"的 100 被反幻觉误判为臆造而清空）。
 * 覆盖：百元/百块（=100）、三百（=300）、一百五（=150 口语）、一百五十（=150）、一百零五（=105）。
 * 裸「百」仅在后接 元/块/钱 时计数，避免"百货/百分百"这类普通词误入白名单。
 */
function addCnHundreds(t, nums) {
  // 注意：汉字码位不连续（五=U+4E94 不在「一-九」区间内），字符类必须显式列举
  for (const m of t.matchAll(/([一二三四五六七八九两])?百/g)) {
    const head = m[1] ? CN_DIGIT[m[1]] : null;
    const base = m[1] ? (head != null ? head * 100 : null) : (/[元块钱]/.test(t[m.index + 1] || '') ? 100 : null);
    if (base == null) continue;
    const tail = t.slice(m.index + m[0].length, m.index + m[0].length + 3);
    const tm = tail.match(/^(?:零([一二三四五六七八九])|([一二三四五六七八九])十([一二三四五六七八九])?|十([一二三四五六七八九])?|([一二三四五六七八九]))/);
    if (tm) {
      // 有尾数只认合成值（「一百五」=150，不额外放行 100，避免反幻觉白名单过宽）
      if (tm[1]) nums.add(base + CN_DIGIT[tm[1]]);
      else if (tm[2]) nums.add(base + CN_DIGIT[tm[2]] * 10 + (tm[3] ? CN_DIGIT[tm[3]] : 0));
      else if (tm[4] !== undefined) nums.add(base + 10 + (tm[4] ? CN_DIGIT[tm[4]] : 0));
      else if (tm[5]) nums.add(base + CN_DIGIT[tm[5]] * 10); // 「一百五」= 150 的口语省略
    } else {
      nums.add(base);
    }
  }
}

/** 从原文抽取全部数字（含中文数字词），用于反幻觉核对 */
export function numbersInText(text) {
  const t = String(text || '');
  const nums = new Set();
  for (const m of t.matchAll(/\d+(?:\.\d+)?/g)) nums.add(Number(m[0]));
  for (const [w, v] of Object.entries(NUM_WORDS)) if (t.includes(w)) nums.add(v);
  // 通用中文数字（十系/个位）：覆盖 NUM_WORDS 未收录的「三十二」等；百系仍走 addCnHundreds
  // 的单位守卫，避免「百货/百分百」误入白名单。
  for (const m of t.matchAll(/[一二两三四五六七八九十]+/g)) {
    const v = cnToNumber(m[0]);
    if (v != null) nums.add(v);
  }
  addCnHundreds(t, nums);
  return nums;
}

function coerceNumber(value, field, textNums, warnings) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    warnings.push(`${field}：模型给出的不是数字（${JSON.stringify(value)}），已置空`);
    return null;
  }
  const lim = LIMITS[field];
  if (lim && (n < lim.min || n > lim.max)) {
    warnings.push(`${field}=${n} 超出合理范围 [${lim.min},${lim.max}]，已置空`);
    return null;
  }
  if (textNums && !textNums.has(n)) {
    warnings.push(`${field}=${n} 在用户原话中找不到对应数字，判定为模型臆造，已置空`);
    return null;
  }
  return n;
}

function asArray(v) {
  if (Array.isArray(v)) return v.filter((x) => x != null && String(x).trim() !== '');
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

function uniq(list) {
  return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
}

/**
 * 规范化模型/规则输出。
 * @param {object} input 原始对象
 * @param {string} rawText 用户原话（用于反幻觉核对）
 * @param {{parseSource?:string, strictNumbers?:boolean}} opts
 */
export function normalizeConstraints(input, rawText, opts = {}) {
  const warnings = [];
  const textNums = opts.strictNumbers === false ? null : numbersInText(rawText);
  const out = emptyConstraints(rawText);

  out.budgetMax = coerceNumber(input.budgetMax, 'budgetMax', textNums, warnings);
  out.budgetMin = coerceNumber(input.budgetMin, 'budgetMin', textNums, warnings);

  // —— 预算区间归一（P0）：区间优先，绝不把区间起点当上限 ——
  // 原文是区间（「35到45块」「三十五到四十五元」）时：上限=区间终点，下限=区间起点。
  // 无论模型/规则把起点还是终点给了 budgetMax，都对齐到区间语义，避免无意义的解析冲突。
  const budgetRange = parseBudgetRange(rawText);
  if (budgetRange && budgetRange.min < budgetRange.max) {
    if (out.budgetMax != null && out.budgetMax === budgetRange.min) {
      warnings.push(`budgetMax：原文是区间 ${budgetRange.min}-${budgetRange.max}，起点被误当上限，已修正为区间上限 ${budgetRange.max}`);
      out.budgetMax = budgetRange.max;
    }
    if (out.budgetMax == null || out.budgetMax === budgetRange.max) {
      out.budgetMax = budgetRange.max;
      if (out.budgetMin == null) out.budgetMin = budgetRange.min;
    }
    if (out.budgetMin != null && out.budgetMin === budgetRange.max && out.budgetMax === budgetRange.max && budgetRange.min !== budgetRange.max) {
      out.budgetMin = budgetRange.min;
    }
  }
  if (out.budgetMin != null && out.budgetMax != null && out.budgetMin > out.budgetMax) {
    warnings.push(`budgetMin=${out.budgetMin} 高于 budgetMax=${out.budgetMax}，已按区间语义对齐顺序`);
    [out.budgetMin, out.budgetMax] = [out.budgetMax, out.budgetMin];
  }
  out.caloriesMax = coerceNumber(input.caloriesMax, 'caloriesMax', textNums, warnings);
  out.caloriesMin = coerceNumber(input.caloriesMin, 'caloriesMin', textNums, warnings);
  out.proteinMin = coerceNumber(input.proteinMin, 'proteinMin', textNums, warnings);

  // —— 预算意图与偏好提示（第五阶段）：只做枚举收敛，不做数值推断 ——
  out.budgetIntent = BUDGET_INTENTS.includes(input.budgetIntent) ? input.budgetIntent : null;
  // 有限条件回退（性能专项）：原文有明确词面证据时（classifyBudget 判定 intentSource='raw-regex'，
  // 如「越便宜越好」「60元左右」「40元以内」），纠正模型的 budgetIntent 误判或补齐模型漏给；
  // 无词面证据时保留模型语义判断——目标价不越级为「越便宜越好」，反之亦然。
  const lexicalBudget = classifyBudget(rawText, out.budgetMax);
  if (lexicalBudget.intentSource === 'raw-regex') {
    if (!out.budgetIntent) {
      out.budgetIntent = lexicalBudget.intent;
    } else if (lexicalBudget.intent !== out.budgetIntent) {
      warnings.push(`budgetIntent：模型给 ${out.budgetIntent}，原文词面证据为 ${lexicalBudget.intent}，已按原文纠正`);
      out.budgetIntent = lexicalBudget.intent;
    }
  }
  out.preferences = normalizePreferences(input.preferences);
  // 无糖诉求：模型可能漏给，原文有明确「无糖/零糖」词面证据时补齐。
  // 它仍是软偏好——菜单没有含糖量字段，只有名称里写明「无糖」的才算证据。
  if (/无糖|零糖|0\s*糖|不含糖|控糖/.test(String(rawText || ''))) {
    out.preferences = { ...(out.preferences || {}), sugarFree: true };
  }

  out.preferredFoods = uniq(asArray(input.preferredFoods));
  out.excludedFoods = uniq(asArray(input.excludedFoods));
  out.requiredCategories = uniq(asArray(input.requiredCategories)).filter((r) => ROLES.includes(r));
  out.preferredCategories = uniq(asArray(input.preferredCategories)).filter((r) => ROLES.includes(r));

  const objectives = asArray(input.objectives)
    .map((o) => (typeof o === 'string' ? { metric: o, direction: null } : o))
    .filter((o) => o && METRICS.includes(o.metric))
    .map((o) => ({ metric: o.metric, direction: DIRECTIONS.includes(o.direction) ? o.direction : defaultDirection(o.metric) }));
  out.objectives = dedupeObjectives(objectives);

  out.dietaryRestrictions = asArray(input.dietaryRestrictions).map((d, i) => {
    const item = typeof d === 'string' ? { text: d } : d;
    return {
      id: item.id || `dr${i + 1}`,
      text: String(item.text || item.type || '').trim(),
      type: ['spicy', 'allergen', 'vegetarian', 'pork', 'other'].includes(item.type) ? item.type : 'other',
      /** 关键：菜单数据没有辣度/配料/过敏原字段，任何此类限制都无法由系统验证 */
      verified: false,
      note: item.note || '菜单数据不含辣度/配料/过敏原字段，系统无法验证此项是否满足',
    };
  });

  out.hardConstraints = uniq(asArray(input.hardConstraints));
  out.softPreferences = uniq(asArray(input.softPreferences));
  out.notes = input.notes ? String(input.notes).slice(0, 300) : null;

  // —— 自洽性检查（只提示，不擅自修改用户意图） ——
  if (out.caloriesMin != null && out.caloriesMax != null && out.caloriesMin > out.caloriesMax) {
    out.clarifications.push({
      id: 'cal_range_conflict',
      field: 'caloriesMin',
      question: `热量下限 ${out.caloriesMin} kcal 高于上限 ${out.caloriesMax} kcal，是否把上限提高或去掉下限？`,
      reason: '上下限互相矛盾，任何商品都无法同时满足',
    });
  }
  if (out.budgetMax != null && out.budgetMin == null && out.budgetMax < 5) {
    out.clarifications.push({
      id: 'budget_too_low',
      field: 'budgetMax',
      question: `预算 ${out.budgetMax} 元可能买不到任何一餐，是否指 ${out.budgetMax * 10} 元？`,
      reason: '预算极低，大概率不可行',
    });
  }
  if (out.proteinMin != null && out.proteinMin > 60) {
    out.clarifications.push({
      id: 'protein_high',
      field: 'proteinMin',
      question: `蛋白质下限 ${out.proteinMin}g 对单餐偏高，是否确认？`,
      reason: '单份麦当劳餐品的蛋白质普遍低于 50g',
    });
  }
  for (const next of asArray(input.clarifications)) {
    const q = typeof next === 'string' ? { question: next } : next;
    if (q?.question) {
      out.clarifications.push({
        id: q.id || `cl${out.clarifications.length + 1}`,
        field: q.field || null,
        question: String(q.question),
        reason: q.reason ? String(q.reason) : '模型标注的待确认项',
      });
    }
  }

  // —— 优化倾向必须有原文依据（防止模型把「练完胸」推断成「要高蛋白」） ——
  const OBJECTIVE_EVIDENCE = {
    'protein:max': /高蛋白|蛋白(?:质)?(?:要|得|需要)?(?:高|多)|多(?:补|吃|来)(?:点)?蛋白|增肌|长肌肉|补蛋白/,
    'calories:min': /低卡|低热量|减脂|减肥|控制(?:一下)?(?:总)?热量|热量低|少吃点|别太油/,
    'price:min': /便宜|省钱|实惠|性价比|不贵|划算/,
    'taste:max': /好吃|口味|喜欢|最爱/,
  };
  const droppedObjectives = [];
  out.objectives = out.objectives.filter((o) => {
    const key = `${o.metric}:${o.direction}`;
    const re = OBJECTIVE_EVIDENCE[key];
    if (!re) return true;
    if (re.test(rawText)) return true;
    droppedObjectives.push(o);
    return false;
  });
  for (const o of droppedObjectives) {
    // 只有「健身/训练」语境下的蛋白质倾向值得回问用户；价格/热量/口味的倾向被丢弃是静默正确的
    if (o.metric !== 'protein') continue;
    if (out.clarifications.some((c) => /蛋白/.test(c.question))) continue;
    out.clarifications.push({
      id: 'objective_unverified_protein',
      field: 'objectives',
      question: '你提到了锻炼场景，但没有明确说要高蛋白。要不要把「尽量高蛋白」作为优化倾向？（这仍然只是倾向，不会变成蛋白质下限）',
      reason: '原话中没有对应的明确表述，系统不擅自推断优化目标',
    });
  }

  // —— 待确认项去重 + 收敛（第五阶段：最多 1 个真正需要用户拍板的确认） ——
  const seenQ = new Set();
  const deduped = out.clarifications.filter((c) => {
    const k = String(c.question || '').trim();
    if (!k || seenQ.has(k)) return false;
    seenQ.add(k);
    return true;
  });
  // 只有"自相矛盾、任何商品都无法满足"的场景值得反问；其余（预算偏低、数值偏高、
  // 模型规则分歧、要不要把偏好当目标）一律降级为说明，不打扰用户。
  const BLOCKING_IDS = new Set(['cal_range_conflict']);
  const blocking = deduped.filter((c) => BLOCKING_IDS.has(c.id));
  const info = deduped.filter((c) => !BLOCKING_IDS.has(c.id));
  out.clarifications = blocking.slice(0, 1);
  const demoted = info.map((c) => (c.question || '').replace(/是否.*[？?]?$/, '').trim()).filter(Boolean);
  if (demoted.length) {
    out.notes = [out.notes, ...demoted].filter(Boolean).join('；').slice(0, 500);
  }

  // —— 硬/软约束清单由结构化字段派生，避免只信模型自述 ——
  const derivedHard = [];
  if (out.budgetMax != null) derivedHard.push(`预算 ≤ ¥${out.budgetMax}`);
  if (out.caloriesMax != null) derivedHard.push(`热量 ≤ ${out.caloriesMax} kcal`);
  if (out.caloriesMin != null) derivedHard.push(`热量 ≥ ${out.caloriesMin} kcal`);
  if (out.proteinMin != null) derivedHard.push(`蛋白质 ≥ ${out.proteinMin} g`);
  if (out.excludedFoods.length) derivedHard.push(`排除：${out.excludedFoods.join('、')}`);
  if (out.requiredCategories.length) derivedHard.push(`必须包含：${out.requiredCategories.map((r) => ROLE_LABEL[r]).join('、')}`);
  for (const d of out.dietaryRestrictions) derivedHard.push(`饮食限制：${d.text}`);

  const derivedSoft = [];
  if (out.budgetMin != null && out.budgetMax != null) derivedSoft.push(`目标价位 ¥${out.budgetMin}–${out.budgetMax}（尽量落在区间内，不强求花满）`);
  if (out.preferredFoods.length) derivedSoft.push(`偏好：${out.preferredFoods.join('、')}`);
  if (out.preferredCategories.length) derivedSoft.push(`希望包含：${out.preferredCategories.map((r) => ROLE_LABEL[r]).join('、')}`);
  for (const o of out.objectives) {
    if (o.metric === 'protein' && o.direction === 'max') derivedSoft.push('尽量高蛋白（优化倾向，非硬阈值）');
    if (o.metric === 'calories' && o.direction === 'min') derivedSoft.push('尽量低热量');
    if (o.metric === 'price' && o.direction === 'min') derivedSoft.push('尽量便宜');
    if (o.metric === 'taste') derivedSoft.push('口味优先');
  }

  // 硬/软清单完全由结构化字段派生：避免模型自述与结构化字段不一致（例如重复表述同一约束）
  out.hardConstraints = derivedHard;
  out.softPreferences = derivedSoft;

  return { constraints: out, warnings };
}

function defaultDirection(metric) {
  if (metric === 'price' || metric === 'calories') return 'min';
  if (metric === 'protein' || metric === 'taste') return 'max';
  return 'satisfy';
}

/** 口味偏好提示的白名单收敛（只接受已知键与合法枚举，不接受任意文本） */
function normalizePreferences(input) {
  if (!input || typeof input !== 'object') return null;
  const spicy = ['hard', 'soft'].includes(input.avoidSpicy) ? input.avoidSpicy : (input.avoidSpicy ? 'soft' : null);
  // 「想要冷饮」与「不想喝冰」互斥：正向冷饮证据优先，不同时成立
  const preferColdDrink = input.preferColdDrink ? true : null;
  const out = {
    avoidSpicy: spicy,
    avoidIce: preferColdDrink ? null : (input.avoidIce ? true : null),
    avoidOily: input.avoidOily ? true : null,
    stomachContext: input.stomachContext ? true : null,
    preferColdDrink,
    preferCoolFood: input.preferCoolFood ? true : null,
    lightMeal: input.lightMeal ? true : null,
    sugarFree: input.sugarFree ? true : null,
  };
  const any = out.avoidSpicy || out.avoidIce || out.avoidOily || out.stomachContext || out.preferColdDrink || out.preferCoolFood || out.lightMeal || out.sugarFree;
  return any ? out : null;
}

function dedupeObjectives(list) {
  const map = new Map();
  for (const o of list) map.set(o.metric, o);
  return [...map.values()];
}

/** 生成给前端的可编辑表单用的摘要 */
export function summarizeConstraints(c) {
  return {
    hard: c.hardConstraints,
    soft: c.softPreferences,
    unverifiable: c.dietaryRestrictions.filter((d) => !d.verified).map((d) => d.text),
    pending: c.clarifications.map((x) => x.question),
  };
}
