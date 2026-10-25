/**
 * HTTP 服务入口：静态验证台 + JSON API。
 * 启动: node src/http/server.js   （默认 http://localhost:5173）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_DIR, config, tokenStatus } from '../config.js';
import { handleApi } from './routes.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    await handleApi(req, res, url);
    return;
  }
  serveStatic(req, res, url);
});

server.listen(config.port, () => {
  const t = tokenStatus();
  console.log('─'.repeat(60));
  console.log('麦门营养决策官 · McFit Agent');
  console.log(`  产品页   http://localhost:${config.port}/`);
  console.log(`  工程台   http://localhost:${config.port}/console.html`);
  console.log(`  API      http://localhost:${config.port}/api/health`);
  console.log(`  门店     ${config.store.defaultStoreCode} ${config.store.storeName}`);
  console.log(`  MCP      ${config.mcp.url}`);
  console.log(`  Token    ${t.configured ? `已配置（${t.source}）` : '未配置 ⚠️'}`);
  if (process.env.NODE_ENV === 'production' && !t.configured) {
    console.warn('[prod] 未配置 MCD_MCP_TOKEN：生产环境不会读取开发者本机 ~/.workbuddy/mcp.json');
  }
  console.log('─'.repeat(60));

  // 后台预热优化池 + 参考价，避免第一个用户请求承担全部冷启动成本（失败不影响服务）
  if (t.configured && process.env.MCFIT_PREWARM !== '0') {
    const warm = async () => {
      const m = await import('../services/recommend-service.js');
      const pool = await m.buildPool(config.store.defaultStoreCode);
      const singles = Object.values(pool.singles).reduce((a, b) => a + b.length, 0);
      const w = await m.warmPrices(config.store.defaultStoreCode);
      console.log(`[prewarm] 池：套餐 ${pool.meals.length} / 单品 ${singles} / 缺营养排除 ${pool.stats.nutritionUnknownExcluded}；参考价 ${w.priced}/${w.targets}（${w.ms}ms）`);
    };
    warm().catch((err) => console.warn('[prewarm] 跳过（不影响服务）：', err.message));
    // 价格缓存 TTL 5 分钟，这里每 4 分钟续一次，保证演示期间不会因缓存过期突然变慢
    setInterval(() => {
      import('../services/recommend-service.js')
        .then((m) => m.warmPrices(config.store.defaultStoreCode, { refresh: true }))
        .catch(() => {});
    }, 4 * 60 * 1000).unref();
  }
});
