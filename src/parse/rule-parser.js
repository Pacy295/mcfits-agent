/**
 * 规则解析器（确定性，可离线单测）。
 *
 * 定位：
 * 1. LLM 不可用时的备用路径 —— 保证"结构化输入"这条路始终可测。
 * 2. LLM 可用时的交叉校验参考（数值抽取逻辑更保守）。
 *
 * 原则：
 * - 只抽取原文出现的数字，绝不推断阈值。
 * - 「高蛋白」只产生优化倾向（objectives.protein=max），绝不生成 proteinMin。
 * - 「必须有饮料」→ requiredCategories.drink（硬）；「最好来杯无糖可乐」→ preferredFoods（软）。
 * - 辣度/配料/过敏原类限制一律 verified:false。
 * - 预算意图（上限/目标价/套餐价/越便宜越好）与口味偏好（辣/冰/油/胃）由 intent.js 的
 *   确定性正则统一识别（第五阶段），本文件只负责把数字抽出来。
 */

import { classifyBudget, preferenceHintsFromText, parseBudgetRange } from './intent.js';

const FOOD_TERMS = [
  { aliases: ['巨无霸'], term: '巨无霸' },
  { aliases: ['板烧'], term: '板烧' },
  { aliases: ['麦香鱼'], term: '麦香鱼' },
  { aliases: ['麦香鸡'], term: '麦香鸡' },
  { aliases: ['麦辣鸡腿', '麦辣'], term: '麦辣鸡腿' },
  { aliases: ['双层吉士'], term: '双层吉士' },
  { aliases: ['安格斯'], term: '安格斯' },
  { aliases: ['不素之霸'], term: '不素之霸' },
  { aliases: ['鳕鱼'], term: '深海鳕鱼' },
  { aliases: ['那么大一鸡排', '鸡排'], term: '鸡排' },
  { aliases: ['薯条'], term: '薯条' },
  { aliases: ['麦乐鸡', '鸡块'], term: '麦乐鸡' },
  { aliases: ['鸡翅'], term: '鸡翅' },
  { aliases: ['脆汁鸡'], term: '脆汁鸡' },
  { aliases: ['玉米杯'], term: '玉米杯' },
  { aliases: ['新地'], term: '新地' },
  { aliases: ['麦旋风'], term: '麦旋风' },
  { aliases: ['圆筒', '冰淇淋'], term: '圆筒' },
  { aliases: ['苹果片'], term: '苹果片' },
  { aliases: ['可乐'], term: '可乐' },
  { aliases: ['雪碧'], term: '雪碧' },
  { aliases: ['咖啡', '美式', '奶铁', '拿铁'], term: '咖啡' },
  { aliases: ['红茶'], term: '红茶' },
  { aliases: ['牛奶'], term: '牛奶' },
];

const NUM = '(\\d+(?:\\.\\d+)?)';
const CAL_UNIT = '(?:kcal|千卡|大卡|卡路里|卡)';

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return Number(m[1]);
  }
  return null;
}

/** 找出文本里提到的餐品词（返回规范检索词） */
export function detectFoodTerms(text) {
  const hits = [];
  for (const { aliases, term } of FOOD_TERMS) {
    if (aliases.some((a) => text.includes(a))) hits.push(term);
  }
  return [...new Set(hits)];
}

/**
 * @param {string} text 用户原话
 * @returns {object} 未规范化的原始约束对象（交给 normalizeConstraints）
 */
