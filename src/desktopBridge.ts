import type {
  AnalysisManifest,
  AppInfo,
  ExportResult,
  MediaInfo,
  ProjectSession,
  SavedSession
} from './types';
import { DEMO_SOURCE_PATH } from './demo';

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type TauriCore = {
  invoke: Invoke;
  convertFileSrc: (filePath: string, protocol?: string) => string;
  isTauri: () => boolean;
};

const mediaUrls = new Map<string, string>();
let corePromise: Promise<TauriCore | null> | null = null;

async function resolveCore(): Promise<TauriCore | null> {
  if (!corePromise) {
    corePromise = (async () => {
      try {
        const core = (await import('@tauri-apps/api/core')) as TauriCore;
        if (!core.isTauri()) return null;
        await core.invoke('get_app_data_dir');
        return core;
      } catch {
        return null;
      }
    })();
  }
  return corePromise;
}

async function call<T>(command: string, args?: Record<string, unknown>, fallback?: T): Promise<T> {
  const core = await resolveCore();
  if (!core) {
    if (fallback !== undefined) return fallback;
    throw new Error('当前处于浏览器预览模式，桌面文件能力不可用。');
  }
  return (await core.invoke(command, args)) as T;
}

function platform(): AppInfo['platform'] {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('mac os') || ua.includes('macintosh')) return 'darwin';
  if (ua.includes('windows')) return 'win32';
  return 'linux';
}

function filenameFromPath(value: string): string {
  try {
    if (/^https?:\/\//i.test(value)) {
      const parsed = new URL(value);
      return decodeURIComponent(parsed.pathname.split('/').pop() || parsed.hostname || '网络视频');
    }
  } catch {
    // Fall through to path parsing.
  }
  return value.split(/[\\/]/).pop() || value || '未命名素材';
}

function extensionOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() || '';
}

function videoMime(name: string): string {
  const ext = extensionOf(name);
  if (ext === 'mov') return 'video/quicktime';
  if (ext === 'webm') return 'video/webm';
  if (ext === 'mkv') return 'video/x-matroska';
  return 'video/mp4';
}

async function fileUrl(pathOrUrl: string): Promise<string> {
  if (/^(https?:|blob:|data:|demo:)/i.test(pathOrUrl)) return pathOrUrl;
  const core = await resolveCore();
  if (core) return core.convertFileSrc(pathOrUrl);
  return pathOrUrl;
}

async function probeVideo(url: string, fallbackName: string): Promise<Pick<MediaInfo, 'duration' | 'width' | 'height' | 'frameRate' | 'videoCodec' | 'audioCodec' | 'sizeBytes'>> {
  if (!url || url.startsWith('demo:')) {
    return { duration: 8, width: 1280, height: 720, frameRate: 24, videoCodec: 'demo', audioCodec: null, sizeBytes: 0 };
  }

  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('metadata timeout')), 4500);
      video.onloadedmetadata = () => {
        window.clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('metadata failed'));
      };
      video.load();
    });
    return {
      duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 8,
      width: video.videoWidth || 1280,
      height: video.videoHeight || 720,
      frameRate: 24,
      videoCodec: videoMime(fallbackName),
      audioCodec: null,
      sizeBytes: 0
    };
  } catch {
    return { duration: 8, width: 1280, height: 720, frameRate: 24, videoCodec: videoMime(fallbackName), audioCodec: null, sizeBytes: 0 };
  } finally {
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}

async function browserPickVideo(): Promise<MediaInfo | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.mkv,.webm';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const url = URL.createObjectURL(file);
      const media = await mediaFromPath(`browser://${file.name}`, url, file.name);
      resolve({ ...media, sizeBytes: file.size, videoCodec: file.type || videoMime(file.name) });
    };
    input.click();
  });
}

async function mediaFromPath(pathOrUrl: string, knownUrl?: string, knownName?: string): Promise<MediaInfo> {
  const name = knownName || filenameFromPath(pathOrUrl);
  const url = knownUrl || (await fileUrl(pathOrUrl));
  const metadata = await probeVideo(url, name);
  mediaUrls.set(pathOrUrl, url);
  return {
    filePath: pathOrUrl,
    url,
    name,
    ...metadata
  };
}

function browserSession(): SavedSession | null {
  try {
    return JSON.parse(localStorage.getItem('motion-previs.session.v2') || 'null') as SavedSession | null;
  } catch {
    return null;
  }
}

async function enrichSession(session: SavedSession | null): Promise<SavedSession | null> {
  if (!session) return null;
  if (session.sourcePath === DEMO_SOURCE_PATH) {
    return { ...session, sourceExists: true, sourceUrl: '' };
  }
  if (session.sourcePath && session.sourceExists !== false) {
    return { ...session, sourceUrl: await fileUrl(session.sourcePath) };
  }
  return session;
}

function fallbackBundle(payload: Record<string, unknown>): ExportResult {
  const outputDir = `browser://motion-previs/output/${Date.now().toString(36)}`;
  localStorage.setItem('motion-previs.lastBundle.v1', JSON.stringify({ ...payload, outputDir }));
  return {
    outputDir,
    zipPath: outputDir,
    manifestPath: `${outputDir}/bundle_manifest.json`,
    files: {
      manifest: `${outputDir}/bundle_manifest.json`,
      shotBible: `${outputDir}/shot_bible.json`,
      motionBlueprint: `${outputDir}/motion_blueprint.json`,
      poseData: `${outputDir}/pose_landmarks.json`,
      cameraMotion: `${outputDir}/camera_motion.json`,
      reference: null,
      depth: null,
      poseMp4: null,
      openPosePose: null,
      aiDepthMp4: null
    }
  };
}

