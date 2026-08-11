/**
 * Motion Previs Studio - Tauri Bridge
 */

const TauriBridge = (() => {
  let isTauri = false;
  let invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

  async function init() {
    try {
      const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
      invoke = tauriInvoke;
      await tauriInvoke("get_app_data_dir");
      isTauri = true;
      console.log("Motion Previs Studio: Running in Tauri mode");
      return true;
    } catch {
      isTauri = false;
      console.log("Motion Previs Studio: Running in browser mode");
      return false;
    }
  }

  function isAvailable() {
    return isTauri;
  }

  async function getAppDataDir(): Promise<string | null> {
    if (!isTauri || !invoke) return null;
    try {
      return await invoke("get_app_data_dir") as string;
    } catch (e) {
      console.error("Failed to get app data dir:", e);
      return null;
    }
  }

  async function showSaveDialog(options: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) {
    if (!isTauri || !invoke) return null;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      return await save(options);
    } catch (e) {
      console.error("Failed to show save dialog:", e);
      return null;
    }
  }

  async function showOpenDialog(options: { multiple?: boolean; filters?: { name: string; extensions: string[] }[] }) {
    if (!isTauri || !invoke) return null;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      return await open(options);
    } catch (e) {
      console.error("Failed to show open dialog:", e);
      return null;
    }
  }

  function safeExternalUrl(url: string) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" ? parsed.toString() : null;
    } catch {
      return null;
    }
  }

  async function openExternal(url: string) {
    const safeUrl = safeExternalUrl(url);
    if (!safeUrl) {
      console.warn("Blocked external URL outside the HTTPS allowlist");
      return;
    }
    window.open(safeUrl, "_blank", "noopener,noreferrer");
  }

  return {
    init,
    isAvailable,
    isTauri: () => isTauri,
    getAppDataDir,
    showSaveDialog,
    showOpenDialog,
    openExternal,
  };
})();

TauriBridge.init();

export default TauriBridge;
