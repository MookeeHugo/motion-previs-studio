// Modified for cross-platform Windows support in 2026; see MODIFICATIONS.md.

import type { ProgressFn } from '../types';
import { encodeFrames } from './frameEncoder';
import { createDevicePipelineWithFallback, createRetryableAsync, probeWebGpuAdapter } from './depthBackend.mjs';

type DepthImage = {
  resize: (width: number, height: number) => Promise<{ toCanvas: () => HTMLCanvasElement }>;
};

type DepthEstimator = (input: unknown) => Promise<{ depth: DepthImage } | Array<{ depth: DepthImage }>>;
type TransformersModule = {
  RawImage: {
    fromCanvas: (canvas: HTMLCanvasElement) => unknown;
  };
  pipeline: unknown;
  env: {
    allowRemoteModels?: boolean;
    allowLocalModels?: boolean;
    useBrowserCache?: boolean;
    localModelPath?: string;
    cacheDir?: string;
    backends?: {
      onnx?: {
        wasm?: {
          wasmPaths?: string | { mjs: string; wasm: string };
        };
      };
    };
  };
};

const DEPTH_ANYTHING_REPOSITORY = 'Xenova/depth-anything-small-hf';
export const DEPTH_ANYTHING_REVISION = '2e942621ab9f2371c1df9eb223291b5ac31475e6';
const DEPTH_ANYTHING_LOCAL_FILES = [
  { path: 'config.json', minBytes: 500 },
  { path: 'preprocessor_config.json', minBytes: 200 },
  { path: 'quantize_config.json', minBytes: 500 },
  { path: 'onnx/model_quantized.onnx', minBytes: 20_000_000 }
];
let transformersModulePromise: Promise<TransformersModule> | null = null;

export async function createAiDepthVideoBlob(
  videoUrl: string,
  fps: number,
  width: number,
  height: number,
  progress?: ProgressFn,
  signal?: AbortSignal
) {
  const [transformers, estimator] = await Promise.all([loadTransformersModule(), loadDepthEstimator(progress)]);
  const { RawImage } = transformers;
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = videoUrl;

  const inputCanvas = document.createElement('canvas');
  const outputCanvas = document.createElement('canvas');

  try {
    await waitForMetadata(video);

    const maxInput = 384;
    const sourceRatio = video.videoWidth / video.videoHeight;
    inputCanvas.width = sourceRatio >= 1 ? maxInput : Math.round(maxInput * sourceRatio);
    inputCanvas.height = sourceRatio >= 1 ? Math.round(maxInput / sourceRatio) : maxInput;
    const inputCtx = inputCanvas.getContext('2d');
    if (!inputCtx) throw new Error('Could not create AI depth input canvas.');

    outputCanvas.width = width;
    outputCanvas.height = height;
    const outputCtx = outputCanvas.getContext('2d');
    if (!outputCtx) throw new Error('Could not create AI depth output canvas.');

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
    const totalFrames = Math.max(1, Math.ceil(duration * fps));

    // v4: deterministic encode — one estimator pass per frame, streamed to
    // ffmpeg as PNGs. No MediaRecorder/captureStream, so the exact frame count
    // is preserved and the output is a reproducible H.264 mp4 (Blob).
    return await encodeFrames({
      canvas: outputCanvas,
      fps,
      frameCount: totalFrames,
      signal,
      renderFrame: async (index) => {
        const time = Math.min(index / fps, Math.max(duration - 0.001, 0));
        await seekVideo(video, time);
        inputCtx.drawImage(video, 0, 0, inputCanvas.width, inputCanvas.height);
        const raw = RawImage.fromCanvas(inputCanvas);
        const outputRaw = await estimator(raw);
        const output = Array.isArray(outputRaw) ? outputRaw[0] : outputRaw;
        const depthImage = await output.depth.resize(width, height);
        const depthCanvas = depthImage.toCanvas();
        outputCtx.drawImage(depthCanvas, 0, 0, width, height);
      },
      onProgress: (fraction, index) => {
        progress?.(0.7 + fraction * 0.12, `正在渲染 AI 深度 ${index + 1}/${totalFrames}`);
      }
    });
  } finally {
    releaseVideo(video);
    inputCanvas.width = 0;
    inputCanvas.height = 0;
    outputCanvas.width = 0;
    outputCanvas.height = 0;
  }
}

/** Release a hidden <video> element's resources. */
function releaseVideo(video: HTMLVideoElement) {
  try {
    video.pause();
  } catch {
    /* ignore */
  }
  video.removeAttribute('src');
  video.src = '';
  try {
    video.load();
  } catch {
    /* ignore */
  }
  video.remove();
}

