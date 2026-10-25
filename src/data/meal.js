/**
 * 套餐结构解析、合法组合枚举、营养求和（第一阶段任务 D 的算法内核）。
 *
 * 关键规则：
 * - 营养求和只对「官方标准条目」做算术相加，结果状态是 derived_sum（各组件之和），
 *   不是官方套餐级标示，前端必须如实呈现这一措辞。
 * - 任一组件营养 unknown → 整体状态为 partial，只输出已确认部分的小计，不输出"总热量"。
 * - 特制（去酱/去冰等）不改变营养数值，且必须显式标注"营养未计入特制变化"。
 */

/** 套餐维度摘要 */
export function describeMeal(rounds) {
  const dimensions = rounds.map((r) => ({
    round: r.id,
    name: r.name,
    quantity: r.quantity,
    choices: r.choices.length,
    required: (r.minQuantity ?? 0) > 0,
    defaultChoice: r.choices.find((c) => c.isDefault)?.code ?? null,
  }));
  const totalCombos = rounds.reduce((acc, r) => acc * Math.max(1, r.choices.length), 1);
  return { roundCount: rounds.length, dimensions, totalCombos, isCombinable: rounds.length > 0 };
}

/** 默认组合（每个 round 取 isDefault 项，无默认则取第一个） */
export function defaultCombo(rounds) {
  return rounds.map((r) => {
    const choice = r.choices.find((c) => c.isDefault) || r.choices[0];
    return { round: r.id, roundName: r.name, code: choice?.code ?? null, name: choice?.name ?? null, quantity: 1 };
  });
}

/**
 * 枚举合法组合（每个 round 恰选 1 项；round.quantity>1 目前未在实测数据中出现，遇到则拒绝枚举）。
 * @param {Array} rounds
 * @param {{limit?:number}} opts
 */
export function enumerateCombos(rounds, { limit = 5000 } = {}) {
  if (!rounds.length) return { combos: [], truncated: false, total: 0 };
  if (rounds.some((r) => (r.quantity ?? 1) > 1)) {
    throw new Error('存在 quantity>1 的 round，暂不支持多选枚举');
  }
  let partial = [[]];
  for (const r of rounds) {
    const next = [];
    for (const combo of partial) {
      for (const c of r.choices) {
        next.push([...combo, { round: r.id, roundName: r.name, code: c.code, name: c.name, diffPriceFen: c.diffPriceFen }]);
        if (next.length > limit) return { combos: next.slice(0, limit), truncated: true, total: null };
      }
    }
    partial = next;
  }
  return { combos: partial, truncated: false, total: partial.length };
}

/** 组合 → calculate-price 的 roundList 参数 */
export function comboToRoundList(combo) {
  const byRound = new Map();
  for (const item of combo) {
    if (!byRound.has(item.round)) byRound.set(item.round, []);
    byRound.get(item.round).push({ code: item.code, quantity: item.quantity ?? 1 });
  }
  return [...byRound.entries()].map(([round, comboItemList]) => ({ round: String(round), comboItemList }));
}

/**
 * 营养求和。
 * @param {Array<{code:string,name:string|null,quantity:number,nutrition:object,resolvedBy:string}>} components
 */
export function composeNutrition(components) {
  const items = components.map((c) => {
    const n = c.nutrition || {};
    const known = n.status === 'official' && Number.isFinite(n.energyKcal);
    const qty = c.quantity ?? 1;
    return {
      code: c.code,
      name: c.name,
      quantity: qty,
      nutritionStatus: n.status || 'unknown',
      matchedName: n.matchedName ?? null,
      matchMethod: n.matchMethod ?? null,
      resolvedBy: c.resolvedBy ?? null,
      unit: known
        ? {
            energyKcal: n.energyKcal,
            protein: n.protein ?? null,
            fat: n.fat ?? null,
            carbohydrate: n.carbohydrate ?? null,
            sodium: n.sodium ?? null,
            calcium: n.calcium ?? null,
          }
        : null,
      subtotal: known
        ? {
            energyKcal: round1(n.energyKcal * qty),
            protein: n.protein == null ? null : round1(n.protein * qty),
            fat: n.fat == null ? null : round1(n.fat * qty),
            carbohydrate: n.carbohydrate == null ? null : round1(n.carbohydrate * qty),
            sodium: n.sodium == null ? null : round1(n.sodium * qty),
            calcium: n.calcium == null ? null : round1(n.calcium * qty),
          }
        : null,
      note: known ? null : n.note || '官方营养数据缺失，未计入',
    };
  });

  const totals = { energyKcal: 0, protein: 0, fat: 0, carbohydrate: 0, sodium: 0, calcium: 0 };
  let allKnown = true;
  let anyKnown = false;
  for (const it of items) {
    if (!it.subtotal) {
      allKnown = false;
      continue;
    }
    anyKnown = true;
    for (const k of Object.keys(totals)) {
      if (it.subtotal[k] == null) {
        if (k === 'energyKcal') allKnown = false;
        continue;
      }
      totals[k] += it.subtotal[k];
    }
  }
  for (const k of Object.keys(totals)) totals[k] = round1(totals[k]);

  return {
    status: allKnown && anyKnown ? 'derived_sum' : anyKnown ? 'partial' : 'unknown',
    basis: '各组件官方标准值之和（官方未提供套餐级营养标示）',
    totals: allKnown && anyKnown ? totals : null,
    knownSubtotal: anyKnown ? totals : null,
    unknownComponents: items.filter((i) => !i.subtotal).map((i) => ({ code: i.code, name: i.name, note: i.note })),
    items,
    modificationImpact: 'not_modeled',
    modificationNote: '特制（去酱/去冰/加减配料）的营养变化无官方数据支撑，未计入上述数值。',
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
