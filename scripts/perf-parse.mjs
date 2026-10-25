/**
 * P2 响应时间实测：自然语言 → 解析 → 推荐 全链路耗时统计。
 *
 * 用法：node scripts/perf-parse.mjs [--rounds 2]
 * 对每组输入跑 N 轮（默认 2：冷启动 + 重复），记录：
 *   parseMs  = POST /api/parse 端到端（用户等待解析的时间）
 *   llmMs    = 模型调用本身（响应里 llm.ms；规则路径为 0/空）
 *   recMs    = POST /api/recommend 端到端（解析完自动搜索的等待）
 *   totalMs  = parseMs + recMs（「说一句话 → 看到推荐」的总等待）
 * 输出实测统计（min/median/max），不承诺固定秒数。
 */
const BASE = process.env.MCFIT_BASE || 'http://localhost:5173';

const SCENARIOS = [
  ['A  随便吃点30内', '今天想随便吃点，预算30以内，给我推荐个套餐。'],
  ['B  问题现场60套餐', '最近肚子有点不舒服，不是很喜欢吃油的，也不喜欢吃辣的吃冰的，你给我推荐一个60元的套餐。'],
  ['C  营养多目标', '40元以内，蛋白质至少30g，热量不超过750 kcal，尽量高蛋白。'],
  ['D  60元套餐', '推荐一个60元的套餐。'],
  ['E  热量矛盾', '热量至少900大卡但不超过700大卡，40元以内。'],
  ['F  不能吃辣', '40元以内，不能吃辣，要有主食。'],
  ['G  高蛋白控热量', '预算 40 元，想吃高蛋白，热量不超过 750 大卡，最好有无糖饮料'],
];

const rounds = Number((process.argv.find((a, i) => process.argv[i - 1] === '--rounds') || 2));

function stats(list) {
  if (!list.length) return '—';
  const s = [...list].sort((a, b) => a - b);
  const med = s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
  return `min ${s[0]} / 中位 ${med} / max ${s[s.length - 1]}`;
}

async function post(path, body) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { json, wall: Date.now() - t0, status: res.status };
}

const rows = [];
console.log(`目标：${BASE} ｜ 每组 ${rounds} 轮（第 1 轮冷、第 2 轮重复）\n`);

for (let round = 1; round <= rounds; round += 1) {
  console.log(`—————— 第 ${round} 轮 ——————`);
  for (const [label, text] of SCENARIOS) {
    const p = await post('/api/parse', { text });
    const rec = await post('/api/recommend', {
      constraints: p.json.constraints,
      text,
      intent: p.json.intent?.preferences ? { preferences: p.json.intent.preferences } : undefined,
      planCount: 4,
      maxVerify: 40,
    });
    const row = {
      round,
      label,
      parseMs: p.wall,
      llmMs: p.json.llm?.ms ?? 0,
      source: p.json.source || p.json.status,
      cache: p.json.cacheStatus || '—',
      recMs: rec.wall,
      totalMs: p.wall + rec.wall,
    };
    rows.push(row);
    console.log(
      `${label.padEnd(18, ' ')} 解析 ${String(row.parseMs).padStart(6)}ms（llm ${String(row.llmMs).padStart(5)}ms, ${row.source}, cache=${row.cache}） + 推荐 ${String(row.recMs).padStart(5)}ms = 总 ${row.totalMs}ms`,
    );
  }
}

const cold = rows.filter((r) => r.round === 1);
const warm = rows.filter((r) => r.round > 1);
const pick = (list, k) => list.map((r) => r[k]);

console.log('\n================ 实测统计 ================');
console.log(`冷启动 解析: ${stats(pick(cold, 'parseMs'))} ms`);
console.log(`冷启动 推荐: ${stats(pick(cold, 'recMs'))} ms`);
console.log(`冷启动 总等待: ${stats(pick(cold, 'totalMs'))} ms`);
if (warm.length) {
  console.log(`重复请求 解析: ${stats(pick(warm, 'parseMs'))} ms`);
  console.log(`重复请求 推荐: ${stats(pick(warm, 'recMs'))} ms`);
  console.log(`重复请求 总等待: ${stats(pick(warm, 'totalMs'))} ms`);
}
const cacheCount = {};
for (const r of rows) cacheCount[r.cache] = (cacheCount[r.cache] || 0) + 1;
console.log(`解析缓存命中分布: ${Object.entries(cacheCount).map(([k, v]) => `${k}=${v}`).join('  ')}`);
console.log(`\n说明：以上为真实调用实测统计，模型耗时随输入与服务负载波动，不承诺固定秒数。`);
