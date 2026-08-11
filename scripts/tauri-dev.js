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

function canBind(port) {
  return new Promise((resolvePort) => {
    const server = http.createServer();
    server.once('error', () => resolvePort(false));
    server.once('listening', () => server.close(() => resolvePort(true)));
    server.listen(port, HOST);
  });
}

function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait, rejectWait) => {
    const tick = () => {
      http
        .get(url, (res) => {
          res.resume();
          resolveWait();
        })
        .on('error', (error) => {
          if (Date.now() > deadline) {
            rejectWait(error);
            return;
          }
          setTimeout(tick, 300);
        });
    };
    tick();
  });
}

async function findPort(startPort) {
  for (let port = startPort; port < startPort + 80; port += 1) {
    if (await canBind(port)) return port;
  }
  throw new Error(`找不到可用 Tauri devUrl 端口，起始端口：${startPort}`);
}

async function main() {
  const requested = Number(process.env.MPS_DEV_PORT || DEFAULT_PORT);
  const port = await findPort(Number.isFinite(requested) ? requested : DEFAULT_PORT);
  const url = `http://${HOST}:${port}`;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const configPath = resolve(OUTPUT_DIR, 'tauri-dev-config.json');
  writeFileSync(
    configPath,
    JSON.stringify({ build: { beforeDevCommand: '', devUrl: url } }, null, 2),
    'utf8'
  );
  writeFileSync(
    resolve(OUTPUT_DIR, 'dev-server.json'),
    JSON.stringify({ app: 'motion-previs-studio', url, port, startedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );

  const viteCommand = npxCommand(['vite', '--host', HOST, '--port', String(port), '--strictPort']);
  const vite = spawn(viteCommand.command, viteCommand.args, {
    cwd: resolve('.'),
    env: { ...process.env, MPS_DEV_PORT: String(port) },
    stdio: 'inherit'
  });

  const stopVite = () => {
    if (!vite.killed) vite.kill();
  };

  try {
    await waitForHttp(url);
    console.log(`Tauri devUrl 使用 ${url}`);
    const tauriCommand = npxCommand(['tauri', 'dev', '--config', configPath]);
    const tauri = spawn(tauriCommand.command, tauriCommand.args, {
      cwd: resolve('.'),
      env: process.env,
      stdio: 'inherit'
    });
    tauri.on('exit', (code) => {
      stopVite();
      process.exit(code ?? 0);
    });
  } catch (error) {
    stopVite();
    throw error;
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
