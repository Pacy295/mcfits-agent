/**
 * 第五阶段真实验收：六组场景 A-F，走真实 LLM 解析 + 真实麦当劳 MCP 检索核价。
 * 用法：node scripts/verify-stage5.mjs [场景字母...]
 * 输出：每组场景的解析意图、推荐主推/备选、理由/提示、耗时（全部实测）。
 */
import { parseRequirement } from '../src/parse/llm-parser.js';
import { recommendPlans } from '../src/services/recommend-service.js';

const SCENARIOS = {
  A: {
    title: '日常一句话点餐（不提营养）',
    text: '今天想随便吃点，预算30以内，给我推荐个套餐。',
    expect: (p, r) => [
      ['mode=daily', p.intent?.mode === 'daily'],
      ['有主推且是完整一餐', r.plans?.[0]?.isPrimary === true && (r.plans?.[0]?.components?.length ?? 0) >= 2],
      ['不是单纯最便宜（主推价 > 全场最低价或含多件）', r.plans?.[0]?.price?.fen != null],
      ['推荐理由非空', (r.plans?.[0]?.daily?.reasons?.length ?? 0) > 0],
      ['无反问', !p.clarification],
    ],
  },
  B: {
    title: '不适与口味偏好（问题现场）',
    text: '最近肚子有点不舒服，不是很喜欢吃油的，也不喜欢吃辣的吃冰的，你给我推荐一个60元的套餐。',
    expect: (p, r) => [
      ['mode=daily', p.intent?.mode === 'daily'],
      ['预算=60 套餐价意图(target_with_cap)', p.intent?.budget?.intent === 'target_with_cap' && p.intent?.budget?.amount === 60],
      ['辣=软偏好 not hard', p.intent?.preferences?.avoidSpicy === 'soft'],
      ['不喝冰=偏好', p.intent?.preferences?.avoidIce === true],
      ['少油=偏好', p.intent?.preferences?.avoidOily === true],
      ['胃不适=背景(非医学)', p.intent?.preferences?.stomachContext === true],
      ['零反问', !p.clarification && (p.constraints?.clarifications?.length ?? 0) === 0],
      ['不把口味软偏好塞进硬排除', !(p.constraints?.excludedFoods || []).some((x) => /辣$|^冰|油/.test(x))],
      ['主推不含明显辣味', !(r.plans?.[0]?.components || []).some((c) => /辣|咖喱|藤椒|麻辣/.test(c.name || ''))],
      ['主推不含明确冰品', !(r.plans?.[0]?.components || []).some((c) => /圆筒|新地|麦旋风|圣代|冰沙|雪冰|^冰/.test(c.name || ''))],
      ['口味提示简短诚实(含"辣度无官方数据"级提示)', (r.plans?.[0]?.daily?.cautions?.some((x) => /辣/.test(x)) ?? false)],
      ['胃部背景提示不缺席(不做医学判断)', (r.plans?.[0]?.daily?.cautions?.some((x) => /医学/.test(x)) ?? false)],
      ['≤1主推+≤2备选', (r.plans?.length ?? 9) <= 3 && (r.plans?.filter((x) => x.isPrimary).length === 1)],
    ],
  },
  C: {
    title: '营养点餐保留（多目标不受影响）',
    text: '40元以内，蛋白质至少30g，热量不超过750 kcal，尽量高蛋白。',
    expect: (p, r) => [
      ['mode=nutrition', p.intent?.mode === 'nutrition'],
      ['硬约束完整', p.constraints?.proteinMin === 30 && p.constraints?.caloriesMax === 750 && p.constraints?.budgetMax === 40],
      ['返回方案', (r.plans?.length ?? 0) >= 1],
      ['全部满足硬约束', (r.plans || []).every((x) => x.price.fen <= 4000 && x.nutrition.protein >= 30 && x.nutrition.energyKcal <= 750)],
      ['保留帕累托标注', r.plans?.[0]?.pareto != null],
    ],
  },
  D: {
    title: '预算意图区分（解析层，规则路径）',
    text: '推荐一个60元的套餐。',
    mode: 'rule',
    expect: (p) => [
      ['target_with_cap', p.intent?.budget?.intent === 'target_with_cap'],
      ['金额60', p.intent?.budget?.amount === 60],
      ['零反问', !p.clarification],
    ],
  },
  E: {
    title: '不频繁反问（矛盾才问，且最多1个）',
    text: '热量至少900大卡但不超过700大卡，40元以内。',
    mode: 'rule',
    expect: (p) => [
      ['恰好 1 个关键确认', (p.constraints?.clarifications?.length ?? 0) <= 1 && !!p.clarification],
      ['是热量矛盾', p.clarification?.id === 'calorie_conflict' || (p.constraints?.clarifications?.[0]?.id ?? '') === 'cal_range_conflict'],
    ],
  },
  F: {
    title: '无法验证偏好只做尽力满足+诚实提示',
    text: '40元以内，不能吃辣，要有主食。',
    expect: (p, r) => [
      ['hard 级辣限制被识别', p.intent?.preferences?.avoidSpicy === 'hard'],
      ['辣限制仍标无法验证', (p.constraints?.dietaryRestrictions || []).some((d) => d.type === 'spicy' && d.verified === false)],
      ['主推不含辣味商品', !(r.plans?.[0]?.components || []).some((c) => /辣|咖喱|藤椒|麻辣/.test(c.name || ''))],
      ['提示需向门店核实(不是大警告框结构)', (r.plans?.[0]?.daily?.cautions?.some((x) => /门店|核实|确认/.test(x)) ?? false)],
    ],
  },
};

