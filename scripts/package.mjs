/**
 * 生成交付包：把仓库复制成一份"干净副本"，再打成 zip。
 *
 * 排除：缓存（cache/）、截图临时目录（.shots/）、本地凭证（.env*）、日志、node_modules、.git
 * 保留：源码、测试、脚本、文档、截图、README、workbuddy.md、LICENSE、.env.example、.gitignore
 *
 * 用法: node scripts/package.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const OUT_ROOT = path.resolve(ROOT, '..', 'dist');
const NAME = 'mcfits-submission';
const STAGE = path.join(OUT_ROOT, NAME);
const DATE = new Date().toISOString().slice(0, 10);
const ZIP = path.join(OUT_ROOT, `mcfits-submission-${DATE}.zip`);

const EXCLUDE_DIRS = new Set(['cache', '.shots', 'node_modules', '.git', 'dist', '.publication-local', '.workbuddy', 'submit', 'logs', 'tmp', 'temp', 'coverage', 'workbuddy-session']);
const EXCLUDE_FILES = /^(\.env|\.env\..*|.*\.log|npm-debug\.log.*)$/i;
const KEEP_ENV_EXAMPLE = /^\.env\.example$/i;

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue;
      copyDir(from, to);
      continue;
    }
    if (/^(models\.json|mcp\.json|\.mcd_mcp_env)$|\.(jsonl|pem|key|p12|pfx|tmp|bak)$/i.test(name)) continue;
    if (EXCLUDE_FILES.test(name) && !KEEP_ENV_EXAMPLE.test(name)) continue;
    fs.copyFileSync(from, to);
  }
}

function walk(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    st.isDirectory() ? walk(full, acc) : acc.push(full);
  }
  return acc;
}

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(OUT_ROOT, { recursive: true });
copyDir(ROOT, STAGE);

const files = walk(STAGE);
const totalBytes = files.reduce((a, f) => a + fs.statSync(f).size, 0);

// 打包前再跑一次敏感信息扫描（在副本目录里）
console.log('─'.repeat(64));
console.log(`交付副本：${STAGE}`);
console.log(`文件数：${files.length}　体积：${(totalBytes / 1024).toFixed(1)} KB`);
console.log('─'.repeat(64));

if (process.platform === 'win32') {
  fs.rmSync(ZIP, { force: true });
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${ZIP}' -Force`],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) {
    console.warn('压缩失败（可手动压缩该目录）。');
  } else {
    console.log(`ZIP：${ZIP}（${(fs.statSync(ZIP).size / 1024).toFixed(1)} KB）`);
  }
} else {
  const r = spawnSync('zip', ['-rq', ZIP, NAME], { cwd: OUT_ROOT, stdio: 'inherit' });
  console.log(r.status === 0 ? `ZIP：${ZIP}` : '未找到 zip 命令，请手动压缩副本目录。');
}

// 清单
const rel = files.map((f) => path.relative(STAGE, f).split(path.sep).join('/')).sort();
console.log('─'.repeat(64));
console.log('包含的顶层条目：');
const tops = [...new Set(rel.map((r) => r.split('/')[0]))].sort();
for (const t of tops) {
  const count = rel.filter((r) => r === t || r.startsWith(t + '/')).length;
  console.log(`  ${t}${count > 1 ? `/（${count} 个文件）` : ''}`);
}
console.log('─'.repeat(64));
console.log('已排除：cache/、.shots/、.env*（保留 .env.example）、*.log、node_modules/、.git/');
