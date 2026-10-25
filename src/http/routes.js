/**
 * 极简 HTTP 路由（零依赖）。
 * 只暴露数据服务，不做任何业务决策；所有响应都带 status/source，前端可直接展示数据可信度。
 */
import { dataService, DataServiceError } from '../services/data-service.js';
import { config } from '../config.js';
import { mcp, McpError } from '../mcp/client.js';
import { getNutritionTable } from '../data/store.js';
import { clientKey, take } from './ratelimit.js';

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(payload);
}

function fail(res, err) {
  if (err instanceof DataServiceError) {
    return send(res, err.code === 'product_not_found' ? 404 : 400, { ok: false, error: { code: err.code, message: err.message, ...err.extra } });
  }
  if (err instanceof McpError) {
    const status = err.kind === 'no_token' ? 503 : 502;
    return send(res, status, { ok: false, error: { code: `mcp_${err.kind}`, message: err.message, detail: err.detail } });
  }
  console.error('[api] 未捕获异常', err);
  return send(res, 500, { ok: false, error: { code: 'internal_error', message: err.message } });
}

/**
 * 菜单类失败（query-meals / query-meal-detail）统一走门店诊断：
 * - 主界面只拿自然语言原因与可行操作（message/reason/actions），不出现工具名与错误码；
 * - 技术证据（工具/错误码/traceId/营业状态）只放进 diagnosis 字段，供工程台展示；
 * - 不硬编码任何错误码含义，原因由营业状态 + 当前时间交叉验证得出。
 */
async function failMenuAware(res, err, storeCode) {
  const tool = err instanceof McpError ? err.detail?.tool : null;
  if (tool === 'query-meals' || tool === 'query-meal-detail') {
    const { diagnoseMenuFailure } = await import('../services/store-health.js');
    const d = await diagnoseMenuFailure(storeCode, err).catch(() => null);
    if (d) {
      return send(res, 503, {
        ok: false,
        error: {
          code: 'menu_unavailable',
          category: d.category,
          message: d.userMessage,
          reason: d.reason,
          actions: d.actions,
          store: { code: d.storeCode, name: d.storeName },
          diagnosis: d.diagnostics,
        },
      });
    }
  }
  return fail(res, err);
}

