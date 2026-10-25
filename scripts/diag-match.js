/** 诊断：未匹配单品的近似候选（仅用于人工确认，不自动采纳） */
import { dataService } from '../src/services/data-service.js';
import { getMenu } from '../src/data/store.js';
import { config } from '../src/config.js';

const store = config.store.defaultStoreCode;
const cov = await dataService.getCoverage(store);
const catalog = await import('../src/data/catalog.js').then((m) => m.buildCatalog(store));
const tableNames = catalog.nutritionRows.map((r) => r.productName);

function bigrams(s) {
  const t = String(s).replace(/[^\p{L}\p{N}]/gu, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  return out;
}
function sim(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / Math.max(A.size, B.size);
}

for (const r of cov.needsHumanReview) {
  const scored = tableNames
    .map((n) => ({ n, s: sim(r.name || '', n) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .filter((x) => x.s > 0.3);
  console.log(`\n[${r.matchStatus}] ${r.code} "${r.name}"`);
  for (const s of scored) console.log(`    ${(s.s * 100).toFixed(0)}%  ${s.n}`);
}

const menu = await getMenu(store);
console.log('\n=== 所有名字含「可乐」的商品 ===');
for (const p of catalog.products.values()) if (p.name?.includes('可乐')) console.log(' ', p.code, p.name, p.nutrition.matchStatus);
