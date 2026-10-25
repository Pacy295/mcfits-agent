/**
 * 候选生成（纯逻辑，不直接调用 MCP）。
 *
 * 两类候选：
 *   A. 官方套餐：按 rounds 枚举合法规格组合，价格 = 套餐基准价 + Σ diffPrice
 *   B. 单品组合：主食 / 主食+饮料 / 主食+小食 / 主食+小食+饮料（数量受限，防止组合爆炸）
 *
 * 硬性要求：
 * - 只有「全部组件都有官方标准营养」的候选才进入严格约束求解；
 * - 角色必须合理：一顿饭必须有 main，不允许几杯饮料充当正餐；
 * - 用内容签名（componentCode×qty 排序）去重，跨"套餐/单品"两种形态也去重。
 */

/** 单品组合模式：role 数组，quantity 均为 1 */
import { roleOfName } from './classify.js';

export const SINGLE_PATTERNS = [
  { id: 'main', roles: ['main'] },
  { id: 'main+drink', roles: ['main', 'drink'] },
  { id: 'main+side', roles: ['main', 'side'] },
  { id: 'main+side+drink', roles: ['main', 'side', 'drink'] },
  { id: 'main+dessert', roles: ['main', 'dessert'] },
];

export function signatureOf(components) {
  return components
    .map((c) => `${c.code}x${c.quantity ?? 1}`)
    .sort()
    .join('|');
}

function sumNutrition(components, nutritionOf) {
  const out = { energyKcal: 0, protein: 0, fat: 0, carbohydrate: 0, sodium: 0, calcium: 0 };
  const missing = [];
  // 钠/钙不是所有条目都有：任一组件缺失就整体置 null，绝不按 0 累加
  let sodiumOk = true;
  let calciumOk = true;
  for (const c of components) {
    const n = nutritionOf(c.code);
    if (!n || n.status !== 'official' || !Number.isFinite(n.energyKcal)) {
      missing.push({ code: c.code, name: c.name });
      continue;
    }
    const q = c.quantity ?? 1;
    out.energyKcal += n.energyKcal * q;
    out.protein += (n.protein ?? 0) * q;
    out.fat += (n.fat ?? 0) * q;
    out.carbohydrate += (n.carbohydrate ?? 0) * q;
    if (n.sodium == null) sodiumOk = false;
    else out.sodium += n.sodium * q;
    if (n.calcium == null) calciumOk = false;
    else out.calcium += n.calcium * q;
  }
  const round1 = (v) => Math.round(v * 10) / 10;
  return {
    complete: missing.length === 0,
    missing,
    nutrition: {
      energyKcal: round1(out.energyKcal),
      protein: round1(out.protein),
      fat: round1(out.fat),
      carbohydrate: round1(out.carbohydrate),
      sodium: sodiumOk ? round1(out.sodium) : null,
      calcium: calciumOk ? round1(out.calcium) : null,
    },
  };
}

/**
 * 生成套餐候选。
 * @param {Array} meals 已通过营养完整性预筛的套餐（带 rounds）
 * @param {(code:string)=>object|null} nutritionOf 组件营养查询
 * @param {{perMealKeep?:number, choiceLimitPerRound?:number}} opts
 */
