import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve('.');
const DIST_INDEX = resolve(ROOT, 'dist', 'index.html');
const SOURCE_DIRS = ['src', 'public'];
const SOURCE_FILES = ['index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts'];

function newestMtimeMs(target) {
  if (!existsSync(target)) return 0;
  const stat = statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    newest = Math.max(newest, newestMtimeMs(join(target, entry.name)));
  }
  return newest;
}

function shouldBuild() {
  if (process.env.MPS_FORCE_BUILD === '1') return 'MPS_FORCE_BUILD=1';
  if (!existsSync(DIST_INDEX)) return 'dist/index.html 不存在';
  const distTime = statSync(DIST_INDEX).mtimeMs;
  const newestSource = Math.max(
    ...SOURCE_DIRS.map((dir) => newestMtimeMs(resolve(ROOT, dir))),
    ...SOURCE_FILES.map((file) => newestMtimeMs(resolve(ROOT, file)))
  );
  return newestSource > distTime ? '源码或 public 资产新于 dist' : '';
}

const reason = shouldBuild();
if (!reason) {
  console.log('[build-if-needed] dist 已是最新，跳过重复 npm run build。');
  process.exit(0);
}

console.log(`[build-if-needed] ${reason}，执行 npm run build。`);
const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', 'run', 'build'] : ['run', 'build'];
const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
if (result.error) {
  console.error(`[build-if-needed] 启动构建失败：${result.error.message}`);
}
process.exit(result.status ?? 1);
