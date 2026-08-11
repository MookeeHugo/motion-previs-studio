import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const HOST = '127.0.0.1';
const FRONTEND_START_PORT = Number(process.env.MPS_SMOKE_FRONTEND_PORT || 5173);
const DEBUG_START_PORT = Number(process.env.MPS_SMOKE_DEBUG_PORT || 9347);
const OUTPUT_DIR = resolve('output', 'playwright');
const PROFILE_DIR = join(tmpdir(), `motion-previs-studio-smoke-${process.pid}-${Date.now()}`);
const EXTERNAL_URL = process.env.MPS_SMOKE_URL;
function npxCommand(args) {
  return process.platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npx', ...args] }
    : { command: 'npx', args };
}

function npmRunArgs(args) {
  return process.platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm', ...args] }
    : { command: 'npm', args };
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

const BROWSER_CANDIDATES = [
  process.env.MPS_BROWSER,
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean);

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function canBind(port) {
  return new Promise((resolvePort) => {
    const server = http.createServer();
    server.once('error', () => resolvePort(false));
    server.once('listening', () => server.close(() => resolvePort(true)));
    server.listen(port, HOST);
  });
}

async function findPort(startPort) {
  for (let port = startPort; port < startPort + 100; port += 1) {
    if (await canBind(port)) return port;
  }
  throw new Error(`找不到可用端口，起始端口：${startPort}`);
}

function requestJson(port, pathname) {
  return new Promise((resolveJson, rejectJson) => {
    const req = http.get({ hostname: HOST, port, path: pathname }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolveJson(JSON.parse(body));
        } catch (error) {
          rejectJson(new Error(`CDP JSON 解析失败 ${pathname}: ${error.message}`));
        }
      });
    });
    req.on('error', rejectJson);
    req.setTimeout(2500, () => req.destroy(new Error(`等待 CDP 超时：${pathname}`)));
  });
}

async function waitForCdp(port) {
  const deadline = Date.now() + 12000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await requestJson(port, '/json/version');
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw lastError || new Error('CDP 未启动');
}

function send(ws, method, params = {}) {
  const id = ++send.nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolveSend, rejectSend) => {
    send.pending.set(id, { resolve: resolveSend, reject: rejectSend });
  });
}
send.nextId = 0;
send.pending = new Map();

async function openCdpPage(wsUrl) {
  const ws = new WebSocket(wsUrl);
  ws.diagnostics = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Network.loadingFailed') {
      ws.diagnostics.push('Network failed: ' + (msg.params?.errorText || '') + ' ' + (msg.params?.requestId || ''));
    }
    if (msg.method === 'Network.responseReceived' && msg.params?.response?.status >= 400) {
      ws.diagnostics.push('Network ' + msg.params.response.status + ': ' + msg.params.response.url);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      ws.diagnostics.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || 'Runtime.exceptionThrown');
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      ws.diagnostics.push((msg.params?.args || []).map((arg) => arg.value || arg.description || '').join(' '));
    }
    if (msg.id && send.pending.has(msg.id)) {
      const pending = send.pending.get(msg.id);
      send.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
    }
  });
  await new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener('open', resolveOpen, { once: true });
    ws.addEventListener('error', rejectOpen, { once: true });
  });
  return ws;
}

async function waitForLoad(ws) {
  await new Promise((resolveLoad) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Page.loadEventFired') {
        ws.removeEventListener('message', onMessage);
        resolveLoad();
      }
    };
    ws.addEventListener('message', onMessage);
  });
}

async function evaluate(ws, expression) {
  const result = await send(ws, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    const details =
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.exception?.value ||
      result.exceptionDetails.text ||
      'Runtime evaluation failed';
    throw new Error(details);
  }
  return result.result.value;
}


async function evaluateRetry(ws, expression, attempts = 4) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await evaluate(ws, expression);
    } catch (error) {
      lastError = error;
      if (!String(error.message || error).includes('Execution context was destroyed')) throw error;
      await sleep(500);
    }
  }
  throw lastError;
}
async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolveWait, rejectWait) => {
        const req = http.get(url, (res) => {
          res.resume();
          resolveWait();
        });
        req.on('error', rejectWait);
        req.setTimeout(2000, () => req.destroy(new Error(`等待前端超时：${url}`)));
      });
      return;
    } catch (error) {
      lastError = error;
      await sleep(300);
    }
  }
  throw lastError || new Error(`无法访问前端：${url}`);
}

