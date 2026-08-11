import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const HOST = '127.0.0.1';
const DEBUG_START_PORT = Number(process.env.MPS_TAURI_SMOKE_DEBUG_PORT || 9447);
const EXE_PATH = resolve(process.env.MPS_TAURI_SMOKE_EXE || 'src-tauri/target/release/motion-previs-studio.exe');
const OUTPUT_DIR = resolve('output', 'tauri-smoke');
const PROFILE_DIR = join(tmpdir(), `motion-previs-studio-tauri-smoke-${process.pid}-${Date.now()}`);

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
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
  throw new Error(`找不到可用 CDP 端口，起始端口：${startPort}`);
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
  const deadline = Date.now() + 20000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await requestJson(port, '/json/version');
    } catch (error) {
      lastError = error;
      await sleep(300);
    }
  }
  throw lastError || new Error('Tauri WebView2 CDP 未启动');
}

async function waitForPageTarget(port) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const targets = await requestJson(port, '/json/list');
    const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    if (page) return page;
    await sleep(300);
  }
  throw new Error('没有找到可调试的 Tauri 页面');
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

async function evaluateRetry(ws, expression, attempts = 8) {
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

async function waitForAppReady(ws) {
  const ready = await evaluateRetry(ws, `(async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const text = document.body?.innerText || '';
      if (text.includes('加载雨夜灯塔示例') || text.includes('中文动作预演')) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  })()`);
  if (!ready) throw new Error('Tauri 窗口未渲染到中文主界面');
}

function assertFile(file, minBytes = 20) {
  if (!file || !existsSync(file) || statSync(file).size < minBytes) {
    throw new Error(`导出文件缺失或为空：${file || '<empty>'}`);
  }
}

async function main() {
  if (!existsSync(EXE_PATH)) {
    throw new Error(`找不到 release exe：${EXE_PATH}。请先运行 npm run tauri:build。`);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  mkdirSync(PROFILE_DIR, { recursive: true });
  const debugPort = await findPort(DEBUG_START_PORT);
  const child = spawn(EXE_PATH, [], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
      WEBVIEW2_USER_DATA_FOLDER: PROFILE_DIR
    },
    stdio: 'ignore'
  });
  let childExit = null;
  child.once('exit', (code, signal) => {
    childExit = { code, signal };
  });

  try {
    await waitForCdp(debugPort);
    if (childExit) throw new Error(`release exe 提前退出：${JSON.stringify(childExit)}`);
    const page = await waitForPageTarget(debugPort);
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
    await waitForAppReady(ws);

    const state = await evaluateRetry(ws, `(async () => {
      const clickByText = (needle) => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const button = buttons.find((item) => item.innerText.includes(needle) || item.getAttribute('aria-label')?.includes(needle));
        if (!button) throw new Error('找不到按钮：' + needle + '；页面文本：' + document.body.innerText.slice(0, 1200));
        button.click();
      };
      clickByText('加载雨夜灯塔示例');
      await new Promise((resolve) => setTimeout(resolve, 900));
      clickByText('导出动作预演包');
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        if (document.body.innerText.includes('动作预演包已生成')) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      const bundle = await window.__mps?.listBundle?.();
      const controlState = window.__mps?.getState?.();
      const text = document.body.innerText;
      return {
        title: document.title,
        hasChineseChrome: text.includes('中文动作预演') && text.includes('动作段落与关键帧'),
        hasExportSuccess: text.includes('动作预演包已生成'),
        keyframeRows: document.querySelectorAll('.keyframe-row').length,
        shotCards: document.querySelectorAll('.shot-beat-card').length,
        actionNodes: document.querySelectorAll('.action-node-pill').length,
        bundlePath: bundle?.bundlePath || controlState?.lastBundlePath || '',
        bundleFiles: bundle?.files || [],
        qualityScore: controlState?.analysis?.qualityScore || 0,
        processVisibleText: text.slice(0, 1200),
        runtimeErrorText: text.includes('ReferenceError') || text.includes('TypeError')
      };
    })()`);

    const screenshot = await send(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const screenshotPath = join(OUTPUT_DIR, 'motion-previs-tauri-smoke.png');
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    ws.close();

    const expectedFiles = {
      manifest: join(state.bundlePath, 'bundle_manifest.json'),
      blueprint: join(state.bundlePath, 'motion_blueprint.json'),
      shotBible: join(state.bundlePath, 'shot_bible.json'),
      pose: join(state.bundlePath, 'pose_landmarks.json'),
      camera: join(state.bundlePath, 'camera_motion.json'),
      readme: join(state.bundlePath, 'README_动作预演包.md')
    };
    for (const file of Object.values(expectedFiles)) assertFile(file);
    const manifest = JSON.parse(readFileSync(expectedFiles.manifest, 'utf8'));
    const blueprint = JSON.parse(readFileSync(expectedFiles.blueprint, 'utf8'));
    const shotBible = JSON.parse(readFileSync(expectedFiles.shotBible, 'utf8'));
    const pose = JSON.parse(readFileSync(expectedFiles.pose, 'utf8'));
    const camera = JSON.parse(readFileSync(expectedFiles.camera, 'utf8'));
    const readme = readFileSync(expectedFiles.readme, 'utf8');

    const failures = [];
    if (!state.hasChineseChrome) failures.push('Tauri 中文主界面缺失');
    if (!state.hasExportSuccess) failures.push('Tauri demo 未完成导出');
    if (state.keyframeRows < 8) failures.push('关键帧数量不足');
    if (state.shotCards < 4) failures.push('镜头段落数量不足');
    if (state.actionNodes < 7) failures.push('动作节点数量不足');
    if (!state.bundlePath || !existsSync(state.bundlePath)) failures.push('导出目录不存在');
    if (!manifest.localFirst || manifest.cloudUpload !== false) failures.push('导出清单未保留本地优先标记');
    if (!blueprint.projectTitle?.includes('雨夜灯塔')) failures.push('导出蓝图不是中文雨夜灯塔 demo');
    if ((blueprint.keyframes?.length || 0) < 8) failures.push('导出蓝图关键帧不足');
    if ((blueprint.shots?.length || 0) < 4) failures.push('导出蓝图镜头段落不足');
    if ((blueprint.actionNodes?.length || 0) < 7) failures.push('导出蓝图动作节点不足');
    if ((pose.frames?.length || 0) < 180) failures.push('导出姿态帧不足');
    if ((camera.frames?.length || 0) < 180) failures.push('导出摄影机关键帧不足');
    if (!readme.includes('本地 Tauri 版生成') || !readme.includes('不会上传云端')) failures.push('导出说明缺少本地优先文案');
    if (!Array.isArray(shotBible.shotBible) || !shotBible.shotBible.length) failures.push('镜头规划 JSON 缺少 shotBible');
    if (childExit) failures.push(`release exe 提前退出：${JSON.stringify(childExit)}`);
    if (state.runtimeErrorText) failures.push('页面出现运行时错误文本');

    const report = {
      ...state,
      screenshotPath,
      expectedFiles,
      manifestTitle: manifest.title,
      localFirst: manifest.localFirst,
      cloudUpload: manifest.cloudUpload,
      exportedKeyframes: blueprint.keyframes?.length || 0,
      exportedShots: blueprint.shots?.length || 0,
      exportedActionNodes: blueprint.actionNodes?.length || 0,
      exportedPoseFrames: pose.frames?.length || 0,
      exportedCameraFrames: camera.frames?.length || 0,
      exeStillRunningBeforeCleanup: !child.killed && !childExit
    };
    writeFileSync(join(OUTPUT_DIR, 'motion-previs-tauri-smoke-result.json'), JSON.stringify(report, null, 2));
    process.stderr.write(
      `[tauri-smoke] 通过：导出目录 ${state.bundlePath}；关键帧 ${state.keyframeRows}；截图 ${screenshotPath}\n`
    );
    if (failures.length) {
      throw new Error(`Tauri smoke 验证失败：${failures.join('；')}`);
    }
  } finally {
    killTree(child);
    await sleep(500);
    try {
      rmSync(PROFILE_DIR, { recursive: true, force: true });
    } catch {
      // WebView2 may keep the profile locked briefly; best effort only.
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
