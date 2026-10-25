/**
 * 安全审计：扫描交付目录里是否混入了 Token / API Key / 账户敏感信息。
 * 用法: node scripts/security-audit.mjs
 * 退出码: 0=干净, 1=发现问题
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', '.shots', '.publication-local']);
const TEXT_EXT = /\.(js|mjs|cjs|json|md|html|css|txt|yml|yaml|env|example|sh|ps1)$/i;

function readKeys() {
  const keys = new Set();
  const add = (v) => {
    if (typeof v === 'string' && v.trim().length >= 8) keys.add(v.trim());
  };
  // MCP Token
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.workbuddy', 'mcp.json'), 'utf8'));
    const auth = cfg?.mcpServers?.['mcd-mcp']?.headers?.Authorization || '';
    const m = /Bearer\s+(.+)/i.exec(auth);
    if (m) add(m[1]);
  } catch {}
  if (process.env.MCD_MCP_TOKEN) add(process.env.MCD_MCP_TOKEN);
  // LLM keys
  try {
    const list = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.workbuddy', 'models.json'), 'utf8'));
    for (const item of list) add(item?.apiKey);
  } catch {}
  if (process.env.MCFIT_LLM_API_KEY) add(process.env.MCFIT_LLM_API_KEY);
  return [...keys];
}

const secrets = readKeys();
const findings = [];
let scanned = 0;
const skipped = [];

function scanFile(file) {
  const rel = path.relative(ROOT, file);
  if (!TEXT_EXT.test(file) && !/^\.[a-z]+$/i.test(path.basename(file))) return;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  scanned += 1;
  for (const s of secrets) {
    if (s && text.includes(s)) findings.push({ file: rel, kind: 'literal_secret' });
  }
  const patterns = [
    { re: /Bearer\s+[A-Za-z0-9._-]{12,}/g, kind: 'bearer_token' },
    { re: /sk-[A-Za-z0-9._-]{20,}/g, kind: 'openai_key' },
    { re: /tp-[a-z0-9]{20,}/g, kind: 'gateway_key' },
    { re: /"apiKey"\s*:\s*"[^"]{12,}"/g, kind: 'apikey_field' },
  ];
  for (const p of patterns) {
    const m = text.match(p.re);
    if (m) findings.push({ file: rel, kind: p.kind });
  }
}

(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) {
        skipped.push(path.relative(ROOT, full));
        continue;
      }
      walk(full);
    } else {
      scanFile(full);
    }
  }
})(ROOT);

// 交付前必须被忽略的目录
const gitignore = fs.existsSync(path.join(ROOT, '.gitignore')) ? fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8') : '';
const ignoreOk = ['cache', '.shots', '.env'].every((k) => gitignore.includes(k));

console.log('='.repeat(64));
console.log('麦门营养决策官 · 交付安全审计');
console.log('='.repeat(64));
console.log(`扫描文本文件: ${scanned} 个`);
console.log(`跳过目录: ${skipped.join(', ') || '无'}`);
console.log(`已登记密钥 ${secrets.length} 条（仅用于比对，不打印）`);
console.log(`.gitignore 覆盖 cache/.shots/.env: ${ignoreOk ? '是' : '否'}`);
console.log('-'.repeat(64));
if (findings.length) {
  console.log(`发现问题 ${findings.length} 处：`);
  for (const f of findings) console.log(`  ✗ ${f.file} → ${f.kind}`);
} else {
  console.log('未在源码/文档/配置中发现 Token、API Key 或账户敏感信息。');
}
console.log('-'.repeat(64));
console.log('说明：cache/ 中的核价缓存含 traceId 与价格，不含凭证；已在 .gitignore 中排除。');
process.exitCode = findings.length || !ignoreOk ? 1 : 0;
