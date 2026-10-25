/**
 * 配餐优化引擎（编排层，可注入依赖，便于脱离 HTTP 与 MCP 单测）。
 *
 * 流程：
 *   真实菜单池 → 排除/角色/营养完整性预筛 → 生成候选（套餐变体 + 单品组合）
 *   → 参考价预筛（含 5% 容差，避免误剪） → 限速批量核价 → 真实价复核全部硬约束
 *   → 帕累托非支配 → 差异化选 2-4 个 → 组装方案 / 或进入不可行分析
 *
 * 依赖注入接口（见 recommend-service.js 的真实实现）：
 *   buildPool()                      → {meals, singles:{main,side,drink,dessert}, nutritionOf}
 *   priceProducts(items)             → Map<key, {fen, checkedAt, traceId, mcpDatetime}>
 *   priceCandidate(candidate)        → {status:'valued'|'failed', priceFen, checkedAt, traceId, mcpDatetime}
 */
import { dedupeByContent, generateMealCandidates, generateSingleCandidates } from './candidates.js';
import { buildDimensions, dominates, paretoFront, valueOf } from './objectives.js';
import { priceFenOf, snapshotOf } from './shape.js';
import { selectLadder, selectRepresentatives } from './diversity.js';
import { analyzeInfeasible, estimatedShortfall } from './infeasible.js';
import { resolveIntent } from '../parse/intent.js';
import { selectDailyPlans } from './daily.js';
import { mapLimit } from '../util/limit.js';

const BUDGET_SLACK = 1.05; // 参考价可能略高于真实价，预筛留 5% 容差
const ROLE_LABEL = { main: '主食', side: '小食', drink: '饮料', dessert: '甜品', other: '其他' };

/** 子序列匹配：让「无糖可乐」能命中「无糖可口可乐中杯」 */
function fuzzyHit(term, name) {
  const t = String(term || '');
  const n = String(name || '');
  if (!t || !n) return false;
  if (n.includes(t) || t.includes(n)) return true;
  let i = 0;
  for (const ch of n) {
    if (ch === t[i]) i += 1;
    if (i === t.length) return true;
  }
  return false;
}

function candidateNames(cand) {
  return [cand.productName, ...(cand.components || []).map((c) => c.name)].filter(Boolean);
}

function prefScoreOf(cand, constraints) {
  let score = 0;
  const matched = [];
  for (const term of constraints.preferredFoods || []) {
    if (candidateNames(cand).some((n) => fuzzyHit(term, n))) {
      score += 1;
      matched.push(`命中偏好「${term}」`);
    }
  }
  for (const role of constraints.preferredCategories || []) {
    if ((cand.roles || []).includes(role)) {
      score += 0.5;
      matched.push(`包含希望的${ROLE_LABEL[role] || role}`);
    }
  }
  cand.prefScore = score;
  cand.prefMatched = matched;
  return score;
}

function hitExclusion(cand, excludedFoods) {
  for (const term of excludedFoods) {
    if (candidateNames(cand).some((n) => fuzzyHit(term, n))) return term;
  }
  return null;
}

/** 硬约束检查（价格可为 null → 视为未验证，不通过） */
export function checkHard(cand, c, { requirePrice = true, nutritionOnly = false } = {}) {
  const fails = [];
  const price = cand.priced?.priceFen ?? null;
  const n = cand.nutrition || {};
  if (nutritionOnly) {
    // 只看与价格无关的约束：营养区间 + 必含类别（供"先剪枝后核价"使用，不会误剪预算可行解）
  } else if (requirePrice) {
    if (price == null) fails.push({ key: 'price', detail: '未核价' });
    else if (c.budgetMax != null && price > c.budgetMax * 100) fails.push({ key: 'budgetMax', detail: `¥${(price / 100).toFixed(2)} 超预算` });
  } else if (c.budgetMax != null) {
    const est = cand.estimatedPriceFen;
    if (est != null && est > c.budgetMax * 100 * BUDGET_SLACK) fails.push({ key: 'budgetMax', detail: '参考价超预算' });
  }
  if (c.caloriesMax != null && (n.energyKcal == null || n.energyKcal > c.caloriesMax)) fails.push({ key: 'caloriesMax', detail: '热量超上限或数据缺失' });
  if (c.caloriesMin != null && (n.energyKcal == null || n.energyKcal < c.caloriesMin)) fails.push({ key: 'caloriesMin', detail: '热量低于下限或数据缺失' });
  if (c.proteinMin != null && (n.protein == null || n.protein < c.proteinMin)) fails.push({ key: 'proteinMin', detail: '蛋白质不足或数据缺失' });
  for (const role of c.requiredCategories || []) {
    if (!(cand.roles || []).includes(role)) fails.push({ key: 'requiredCategories', detail: `缺少${ROLE_LABEL[role] || role}` });
  }
  return fails;
}

