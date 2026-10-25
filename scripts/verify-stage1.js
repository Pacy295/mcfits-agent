/**
 * 第一阶段验收脚本（真实 MCP 调用，不使用任何手写假数据）。
 * 用法: node scripts/verify-stage1.js [storeCode]
 * 输出: 控制台报告 + cache/verify-report.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR, config, tokenStatus } from '../src/config.js';
import { mcp, McpError } from '../src/mcp/client.js';
import { dataService, DataServiceError } from '../src/services/data-service.js';
import { getDetail, getNutritionTable } from '../src/data/store.js';
import { buildCatalog } from '../src/data/catalog.js';
import { defaultCombo } from '../src/data/meal.js';

const store = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : config.store.defaultStoreCode;
const results = [];
const evidence = {};

function check(id, title, fn) {
  const t0 = Date.now();
  try {
    const detail = fn();
    const pass = detail?.pass !== false;
    results.push({ id, title, pass, ms: Date.now() - t0, detail: detail?.text ?? '', data: detail?.data });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(4)} ${title}${detail?.text ? ` — ${detail.text}` : ''}`);
    return detail?.data;
  } catch (err) {
    results.push({ id, title, pass: false, ms: Date.now() - t0, detail: `异常: ${err.message}` });
    console.log(`FAIL  ${id.padEnd(4)} ${title} — 异常: ${err.message}`);
    return null;
  }
}

async function checkAsync(id, title, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    const pass = detail?.pass !== false;
    results.push({ id, title, pass, ms: Date.now() - t0, detail: detail?.text ?? '', data: detail?.data });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(4)} ${title}${detail?.text ? ` — ${detail.text}` : ''}`);
    return detail?.data;
  } catch (err) {
    results.push({ id, title, pass: false, ms: Date.now() - t0, detail: `异常: ${err.message}` });
    console.log(`FAIL  ${id.padEnd(4)} ${title} — 异常: ${err.message}`);
    return null;
  }
}

console.log('='.repeat(78));
console.log(`麦门营养决策官 · 第一阶段验收（真实 MCP）  门店 ${store}`);
console.log(`执行时间 ${new Date().toLocaleString('zh-CN')}  Node ${process.version}`);
console.log(`Token 状态 ${JSON.stringify(tokenStatus())}`);
console.log('='.repeat(78));

/* ---------- A. 环境与 MCP 真实调用能力 ---------- */
console.log('\n[A] 环境检查与独立进程 MCP 直连');

await checkAsync('A1', '独立 Node 进程可列出 MCP 工具', async () => {
  const tools = await mcp.listTools();
  evidence.toolCount = tools.length;
  return { pass: tools.length > 30, text: `${tools.length} 个工具`, data: tools.map((t) => t.name) };
});

await checkAsync('A2', 'MCP 服务端时间可用（证明为实时连接）', async () => {
  const r = await mcp.callTool('now-time-info', {});
  evidence.serverTime = r.data?.formatted;
  evidence.timeTraceId = r.traceId;
  return { pass: Boolean(r.data?.formatted), text: `服务端时间 ${r.data?.formatted}，traceId ${r.traceId}` };
});

await checkAsync('A3', '写操作类工具被客户端阻断', async () => {
  try {
    await mcp.callTool('create-order', { storeCode: store });
    return { pass: false, text: '未被阻断（严重问题）' };
  } catch (err) {
    return { pass: err instanceof McpError && err.kind === 'blocked', text: `已阻断：${err.kind}` };
  }
});

/* ---------- B/C/D. 真实商品、营养映射、套餐结构 ---------- */
console.log('\n[B] 统一商品数据结构');

const catalog = await buildCatalog(store);
evidence.catalogSize = catalog.products.size;
evidence.menuTraceId = catalog.sources.menu?.traceId;

await checkAsync('B1', '门店菜单拉取（query-meals）', async () => {
  const p = catalog.products.get('1600');
  return {
    pass: catalog.products.size > 50,
    text: `在售 ${catalog.products.size} 个商品，query-meals traceId=${catalog.sources.menu?.traceId}`,
    data: { count: catalog.products.size },
  };
});

