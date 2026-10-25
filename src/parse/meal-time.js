/**
 * 用餐时段识别（纯函数）。
 *
 * 只做两件事：
 *  1) 识别用户明确说的用餐时段（今晚 / 明早 / 中午 …）；
 *  2) 和「本次实际查询的时段」比对，不一致时给一句简短提示。
 *
 * 明确不做：未来菜单预测、预约、定时查询。
 * 因此提示只说明「现在只能核实当前时段菜单」，绝不声称未来时段一定可售。
 */

const PERIODS = [
  { key: 'breakfast', label: '早餐', words: ['早餐', '早饭', '早点', '早上', '早晨', '清晨', '明早', '明天早上'] },
  { key: 'lunch', label: '午餐', words: ['午餐', '午饭', '中饭', '中午', '晌午'] },
  { key: 'dinner', label: '晚餐', words: ['晚餐', '晚饭', '今晚', '今天晚上', '傍晚', '晚上'] },
  { key: 'latenight', label: '夜宵', words: ['夜宵', '宵夜', '深夜', '半夜'] },
];

const TOMORROW_RE = /明早|明天早上|明天中午|明天晚上|明晚/;

/** 用户明确提到的用餐时段；没提就返回 null（不影响正常推荐）。 */
export function classifyPlannedPeriod(text = '') {
  const t = String(text || '');
  for (const p of PERIODS) {
    const hit = p.words.find((w) => t.includes(w));
    if (hit) return { key: p.key, label: p.label, word: hit, tomorrow: TOMORROW_RE.test(t) };
  }
  return null;
}

/** 按当前时钟判断实际查询所处时段（只用于比对，不用于推断菜单）。 */
export function currentPeriod(now = new Date()) {
  const h = now.getHours() + now.getMinutes() / 60;
  if (h >= 5 && h < 10.5) return { key: 'breakfast', label: '早餐' };
  if (h >= 10.5 && h < 14) return { key: 'lunch', label: '午餐' };
  if (h >= 14 && h < 17) return { key: 'afternoon', label: '午后' };
  if (h >= 17 && h < 21) return { key: 'dinner', label: '晚餐' };
  return { key: 'night', label: '夜间' };
}

const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/**
 * 计划用餐时段 vs 实际查询时段。
 * @returns {null | {planned, plannedLabel, tomorrow, current, currentLabel, now, mismatch, note}}
 */
export function analyzeMealTime(text = '', now = new Date()) {
  const planned = classifyPlannedPeriod(text);
  if (!planned) return null;
  const cur = currentPeriod(now);
  const base = {
    planned: planned.key,
    plannedLabel: planned.label,
    tomorrow: planned.tomorrow,
    current: cur.key,
    currentLabel: cur.label,
    now: hhmm(now),
  };

  if (planned.tomorrow) {
    return {
      ...base,
      mismatch: true,
      note: `你说的是明天${planned.label}，现在（${base.now}）只能核实${cur.label}时段的菜单；到那个时段再查一次更准确。`,
    };
  }
  if (planned.key !== cur.key) {
    return {
      ...base,
      mismatch: true,
      note: `你说的是${planned.label}，现在是${cur.label}时段；现在只能核实当前菜单，${planned.label}的菜单到点再查一次更准确。`,
    };
  }
  return { ...base, mismatch: false, note: null };
}
