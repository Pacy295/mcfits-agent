/**
 * 预热缓存并输出「商品名 vs 营养表名」对照，用于人工确认别名映射。
 * 用法: node scripts/prefetch.js [storeCode] [--refresh]
 */
import { config } from '../src/config.js';
import { getMenu, getDetails, getNutritionTable } from '../src/data/store.js';

const store = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : config.store.defaultStoreCode;
const refresh = process.argv.includes('--refresh');

const t0 = Date.now();
const menu = await getMenu(store, { refresh });
console.log(`[menu] ${store} 分类=${menu.categories.length} 唯一商品=${menu.uniqueCodes.length} cache=${menu.meta.cache}`);

const nutrition = await getNutritionTable({ refresh });
console.log(`[nutrition] 声明=${nutrition.declaredCount} 解析=${nutrition.rows.length} 问题=${nutrition.issues.length} cache=${nutrition.meta.cache}`);

const { details, failures } = await getDetails(store, menu.uniqueCodes, {
  refresh,
  onProgress: (d, t) => {
    if (d % 10 === 0 || d === t) process.stdout.write(`\r[detail] ${d}/${t}`);
  },
});
process.stdout.write('\n');
console.log(`[detail] 成功=${details.size} 失败=${failures.length} 耗时=${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (failures.length) console.log('失败样本:', failures.slice(0, 5));

const nutNames = nutrition.rows.map((r) => r.productName);
const prodNames = [...details.values()].map((d) => d.name).filter(Boolean);

console.log('\n===== 商品名称（门店实际）=====');
prodNames.sort((a, b) => a.localeCompare(b, 'zh')).forEach((n) => console.log(' P', n));

console.log('\n===== 营养表名称（官方 160 条）=====');
nutNames.sort((a, b) => a.localeCompare(b, 'zh')).forEach((n) => console.log(' N', n));