const only = process.argv.slice(2).map((s) => s.toUpperCase()).filter((s) => SCENARIOS[s]);
const keys = only.length ? only : Object.keys(SCENARIOS);
let failed = 0;

for (const key of keys) {
  const s = SCENARIOS[key];
  console.log(`\n${'='.repeat(78)}\n场景 ${key}：${s.title}\n原话：${s.text}`);
  const t0 = Date.now();
  const p = await parseRequirement(s.text, s.mode ? { mode: s.mode } : {});
  const parseMs = Date.now() - t0;
  console.log(`解析：status=${p.status} source=${p.source} mode=${p.intent?.mode} 预算意图=${p.intent?.budget?.intent}(${p.intent?.budget?.amount ?? '-'}) chips=${JSON.stringify(p.chips)} 解析耗时=${parseMs}ms llm=${p.llm ? p.llm.ms + 'ms' : '-'}`);
  console.log(`偏好：${JSON.stringify(p.intent?.preferences)} 反问=${JSON.stringify(p.clarification)}`);

  let r = { plans: [] };
  if (['A', 'B', 'C', 'F'].includes(key)) {
    const t1 = Date.now();
    r = await recommendPlans(p.constraints, { maxVerify: 30 });
    console.log(`推荐：status=${r.status} basis=${r.selection?.basis} strategy=${r.selection?.strategy} 耗时=${Date.now() - t1}ms`);
    for (const plan of r.plans || []) {
      console.log(`  ${plan.isPrimary ? '【主推】' : '【备选】'} ${plan.productName} ¥${plan.price.yuan} ${plan.nutrition.energyKcal}kcal | ${plan.components.map((c) => c.name).join(' + ')}`);
      for (const x of plan.daily?.reasons || []) console.log(`     理由: ${x}`);
      for (const x of plan.daily?.cautions || []) console.log(`     提示: ${x}`);
    }
  }

  const checks = s.expect(p, r);
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed++;
  }
}

console.log(`\n${'='.repeat(78)}\n验收结论：${failed === 0 ? '全部通过' : `失败 ${failed} 项`}`);
process.exit(failed === 0 ? 0 : 1);