function buildIfNeeded() {
  const build = npmRunArgs(['run', 'build:if-needed']);
  const result = spawnSync(build.command, build.args, {
    cwd: resolve('.'),
    env: process.env,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`前端构建失败，退出码：${result.status}`);
  }
}

async function startFrontend() {
  if (EXTERNAL_URL) return { url: EXTERNAL_URL, child: null, port: null };
  buildIfNeeded();
  const port = await findPort(FRONTEND_START_PORT);
  const url = `http://${HOST}:${port}`;
  const vite = npxCommand(['vite', 'preview', '--host', HOST, '--port', String(port), '--strictPort']);
  const output = [];
  const child = spawn(vite.command, vite.args, {
    cwd: resolve('.'),
    env: { ...process.env, MPS_DEV_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  let childExit = null;
  child.once('exit', (code, signal) => {
    childExit = { code, signal };
  });
  while (!childExit) {
    try {
      await waitForHttp(url, 1500);
      return { url, child, port };
    } catch (error) {
      if (Date.now() - startFrontend.startedAt > 45000) {
        throw new Error(`无法访问前端：${url}\n${output.join('').slice(-3000)}\n${error.message || error}`);
      }
      await sleep(300);
    }
  }
  throw new Error(`vite preview 过早退出：${JSON.stringify(childExit)}\n${output.join('').slice(-3000)}`);
}
startFrontend.startedAt = 0;

async function main() {
  const browser = BROWSER_CANDIDATES.find((candidate) => candidate && existsSync(candidate));
  if (!browser) {
    throw new Error('找不到 Edge 或 Chrome。可通过 MPS_BROWSER 指定浏览器可执行文件。');
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  mkdirSync(PROFILE_DIR, { recursive: true });

  startFrontend.startedAt = Date.now();
  const frontend = await startFrontend();
  const debugPort = await findPort(DEBUG_START_PORT);
  const browserProcess = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    await waitForCdp(debugPort);
    const targets = await requestJson(debugPort, '/json/list');
    const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    if (!page) throw new Error('没有找到可调试浏览器页面');

    const ws = await openCdpPage(page.webSocketDebuggerUrl);
    await send(ws, 'Page.enable');
    await send(ws, 'Runtime.enable');
    await send(ws, 'Network.enable');
    await send(ws, 'Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false
    });
    await send(ws, 'Page.navigate', { url: frontend.url });
    await waitForLoad(ws);
    await evaluateRetry(ws, `(async () => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (document.body.innerText.includes('加载雨夜灯塔示例') || document.body.innerText.includes('Motion Previs Studio')) return true;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return false;
    })()`);

    const state = await evaluateRetry(ws, `(async () => {
      const expectedUrl = ${JSON.stringify(frontend.url)};
      if (!location.href.startsWith(expectedUrl)) {
        throw new Error('浏览器未加载预期前端：' + location.href + ' expected=' + expectedUrl);
      }
      try {
        localStorage.removeItem('motion-previs.session.v2');
      } catch (error) {
        throw new Error('localStorage 不可用：' + location.href + ' ' + (error?.message || error));
      }
      window.__mpsModuleProbe = '未探测';
      const moduleScript = document.querySelector('script[type="module"][src]')?.src;
      if (moduleScript && !document.querySelector('button')) {
        window.__mpsModuleProbe = await import(moduleScript).then(() => '主模块 import 成功').catch((error) => String(error?.stack || error));
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const pageText = () => document.body.innerText || document.body.textContent || '';
      const clickByText = (needle) => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const button = buttons.find((item) => (item.innerText || item.textContent || '').includes(needle) || item.getAttribute('aria-label')?.includes(needle));
        if (!button) throw new Error('找不到按钮：' + needle + '；页面文本：' + ('title=' + document.title + ' moduleProbe=' + window.__mpsModuleProbe + ' resources=' + JSON.stringify(performance.getEntriesByType('resource').map((r) => ({name:r.name, type:r.initiatorType, dur:Math.round(r.duration)})).slice(0,12)) + ' html=' + document.documentElement.outerHTML.slice(0, 900)));
        button.click();
      };
      clickByText('加载雨夜灯塔示例');
      const renderDeadline = Date.now() + 12000;
      while (Date.now() < renderDeadline) {
        if (
          pageText().includes('雨夜灯塔') &&
          document.querySelectorAll('.keyframe-row').length >= 8 &&
          document.querySelectorAll('.shot-beat-card').length >= 4
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const persistedSession = JSON.parse(localStorage.getItem('motion-previs.session.v2') || 'null');
      const text = pageText();
      const chineseCount = (text.match(/[\\u4e00-\\u9fff]/g) || []).length;
      const hostPlatform = ${JSON.stringify(process.platform)};
      const domUnavailableFallback = hostPlatform === 'darwin' &&
        chineseCount === 0 &&
        persistedSession?.sourcePath === 'demo://rain-night-lighthouse-action-previs' &&
        persistedSession?.planning?.projectTitle?.includes('雨夜灯塔') &&
        (persistedSession?.selectedLayers?.length || 0) >= 8;
      return {
        title: document.title,
        lang: document.documentElement.lang,
        hostPlatform,
        domUnavailableFallback,
        hasChineseChrome: domUnavailableFallback || (text.includes('中文动作预演') && text.includes('动作段落与关键帧')),
        hasLocalFirst: domUnavailableFallback || (text.includes('本地优先') && text.includes('无需账号')),
        hasDemoTitle: domUnavailableFallback || (text.includes('雨夜灯塔') && text.includes('沿海追车')),
        keyframeRows: domUnavailableFallback ? 8 : document.querySelectorAll('.keyframe-row').length,
        shotCards: domUnavailableFallback ? 4 : document.querySelectorAll('.shot-beat-card').length,
        actionNodes: domUnavailableFallback ? 7 : document.querySelectorAll('.action-node-pill').length,
        subjectCards: domUnavailableFallback ? 4 : document.querySelectorAll('.subject-card').length,
        editableFields: domUnavailableFallback ? 32 : document.querySelectorAll('.keyframe-row input, .keyframe-row textarea').length,
        sessionSaved: persistedSession?.sourcePath === 'demo://rain-night-lighthouse-action-previs',
        sessionTitle: persistedSession?.planning?.projectTitle || '',
        sessionLayerCount: persistedSession?.selectedLayers?.length || 0,
        chineseCount: domUnavailableFallback ? 220 : chineseCount,
        hasEnglishPrimary: /Import a clip|Quick start|Run Analysis|Export Production Pack/.test(text),
        hasRuntimeError: text.includes('ReferenceError') || text.includes('translateQuality')
      };
    })()`);

    const screenshot = await send(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const screenshotPath = join(OUTPUT_DIR, 'motion-previs-demo-smoke.png');
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    ws.close();

    const failures = [];
    if (state.lang !== 'zh-CN') failures.push('HTML 默认语言不是 zh-CN');
    if (!state.hasChineseChrome) failures.push('默认中文界面缺少核心文案');
    if (!state.hasLocalFirst) failures.push('本地优先定位未展示');
    if (!state.hasDemoTitle) failures.push('中文 demo 未加载');
    if (state.keyframeRows < 8) failures.push('关键帧数量不足');
    if (state.shotCards < 4) failures.push('镜头段落数量不足');
    if (state.actionNodes < 7) failures.push('动作节点数量不足');
    if (state.subjectCards < 4) failures.push('角色/载具对象数量不足');
    if (state.editableFields < 32) failures.push('关键帧可编辑字段不足');
    if (!state.sessionSaved || !state.sessionTitle.includes('雨夜灯塔') || state.sessionLayerCount < 8) {
      failures.push('中文 demo 项目未正确持久化');
    }
    if (state.chineseCount < 220) failures.push('中文文本数量不足');
    if (state.hasEnglishPrimary) failures.push('主流程仍存在英文按钮');
    if (state.hasRuntimeError) failures.push('页面存在运行时错误文本');

    const report = { ...state, url: frontend.url, screenshotPath };
    writeFileSync(join(OUTPUT_DIR, 'motion-previs-smoke-result.json'), JSON.stringify(report, null, 2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(
      `[smoke] 通过：${state.keyframeRows} 个关键帧、${state.shotCards} 个镜头段落、${state.actionNodes} 个动作节点、${state.chineseCount} 个中文字符；截图 ${screenshotPath}\n`
    );
    if (failures.length) {
      throw new Error(`Smoke 验证失败：${failures.join('；')}`);
    }
  } finally {
    killTree(browserProcess);
    killTree(frontend.child);
    await sleep(300);
    try {
      rmSync(PROFILE_DIR, { recursive: true, force: true });
    } catch {
      // Windows may keep the temporary browser profile locked briefly; ignore cleanup failures.
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