await checkAsync('B2', '真实商品麦香鱼存在且字段完整', async () => {
  const p = catalog.products.get('1600');
  if (!p) return { pass: false, text: '未找到 code 1600' };
  const required = ['storeCode', 'code', 'name', 'categories', 'sellable', 'isMeal', 'rounds', 'modification', 'nutrition', 'pricing'];
  const missing = required.filter((k) => !(k in p));
  const modKeys = p.modification?.items?.flatMap((g) => g.values.map((v) => v.name)) || [];
  return {
    pass: missing.length === 0 && p.name === '麦香鱼',
    text: `${p.name} | 分类=${p.categories.join('/')} | 特制项=[${modKeys.join(',')}] | 营养=${p.nutrition.status}`,
    data: {
      code: p.code,
      name: p.name,
      categories: p.categories,
      sellable: p.sellable,
      modification: p.modification,
      nutrition: p.nutrition,
      pricing: p.pricing,
    },
  };
});

console.log('\n[C] 营养数据映射');

await checkAsync('C1', '麦香鱼官方营养取值正确', async () => {
  const p = catalog.products.get('1600');
  const n = p?.nutrition;
  return {
    pass: n?.status === 'official' && n.energyKcal === 325 && n.protein === 16,
    text: `${n?.energyKcal} kcal / 蛋白 ${n?.protein} g / 匹配方式 ${n?.matchMethod}`,
    data: n,
  };
});

await checkAsync('C2', '官方营养表解析（160 条）', async () => {
  const t = await getNutritionTable();
  evidence.nutritionRows = t.rows.length;
  evidence.nutritionIssues = t.issues.length;
  return {
    pass: t.rows.length === 160 && t.issues.length === 0,
    text: `解析 ${t.rows.length}/${t.declaredCount} 条，自洽性问题 ${t.issues.length}`,
    data: { declared: t.declaredCount, parsed: t.rows.length, issues: t.issues },
  };
});

await checkAsync('C3', '无营养数据商品返回 unknown 而非 0', async () => {
  const p = catalog.products.get('521951'); // 灰焰圆筒
  if (!p) return { pass: false, text: '样本商品不存在' };
  return {
    pass: p.nutrition.status === 'unknown' && p.nutrition.energyKcal === null,
    text: `${p.name} → status=${p.nutrition.status}, energyKcal=${p.nutrition.energyKcal}`,
    data: p.nutrition,
  };
});

const coverage = await dataService.getCoverage(store);
await checkAsync('C4', '营养匹配覆盖率统计', async () => {
  return {
    pass: coverage.counts.onMenuProducts > 0,
    text: `单品 ${coverage.coverage.singleItems}% / 套餐 ${coverage.coverage.meals}% / 整体 ${coverage.coverage.overall}%，需人工确认 ${coverage.reviewCount} 条`,
    data: coverage,
  };
});

console.log('\n[D] 套餐组成与规格验证（麦香鱼中套餐）');

const MEAL = '9900005460';
const rounds = await dataService.getMealRounds(store, MEAL);
evidence.meal = { code: MEAL, name: rounds.name, totalCombos: rounds.totalCombos, rounds: rounds.dimensions };

await checkAsync('D1', '解析真实 rounds 与合法替换项', async () => {
  return {
    pass: rounds.roundCount === 3,
    text: `${rounds.name}：${rounds.roundCount} 个 round，合法组合 ${rounds.totalCombos} 种；` +
      rounds.dimensions.map((d) => `${d.name}(${d.choices})`).join(' / '),
    data: rounds.dimensions,
  };
});

const combos = {
  '原始中套餐(麦香鱼+中薯条+可乐中杯)': [
    { round: '1', code: '1600' },
    { round: '2', code: '4810' },
    { round: '3', code: '3050' },
  ],
  '改大杯可乐(3100)': [
    { round: '1', code: '1600' },
    { round: '2', code: '4810' },
    { round: '3', code: '3100' },
  ],
  '改大薯条(4820)': [
    { round: '1', code: '1600' },
    { round: '2', code: '4820' },
    { round: '3', code: '3050' },
  ],
};