function priceKey(item) {
  return item.kind === 'meal' ? `meal:${item.code}` : `single:${item.code}`;
}

function sortKeyMetrics(c, objectives) {
  const has = (m, d) => objectives.some((o) => o.metric === m && o.direction === d);
  if (has('protein', 'max')) return 'protein';
  if (has('calories', 'min')) return 'calories';
  return 'price';
}

/** 轮转取样，避免把核价额度全花在同一个主食的变体上 */
function stratify(cands, limit, keyFn) {
  const buckets = new Map();
  for (const c of cands) {
    const k = keyFn(c);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(c);
  }
  const keys = [...buckets.keys()];
  const out = [];
  let idx = 0;
  while (out.length < limit && keys.length) {
    const k = keys[idx % keys.length];
    const arr = buckets.get(k);
    if (arr.length) out.push(arr.shift());
    else keys.splice(idx % keys.length, 1);
    idx += 1;
    if (keys.length && out.length >= limit) break;
  }
  return out;
}

/**
 * 不可行时的「放宽重搜」：仅在"已核价集合里放宽后仍为 0"时触发。
 * 目的：把「去掉某约束也没有解」这个结论建立在真实重新搜索 + 真实核价上，
 * 而不是只拿十几个诊断候选推断。调用量有上限，避免拖慢响应。
 */
async function rescanRelaxations(analysis, allCandidates, c, deps, { perConstraint = 5, total = 12 } = {}) {
  let budget = total;
  for (const r of analysis.relaxations || []) {
    if (r.feasibleCount > 0) {
      r.rescan = 'not-needed';
      continue;
    }
    if (budget <= 0) {
      r.rescan = 'skipped-budget';
      continue;
    }
    const relaxed = { ...c, [r.constraint]: null };
    const pool = allCandidates.filter(
      (x) => !x.priced && checkHard(x, relaxed, { nutritionOnly: true }).length === 0,
    );
    const picks = [...pool]
      .sort((a, b) => (a.estimatedPriceFen ?? Infinity) - (b.estimatedPriceFen ?? Infinity))
      .slice(0, Math.min(perConstraint, budget));
    budget -= picks.length;
    if (!picks.length) {
      r.rescan = 'no-candidates';
      r.note = `去掉「${r.label}」后，其它约束仍然生效的情况下，本次候选空间里也没有可核价的组合（搜索范围见 searchScope）`;
      continue;
    }
    const priced = await mapLimit(picks, 3, async (cand) => {
      try {
        return await deps.priceCandidate(cand);
      } catch {
        return { status: 'failed' };
      }
    });
    const found = [];
    for (let i = 0; i < picks.length; i += 1) {
      const p = priced[i]?.ok ? priced[i].value : null;
      if (p?.status === 'valued' && Number.isFinite(p.priceFen)) {
        picks[i].priced = p;
        if (checkHard(picks[i], relaxed, { requirePrice: true }).length === 0) found.push(picks[i]);
      }
    }
    r.rescan = 'done';
    r.rescanned = picks.length;
    if (found.length) {
      const cheapest = found.reduce((a, b) => ((priceFenOf(a) ?? Infinity) <= (priceFenOf(b) ?? Infinity) ? a : b));
      const sc = snapshotOf(cheapest);
      r.feasibleCount = found.length;
      r.cheapest = { name: sc.name, priceFen: sc.priceFen, kcal: sc.kcal, protein: sc.protein };
      r.note = `去掉「${r.label}」后重新搜索并核价 ${picks.length} 个候选，其中 ${found.length} 个可行；最便宜 ¥${((sc.priceFen ?? 0) / 100).toFixed(2)}（${sc.name}）`;
    } else {
      r.note = `去掉「${r.label}」后重新核价 ${picks.length} 个候选，仍未找到可行解（仅限本次搜索范围）`;
    }
  }
  return analysis;
}