async function readJson(req, limit = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new DataServiceError('payload_too_large', '请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const storeOf = (url) => url.searchParams.get('store') || config.store.defaultStoreCode;
const boolOf = (url, key) => ['1', 'true', 'yes'].includes(String(url.searchParams.get(key) || '').toLowerCase());
function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  try {
    if (m === 'OPTIONS') return send(res, 204, {});

    /* ---------- 限流（只作用于会触发模型/大量核价的写接口） ---------- */
    const limitRule =
      p === '/api/parse' && m === 'POST'
        ? config.llm.rateLimit.parse
        : p === '/api/recommend' && m === 'POST'
          ? config.llm.rateLimit.recommend
          : p === '/api/plan/rebuild' && m === 'POST'
            ? config.llm.rateLimit.rebuild
            : null;
    if (limitRule) {
      const r = take(clientKey(req, p), limitRule);
      res.setHeader('X-RateLimit-Limit', String(limitRule.limit));
      res.setHeader('X-RateLimit-Remaining', String(r.remaining));
      if (!r.allowed) {
        res.setHeader('Retry-After', String(r.retryAfterSec));
        return send(res, 429, {
          ok: false,
          error: { code: 'rate_limited', message: `请求过于频繁，请 ${r.retryAfterSec} 秒后再试`, retryAfterSec: r.retryAfterSec },
        });
      }
    }

    if (p === '/api/health' && m === 'GET') {
      return send(res, 200, { ok: true, ...(await dataService.health()) });
    }

    if (p === '/api/mcp/tools' && m === 'GET') {
      const tools = await mcp.listTools();
      return send(res, 200, {
        ok: true,
        count: tools.length,
        tools: tools.map((t) => ({ name: t.name, description: (t.description || '').split('\n')[0], readonly: config.mcp.readOnlyAllowlist.has(t.name) })),
      });
    }

    if (p === '/api/products' && m === 'GET') {
      const r = await dataService.getAvailableProducts(storeOf(url), {
        refresh: boolOf(url, 'refresh'),
        category: url.searchParams.get('category'),
      });
      return send(res, 200, { ok: true, ...r });
    }

    // /api/products/:code 及其子资源
    const prodMatch = /^\/api\/products\/([^/]+)(?:\/(nutrition|rounds|price))?$/.exec(p);
    if (prodMatch) {
      const [, code, sub] = prodMatch;
      const store = storeOf(url);
      if (sub === 'nutrition' && m === 'GET') {
        return send(res, 200, { ok: true, ...(await dataService.getNutrition(store, code)) });
      }
      if (sub === 'rounds' && m === 'GET') {
        return send(res, 200, { ok: true, ...(await dataService.getMealRounds(store, code)) });
      }
      if (sub === 'price' && m === 'POST') {
        const body = await readJson(req);
        return send(res, 200, { ok: true, ...(await dataService.priceCombo(store, { productCode: code, ...body })) });
      }
      if (!sub && m === 'GET') {
        const nutrition = await dataService.getNutrition(store, code);
        const products = await dataService.getAvailableProducts(store);
        const base = products.products.find((x) => x.code === String(code));
        if (!base) return send(res, 404, { ok: false, error: { code: 'product_not_found', message: `商品 ${code} 不在售` } });
        let rounds = null;
        if (base.isMeal) {
          try {
            rounds = await dataService.getMealRounds(store, code);
          } catch {
            rounds = null;
          }
        }
        return send(res, 200, { ok: true, product: base, nutrition, rounds });
      }
    }

    if (p === '/api/compose' && m === 'POST') {
      const body = await readJson(req);
      const components = body.components;
      if (!Array.isArray(components) || !components.length) {
        return send(res, 400, { ok: false, error: { code: 'invalid_request', message: 'components 必须是非空数组' } });
      }
      if (components.length > 20) {
        return send(res, 400, { ok: false, error: { code: 'invalid_request', message: '单次最多组合 20 个组件' } });
      }
      return send(res, 200, { ok: true, ...(await dataService.composeNutrition(storeOf(url), components)) });
    }

    if (p === '/api/price' && m === 'POST') {
      const body = await readJson(req);
      return send(res, 200, { ok: true, ...(await dataService.priceCombo(storeOf(url), body)) });
    }

    if (p === '/api/coverage' && m === 'GET') {
      return send(res, 200, { ok: true, ...(await dataService.getCoverage(storeOf(url), { refresh: boolOf(url, 'refresh') })) });
    }

    if (p === '/api/nutrition/table' && m === 'GET') {
      const t = await getNutritionTable({ refresh: boolOf(url, 'refresh') });
      return send(res, 200, {
        ok: true,
        declaredCount: t.declaredCount,
        parsedCount: t.rows.length,
        issues: t.issues,
        source: t.source,
        cache: t.meta,
        rows: boolOf(url, 'all') ? t.rows : t.rows.slice(0, 20),
      });
    }

    /* ---------------- 第二阶段：自然语言解析 + 多目标推荐 ---------------- */

    if (p === '/api/llm/status' && m === 'GET') {
      const { llmStatus, probe } = await import('../llm/provider.js');
      const probed = boolOf(url, 'probe') ? await probe() : null;
      return send(res, 200, { ok: true, ...llmStatus(), probed });
    }

    if (p === '/api/parse' && m === 'POST') {
      const { parseRequirement } = await import('../parse/llm-parser.js');
      const body = await readJson(req);
      const rawText = String(body.text || '');
      if (rawText.length > config.llm.maxInputChars) {
        return send(res, 400, {
          ok: false,
          error: { code: 'input_too_long', message: `需求描述最多 ${config.llm.maxInputChars} 个字符，当前 ${rawText.length}` },
        });
      }
      const mode = body.mode === 'rule' || body.mode === 'llm' ? body.mode : 'auto';
      const r = await parseRequirement(rawText, { mode });
      const code = r.status === 'error' ? 400 : 200;
      return send(res, code, { ok: r.status !== 'error', ...r });
    }

    if (p === '/api/recommend' && m === 'POST') {
      const body = await readJson(req);
      const { normalizeConstraints } = await import('../parse/schema.js');
      const { recommendPlans } = await import('../services/recommend-service.js');

      const bodyText = String(body.text || '');
      if (bodyText.length > config.llm.maxInputChars) {
        return send(res, 400, { ok: false, error: { code: 'input_too_long', message: `需求描述最多 ${config.llm.maxInputChars} 个字符` } });
      }
      let constraints = null;
      let parseInfo = null;
      if (body.constraints && typeof body.constraints === 'object') {
        // 用户在前端编辑后的结构化约束：直接进优化器，不再调用模型
        const norm = normalizeConstraints(body.constraints, String(body.text || ''), { strictNumbers: false });
        constraints = { ...norm.constraints, parseSource: 'manual' };
        parseInfo = { source: 'manual', warnings: norm.warnings };
      } else {
        const { parseRequirement } = await import('../parse/llm-parser.js');
        const parsed = await parseRequirement(String(body.text || ''), { mode: body.mode === 'rule' ? 'rule' : 'auto' });
        if (!parsed.constraints) return send(res, 400, { ok: false, error: { code: 'parse_failed', message: parsed.error?.message || '解析失败' } });
        constraints = parsed.constraints;
        parseInfo = { source: parsed.source, status: parsed.status, degraded: parsed.degraded, warnings: parsed.warnings, llm: parsed.llm, fallbackReason: parsed.fallbackReason };
      }

      // 用餐时段：区分「用户计划用餐时段」与「本次实际查询时段」。
      // 只在明确提到时段时给一句提示，不预测未来菜单、不预约。
      const { analyzeMealTime } = await import('../parse/meal-time.js');
      parseInfo.mealTime = parseInfo.mealTime || analyzeMealTime(bodyText);

      const t0 = Date.now();
      const result = await recommendPlans(constraints, {
        // 第五阶段：原文与意图必须随请求传递，否则手动改条件后重搜会丢掉
        // 「60 元的套餐」这类预算意图（target_with_cap）与口味偏好。
        rawText: bodyText,
        intent: body.intent && typeof body.intent === 'object' ? body.intent : undefined,
        storeCode: storeOf(url),
        maxVerify: clampInt(body.maxVerify, 10, 80, 40),
        maxPriceTargets: clampInt(body.maxPriceTargets, 20, 140, 90),
        planCount: clampInt(body.planCount, 2, 4, 4),
        verifyConcurrency: clampInt(body.verifyConcurrency, 1, 8, 6),
        refreshPool: Boolean(body.refreshPool),
      });
      return send(res, 200, { ok: true, parse: parseInfo, mealTime: parseInfo.mealTime || null, ...result, elapsedMs: Date.now() - t0 });
    }

    if (p === '/api/plan/rebuild' && m === 'POST') {
      const body = await readJson(req);
      const { normalizeConstraints } = await import('../parse/schema.js');
      const { rebuildPlan } = await import('../services/recommend-service.js');
      const norm = normalizeConstraints(body.constraints || {}, '', { strictNumbers: false });
      const r = await rebuildPlan({
        storeCode: storeOf(url),
        productCode: body.productCode,
        choices: body.choices,
        components: body.components,
        constraints: norm.constraints,
        refreshPrice: Boolean(body.refreshPrice),
      });
      return send(res, r.status === 'ok' ? 200 : 502, { ok: r.status === 'ok', ...r });
    }

    if (p === '/api/compare' && m === 'POST') {
      const body = await readJson(req);
      const { comparePlans } = await import('../optimize/compare.js');
      if (!body.a || !body.b) return send(res, 400, { ok: false, error: { code: 'invalid_request', message: '需要 a 与 b 两个方案' } });
      return send(res, 200, { ok: true, ...comparePlans(body.a, body.b) });
    }

    if (p === '/api/optimize/pool' && m === 'GET') {
      const { buildPool } = await import('../services/recommend-service.js');
      const pool = await buildPool(storeOf(url), { refresh: boolOf(url, 'refresh') });
      return send(res, 200, {
        ok: true,
        storeCode: pool.storeCode,
        stats: pool.stats,
        meals: pool.meals.map((m) => ({ code: m.code, name: m.name, rounds: m.rounds.length })),
        singles: Object.fromEntries(
          Object.entries(pool.singles).map(([role, list]) => [
            role,
            list.map((p) => ({ code: p.code, name: p.name, kcal: p.nutrition.energyKcal, protein: p.nutrition.protein, container: Boolean(p.container) })),
          ]),
        ),
      });
    }

    /* ---------------- 门店：备选列表 + 切换前真实验证 ---------------- */

    if (p === '/api/stores' && m === 'GET') {
      const { listStoreOptions } = await import('../services/store-health.js');
      return send(res, 200, { ok: true, ...(await listStoreOptions()) });
    }

    if (p === '/api/stores/verify' && m === 'POST') {
      const body = await readJson(req);
      const code = String(body.storeCode || '').trim();
      if (!code) {
        return send(res, 400, { ok: false, error: { code: 'invalid_request', message: 'storeCode 必填' } });
      }
      // 备选门店必须真实 query-meals 验证通过才允许切换（不拿搜索结果冒充可用门店）
      const { verifyStoreUsable } = await import('../services/store-health.js');
      const r = await verifyStoreUsable(code);
      if (!r.usable) {
        const d = r.diagnosis || {};
        return send(res, 503, {
          ok: false,
          storeCode: code,
          error: {
            code: 'menu_unavailable',
            category: d.category || 'business',
            message: d.userMessage || '这家门店暂时无法获取菜单。',
            reason: d.reason || '先不切换，换一家门店试试。',
            actions: d.actions || ['switch_store'],
            diagnosis: d.diagnostics || null,
          },
        });
      }
      return send(res, 200, { ok: true, storeCode: code, usable: true, categories: r.categories ?? 0, meta: r.meta });
    }

    return send(res, 404, { ok: false, error: { code: 'not_found', message: `未定义的接口 ${p}` } });
  } catch (err) {
    return failMenuAware(res, err, storeOf(url));
  }
}
