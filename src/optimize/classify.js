/**
 * 商品角色分类（确定性规则，不依赖模型）。
 *
 * 为什么需要：约束里「必须有饮料」「要一顿正餐」必须落到可验证的角色上，
 * 否则优化器可能拿"三杯饮料"冒充一顿正餐。
 *
 * 判定顺序：甜品 → 饮料 → 小食 → 主食，避免「咖啡阿芙佳朵」被当成咖啡饮料。
 */

const DESSERT = ['新地', '麦旋风', '圆筒', '冰淇淋', '甜筒', '圣代', '派', '拉明顿', '阿芙佳朵', '雪顶', '马卡龙'];
const DRINK = ['可乐', '雪碧', '芬达', '咖啡', '美式', '奶铁', '拿铁', '玛奇朵', '红茶', '奶茶', '牛奶', '豆浆', '果汁', '苹果汁', '纯悦', '怡泉', '多汁柠柠', '柠', '茶', '雪冰', '麦旋酷', '水'];
const SIDE = ['薯条', '薯饼', '麦乐鸡', '鸡块', '鸡翅', '脆汁鸡', '鸡排', '玉米杯', '苹果片', '沙拉', '酱', '芝士条', 'V翅', '鸡球', '鸡柳', '脆薯'];
const MAIN = ['堡', '卷', '麦满分', '粥', '油条', '松饼', '套餐', '三件套', '四件套', '双人餐', '单人餐', '随心配', '1+1', '盒', '餐'];

const has = (name, keys) => keys.some((k) => name.includes(k));

/**
 * @param {{name:string, isMeal:boolean, categories:string[], rounds:Array}} product
 * @returns {'main'|'side'|'drink'|'dessert'|'other'}
 */
export function roleOf(product) {
  const name = product.name || '';
  const cats = (product.categories || []).join('/');

  // 套餐：看实际组成。注意门店存在大量"容器型"商品——
  // 「可乐」= 选饮料、「派」= 选口味、「新地」= 选口味，它们有 rounds 但不是一顿饭。
  if (product.isMeal) {
    const compRoles = new Set();
    for (const r of product.rounds || []) {
      for (const c of r.choices || []) {
        compRoles.add(roleOfName(c.name || ''));
      }
    }
    if (compRoles.has('main')) return 'main';
    // 没有主食部件：按主要部件角色归类，绝不冒充正餐
    if (compRoles.has('drink')) return 'drink';
    if (compRoles.has('dessert')) return 'dessert';
    if (compRoles.has('side')) return 'side';
    return 'other';
  }

  const byName = roleOfName(name);
  if (byName !== 'other') return byName;
  if (cats.includes('饮品')) return 'drink';
  if (cats.includes('小食甜品')) return 'dessert';
  return 'other';
}

/** 仅按名称判断角色 */
export function roleOfName(name) {
  const n = String(name || '');
  if (!n) return 'other';
  if (has(n, DESSERT)) return 'dessert';
  if (has(n, DRINK) && !has(n, ['堡', '卷'])) return 'drink';
  if (has(n, SIDE)) return 'side';
  if (has(n, MAIN)) return 'main';
  return 'other';
}

export const ROLE_ORDER = ['main', 'side', 'drink', 'dessert', 'other'];
