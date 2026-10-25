/**
 * 日常点餐模式（daily）的确定性排序。
 *
 * 与营养模式（nutrition）分开：
 * - 营养模式走原有的"价格/蛋白/热量 多目标帕累托"。
 * - 日常模式先满足硬约束，再按"像不像一顿饭、符不符合口味、温度是否合适、价位意图"排序。
 *
 * 不用 LLM 打分，不做主观健康判断，所有理由都能回指到菜单字段或官方营养值。
 */
import { roleOfName } from './classify.js';

/** 名称里明确带辣味的证据（保守：只认明确字样） */
export function hasSpicyMarker(name) {
  return /辣|咖喱|藤椒|麻辣|酸辣|红油|泡椒|椒麻/.test(String(name || ''));
}

/**
 * 饮品温度。只有菜单名称明确支持时才判定：
 * - warm：名称含「热」（热美式/热奶铁/热牛奶/热朱古力…）
 * - cold：名称含「冰」「雪冰」「冰沙」，或本身是冰品（圆筒/新地/麦旋风）
 * - unknown：其余（可乐、果汁、锡兰红茶等），温度待核实，不得默认成"温热"
 */
export function drinkTemperature(name) {
  const n = String(name || '');
  if (/圆筒|新地|麦旋风|冰淇淋|圣代|甜筒|阿芙佳朵/.test(n)) return 'cold';
  if (/雪冰|冰沙|冰美|冰奶|冰拿铁|冰焦|冰牛奶|冰咖啡|冰浓浓|冰燕麦|冰美式|冰奶铁|冰柠|冰爽|冷饮/.test(n)) return 'cold';
  if (/^冰|冰$|（冰|\(冰/.test(n)) return 'cold';
  if (/热|温/.test(n)) return 'warm';
  return 'unknown';
}

const ROLE_LABEL = { main: '主食', side: '小食', drink: '饮料', dessert: '甜品', other: '其他' };

function partsOf(cand) {
  const comps = cand.components || [];
  // 套餐候选的 components 只有 code/name（角色在候选的 roles 汇总里），
  // 这里必须按名称回推逐项角色，否则套餐会被当成"无小食无饮料"打低分，
  // 「主食+小食+饮料」的完整一餐反而排在单品组合后面。
  const roleOf = (c) => c.role || roleOfName(c.name);
  return {
    hasMain: (cand.roles || []).includes('main') || comps.some((c) => roleOf(c) === 'main'),
    sides: comps.filter((c) => roleOf(c) === 'side'),
    drinks: comps.filter((c) => roleOf(c) === 'drink'),
    desserts: comps.filter((c) => roleOf(c) === 'dessert'),
    mains: comps.filter((c) => roleOf(c) === 'main'),
    names: comps.map((c) => c.name).filter(Boolean),
  };
}

function fatOf(cand) {
  return Number.isFinite(cand.nutrition?.fat) ? cand.nutrition.fat : null;
}

/**
 * 给单个候选打分并生成"为什么是它"的理由与需要核实的事项。
 * @returns {{score:number, reasons:string[], cautions:string[], tags:string[]}}
 */
export function scoreDaily(cand, intent) {
  const prefs = intent.preferences || {};
  const p = partsOf(cand);
  const reasons = [];
  const cautions = [];
  const tags = [];
  let score = 0;

  /* ---------- 1. 组合是否像一顿饭 ---------- */
  let compositionScore = 0;
  if (p.hasMain) compositionScore += 2;
  if (p.sides.length) compositionScore += 2;
  if (p.drinks.length) compositionScore += prefs.avoidIce ? 0 : 1;
  if (p.desserts.length) compositionScore += 0.5;
  if (!p.sides.length && !p.drinks.length) compositionScore -= 1;
  score += compositionScore;

  if (p.sides.length && p.drinks.length) reasons.push('主食 + 小食 + 饮料，是一顿完整的饭');
  else if (p.sides.length) reasons.push('主食配小食，能顶一顿');
  else if (p.drinks.length) reasons.push('主食配饮料，简单一餐');
  else reasons.push('单个主食，最省事的填肚子选择');

  /* ---------- 2. 辣味处理 ---------- */
  const spicyNames = p.names.filter(hasSpicyMarker);
  if (spicyNames.length) {
    // 明确辣味的直接淘汰（即使只是偏好，也没必要推给用户）
    score -= 100;
    tags.push('含明显辣味');
  } else if (prefs.avoidSpicy) {
    score += 1.5;
    if (prefs.avoidSpicy === 'hard') {
      cautions.push('名称未见辣味，但没有官方辣度数据，仍建议向门店确认');
    } else {
      cautions.push('按名称避开明显辣味，辣度本身没有官方数据');
    }
  }

  /* ---------- 3. 温度处理（只对饮料/冰品） ---------- */
  const coldItems = [...p.drinks, ...p.desserts].map((c) => ({ ...c, temp: drinkTemperature(c.name) }));
  if (prefs.preferColdDrink) {
    // 正向要冷饮：只按名称证据加分（温度无官方字段，不声称、不保证）
    const cold = coldItems.filter((x) => x.temp === 'cold');
    const unknown = coldItems.filter((x) => x.temp === 'unknown');
    if (cold.length) {
      score += 2;
      reasons.push(`配了${cold[0].name}（按名称看是冷饮）`);
    } else if (unknown.length) {
      score += 0.3;
      cautions.push(`${unknown[0].name}的温度按名称无法确认，是否冰饮以门店为准`);
    } else if (!coldItems.length) {
      score -= 0.5;
    }
  } else if (prefs.avoidIce) {
    const hasCold = coldItems.some((x) => x.temp === 'cold');
    if (hasCold) {
      score -= 100; // 明确冰品直接排除
      tags.push('含冰品');
    } else {
      const warm = coldItems.filter((x) => x.temp === 'warm');
      const unknown = coldItems.filter((x) => x.temp === 'unknown');
      if (warm.length) {
        score += 2.5;
        reasons.push(`配的是${warm[0].name}（热饮）`);
      } else if (!coldItems.length) {
        reasons.push('不加冰饮，按你的要求');
      }
      if (unknown.length) {
        score -= 0.8;
        cautions.push(`${unknown.map((x) => x.name).join('、')}的温度待核实`);
      }
    }
  }

  /* ---------- 3b. 无糖诉求（只看名称证据，绝不猜） ---------- */
  if (prefs.sugarFree) {
    const SUGAR_FREE_NAME = /无糖|零糖|零度|0\s*糖|不含糖/;
    const drinksAll = coldItems;
    const verified = drinksAll.filter((x) => SUGAR_FREE_NAME.test(x.name));
    if (verified.length) {
      score += 2.5;
      reasons.push(`${verified[0].name}名称写明无糖，按名称作为无糖选择`);
    } else if (drinksAll.length) {
      score -= 0.8;
      cautions.push(`菜单没有含糖量字段，${drinksAll.map((d) => d.name).join('、')}是否无糖无法核实`);
    } else {
      cautions.push('这套没有饮料，无法满足「饮料最好无糖」');
    }
  }

  /* ---------- 4. 脂肪（辅助，不是"清淡"标准） ---------- */
  const fat = fatOf(cand);
  if (prefs.avoidOily && fat != null) {
    score -= fat * 0.08;
    reasons.push(`脂肪 ${fat}g，用来辅助避开高油搭配`);
    cautions.push('「清淡」只用脂肪数据辅助排序，不代表医学或官方认定');
  }

  /* ---------- 4b. 份量（不太饿 → 小份优先，不为凑满预算加餐，不虚构热量上限） ---------- */
  if (prefs.lightMeal) {
    const n = p.names.length;
    if (n <= 1) {
      score += 2;
      reasons.push('你说不太饿，简单一份就够');
    } else if (n === 2) {
      score += 1.5;
      reasons.push('你说不太饿，两件轻量搭配刚刚好');
    } else if (n >= 4) {
      score -= (n - 2) * 2;
      cautions.push('件数偏多，不太饿的时候可能吃不完');
    } else {
      score -= 0.5;
    }
    cautions.push('菜单没有每份的克重/热量口径，「小份」只按件数估计，不虚构热量上限');
  }

  /* ---------- 4c. 食物温度（凉凉的）：菜单无温度数据，只提示不声称 ---------- */
  if (prefs.preferCoolFood) {
    cautions.push('菜单没有食物温度数据，无法核实哪些餐品是凉的，具体以门店为准');
  }

  /* ---------- 5. 用户点名的餐品/类别偏好 ---------- */
  const prefScore = Number.isFinite(cand.prefScore) ? cand.prefScore : 0;
  if (prefScore > 0) {
    score += prefScore * 2;
    if (cand.prefMatched?.length) reasons.push(cand.prefMatched[0]);
  }

  /* ---------- 6. 价位意图 ---------- */
  const price = cand.priced?.priceFen ?? cand.estimatedPriceFen ?? null;
  const b = intent.budget || {};
  if (price != null) {
    switch (b.intent) {
      case 'minimize':
        score -= price / 1500;
        reasons.push('按你要求，优先便宜的');
        break;
      case 'max':
        score -= price / 4000;
        break;
      case 'target':
      case 'target_with_cap': {
        const target = b.target * 100;
        score -= Math.abs(price - target) / 900;
        if (Math.abs(price - target) <= target * 0.1) reasons.push(`¥${(price / 100).toFixed(2)}，接近你要的价位`);
        else reasons.push(`¥${(price / 100).toFixed(2)}，离你要的价位稍远一点`);
        break;
      }
      case 'range': {
        // 目标区间：落在区间内加分；低于区间下限不惩罚（不为花满强加、不为凑预算加餐）
        const lo = (b.range?.min ?? 0) * 100;
        const hi = (b.range?.max ?? 0) * 100;
        if (hi > 0 && price >= lo && price <= hi) {
          // 目标区间必须在排序里起实质作用：区间内 +2.5（高于一份小食的 2 分），
          // 否则"最便宜的完整搭配"会一直压过用户明确说的价位。
          score += 2.5;
          reasons.push(`¥${(price / 100).toFixed(2)}，落在你说的 ¥${b.range.min}–${b.range.max} 区间`);
        } else if (hi > 0 && price < lo) {
          // 放进 cautions（不受理由条数截断）：「不为花满强加」这句诚实说明必须始终可见
          cautions.push(`¥${(price / 100).toFixed(2)}，比你说的 ¥${b.range.min}–${b.range.max} 区间便宜，不硬凑、不为凑满预算加餐`);
        }
        break;
      }
      default:
        break;
    }
  }

  /* ---------- 7. 胃部背景（只做提示，不做判断） ---------- */
  if (prefs.stomachContext) {
    cautions.push('「肚子不舒服」只是背景，是否适合你需要你自己判断，系统不做医学建议');
  }

  return { score, reasons: reasons.slice(0, 4), cautions, tags };
}

/**
 * 日常模式选 1 个主推 + 至多 2 个备选。
 * 备选必须在主商品或价位上有真实差异，不为了凑数。
 */
export function selectDailyPlans(feasible, intent, { maxAlternates = 2 } = {}) {
  const scored = feasible.map((cand) => ({ cand, ...scoreDaily(cand, intent) }));
  const viable = scored.filter((x) => x.score > -50); // 明确辣味/冰品已被打分淘汰

  const excluded = {
    spicyOrCold: scored.length - viable.length,
    totalScored: scored.length,
  };

  /**
   * 无糖诉求：菜单没有含糖量字段，只有名称写明「无糖/零度」才算证据。
   * 当前菜单没有这种饮品时，必须在结论里说清楚，不能默认推荐的是无糖。
   */
  const SUGAR_FREE_NAME = /无糖|零糖|零度|0\s*糖|不含糖/;
  const sugarFreeWanted = Boolean(intent.preferences?.sugarFree);
  const sugarFreeVerified = feasible.some((c) => (c.components || []).some((x) => SUGAR_FREE_NAME.test(x.name || '')));
  const sugarNote = sugarFreeWanted && !sugarFreeVerified ? '；当前菜单没有名称标注「无糖」的饮品，无糖偏好无法核实，不能当作已满足' : '';

  viable.sort((a, b) => b.score - a.score);

  const primary = viable[0] || null;
  const alternates = [];
  if (primary) {
    const primaryKey = primary.cand.components?.[0]?.code;
    for (const item of viable.slice(1)) {
      if (alternates.length >= maxAlternates) break;
      const key = item.cand.components?.[0]?.code;
      const priceDiff = Math.abs((item.cand.priced?.priceFen ?? 0) - (primary.cand.priced?.priceFen ?? 0));
      const differentMain = key !== primaryKey;
      const differentPrice = priceDiff >= 300;
      if (differentMain || differentPrice) alternates.push(item);
    }
  }

  return {
    primary,
    alternates,
    excluded,
    rankedCount: viable.length,
    sugarFree: { wanted: sugarFreeWanted, verified: sugarFreeVerified },
    note: primary
      ? `在 ${viable.length} 个已核价候选中，按"像不像一顿饭 + 口味 + 价位意图"排序；不是单纯按价格高低${sugarNote}`
      : '没有可推荐的候选',
  };
}
