/**
 * 名称规范化。
 *
 * 原则：只做「不改变语义」的字符级归一化 —— 全半角、空格、标点、商标符号。
 * 任何涉及规格/口味/包装的描述性差异（如「（椒盐风味）」「盒装」「大杯」）
 * 都不在规范化范围内，必须走人工确认别名表，禁止由规范化悄悄吞掉。
 */

/** 严格键：统一括号/连字符/空格/大小写/商标符，保留其余字符 */
export function strictKey(name) {
  if (!name) return '';
  return String(name)
    .replace(/[™®©]/g, '')
    .normalize('NFKC')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[－—–−]/g, '-')
    .replace(/[“”„‟"']/g, '')
    .replace(/[·・]/g, '')
    .toLowerCase();
}

/** 宽松键：在严格键基础上去掉全部标点符号。仅用于「纯标点差异」判定。 */
export function looseKey(name) {
  return strictKey(name).replace(/[^\p{L}\p{N}%+%]/gu, '');
}

/** 是否含中文（用于展示层区分中英文名） */
export function hasCJK(s) {
  return /[\u4e00-\u9fff]/.test(String(s || ''));
}
