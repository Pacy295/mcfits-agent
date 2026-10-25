import { parseRequirement } from '../src/parse/llm-parser.js';
import { recommendPlans } from '../src/services/recommend-service.js';

const cases = process.argv.slice(2).length
  ? [process.argv.slice(2).join(' ')]
  : ['40 元以内，尽量高蛋白', '40 元以内，蛋白质至少 30g，热量不超过 750 kcal', '15 元以内，蛋白质至少 40g，必须有饮料'];

for (const text of cases) {
  const p = await parseRequirement(text);
  console.log('\n' + '='.repeat(76));
  console.log(`需求：${text}`);
  console.log(`解析：status=${p.status} source=${p.source} 硬约束=${JSON.stringify(p.constraints?.hardConstraints)}`);
  const r = await recommendPlans(p.constraints, { maxVerify: 30 });
  console.log(`结果：${r.status}  ${r.message || ''}`);
  console.log('searchScope:', JSON.stringify({ gen: r.searchScope.candidatesGenerated, afterFilter: r.searchScope.candidatesAfterHardPrefilter, priced: r.searchScope.candidatesPriced, ok: r.searchScope.pricedOk, completeness: r.searchScope.completeness }));
  console.log('timing:', JSON.stringify(r.timing));
  for (const plan of r.plans || []) {
    console.log(`  ${plan.id} ${plan.label} | ${plan.productName} | ¥${plan.price.yuan} | ${plan.nutrition.energyKcal}kcal ${plan.nutrition.protein}g | ${plan.components.map((c) => c.name).join('+')}`);
    console.log(`     优势: ${plan.advantages.join(' / ')}  ${plan.tradeoffs.length ? '代价: ' + plan.tradeoffs.join(' / ') : ''}`);
    console.log(`     traceId=${plan.mcp.traceId}`);
  }
  if (r.status === 'infeasible') {
    console.log('  reason:', r.analysis.reason);
    console.log('  blocking:', JSON.stringify(r.analysis.blocking));
    for (const rel of r.analysis.relaxations) console.log(`  放宽「${rel.label}」→ ${rel.note}`);
    for (const cl of r.analysis.closest) console.log(`  最接近: ${cl.candidate.name} ¥${(cl.candidate.priceFen / 100).toFixed(2)} ${cl.candidate.kcal}kcal ${cl.candidate.protein}g → ${cl.violations.map((v) => v.detail).join(',')}`);
  }
}