export function parseByRules(text) {
  const t = String(text || '');
  const out = {
    budgetMax: null,
    budgetMin: null,
    caloriesMax: null,
    caloriesMin: null,
    proteinMin: null,
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
  };

  // —— 预算：优先识别完整区间，再取单值（P0：「35到45块」绝不能把起点 35 当上限） ——
  const budgetRange = parseBudgetRange(t);
  if (budgetRange) {
    out.budgetMin = budgetRange.min; // 目标区间下限（软目标）
    out.budgetMax = budgetRange.max; // 预算上限 = 区间终点
  } else {
    // —— 单值预算：必须有货币单位或"预算"字样，避免把"3块麦乐鸡"的 3 当成预算 ——
    out.budgetMax = firstMatch(t, [
      new RegExp(`(?:预算|最多|不超过|不超|控制在|顶多|至多|价格)\\D{0,6}${NUM}\\s*(?:元|块钱|块)`),
      new RegExp(`${NUM}\\s*(?:元|块钱|块)?\\s*(?:以内|以下|之内|封顶)`),
      // 第五阶段：「推荐一个 60 元的套餐」「一顿 30 元」「人均 50 元」也是预算表达
      // 注意用 \D{0,6} 而不是 .{0,6}：后者贪婪吞掉数字首位会把 60 抽成 0
      new RegExp(`(?:推荐|来|要|给我|配|搭|吃)\\D{0,6}${NUM}\\s*(?:元|块钱|块)?\\s*(?:的)?(?:套餐|一顿|一餐|餐)`),
      new RegExp(`${NUM}\\s*(?:元|块钱|块)\\s*(?:的)?(?:套餐|一顿|一餐)`),
      new RegExp(`人均\\D{0,4}${NUM}\\s*(?:元|块钱|块)?`),
      new RegExp(`${NUM}\\s*(?:元|块钱|块)\\s*(?:左右|上下|附近)`),
    ]);
    if (out.budgetMax == null) {
      const m = new RegExp(`(?:预算|不超过|最多)\\D{0,6}${NUM}`).exec(t);
      if (m && /元|块|钱/.test(t)) out.budgetMax = Number(m[1]);
    }
  }

  // —— 热量 ——
  out.caloriesMax = firstMatch(t, [
    new RegExp(`(?:热量|卡路里|能量)?\\s*(?:不超过|不高于|低于|少于|最多|控制在|≤|<)\\s*${NUM}\\s*${CAL_UNIT}`),
    new RegExp(`${NUM}\\s*${CAL_UNIT}\\s*(?:以内|以下|之内|封顶)`),
  ]);
  out.caloriesMin = firstMatch(t, [
    // 注意：「不超过 750 kcal」里的「超过」不能算下限，用 (?<!不) 排除
    new RegExp(`(?:热量|卡路里|能量)?\\s*(?:至少|不低于|不少于|高于|(?<!不)超过|(?<!不)大于|≥|(?<!>)>)\\s*${NUM}\\s*${CAL_UNIT}`),
  ]);

  // —— 蛋白质：只有明确数字才是硬约束 ——
  out.proteinMin = firstMatch(t, [
    new RegExp(`(?:蛋白质|蛋白)\\D{0,8}?(?:至少|不低于|不少于|超过|大于|≥|>)\\s*${NUM}\\s*(?:g|克)?`),
    new RegExp(`(?:至少|不低于|不少于)\\s*${NUM}\\s*(?:g|克)\\s*(?:蛋白质|蛋白)`),
    // 后置写法：「蛋白30g以上」「蛋白质30克以上」（以上/起 = 下限语义）
    new RegExp(`(?:蛋白质|蛋白)\\D{0,8}?${NUM}\\s*(?:g|克)?\\s*(?:以上|起)`),
  ]);

  // —— 优化倾向（不产生数值） ——
  if (/高蛋白|多(?:补|吃)?点?蛋白|蛋白质(?:高|多)|增肌|长肌肉|蛋白(?:质)?(?:要|得|需要)(?:多|高)/.test(t)) {
    out.objectives.push({ metric: 'protein', direction: 'max' });
  }
  if (/低卡|低热量|减脂|减肥|少吃点|控制(?:一下)?(?:总)?热量|热量低|别太油/.test(t)) {
    out.objectives.push({ metric: 'calories', direction: 'min' });
  }
  if (/便宜|省钱|实惠|性价比|不贵|划算/.test(t)) {
    out.objectives.push({ metric: 'price', direction: 'min' });
  }
  if (/好吃|口味|喜欢|最爱|好吃点/.test(t)) {
    out.objectives.push({ metric: 'taste', direction: 'max' });
  }

  // —— 必须有饮料 / 必须是正餐 ——
  if (/(?:必须|一定要|要|得|需要|带|配|加).{0,3}(?:杯|份|个)?(?:饮料|喝的|饮品)|饮料(?:必须|要)/.test(t)) {
    out.requiredCategories.push('drink');
  }
  if (/(?:一顿|一餐|正餐|主食|吃饱|午饭|晚饭|午餐|晚餐|早饭|早餐|当饭)/.test(t)) {
    out.requiredCategories.push('main');
  }

  // —— 排除项 ——
  const excludeRe = /(?:不要|不吃|别(?:加|要|放|给)?|去掉|不能吃|忌口?|排除|不含)\s*([^\s，,。；;！!？?]{1,10})/g;
  for (const m of t.matchAll(excludeRe)) {
    const phrase = m[1];
    const terms = detectFoodTerms(phrase);
    if (terms.length) out.excludedFoods.push(...terms);
    else if (phrase.length <= 6 && !/辣|肉|冰|糖/.test(phrase)) out.excludedFoods.push(phrase);
  }

  // —— 偏好项（软） ——
  const preferRe = /(?:最好|想吃|想喝|来(?:一)?[杯份个]|要(?:一)?[杯份个]|喜欢|偏爱)\s*([^\s，,。；;！!？?]{1,10})/g;
  for (const m of t.matchAll(preferRe)) {
    const phrase = m[1];
    const terms = detectFoodTerms(phrase);
    const sugarFree = /无糖/.test(phrase);
    for (const term of terms) out.preferredFoods.push(sugarFree ? `无糖${term}` : term);
  }
  if (/无糖/.test(t) && !out.preferredFoods.some((x) => x.startsWith('无糖'))) out.preferredFoods.push('无糖');

  // —— 饮食限制（无法验证，一律 unverified） ——
  if (/不吃辣|不要辣|不能吃辣|忌辣|不辣|怕辣/.test(t)) {
    out.dietaryRestrictions.push({ type: 'spicy', text: '不吃辣' });
    if (out.excludedFoods.includes('麦辣鸡腿')) {
      out.notes = '同时提到「不吃辣」与「不要麦辣」，系统会排除含"辣"字商品，但无法验证其它商品的辣度';
    }
  }
  if (/不吃(?:猪|猪肉)|清真|回民/.test(t)) {
    out.dietaryRestrictions.push({ type: 'pork', text: '不吃猪肉/清真' });
  }
  if (/吃素|素食|不吃肉/.test(t)) {
    out.dietaryRestrictions.push({ type: 'vegetarian', text: '素食' });
  }
  if (/过敏|过敏源|过敏原/.test(t)) {
    out.dietaryRestrictions.push({ type: 'allergen', text: '过敏限制' });
  }

  // —— 语义背景不算约束 ——
  if (/练完|健身|运动|去健身房|刚练/.test(t) && !out.proteinMin && !out.caloriesMax) {
    out.notes = '检测到「锻炼/健身」语境。这只能作为背景，不能据此推断具体热量或蛋白质阈值，因此未生成任何数值约束。';
  }

  // —— 第五阶段：预算意图 + 口味偏好提示（确定性正则，单一来源在 intent.js） ——
  out.budgetIntent = classifyBudget(t, out.budgetMax).intent;
  const pref = preferenceHintsFromText(t, out.dietaryRestrictions);
  out.preferences = {
    avoidSpicy: pref.avoidSpicy,
    avoidIce: pref.avoidIce,
    avoidOily: pref.avoidOily,
    stomachContext: pref.stomachContext,
    sugarFree: pref.sugarFree,
  };
  // 「不喜欢/不爱吃 X」是口味偏好（软），不是「不吃 X」级的硬排除
  const softDislikeRe = /(?:不太喜欢|不喜欢|不爱吃|不想吃|不太想吃|讨厌)\s*([^\s，,。；;！!？?]{1,8})/g;
  for (const m of t.matchAll(softDislikeRe)) {
    const phrase = m[1];
    if (/辣|冰|油|腻/.test(phrase)) continue; // 已由 preferences 表达
    out.softPreferences.push(`尽量避开${phrase}`);
  }

  out.preferredFoods = [...new Set(out.preferredFoods)];
  out.excludedFoods = [...new Set(out.excludedFoods)];
  out.requiredCategories = [...new Set(out.requiredCategories)];

  return out;
}