const loadDepthEstimator = createRetryableAsync(async (progress?: ProgressFn): Promise<DepthEstimator> => {
  progress?.(0.65, '正在加载 Depth Anything 深度模型');
  const { pipeline, env } = await loadTransformersModule();
  configureTransformersCache(env);
  const localCacheReady = await isDepthAnythingLocalCacheReady();
  progress?.(
    0.65,
    localCacheReady
      ? 'Depth Anything 本机离线缓存已就绪'
      : 'Depth Anything 本机缓存不完整，将使用网络下载并写入浏览器缓存'
  );
  const options = {
    dtype: 'q8' as const,
    revision: DEPTH_ANYTHING_REVISION,
    local_files_only: localCacheReady,
    progress_callback: (event: { status?: string; file?: string; progress?: number }) => {
      if (event.status === 'progress') {
        progress?.(0.65, `正在下载并缓存深度模型 ${Math.round(event.progress || 0)}%`);
      }
    }
  };
  const depthPipeline = pipeline as unknown as (
    task: string,
    repository: string,
    options: Record<string, unknown>
  ) => Promise<DepthEstimator>;
  try {
    return await createDepthPipeline(depthPipeline, options);
  } catch (error) {
    if (!localCacheReady) throw error;
    console.warn('[ai-depth] 本机 Depth Anything 缓存加载失败，改用远程/浏览器缓存兜底。', error);
    progress?.(0.65, '本机深度模型缓存异常，正在改用远程/浏览器缓存兜底');
    return createDepthPipeline(depthPipeline, { ...options, local_files_only: false });
  }
});

function createDepthPipeline(
  pipeline: (task: string, repository: string, options: Record<string, unknown>) => Promise<DepthEstimator>,
  options: Record<string, unknown>
) {
  return createDevicePipelineWithFallback<DepthEstimator>({
    pipeline,
    task: 'depth-estimation',
    repository: DEPTH_ANYTHING_REPOSITORY,
    options,
    probeWebGpu: () => probeWebGpuAdapter(
      (navigator as Navigator & { gpu?: { requestAdapter?: () => Promise<unknown> } }).gpu
    ),
    onFallback: (error) => console.warn('[ai-depth] WebGPU 不可用，改用 CPU/WASM 缓存路径。', error),
    onCpuReady: () => console.info('[ai-depth] CPU/WASM 深度路径已就绪。'),
    onWebGpuFailure: (error) => console.error('[ai-depth] WebGPU 预检后初始化失败。', error)
  });
}

async function loadTransformersModule(): Promise<TransformersModule> {
  if (!transformersModulePromise) {
    transformersModulePromise = (async () => {
      const localCandidates = [
        publicAssetUrl('transformers/transformers.min.js'),
        publicAssetUrl('transformers/transformers.js'),
        publicAssetUrl('transformers/transformers.web.min.js'),
        publicAssetUrl('transformers/transformers.web.js')
      ];
      let lastError: unknown;
      for (const url of localCandidates) {
        try {
          const mod = (await import(/* @vite-ignore */ url)) as Partial<TransformersModule>;
          if (mod.RawImage && mod.pipeline && mod.env) return mod as TransformersModule;
        } catch (error) {
          lastError = error;
        }
      }
      try {
        return (await import('@huggingface/transformers')) as TransformersModule;
      } catch (error) {
        lastError = error;
      }
      throw new Error(
        `Depth Anything 运行时不可用。请安装 @huggingface/transformers，或运行 npm run prepare-analysis-assets 复制离线运行时。${errorMessage(lastError)}`
      );
    })();
  }
  return transformersModulePromise;
}

function configureTransformersCache(env: TransformersModule['env']) {
  env.allowRemoteModels = true;
  env.useBrowserCache = true;
  env.allowLocalModels = true;
  env.localModelPath = publicAssetUrl('models/transformers/');
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = {
      mjs: publicAssetUrl('transformers/ort-wasm-simd-threaded.asyncify.mjs'),
      wasm: publicAssetUrl('transformers/ort-wasm-simd-threaded.asyncify.wasm')
    };
  }
}

async function isDepthAnythingLocalCacheReady() {
  const checks = DEPTH_ANYTHING_LOCAL_FILES.map((asset) =>
    localAssetExists(`models/transformers/${DEPTH_ANYTHING_REPOSITORY}/${asset.path}`, asset.minBytes)
  );
  const results = await Promise.all(checks);
  return results.every(Boolean);
}

async function localAssetExists(relativePath: string, minBytes: number) {
  try {
    const response = await fetch(publicAssetUrl(relativePath), { method: 'HEAD', cache: 'no-store' });
    if (!response.ok) return false;
    const size = Number(response.headers.get('content-length') || 0);
    return !size || size >= minBytes;
  } catch {
    return false;
  }
}

function publicAssetUrl(relativePath: string) {
  return new URL(relativePath.replace(/^\/+/, ''), window.location.href).href;
}

function waitForMetadata(video: HTMLVideoElement) {
  return new Promise<void>((resolve, reject) => {
    if (video.readyState >= 1) {
      resolve();
      return;
    }
    const timeout = window.setTimeout(() => reject(new Error('Timed out loading video metadata for AI depth.')), 15000);
    video.onloadedmetadata = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    video.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error('Could not load video for AI depth analysis.'));
    };
    video.load();
  });
}

function seekVideo(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(`Timed out seeking video to ${time.toFixed(2)}s.`)), 10000);
    const done = () => {
      window.clearTimeout(timeout);
      video.onseeked = null;
      resolve();
    };
    video.onseeked = done;
    video.currentTime = time;
    if (Math.abs(video.currentTime - time) < 0.002 && video.readyState >= 2) {
      requestAnimationFrame(done);
    }
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || '');
}
