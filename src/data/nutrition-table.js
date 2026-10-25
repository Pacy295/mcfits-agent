/**
 * 官方营养表解析器。
 *
 * 数据来源：MCP 工具 `list-nutrition-foods`，返回的 data 是一段「自描述表格字符串」：
 *   [160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
 *     猪柳麦满分,null,1288,308,16,16,24,781,213
 *     ...
 *
 * 重要事实（来自第一阶段前置验证）：
 * - 官方未声明单位与基准份量；按字段名与量级推断：kJ/kcal、g、mg。
 * - 没有克数/毫升字段，没有配料级条目。因此本解析器只负责「按成品」取数，不做任何推算。
 */

const NUMERIC_FIELDS = ['energyKj', 'energyKcal', 'protein', 'fat', 'carbohydrate', 'sodium', 'calcium'];

/** 单位标注：明确标记为「推断」，供前端展示时使用，避免把推断当官方声明 */
export const NUTRITION_UNITS = {
  energyKj: { unit: 'kJ', basis: 'per_serving_inferred' },
  energyKcal: { unit: 'kcal', basis: 'per_serving_inferred' },
  protein: { unit: 'g', basis: 'per_serving_inferred' },
  fat: { unit: 'g', basis: 'per_serving_inferred' },
  carbohydrate: { unit: 'g', basis: 'per_serving_inferred' },
  sodium: { unit: 'mg', basis: 'per_serving_inferred' },
  calcium: { unit: 'mg', basis: 'per_serving_inferred' },
};

function toNum(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s.toLowerCase() === 'null' || s === '-' || s === '—') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {string} text list-nutrition-foods 的 data 原文
 * @returns {{rows: Array<object>, declaredCount: number|null, columns: string[]}}
 */
export function parseNutritionTable(text) {
  if (typeof text !== 'string') {
    throw new Error('营养表格式异常：期望自描述表格字符串');
  }
  const headerMatch = /^\s*\[(\d+)\]\{([^}]+)\}:\s*$/m.exec(text);
  const columns = headerMatch ? headerMatch[2].split(',').map((s) => s.trim()) : [];
  const declaredCount = headerMatch ? Number(headerMatch[1]) : null;
  const nameIdx = columns.indexOf('productName');
  if (nameIdx !== -1 || !headerMatch) {
    // 有表头时按表头字段名取；无表头时按前置验证确认的固定 9 列取值
  }
  const cols = columns.length ? columns : ['productName', 'nutritionDescription', ...NUMERIC_FIELDS];

  const bodyStart = headerMatch ? text.indexOf(headerMatch[0]) + headerMatch[0].length : 0;
  const lines = text.slice(bodyStart).split(/\r?\n/);

  const rows = [];
  const issues = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(',').map((s) => s.trim());
    if (parts.length !== cols.length) {
      // 名称里可能含逗号：把多余的片段并回第一列
      const extra = parts.length - cols.length;
      if (extra > 0) {
        parts.splice(0, extra + 1, parts.slice(0, extra + 1).join(','));
      } else {
        issues.push({ line: t, reason: `列数不符（期望 ${cols.length}，实际 ${parts.length}）` });
        continue;
      }
    }
    /** @type {Record<string, any>} */
    const rec = {};
    cols.forEach((c, i) => {
      rec[c] = parts[i];
    });
    const row = {
      productName: rec.productName ?? null,
      nutritionDescription: rec.nutritionDescription && rec.nutritionDescription !== 'null' ? rec.nutritionDescription : null,
      energyKj: toNum(rec.energyKj),
      energyKcal: toNum(rec.energyKcal),
      protein: toNum(rec.protein),
      fat: toNum(rec.fat),
      carbohydrate: toNum(rec.carbohydrate),
      sodium: toNum(rec.sodium),
      calcium: toNum(rec.calcium),
      raw: parts.join(','),
    };
    if (!row.productName) {
      issues.push({ line: t, reason: '缺少 productName' });
      continue;
    }
    // 自洽性校验：energyKj / 4.184 ≈ energyKcal
    if (row.energyKj != null && row.energyKcal != null) {
      const est = row.energyKj / 4.184;
      if (Math.abs(est - row.energyKcal) > Math.max(3, row.energyKcal * 0.02)) {
        issues.push({ line: t, reason: `能量自洽性偏差：kJ/4.184=${est.toFixed(1)} vs ${row.energyKcal}` });
      }
    }
    rows.push(row);
  }

  return { rows, declaredCount, columns: cols, issues };
}

/** 取「每份」营养对象的可计算字段（只保留确认存在的数值，缺失保持 null） */
export function nutritionValuesOf(row) {
  if (!row) return null;
  const out = {};
  for (const f of NUMERIC_FIELDS) out[f] = row[f] ?? null;
  return out;
}