/**
 * @param {object} constraints 规范化后的约束
 * @param {{maxPriceTargets?:number, maxVerify?:number, planCount?:number, priceConcurrency?:number}} options
 * @param {object} deps
 */
export async function recommend(constraints, options, deps) {
  const t0 = Date.now();
  const timing = {};
  const c = constraints;
  const intent = resolveIntent(c, options.rawText);
  if (options.intent?.preferences) intent.preferences = options.intent.preferences;
  if (options.intent?.mode) intent.mode = options.intent.mode;
  const maxPriceTargets = options.maxPriceTargets ?? 90;
  const maxVerify = options.maxVerify ?? 40;
  const planCount = options.planCount ?? 4;

  /* ---------- 1. 真实菜单池 ---------- */
  let t = Date.now();
  const pool = await deps.buildPool();
  timing.poolMs = Date.now() - t;

  const poolStats = {
    meals: pool.meals.length,
    singles: Object.fromEntries(Object.entries(pool.singles).map(([k, v]) => [k, v.length])),
    nutritionUnknownExcluded: pool.stats?.nutritionUnknownExcluded ?? null,
  };

  /* ---------- 2. 排除项（硬约束） ---------- */
  const excludedHits = [];
  const filterOut = (list) =>
    list.filter((p) => {
      const hit = (c.excludedFoods || []).find((term) => fuzzyHit(term, p.name));
      if (hit) {
        excludedHits.push({ code: p.code, name: p.name, matched: hit });
        return false;
      }
      return true;
    });

  const meals = filterOut(pool.meals);
  const singles = Object.fromEntries(Object.entries(pool.singles).map(([k, list]) => [k, filterOut(list)]));

  /* ---------- 3. 生成候选（此步只需要营养，不需要价格） ---------- */
  t = Date.now();
  const mealCands = generateMealCandidates(meals, (code) => pool.nutritionOf(code), { perMealKeep: 6, choiceLimitPerRound: 4 });
  const singleCands = generateSingleCandidates(singles, { maxPerPattern: 4000 });
  timing.generateMs = Date.now() - t;

  let allCandidates = [...mealCands.candidates, ...singleCands].filter((cand) => !hitExclusion(cand, c.excludedFoods || []));
  for (const cand of allCandidates) prefScoreOf(cand, c);
  allCandidates = dedupeByContent(allCandidates);
  const beforeFilter = allCandidates.length;

  /* ---------- 4. 营养硬约束预筛（与价格无关，因此可以先剪，不会误剪预算可行解） ---------- */
  let nutritionOk = allCandidates.filter((cand) => checkHard(cand, c, { nutritionOnly: true }).length === 0);
  const afterNutritionFilter = nutritionOk.length;

  /* ---------- 5. 只给还有存活候选的商品核参考价 ---------- */
  t = Date.now();
  const needMeals = new Set(nutritionOk.filter((x) => x.kind === 'meal').map((x) => x.productCode));
  const needSingles = new Map(); // priceKey -> target
  for (const cand of nutritionOk) {
    if (cand.kind !== 'single') continue;
    for (const comp of cand.components) {
      const key = comp.priceKey || priceKey({ kind: 'single', code: comp.code });
      if (!needSingles.has(key)) {
        const poolItem = ['main', 'side', 'drink', 'dessert'].flatMap((r) => singles[r] || []).find((p) => p.code === comp.code);
        needSingles.set(key, {
          kind: key.startsWith('meal:') ? 'meal' : 'single',
          code: comp.code,
          defaultChoices: poolItem?.container || null,
        });
      }
    }
  }
  const targets = [
    ...meals.filter((m) => needMeals.has(m.code)).map((m) => ({ kind: 'meal', code: m.code, meal: m })),
    ...needSingles.values(),
  ].slice(0, maxPriceTargets);

  let atomPrices = new Map();
  try {
    atomPrices = await deps.priceProducts(targets);
  } catch {
    atomPrices = new Map();
  }
  const atomFailures = targets.length - atomPrices.size;
  timing.priceAtomsMs = Date.now() - t;
  timing.atomCalls = targets.length;

  /* ---------- 6. 挂参考价并做预算预筛（留容差，避免参考价误差误剪） ---------- */
  for (const cand of nutritionOk) {
    if (cand.kind === 'meal') {
      const base = atomPrices.get(priceKey({ kind: 'meal', code: cand.productCode }));
      cand.estimatedPriceFen = base ? base.fen + cand.priceDeltaFen : null;
      cand.priceBasis = '套餐基准价 + rounds 补差价';
    } else {
      // 任一组件缺少参考价 → 参考价置 null（绝不能把缺失当 0，否则会误判为省钱而通过预算）
      const parts = cand.components.map((comp) => atomPrices.get(comp.priceKey || priceKey({ kind: 'single', code: comp.code }))?.fen ?? null);
      cand.estimatedPriceFen = parts.every((v) => v != null) ? parts.reduce((a, b) => a + b, 0) : null;
      cand.priceBasis = '各单品实价之和';
    }
  }
  // 参考价缺失的候选无法判断预算，单独计数，不静默丢弃
  const noPrice = nutritionOk.filter((x) => x.estimatedPriceFen == null);
  nutritionOk = nutritionOk.filter((x) => x.estimatedPriceFen != null);

  const candidates = nutritionOk.filter((cand) => checkHard(cand, c, { requirePrice: false }).length === 0);
  const afterFilter = candidates.length;

  /* ---------- 6. 选核价批次（按用户目标排序 + 主食轮转） ---------- */
  const metric = sortKeyMetrics(c, c.objectives || []);
  const budgetRange = intent.budget?.range || null;
  const inTargetRange = (cand) => {
    const p = cand.estimatedPriceFen;
    return Boolean(budgetRange && p != null && p >= budgetRange.min * 100 && p <= budgetRange.max * 100);
  };
  const sortedForVerify = [...candidates].sort((a, b) => {
    // ① 用户给了目标区间：区间内候选优先核价。
    //    否则核价额度会被最便宜的商品吃光，区间内候选永远没机会进入最终结果。
    if (budgetRange) {
      const ia = inTargetRange(a) ? 0 : 1;
      const ib = inTargetRange(b) ? 0 : 1;
      if (ia !== ib) return ia - ib;
    }
    // ② 营养目标优先于价格：用户要蛋白最大化时，先核高蛋白候选，价格不能抢位
    if (metric === 'protein') {
      const d = (b.nutrition.protein ?? 0) - (a.nutrition.protein ?? 0);
      if (d !== 0) return d;
    }
    if (metric === 'calories') {
      const d = (a.nutrition.energyKcal ?? 0) - (b.nutrition.energyKcal ?? 0);
      if (d !== 0) return d;
    }
    // ③ 预算上限：再按参考价升序，避免把额度花在明显超预算的候选上
    if (c.budgetMax != null) {
      const pa = a.estimatedPriceFen ?? Infinity;
      const pb = b.estimatedPriceFen ?? Infinity;
      if (pa !== pb) return pa - pb;
    }
    if ((b.prefScore || 0) !== (a.prefScore || 0)) return (b.prefScore || 0) - (a.prefScore || 0);
    return (a.estimatedPriceFen ?? Infinity) - (b.estimatedPriceFen ?? Infinity);
  });
  const verifyList = stratify(sortedForVerify, Math.min(maxVerify, afterFilter), (cand) =>
    cand.kind === 'meal' ? `meal:${cand.productCode}` : `single:${cand.components[0]?.code}`,
  );

  /**
   * 诊断批次：当预筛后候选过少（或为 0）时，额外核价"最接近硬约束"的候选。
   * 目的不是凑方案，而是让"不可行"这个结论建立在真实核价+真实营养的量化差距上，
   * 而不是"预筛就筛没了"。
   */
  const MIN_DIAG = options.minDiagnosticVerify ?? 12;
  const diagNeed = Math.max(0, MIN_DIAG - verifyList.length);
  const diagList = [];
  if (diagNeed > 0) {
    // 诊断池优先用"有参考价"的候选（预算差距可量化），没有时退回全部候选
    const diagPool = nutritionOk.length ? nutritionOk : allCandidates;
    const rest = diagPool.filter((cand) => !candidates.includes(cand));
    const scored = rest
      .map((cand) => ({ cand, s: estimatedShortfall(cand, c) }))
      .sort((a, b) => a.s - b.s);
    for (const item of scored.slice(0, diagNeed)) diagList.push(item.cand);
  }
  const toVerify = [...verifyList, ...diagList];

  /* ---------- 7. 真实核价（有限并发，保持优先级顺序） ---------- */
  t = Date.now();
  const verified = [];
  const pricedFailed = [];
  const priced = await mapLimit(toVerify, options.verifyConcurrency ?? 6, async (cand) => {
    try {
      return await deps.priceCandidate(cand);
    } catch (err) {
      return { status: 'failed', error: { message: err.message } };
    }
  });
  for (let i = 0; i < toVerify.length; i += 1) {
    const cand = toVerify[i];
    const res = priced[i];
    const p = res?.ok ? res.value : null;
    if (p?.status === 'valued' && Number.isFinite(p.priceFen)) {
      cand.priced = p;
      cand.estimatedPriceFen = p.priceFen;
      verified.push(cand);
    } else {
      pricedFailed.push({ signature: cand.signature, name: cand.productName, error: p?.error?.message || res?.error?.message || '核价失败' });
    }
  }
  timing.verifyMs = Date.now() - t;
  timing.verifyCalls = toVerify.length;
  timing.diagnosticCalls = diagList.length;

  /* ---------- 8. 真实价复核硬约束 ---------- */
  const feasible = [];
  const rejectedByHard = [];
  for (const cand of verified) {
    const fails = checkHard(cand, c, { requirePrice: true });
    if (fails.length) rejectedByHard.push({ name: cand.productName, fails });
    else feasible.push(cand);
  }

  const searchScope = {
    storeCode: pool.storeCode,
    pool: poolStats,
    candidatesGenerated: beforeFilter,
    candidatesAfterNutritionFilter: afterNutritionFilter,
    candidatesWithoutReferencePrice: noPrice.length,
    candidatesAfterHardPrefilter: afterFilter,
    candidatesPriced: toVerify.length,
    diagnosticPriced: diagList.length,
    pricedOk: verified.length,
    pricedFailed: pricedFailed.length,
    rejectedByRealPriceOrConstraint: rejectedByHard.length,
    referencePriceTargets: targets.length,
    referencePriceMissing: atomFailures,
    completeness: afterFilter === 0 ? 'no-candidates-after-prefilter' : toVerify.length >= afterFilter ? 'full' : 'partial',
    spaceNote:
      `候选空间有界：套餐每轮最多取 4 个选项、每套餐最多保留 6 个配置；单品组合仅 ${['main', 'main+drink', 'main+side', 'main+side+drink', 'main+dessert'].join(' / ')} 五种形态；` +
      `本次对其中 ${toVerify.length} 个候选做了真实核价（含 ${diagList.length} 个用于不可行诊断的近似候选）`,
    budgetSlackPct: Math.round((BUDGET_SLACK - 1) * 100),
  };

  /* ---------- 9. 选方案 ---------- */
  const allDims = buildDimensions(c);
  /**
   * 只保留「在可行解中真正有差异」的维度。
   * 例：用户提了偏好但没有任何候选命中，prefScore 恒为 0，这时它不该占一个维度，
   * 否则帕累托退化成"只看价格"，还会掩盖真正该比的其他指标。
   */
  const dims = allDims.filter((d) => new Set(feasible.map((x) => valueOf(x, d.key))).size > 1);
  const dimensions = allDims.map((d) => ({ ...d, active: dims.some((x) => x.key === d.key) }));
  const baseResult = {
    status: 'ok',
    constraints: c,
    intent,
    dimensions,
    searchScope,
    timing: { ...timing, totalMs: Date.now() - t0 },
    dataQuality: {
      unverifiableRestrictions: (c.dietaryRestrictions || []).filter((d) => !d.verified).map((d) => d.text),
      excludedMatched: excludedHits,
      pricedFailed,
      rejectedByHard: rejectedByHard.slice(0, 10),
    },
  };

  /**
   * 日常点餐模式：先满足硬约束，再按"像不像一顿饭 + 口味 + 温度 + 价位意图"排序。
   * 与营养模式的帕累托路径分开，避免把"最便宜"当默认第一推荐。
   */
  if (intent.mode === 'daily') {
    const daily = selectDailyPlans(feasible, intent, { maxAlternates: 2 });
    const dailyStrictSet = new Set(paretoFront(feasible, dims).map((x) => x.signature));
    if (!daily.primary) {
      const analysis = analyzeInfeasible(verified, c, { searchScope, maxAlternatives: 3 });
      return { ...baseResult, status: 'infeasible', plans: [], analysis, message: analysis.reason };
    }
    const entries = [daily.primary, ...daily.alternates];
    const plans = entries.map((item, i) => {
      const plan = buildPlan(item.cand, i, entries.map((x) => x.cand), c);
      plan.pareto = paretoInfoOf(item.cand, feasible, dims, dailyStrictSet);
      plan.isPrimary = i === 0;
      plan.daily = {
        reasons: item.reasons,
        cautions: item.cautions,
        tags: item.tags,
        score: Math.round(item.score * 100) / 100,
      };
      return plan;
    });
    return {
      ...baseResult,
      status: 'ok',
      plans,
      selection: {
        strategy: 'daily-preference',
        basis: 'daily',
        primaryId: plans[0]?.id,
        alternatesCount: plans.length - 1,
        note: daily.note,
        excludedByPreference: daily.excluded,
        sugarFree: daily.sugarFree,
        feasibleCount: feasible.length,
        dimensions: dims.map((d) => ({ key: d.key, label: d.label, dir: d.dir })),
      },
    };
  }

  if (!feasible.length) {
    const analysis = analyzeInfeasible(verified, c, { searchScope, maxAlternatives: 3 });
    try {
      await rescanRelaxations(analysis, allCandidates, c, deps, {
        perConstraint: options.relaxRescanPerConstraint ?? 5,
        total: options.relaxRescanTotal ?? 12,
      });
    } catch {
      // 重搜失败不改变"不可行"结论，保持诚实文案
    }
    return {
      ...baseResult,
      status: 'infeasible',
      plans: [],
      analysis,
      message: analysis.reason,
    };
  }

  /**
   * 「一顿饭」语境（如「想吃一顿高蛋白的麦当劳」）：营养模式也不拿单件
   * （一份油条、单只汉堡）代表一顿饭。若确实没有多件可行解，退回全部可行解并如实说明。
   */
  const mealOnly = intent.mode !== 'daily' && intent.mealContext === true;
  const mealCandidates = mealOnly ? feasible.filter((x) => (x.components || []).length >= 2) : feasible;
  const selectable = mealCandidates.length ? mealCandidates : feasible;

  /**
   * 严格帕累托前沿：只在整个已核价可行解集合上计算，与推荐了哪几套无关。
   * 注意：维度只有价格时，前沿 = 最低价的那一批；其余更贵的方案一定被支配。
   */
  const strictFront = paretoFront(selectable, dims);
  const strictSet = new Set(strictFront.map((x) => x.signature));

  // 主目标：要高蛋白时按蛋白优先，否则按价格。选择器首位必须是它，而不是永远取最低价。
  const priorityKey = metric === 'protein' ? 'protein' : 'priceFen';

  let selection;
  let basis;
  if (strictFront.length >= 2 && dims.length >= 2) {
    selection = selectRepresentatives(strictFront, { k: planCount, dims, minDistance: 0.12, priorityKey });
    basis = 'strict-front';
  } else {
    // 有效维度不足两维（如只给了预算/只给了蛋白质下限）：严格前沿可能只有最低价的几个点，
    // 无法满足同时看到多套有不同优势的方案。这里补充差异化方案，但必须逐条标注它不是非支配解。
    selection = selectLadder(selectable, { k: planCount, dims, front: strictFront, priorityKey });
    basis = 'ladder';
  }

  const entries = selection.selected.map((cand, i) => ({ cand, plan: buildPlan(cand, i, selection.selected, c) }));
  for (const { cand, plan } of entries) {
    plan.pareto = paretoInfoOf(cand, selectable, dims, strictSet);
  }
  const plans = entries.map((e) => e.plan);

  const nonDominatedSelected = plans.filter((x) => x.pareto.nonDominated).length;
  const diversifiedSelected = plans.length - nonDominatedSelected;
  const dimLabels = dims.map((d) => d.label).join(' + ') || '（无差异维度）';
  const cheapest = strictFront.length ? Math.min(...strictFront.map((x) => priceFenOf(x))) : null;

  return {
    ...baseResult,
    status: 'ok',
    plans,
    selection: {
      strategy: selection.strategy,
      basis,
      dimensions: dims.map((d) => ({ key: d.key, label: d.label, dir: d.dir })),
      strictParetoSize: strictFront.length,
      strictParetoCheapestFen: cheapest,
      feasibleCount: feasible.length,
      mealOnly,
      singleItemExcluded: feasible.length - selectable.length,
      priority: priorityKey,
      nonDominatedSelected,
      diversifiedSelected,
      note:
        basis === 'strict-front'
          ? `按「${dimLabels}」在 ${feasible.length} 个已核价可行解中筛出 ${strictFront.length} 个严格非支配解，再按差异度取 ${plans.length} 个（全部为严格非支配解）`
          : `按「${dimLabels}」计算，严格非支配解只有 ${strictFront.length} 个（最低价 ¥${((cheapest ?? 0) / 100).toFixed(2)}）。` +
            `为满足多套方案可选，另外补充 ${diversifiedSelected} 个差异化方案：它们在价格上被更便宜的方案支配，` +
            `但在组合结构/蛋白质等指标上有明确优势，已逐条标注「差异化补充」。`,
      strictParetoSample: strictFront.slice(0, 5).map((x) => snapshotOf(x)),
    },
    alternatives: (selection.rest || []).slice(0, 5).map((cand) => snapshotOf(cand)),
  };
}