const EXPECT = {
  '原始中套餐(麦香鱼+中薯条+可乐中杯)': 761,
  '改大杯可乐(3100)': 838,
  '改大薯条(4820)': 851,
};

const nutritionByCombo = {};
for (const [label, combo] of Object.entries(combos)) {
  const composed = await dataService.composeNutrition(
    store,
    combo.map((c) => ({ code: c.code, quantity: 1, fallbackName: rounds.rounds.find((r) => r.id === c.round)?.choices.find((x) => x.code === c.code)?.name })),
  );
  nutritionByCombo[label] = composed;
  await checkAsync(
    `D2.${Object.keys(nutritionByCombo).length}`,
    `营养合计 — ${label}`,
    async () => {
      const kcal = composed.totals?.energyKcal ?? null;
      return {
        pass: kcal === EXPECT[label],
        text: `${composed.items.map((i) => `${i.name}=${i.subtotal?.energyKcal ?? 'unknown'}`).join(' + ')} = ${kcal} kcal（期望 ${EXPECT[label]}）`,
        data: composed,
      };
    },
  );
}

evidence.unitTest = Object.entries(nutritionByCombo).map(([k, v]) => ({
  combo: k,
  kcal: v.totals?.energyKcal ?? null,
  expected: EXPECT[k],
  status: v.status,
}));

const priceByCombo = {};
let i = 0;
for (const [label, combo] of Object.entries(combos)) {
  i += 1;
  const priced = await dataService.priceCombo(store, { productCode: MEAL, choices: combo, refresh: true });
  priceByCombo[label] = priced;
  await checkAsync(`D3.${i}`, `MCP 实算价格 — ${label}`, async () => {
    return {
      pass: priced.status === 'valued' && Number.isFinite(priced.priceFen),
      text: priced.status === 'valued'
        ? `¥${(priced.priceFen / 100).toFixed(2)}（traceId ${priced.traceId}，${priced.mcpDatetime}）`
        : `失败 ${JSON.stringify(priced.error)}`,
      data: priced,
    };
  });
}

await checkAsync('D4', '价格差额与 rounds diffPrice 一致', async () => {
  const base = priceByCombo['原始中套餐(麦香鱼+中薯条+可乐中杯)'].priceFen;
  const bigCola = priceByCombo['改大杯可乐(3100)'].priceFen;
  const bigFries = priceByCombo['改大薯条(4820)'].priceFen;
  const d1 = bigCola - base;
  const d2 = bigFries - base;
  return {
    pass: d1 === 200 && d2 === 200,
    text: `大杯可乐 +${d1 / 100} 元、大薯条 +${d2 / 100} 元（rounds 标注均为 +¥2）`,
    data: { base, bigCola, bigFries },
  };
});

/* ---------- E. 数据服务与错误处理 ---------- */
console.log('\n[E] 数据服务接口与错误处理');

await checkAsync('E1', 'getAvailableProducts 可用', async () => {
  const r = await dataService.getAvailableProducts(store);
  return { pass: r.count > 0, text: `${r.count} 个商品，${r.categories.length} 个分类` };
});

await checkAsync('E2', '不存在商品返回结构化错误', async () => {
  try {
    await dataService.getNutrition(store, '999999999');
    return { pass: false, text: '未抛错' };
  } catch (err) {
    return { pass: err instanceof DataServiceError && err.code === 'product_not_found', text: `${err.code}: ${err.message}` };
  }
});

await checkAsync('E3', '非法套餐选项被拒绝（round 校验）', async () => {
  try {
    await dataService.priceCombo(store, {
      productCode: MEAL,
      choices: [
        { round: '1', code: '1600' },
        { round: '2', code: '4810' },
        { round: '3', code: '4820' }, // 大薯条不属于饮料 round
      ],
    });
    return { pass: false, text: '未拒绝非法组合' };
  } catch (err) {
    return { pass: err instanceof DataServiceError && err.code === 'illegal_choice', text: `${err.code}: ${err.message.slice(0, 60)}...` };
  }
});

