/**
 * 商品详情 ↔ 官方营养条目 匹配器。
 *
 * 匹配层级（严格 → 宽松，任何一层都要求「唯一命中」）：
 *   L1 matched_exact  : 严格规范化后完全相等（全半角/空格/标点/商标符差异）
 *   L2 matched_loose  : 再去掉全部标点后相等（如「麦辣鸡翅2块」vs「麦辣鸡翅-2块」）
 *   L3 matched_alias  : 命中人工确认过的别名表（data/nutrition-aliases.json，confirmed=true）
 *   L4 ambiguous      : 有多个候选（如「可乐」→ 可乐小/中/大杯），必须拒绝自动匹配
 *   L5 unmatched      : 无候选
 *
 * 硬规则：L4/L5 一律返回 nutrition.status = 'unknown'，energyKcal 为 null，绝不填 0。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { looseKey, strictKey } from './normalize.js';

let aliasCache;

export function loadAliases() {
  if (aliasCache) return aliasCache;
  const file = path.join(DATA_DIR, 'nutrition-aliases.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const confirmed = new Map();
  const suggested = new Map();
  for (const a of raw.aliases || []) {
    if (a.confirmed && a.nutritionName) confirmed.set(strictKey(a.productName), a);
    else suggested.set(strictKey(a.productName), a);
  }
  aliasCache = { confirmed, suggested, raw };
  return aliasCache;
}

/**
 * 建立索引。
 * @param {Array<object>} rows parseNutritionTable 的 rows
 */
export function buildNutritionIndex(rows) {
  const byStrict = new Map();
  const byLoose = new Map();
  const duplicates = [];
  for (const row of rows) {
    const sk = strictKey(row.productName);
    const lk = looseKey(row.productName);
    for (const [map, key] of [
      [byStrict, sk],
      [byLoose, lk],
    ]) {
      const list = map.get(key) || [];
      list.push(row);
      map.set(key, list);
    }
  }
  for (const [k, list] of byStrict) {
    if (list.length > 1) {
      const same = list.every(
        (r) => r.energyKcal === list[0].energyKcal && r.protein === list[0].protein && r.sodium === list[0].sodium,
      );
      duplicates.push({ key: k, count: list.length, valuesIdentical: same, names: list.map((r) => r.productName) });
    }
  }
  return { byStrict, byLoose, duplicates, size: rows.length, rows, names: rows.map((r) => r.productName) };
}