async function openLocalPath(targetPath: string): Promise<string> {
  // Local reveal is intentionally best-effort in the Tauri migration branch.
  // Keeping it renderer-only avoids granting broad shell-open permissions.
  return targetPath;
}

async function revealLocalPath(targetPath: string): Promise<void> {
  await openLocalPath(targetPath);
}

async function savePlanningBundle(payload: Record<string, unknown>): Promise<ExportResult> {
  const core = await resolveCore();
  if (!core) return fallbackBundle(payload);
  return (await core.invoke('save_planning_bundle', { payload })) as ExportResult;
}

const api: Partial<NonNullable<Window['motionPrevis']>> = {
  async openMedia() {
    const core = await resolveCore();
    if (!core) return browserPickVideo();
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      title: '选择动作参考视频',
      multiple: false,
      filters: [{ name: '视频素材', extensions: ['mp4', 'mov', 'mkv', 'webm'] }],
      fileAccessMode: 'scoped'
    });
    return typeof selected === 'string' ? mediaFromPath(selected) : null;
  },

  importPath(sourcePath: string) {
    return mediaFromPath(sourcePath);
  },

  importUrl(url: string) {
    if (!/^https?:\/\//i.test(url)) throw new Error('请输入 http 或 https 开头的视频链接。');
    return mediaFromPath(url, url);
  },

  async prepareAnalysis(payload: { sourcePath: string; start: number; end: number; sampleFps: number }) {
    const url = mediaUrls.get(payload.sourcePath) || (await fileUrl(payload.sourcePath));
    const name = filenameFromPath(payload.sourcePath);
    const metadata = await probeVideo(url, name);
    const duration = Math.max(0.1, payload.end - payload.start);
    const analysis: AnalysisManifest = {
      analysisId: `local-${Date.now().toString(36)}`,
      createdAt: new Date().toISOString(),
      sourcePath: payload.sourcePath,
      sourceName: name,
      range: { start: payload.start, end: payload.end, duration },
      sampleFps: payload.sampleFps,
      outputDir: `local://analysis/${Date.now().toString(36)}`,
      referencePath: payload.sourcePath,
      referenceUrl: url,
      depthPath: '',
      depthUrl: '',
      edgesPath: '',
      edgesUrl: '',
      lineartPath: '',
      lineartUrl: '',
      motionMaskPath: '',
      motionMaskUrl: '',
      normalsPath: '',
      normalsUrl: '',
      animaticPath: '',
      animaticUrl: '',
      contactSheetPath: '',
      contactSheetUrl: '',
      previewPath: payload.sourcePath,
      previewUrl: '',
      frameSize: { width: metadata.width, height: metadata.height },
      status: 'ready'
    };
    return analysis;
  },

  async savePoseArtifacts(payload: Record<string, unknown>): Promise<ExportResult> {
    return savePlanningBundle(payload);
  },

  savePlanningBundle,

  cancelAnalysis() {
    return Promise.resolve({ cancelled: 1 });
  },

  openPath: openLocalPath,
  revealPath: revealLocalPath,

  async openExternal(url: string) {
    if (!/^https:\/\//i.test(url)) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  },

  async getVersions() {
    const info = await call<{ name: string; version: string }>('get_version', undefined, {
      name: 'Motion Previs Studio',
      version: __MPS_APP_VERSION__
    });
    const dataDir = await call<string>('get_app_data_dir', undefined, '浏览器本地存储');
    return { app: info.version, electron: 'Tauri / Browser', workspace: dataDir };
  },

  async getAppInfo(): Promise<AppInfo> {
    const info = await call<{ name: string; version: string }>('get_version', undefined, {
      name: 'Motion Previs Studio',
      version: __MPS_APP_VERSION__
    });
    return {
      platform: platform(),
      appId: 'studio.motionprevis.app',
      displayName: `${info.name} · 中文动作预演`,
      version: info.version,
      isCommunityBuild: true,
      maintainer: 'Gumbii Digital'
    };
  },

  async saveSession(session: ProjectSession) {
    const payload = { ...session };
    const core = await resolveCore();
    if (!core) {
      const saved = { ...payload, version: __MPS_APP_VERSION__, savedAt: new Date().toISOString() };
      localStorage.setItem('motion-previs.session.v2', JSON.stringify(saved));
      return { saved: true, path: 'browser://motion-previs/session' };
    }
    return (await core.invoke('save_session', { session: payload })) as { saved: boolean; path: string };
  },

  async loadSession() {
    const session = await call<SavedSession | null>('load_session', undefined, browserSession());
    return enrichSession(session);
  },

  sendToBlockout() {
    throw new Error('当前 Tauri 版未启动 Blockout 交接服务；请先导出动作预演包，再在 Blockout 中导入参考。');
  },

  blockoutStatus() {
    return Promise.resolve({ available: false });
  },

  onControlInvoke() {
    return () => undefined;
  },

  controlResult() {}
} satisfies Partial<NonNullable<Window['motionPrevis']>>;

window.motionPrevis = api as NonNullable<Window['motionPrevis']>;

void resolveCore().then((core) => {
  console.info(core ? 'Motion Previs Studio：Tauri 桌面模式' : 'Motion Previs Studio：浏览器本地模式');
});