await checkAsync('E4', '价格缓存带 checkedAt 且短期有效', async () => {
  const first = await dataService.priceCombo(store, { productCode: MEAL, choices: combos['原始中套餐(麦香鱼+中薯条+可乐中杯)'] });
  const second = await dataService.priceCombo(store, { productCode: MEAL, choices: combos['原始中套餐(麦香鱼+中薯条+可乐中杯)'] });
  return {
    pass: second.cacheMeta?.cache === 'hit' && Number.isFinite(second.checkedAt),
    text: `第二次命中缓存=${second.cacheMeta?.cache}，checkedAt=${new Date(first.checkedAt).toLocaleTimeString('zh-CN')}，TTL=${config.ttl.priceMs / 1000}s`,
  };
});

await checkAsync('E5', '商品详情缓存生效（不重复请求）', async () => {
  const before = mcp.snapshotMetrics().byTool['query-meal-detail'] || 0;
  const d1 = await getDetail(store, '1600');
  const d2 = await getDetail(store, '1600');
  const after = mcp.snapshotMetrics().byTool['query-meal-detail'] || 0;
  return {
    pass: after === before && d1.meta.cache === 'hit' && d2.meta.cache === 'hit',
    text: `两次读取均为 ${d1.meta.cache}，本进程 query-meal-detail 调用次数 ${before} → ${after}（未新增请求）`,
  };
});

/* ---------- F. 安全 ---------- */
console.log('\n[F] 安全与真实性');

await checkAsync('F1', '报告与响应中不含 Token', async () => {
  const raw = JSON.stringify({ results, coverage, rounds, priceByCombo });
  const token = process.env.MCD_MCP_TOKEN;
  const hasBearer = /Bearer\s+[A-Za-z0-9._-]{10,}/.test(raw);
  return { pass: !hasBearer && (!token || !raw.includes(token)), text: hasBearer ? '发现疑似 Bearer 串' : '未发现任何 Token 痕迹' };
});

await checkAsync('F2', '特制变化未伪造成精确营养值', async () => {
  const composed = nutritionByCombo['原始中套餐(麦香鱼+中薯条+可乐中杯)'];
  return {
    pass: composed.modificationImpact === 'not_modeled',
    text: `modificationImpact=${composed.modificationImpact}；提示：${composed.modificationNote}`,
  };
});

/* ---------- 汇总 ---------- */
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n' + '='.repeat(78));
console.log(`验收结果：${passed}/${results.length} 通过，${failed} 失败`);
if (failed) console.log('失败项：', results.filter((r) => !r.pass).map((r) => r.id).join(', '));
console.log('='.repeat(78));

const report = {
  generatedAt: new Date().toISOString(),
  storeCode: store,
  node: process.version,
  tokenStatus: tokenStatus(),
  summary: { total: results.length, passed, failed },
  evidence: {
    serverTime: evidence.serverTime,
    timeTraceId: evidence.timeTraceId,
    toolCount: evidence.toolCount,
    catalogSize: evidence.catalogSize,
    nutritionRows: evidence.nutritionRows,
    meal: evidence.meal,
    nutritionUnitTests: evidence.unitTest,
    prices: Object.fromEntries(
      Object.entries(priceByCombo).map(([k, v]) => [k, { status: v.status, priceFen: v.priceFen, traceId: v.traceId, mcpDatetime: v.mcpDatetime }]),
    ),
    coverage: coverage.coverage,
    coverageCounts: coverage.counts,
    matchBreakdown: coverage.singleItemMatch,
    mealComposition: coverage.mealComposition,
    reviewCount: coverage.reviewCount,
    sources: coverage.sources,
  },
  checks: results,
};
fs.writeFileSync(path.join(CACHE_DIR, 'verify-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(`报告已写入 cache/verify-report.json`);
process.exitCode = failed ? 1 : 0;