export function generateMealCandidates(meals, nutritionOf, opts = {}) {
  const perMealKeep = opts.perMealKeep ?? 6;
  const choiceLimit = opts.choiceLimitPerRound ?? 4;
  const out = [];
  const skipped = { nutritionIncompleteX: 0, noChoices: 0 };

  for (const meal of meals) {
    const rounds = meal.rounds || [];
    if (!rounds.length) continue;

    // 每轮收敛：优先"营养已知"的选项，再按补差价升序（便宜的可选项先进入候选池）
    const pools = rounds.map((r) => {
      const sorted = [...r.choices].sort((a, b) => {
        const na = nutritionOf(a.code)?.status === 'official' ? 0 : 1;
        const nb = nutritionOf(b.code)?.status === 'official' ? 0 : 1;
        if (na !== nb) return na - nb;
        return (a.diffPriceFen ?? 0) - (b.diffPriceFen ?? 0);
      });
      return sorted.slice(0, choiceLimit);
    });
    if (pools.some((p) => !p.length)) {
      skipped.noChoices += 1;
      continue;
    }

    // 笛卡尔积（受 choiceLimit 限制，最大 4^4=256）
    let combos = [[]];
    for (let i = 0; i < pools.length; i += 1) {
      const next = [];
      for (const base of combos) {
        for (const c of pools[i]) next.push([...base, { round: rounds[i].id, code: c.code, name: c.name, diffPriceFen: c.diffPriceFen ?? 0, roundName: rounds[i].name }]);
      }
      combos = next;
    }

    const built = [];
    for (const combo of combos) {
      const components = combo.map((c) => ({ code: c.code, name: c.name, quantity: 1 }));
      const sum = sumNutrition(components, nutritionOf);
      if (!sum.complete) {
        skipped.nutritionIncompleteX += 1;
        continue;
      }
      built.push({
        kind: 'meal',
        productCode: meal.code,
        productName: meal.name,
        meal,
        combo,
        components,
        // 套餐的类别角色要按实际组成算：一份含饮料的套餐才算「包含饮料」
        roles: ['main', ...['side', 'drink', 'dessert'].filter((r) => components.some((c) => roleOfName(c.name) === r))],
        nutrition: sum.nutrition,
        nutritionStatus: 'derived_sum',
        priceDeltaFen: combo.reduce((a, c) => a + (c.diffPriceFen || 0), 0),
        signature: `${menuSig(meal.code)}#${signatureOf(components)}`,
        contentSignature: signatureOf(components),
      });
    }

    if (!built.length) continue;
    // 收敛：按补差价为基准分层保留，并额外保留蛋白质最高的若干
    built.sort((a, b) => a.priceDeltaFen - b.priceDeltaFen);
    const byProtein = [...built].sort((a, b) => b.nutrition.protein - a.nutrition.protein);
    const keep = new Map();
    const step = Math.max(1, Math.floor(built.length / Math.max(1, perMealKeep - 2)));
    for (let i = 0; i < built.length && keep.size < perMealKeep - 2; i += step) keep.set(built[i].signature, built[i]);
    for (const c of byProtein.slice(0, 2)) keep.set(c.signature, c);
    out.push(...keep.values());
  }
  return { candidates: out, skipped };
}

function menuSig(code) {
  return `M${code}`;
}

/**
 * 生成单品组合候选。
 * @param {{main:Array, side:Array, drink:Array, dessert:Array}} pools 已过营养完整性预筛的单品
 */
export function generateSingleCandidates(pools, opts = {}) {
  const maxPerPattern = opts.maxPerPattern ?? 4000;
  const out = [];
  for (const pattern of SINGLE_PATTERNS) {
    const roleLists = pattern.roles.map((r) => pools[r] || []);
    if (roleLists.some((l) => l.length === 0)) continue;

    let combos = [[]];
    for (let i = 0; i < roleLists.length; i += 1) {
      const next = [];
      for (const base of combos) {
        for (const p of roleLists[i]) {
          if (base.some((b) => b.code === p.code)) continue; // 同商品不重复
          next.push([...base, p]);
        }
      }
      combos = next;
      if (combos.length > maxPerPattern) {
        combos = combos.slice(0, maxPerPattern);
        break;
      }
    }

    for (const combo of combos) {
      const components = combo.map((p) => ({
        code: p.code,
        name: p.name,
        quantity: 1,
        role: p.role,
        priceKey: p.priceKey || `single:${p.code}`,
        // 容器型商品（选规格/选口味）需要带着 roundList 才能核价
        container: p.container || null,
      }));
      const sum = sumNutrition(components, (code) => combo.find((p) => p.code === code)?.nutrition ?? null);
      if (!sum.complete) continue;
      out.push({
        kind: 'single',
        productCode: components.map((c) => c.code).join('+'),
        productName: components.map((c) => c.name).join(' + '),
        pattern: pattern.id,
        components,
        roles: combo.map((p) => p.role),
        nutrition: sum.nutrition,
        nutritionStatus: 'derived_sum',
        priceDeltaFen: 0,
        signature: `S${pattern.id}:${signatureOf(components)}`,
        contentSignature: signatureOf(components),
        singleCodes: combo.map((p) => p.code),
        hasContainer: combo.some((p) => p.container),
      });
    }
  }
  return out;
}

/** 内容签名去重：同一份食物只保留一条（保留 estimated price 更低者由调用方决定） */
export function dedupeByContent(candidates) {
  const map = new Map();
  for (const c of candidates) {
    const prev = map.get(c.contentSignature);
    if (!prev) {
      map.set(c.contentSignature, c);
      continue;
    }
    // 保留预估价格更低的；价格未知时保留套餐形态（通常更便宜）
    const a = c.estimatedPriceFen ?? Infinity;
    const b = prev.estimatedPriceFen ?? Infinity;
    const better = a < b ? c : a === b ? (c.kind === 'meal' ? c : prev) : prev;
    const worse = better === c ? prev : c;
    better.duplicateOf = worse.signature;
    map.set(c.contentSignature, better);
  }
  return [...map.values()];
}
