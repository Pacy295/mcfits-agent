/**
 * 价格核算（calculate-price）。
 *
 * 规则：
 * - 价格只来自 MCP 返回，本地不做任何金额推断；diffPrice 仅用于「选项差异」的展示与一致性校验。
 * - 价格是短时效数据：缓存 5 分钟，响应里必须带 checkedAt 与 mcpDatetime；
 *   过期缓存不会被当成实时价，会重新调用。核价失败时状态为 failed，且绝不回填旧价格冒充当前价。
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { mcp } from '../mcp/client.js';
import { cache } from './cache.js';

export function priceCacheKey(storeCode, items) {
  const h = crypto.createHash('sha1').update(JSON.stringify(items)).digest('hex').slice(0, 12);
  return `price:${storeCode}:${h}`;
}

/**
 * @param {string} storeCode
 * @param {Array<{productCode:string, quantity:number, roundList?:Array, modification?:object}>} items
 */
export async function priceItems(storeCode, items, { refresh = false } = {}) {
  if (!Array.isArray(items) || !items.length) {
    return { status: 'failed', error: { kind: 'invalid_request', message: 'items 不能为空' } };
  }
  const normalized = items.map((it) => {
    const out = { productCode: String(it.productCode), quantity: Math.max(1, Number(it.quantity) || 1) };
    if (it.roundList?.length) {
      out.roundList = it.roundList.map((r) => ({
        round: String(r.round),
        comboItemList: (r.comboItemList || []).map((c) => {
          const ci = { code: String(c.code), quantity: Math.max(1, Number(c.quantity) || 1) };
          if (c.modification?.values?.length) ci.modification = c.modification;
          return ci;
        }),
      }));
    }
    if (it.modification?.values?.length) out.modification = it.modification;
    return out;
  });

  const key = priceCacheKey(storeCode, normalized);
  if (refresh) cache.invalidate(key);

  const hit = cache.get(key);
  if (hit && hit.fresh) {
    return { ...hit.value, cacheMeta: { cache: 'hit', storedAt: hit.storedAt, ttlMs: hit.ttlMs } };
  }

  const requestedAt = Date.now();
  try {
    const r = await mcp.callTool('calculate-price', {
      storeCode,
      orderType: config.store.orderType,
      beType: config.store.beType,
      items: normalized,
    });
    const d = r.data || {};
    const value = {
      status: 'valued',
      storeCode,
      priceFen: d.price ?? null,
      originalFen: d.originalPrice ?? null,
      productPriceFen: d.productPrice ?? null,
      productOriginalFen: d.productOriginalPrice ?? null,
      discountFen: d.discount ?? null,
      productList: d.productList || [],
      takeWayList: d.takeWayList || [],
      checkedAt: requestedAt,
      mcpDatetime: r.datetime,
      traceId: r.traceId,
      requestItems: normalized,
      currency: 'CNY',
      note: '价格由 MCP calculate-price 实算，仅试算，未生成订单',
    };
    cache.set(key, value, config.ttl.priceMs, 'mcp:calculate-price');
    return { ...value, cacheMeta: { cache: hit ? 'refresh-expired' : 'miss', ttlMs: config.ttl.priceMs } };
  } catch (err) {
    return {
      status: 'failed',
      storeCode,
      priceFen: null,
      error: { kind: err.kind || 'unknown', message: err.message, detail: err.detail || null },
      checkedAt: requestedAt,
      requestItems: normalized,
      stalePriceAvailable: Boolean(hit),
      stalePrice: hit ? { priceFen: hit.value.priceFen, checkedAt: hit.storedAt } : null,
      cacheMeta: { cache: 'bypass' },
    };
  }
}
