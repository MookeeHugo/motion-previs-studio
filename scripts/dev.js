import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { resolve } from 'node:path';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 5173;
const OUTPUT_DIR = resolve('output');
function npxCommand(args) {
  return process.platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npx', ...args] }
    : { command: 'npx', args };
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function canBind(port) {
  return new Promise((resolvePort) => {
    const server = http.createServer();
    server.once('error', () => resolvePort(false));
    server.once('listening', () => {
      server.close(() => resolvePort(true));
    });
    server.listen(port, HOST);
  });
}

async function findPort(startPort) {
  for (let port = startPort; port < startPort + 80; port += 1) {
    if (await canBind(port)) return port;
  }
  throw new Error(`找不到可用前端端口，起始端口：${startPort}`);
}

async function main() {
  const requested = Number(argValue('--port') || process.env.MPS_DEV_PORT || DEFAULT_PORT);
  const port = await findPort(Number.isFinite(requested) ? requested : DEFAULT_PORT);
  const url = `http://${HOST}:${port}`;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(
    resolve(OUTPUT_DIR, 'dev-server.json'),
    JSON.stringify({ app: 'motion-previs-studio', url, port, startedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );

  if (port !== DEFAULT_PORT) {
    console.log(`5173 已被占用，Motion Previs Studio 改用 ${url}`);
  } else {
    console.log(`Motion Previs Studio 前端运行在 ${url}`);
  }

  const vite = npxCommand(['vite', '--host', HOST, '--port', String(port), '--strictPort']);
  const child = spawn(vite.command, vite.args, {
    cwd: resolve('.'),
    env: { ...process.env, MPS_DEV_PORT: String(port) },
    stdio: 'inherit'
  });

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
