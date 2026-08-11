/// <reference types="vite/client" />

// Modified for cross-platform Windows support in 2026; see MODIFICATIONS.md.

declare const __MPS_APP_VERSION__: string;

declare module '@huggingface/transformers' {
  export const RawImage: {
    fromCanvas(canvas: HTMLCanvasElement): unknown;
  };
  export const env: {
    allowRemoteModels: boolean;
    allowLocalModels?: boolean;
    useBrowserCache?: boolean;
    localModelPath?: string;
    cacheDir?: string;
  };
  export function pipeline(
    task: string,
    repository: string,
    options?: Record<string, unknown>
  ): Promise<unknown>;
}

declare module '@mediapipe/tasks-vision' {
  export const FilesetResolver: {
    forVisionTasks(path: string): Promise<unknown>;
  };
  export const PoseLandmarker: {
    createFromOptions(vision: unknown, options: Record<string, unknown>): Promise<{
      detectForVideo(video: HTMLVideoElement, timestampMs: number): {
        landmarks?: Array<Array<Partial<import('./types').Landmark>>>;
        worldLandmarks?: Array<Array<Partial<import('./types').Landmark>>>;
      };
      close(): void;
    }>;
  };
}