/** 双字组相似度，仅用于「生成人工确认候选」，绝不用于自动匹配 */
function bigramSimilarity(a, b) {
  const grams = (s) => {
    const t = looseKey(s);
    const set = new Set();
    for (let i = 0; i < t.length - 1; i += 1) set.add(t.slice(i, i + 2));
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / Math.max(A.size, B.size);
}

function uniqByNutritionName(rows) {
  const seen = new Map();
  for (const r of rows) if (!seen.has(r.productName)) seen.set(r.productName, r);
  return [...seen.values()];
}

/**
 * 匹配单个商品名。
 * @param {string} productName
 * @param {ReturnType<typeof buildNutritionIndex>} index
 */
export function matchNutrition(productName, index) {
  const sk = strictKey(productName);
  const lk = looseKey(productName);

  const exact = uniqByNutritionName(index.byStrict.get(sk) || []);
  if (exact.length === 1) {
    return {
      status: 'matched_exact',
      entry: exact[0],
      matchedName: exact[0].productName,
      confidence: 'high',
      method: 'L1 严格规范化完全相等',
      candidates: [],
      note: null,
    };
  }
  if (exact.length > 1) {
    const identical = exact.every((r) => r.energyKcal === exact[0].energyKcal && r.protein === exact[0].protein);
    if (identical) {
      return {
        status: 'matched_exact',
        entry: exact[0],
        matchedName: exact[0].productName,
        confidence: 'high',
        method: 'L1 严格规范化完全相等（官方表内重复条目且数值一致）',
        candidates: [],
        note: `官方营养表存在 ${exact.length} 条同名同值记录，已取首条`,
      };
    }
    return {
      status: 'ambiguous',
      entry: null,
      matchedName: null,
      confidence: 'none',
      method: 'L1 同名多条且数值不一致',
      candidates: exact.map((r) => r.productName),
      note: '官方营养表内同名条目数值不一致，需人工确认',
    };
  }

  const loose = uniqByNutritionName(index.byLoose.get(lk) || []);
  if (loose.length === 1) {
    return {
      status: 'matched_loose',
      entry: loose[0],
      matchedName: loose[0].productName,
      confidence: 'high',
      method: 'L2 去标点后完全相等',
      candidates: [],
      note: null,
    };
  }
  if (loose.length > 1) {
    return {
      status: 'ambiguous',
      entry: null,
      matchedName: null,
      confidence: 'none',
      method: 'L2 去标点后命中多条',
      candidates: loose.map((r) => r.productName),
      note: '存在多个同形候选，拒绝自动匹配',
    };
  }

  const { confirmed, suggested } = loadAliases();
  const alias = confirmed.get(sk);
  if (alias) {
    const row = index.byStrict.get(strictKey(alias.nutritionName))?.[0];
    if (row) {
      return {
        status: 'matched_alias',
        entry: row,
        matchedName: row.productName,
        confidence: 'medium',
        method: 'L3 人工确认别名表',
        candidates: [],
        note: alias.evidence || null,
      };
    }
  }

  // 无精确命中：给出候选（仅作建议，不自动采用）
  const candidates = uniqByNutritionName(index.byStrict.get(sk) || []);
  const containment = uniqByNutritionName(
    [...index.byLoose.entries()]
      .filter(([k]) => k !== lk && (k.includes(lk) || lk.includes(k)) && Math.min(k.length, lk.length) >= 3)
      .flatMap(([, v]) => v),
  ).map((r) => r.productName);

  const suggestion = suggested.get(sk);
  const similar = (index.names || [])
    .map((n) => ({ n, s: bigramSimilarity(productName, n) }))
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map((x) => x.n);

  return {
    status: candidates.length || containment.length ? 'ambiguous' : 'unmatched',
    entry: null,
    matchedName: null,
    confidence: 'none',
    method: candidates.length ? 'L1 同名多条' : containment.length ? 'L4 包含关系候选' : 'L5 无候选',
    candidates: candidates.length ? candidates.map((r) => r.productName) : containment.length ? containment.slice(0, 8) : similar,
    note:
      suggestion?.evidence ||
      (similar.length
        ? '无可靠对应关系，以下仅为字面相似候选，需人工确认；当前按 unknown 处理'
        : '官方营养表中无对应条目，按 unknown 处理'),
  };
}

/** 把匹配结果转成统一的营养状态对象（未知一律 null，不用 0） */
export function toNutritionStatus(match, entry) {
  if (match.status.startsWith('matched') && entry) {
    return {
      status: 'official',
      energyKcal: entry.energyKcal ?? null,
      energyKj: entry.energyKj ?? null,
      protein: entry.protein ?? null,
      fat: entry.fat ?? null,
      carbohydrate: entry.carbohydrate ?? null,
      sodium: entry.sodium ?? null,
      calcium: entry.calcium ?? null,
      matchMethod: match.method,
      matchStatus: match.status,
      matchedName: match.matchedName,
      confidence: match.confidence,
      note: match.note,
    };
  }
  return {
    status: 'unknown',
    energyKcal: null,
    energyKj: null,
    protein: null,
    fat: null,
    carbohydrate: null,
    sodium: null,
    calcium: null,
    matchMethod: match.method,
    matchStatus: match.status,
    matchedName: null,
    confidence: 'none',
    note: match.note,
    candidates: match.candidates,
  };
}