/**
 * 单个方案的帕累托归属（独立于选择过程计算）：
 * - nonDominated: 是否属于严格非支配前沿
 * - dominatedBy: 若是被支配的，列出真实支配者与差价（价格为负表示对方更便宜）
 */
function paretoInfoOf(cand, feasible, dims, strictSet) {
  const nonDominated = strictSet.has(cand.signature);
  if (nonDominated) {
    return {
      nonDominated: true,
      label: '严格非支配',
      dimensions: dims.map((d) => d.key),
      dominatedBy: [],
      note: '在所选维度上没有任何其他已核价方案全面优于它',
    };
  }
  const dominatedBy = feasible
    .filter((o) => o.signature !== cand.signature && dominates(o, cand, dims))
    .slice(0, 3)
    .map((o) => {
      const snapshot = snapshotOf(o);
      return { name: snapshot.name, priceFen: snapshot.priceFen, deltaFen: snapshot.priceFen == null || priceFenOf(cand) == null ? null : snapshot.priceFen - priceFenOf(cand) };
    });
  return {
    nonDominated: false,
    label: '差异化补充',
    dimensions: dims.map((d) => d.key),
    dominatedBy,
    note: '价格上被更便宜的方案支配，为丰富选择而保留；它的价值在于其它指标或组合结构',
  };
}

