/**
 * 文件级缓存（带 TTL 与溯源信息）。
 *
 * 为什么不用 Redis/SQLite：第一阶段的约束是「不做复杂数据库」，且需要缓存能被人肉检查。
 * 落盘为 cache/<key>.json，结构 { key, storedAt, ttlMs, source, value }。
 *
 * 缓存分级（见 config.ttl）：
 * - 菜单 / 商品详情 / 营养表：静态性或低频变化，可长 TTL
 * - 价格：短 TTL，且必须带 checkedAt；过期后不自动当成实时价，而是返回 stale 标记并重算
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CACHE_DIR } from '../config.js';

function keyToFile(key) {
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
  return path.join(CACHE_DIR, `${safe}.${hash}.json`);
}

export class FileCache {
  constructor(dir = CACHE_DIR) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.mem = new Map();
  }

  /** @returns {{value:any, storedAt:number, ttlMs:number, source:string, fresh:boolean}|null} */
  get(key) {
    if (this.mem.has(key)) {
      const hit = this.mem.get(key);
      return { ...hit, fresh: Date.now() - hit.storedAt <= hit.ttlMs };
    }
    const file = keyToFile(key);
    if (!fs.existsSync(file)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.mem.set(key, raw);
      return { ...raw, fresh: Date.now() - raw.storedAt <= raw.ttlMs };
    } catch {
      return null;
    }
  }

  set(key, value, ttlMs, source = 'mcp') {
    const entry = { key, storedAt: Date.now(), ttlMs, source, value };
    this.mem.set(key, entry);
    try {
      fs.writeFileSync(keyToFile(key), JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[cache] 写入失败', key, err.message);
    }
    return entry;
  }

  /** 读取缓存；不存在或已过期则执行 loader 并写回 */
  async through(key, ttlMs, loader, source = 'mcp') {
    const hit = this.get(key);
    if (hit && hit.fresh) {
      return { value: hit.value, meta: { cache: 'hit', storedAt: hit.storedAt, ttlMs, source: hit.source } };
    }
    const value = await loader();
    const entry = this.set(key, value, ttlMs, source);
    return { value, meta: { cache: hit ? 'refresh-expired' : 'miss', storedAt: entry.storedAt, ttlMs, source } };
  }

  invalidate(prefix) {
    for (const k of [...this.mem.keys()]) if (k.startsWith(prefix)) this.mem.delete(k);
    for (const f of fs.readdirSync(this.dir)) {
      if (f.startsWith(prefix.replace(/[^a-zA-Z0-9._-]/g, '_'))) {
        try {
          fs.unlinkSync(path.join(this.dir, f));
        } catch {
          /* ignore */
        }
      }
    }
  }
}

export const cache = new FileCache();
