import { parseRequirement } from '../src/parse/llm-parser.js';

const cases = [
  '40 元以内，尽量高蛋白',
  '40 元以内，蛋白质至少 30g，热量不超过 750 kcal',
  '给我一份 35 元以内的午饭，必须有个饮料，最好是无糖可乐',
  '练完胸想吃点东西',
  '50元以内，不吃辣，要有主食',
  '热量至少 900 大卡但不超过 700 大卡',
];

for (const c of cases) {
  const r = await parseRequirement(c);
  const k = r.constraints || {};
  console.log(`\n【${c}】 status=${r.status} source=${r.source}${r.degraded ? ' (degraded)' : ''}`);
  console.log('  budgetMax=%s kcalMax=%s kcalMin=%s proteinMin=%s', k.budgetMax, k.caloriesMax, k.caloriesMin, k.proteinMin);
  console.log('  objectives=', JSON.stringify(k.objectives));
  console.log('  required=', JSON.stringify(k.requiredCategories), 'preferredFoods=', JSON.stringify(k.preferredFoods), 'excluded=', JSON.stringify(k.excludedFoods));
  console.log('  restrictions=', JSON.stringify((k.dietaryRestrictions || []).map((d) => `${d.type}:${d.text}`)));
  console.log('  clarifications=', JSON.stringify((k.clarifications || []).map((x) => x.question)));
  if (r.warnings?.length) console.log('  warnings=', JSON.stringify(r.warnings));
}
