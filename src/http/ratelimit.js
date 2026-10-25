/**
 * 极简内存限流（按 IP + 路由桶）。
 *
 * 目的：对外演示/部署时限制滥用风险，而不是做完整的网关。
 * 说明：单进程内存实现，重启即清零；多实例部署需要换成共享存储。
 */

const buckets = new Map();

/**
 * @param {string} key
 * @param {{limit:number, windowMs:number}} opts
 * @returns {{allowed:boolean, remaining:number, retryAfterSec:number, resetAt:number}}
 */
export function take(key, { limit, windowMs }) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSec: 0, resetAt: now + windowMs };
  }
  b.count += 1;
  const allowed = b.count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - b.count),
    retryAfterSec: allowed ? 0 : Math.ceil((b.resetAt - now) / 1000),
    resetAt: b.resetAt,
  };
}

export function clientKey(req, route) {
  const ip = req.socket?.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
  return `${ip}|${route}`;
}

/** 周期性清理过期桶，避免内存无限增长 */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
}, 60 * 1000).unref();

export function snapshot() {
  return { buckets: buckets.size };
}