/** 组装单个方案（含优势/代价，全部由数值比较得出，不含模型推测）。也供 /api/plan/rebuild 复用。 */
export function buildPlan(cand, index, peers, constraints) {
  const price = priceFenOf(cand);
  const prices = peers.map((p) => priceFenOf(p)).filter((v) => v != null);
  const proteins = peers.map((p) => p.nutrition.protein).filter((v) => v != null);
  const kcals = peers.map((p) => p.nutrition.energyKcal).filter((v) => v != null);

  const advantages = [];
  const tradeoffs = [];
  const spread = (arr) => (arr.length > 1 ? Math.max(...arr) - Math.min(...arr) : 0);
  const priceSpread = spread(prices);
  const proteinSpread = spread(proteins);
  const kcalSpread = spread(kcals);

  if (price != null && priceSpread > 0) {
    if (price === Math.min(...prices)) advantages.push(`这几套里最便宜（比最贵的省 ¥${((Math.max(...prices) - price) / 100).toFixed(2)}）`);
    if (price === Math.max(...prices)) tradeoffs.push(`价格最高（比最便宜的贵 ¥${((price - Math.min(...prices)) / 100).toFixed(2)}）`);
  }
  if (proteinSpread > 0) {
    if (cand.nutrition.protein === Math.max(...proteins)) advantages.push(`蛋白质最高（${cand.nutrition.protein} g）`);
    if (cand.nutrition.protein === Math.min(...proteins)) tradeoffs.push(`蛋白质最低（${cand.nutrition.protein} g）`);
  }
  if (kcalSpread > 0) {
    if (cand.nutrition.energyKcal === Math.min(...kcals)) advantages.push(`热量最低（${cand.nutrition.energyKcal} kcal）`);
    if (cand.nutrition.energyKcal === Math.max(...kcals)) tradeoffs.push(`热量最高（${cand.nutrition.energyKcal} kcal）`);
  }
  if (cand.prefMatched?.length) advantages.push(...cand.prefMatched);
  if (cand.kind === 'meal' && (cand.roles || []).includes('main')) advantages.push('官方套餐形态，规格合法');
  if (cand.kind === 'single' && cand.pattern) advantages.push(`单品组合（${cand.pattern}）`);
  if (cand.pickReason) advantages.push(cand.pickReason);

  const hardSatisfied = [];
  if (constraints.budgetMax != null && price != null && price <= constraints.budgetMax * 100) hardSatisfied.push(`预算 ≤ ¥${constraints.budgetMax}`);
  if (constraints.caloriesMax != null) hardSatisfied.push(`热量 ≤ ${constraints.caloriesMax} kcal`);
  if (constraints.caloriesMin != null) hardSatisfied.push(`热量 ≥ ${constraints.caloriesMin} kcal`);
  if (constraints.proteinMin != null) hardSatisfied.push(`蛋白质 ≥ ${constraints.proteinMin} g`);
  for (const r of constraints.requiredCategories || []) hardSatisfied.push(`包含${ROLE_LABEL[r] || r}`);

  return {
    id: `P${index + 1}`,
    // 面向用户的标签由前端依据真实数值生成；这里只放中性标识与机器可读理由
    label: `方案 ${index + 1}`,
    pickReason: cand.pickReason ?? null,
    kind: cand.kind,
    productCode: cand.productCode,
    productName: cand.productName,
    components: (cand.components || []).map((comp) => ({
      code: comp.code,
      name: comp.name,
      quantity: comp.quantity ?? 1,
      role: comp.role || null,
    })),
    rounds: cand.combo ? cand.combo.map((x) => ({ round: x.round, roundName: x.roundName, code: x.code, name: x.name, diffPriceFen: x.diffPriceFen })) : null,
    price: {
      fen: price,
      yuan: price == null ? null : Number((price / 100).toFixed(2)),
      checkedAt: cand.priced?.checkedAt ?? null,
      mcpDatetime: cand.priced?.mcpDatetime ?? null,
      traceId: cand.priced?.traceId ?? null,
      status: 'valued',
      basis: cand.priceBasis,
      estimatedFen: cand.estimatedPriceFen,
      // 只有存在参考价时才谈得上"估算是否命中"；手动重建没有参考价，给 null 而不是 false
      estimateMatched: cand.estimatedPriceFen == null ? null : price === cand.estimatedPriceFen,
    },
    nutrition: {
      energyKcal: cand.nutrition.energyKcal,
      protein: cand.nutrition.protein,
      fat: cand.nutrition.fat,
      carbohydrate: cand.nutrition.carbohydrate,
      sodium: cand.nutrition.sodium ?? null,
      calcium: cand.nutrition.calcium ?? null,
      status: cand.nutritionStatus,
      basis: '各组件官方标准值之和；官方未提供套餐级营养标示',
      modificationImpact: 'not_modeled',
    },
    hardSatisfied,
    softMatched: cand.prefMatched || [],
    prefScore: cand.prefScore ?? 0,
    advantages: [...new Set(advantages)].slice(0, 5),
    tradeoffs: [...new Set(tradeoffs)].slice(0, 3),
    mcp: { priced: true, verifiedAt: cand.priced?.checkedAt ?? null, traceId: cand.priced?.traceId ?? null },
  };
}
