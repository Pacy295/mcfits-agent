/**
 * 营养匹配覆盖率报告（第一阶段任务 C 的验收输出）。
 * 用法: node scripts/coverage.js [storeCode] [--refresh]
 */
import { dataService } from '../src/services/data-service.js';
import { config } from '../src/config.js';

const store = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : config.store.defaultStoreCode;
const refresh = process.argv.includes('--refresh');

const t0 = Date.now();
const cov = await dataService.getCoverage(store, { refresh });

console.log('='.repeat(70));
console.log(`门店 ${cov.storeCode} —— 营养匹配覆盖率报告（${new Date(cov.checkedAt).toLocaleString('zh-CN')}）`);
console.log('='.repeat(70));
console.log(`官方营养表条目            : ${cov.officialTableRows}`);
console.log(`在售商品总数              : ${cov.counts.onMenuProducts}`);
console.log(`  单品                    : ${cov.counts.singleItems}`);
console.log(`  套餐                    : ${cov.counts.meals}`);
console.log(`详情拉取失败              : ${cov.counts.detailFailures}`);
console.log('-'.repeat(70));
console.log('单品名称匹配：');
for (const [k, v] of Object.entries(cov.singleItemMatch)) console.log(`  ${k.padEnd(16)} ${v}`);
console.log('套餐组合解析：');
for (const [k, v] of Object.entries(cov.mealComposition)) console.log(`  ${k.padEnd(16)} ${v}`);
console.log('-'.repeat(70));
console.log(`营养覆盖率：单品 ${cov.coverage.singleItems}% | 套餐 ${cov.coverage.meals}% | 整体 ${cov.coverage.overall}% (${cov.coverage.usable}/${cov.coverage.total})`);
console.log(`需人工确认：${cov.reviewCount} 条`);
for (const r of cov.needsHumanReview) {
  console.log(`  - [${r.matchStatus}] ${r.code} ${r.name}  候选=${JSON.stringify(r.candidates)}`);
}
if (cov.mealIssues.length) {
  console.log('-'.repeat(70));
  console.log(`无法完整求和的套餐：${cov.mealIssues.length} 个`);
  for (const m of cov.mealIssues.slice(0, 12)) {
    console.log(`  - ${m.code} ${m.name} [${m.status}] 缺: ${m.unknown.map((u) => `${u.code}:${u.name || '?'}`).join(', ')}`);
  }
}
console.log('='.repeat(70));
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
