import { execFile } from "node:child_process";
import type { BrowserWindow, Display } from "electron";
import type { InputPlatform } from "./inputInjector";

export type PowerOperation = "lock" | "sleep" | "restart" | "shutdown";

export interface PowerCommandSpec {
  file: string;
  args: string[];
}

export interface PowerActionResult {
  ok: boolean;
  message?: string;
}

export function isPowerOperation(value: unknown): value is PowerOperation {
  return (
    value === "lock" ||
    value === "sleep" ||
    value === "restart" ||
    value === "shutdown"
  );
}

/**
 * Resolves the allowlisted OS command for a remote power operation.
 * Never uses shell interpolation.
 */
export function resolvePowerCommand(
  operation: PowerOperation,
  platform: InputPlatform,
): PowerCommandSpec | null {
  switch (operation) {
    case "lock":
      if (platform === "darwin") {
        return { file: "pmset", args: ["displaysleepnow"] };
      }
      if (platform === "win32") {
        return { file: "rundll32.exe", args: ["user32.dll,LockWorkStation"] };
      }
      return { file: "loginctl", args: ["lock-session"] };

    case "sleep":
      if (platform === "darwin") {
        return { file: "pmset", args: ["sleepnow"] };
      }
      if (platform === "win32") {
        return {
          file: "rundll32.exe",
          args: ["powrprof.dll,SetSuspendState", "0,1,0"],
        };
      }
      return { file: "systemctl", args: ["suspend"] };

    case "restart":
      if (platform === "darwin") {
        return {
          file: "osascript",
          args: ["-e", 'tell application "System Events" to restart'],
        };
      }
      if (platform === "win32") {
        return { file: "shutdown", args: ["/r", "/t", "5"] };
      }
      return { file: "systemctl", args: ["reboot"] };

    case "shutdown":
      if (platform === "darwin") {
        return {
          file: "osascript",
          args: ["-e", 'tell application "System Events" to shut down'],
        };
      }
      if (platform === "win32") {
        return { file: "shutdown", args: ["/s", "/t", "5"] };
      }
      return { file: "systemctl", args: ["poweroff"] };
  }
}

function runExecFile(spec: PowerCommandSpec): Promise<PowerActionResult> {
  return new Promise((resolve) => {
    execFile(
      spec.file,
      spec.args,
      { timeout: 10_000, windowsHide: true },
      (error) => {
        if (error) {
          resolve({
            ok: false,
            message: error.message || `Failed to execute ${spec.file}`,
          });
          return;
        }
        resolve({ ok: true });
      },
    );
  });
}

/**
 * Executes an allowlisted remote power action (`lock | sleep | restart | shutdown`).
 * For `lock`, prefers the native input helper (`Ctrl+Cmd+Q` / `LockWorkStation`) and falls back to OS CLI.
 */
export async function executePowerAction(
  operation: PowerOperation,
  platform: InputPlatform,
  lockFallbackFn?: () => boolean,
  execFn: (spec: PowerCommandSpec) => Promise<PowerActionResult> = runExecFile,
): Promise<PowerActionResult> {
  if (!isPowerOperation(operation)) {
    return { ok: false, message: "不支持的电源操作" };
  }

  if (operation === "lock" && lockFallbackFn) {
    try {
      if (lockFallbackFn()) {
        return { ok: true };
      }
    } catch {
      // Fall through to OS command fallback
    }
  }

  const spec = resolvePowerCommand(operation, platform);
  if (!spec) {
    return { ok: false, message: "当前系统不支持该电源操作" };
  }
  return execFn(spec);
}

const EMERGENCY_SHORTCUT = "CommandOrControl+Alt+Escape";
const UNLOCK_TITLE_SENTINEL = "VELODECK_PRIVACY_CURTAIN_UNLOCK";

function buildMainCurtainDataUrl(platform: InputPlatform): string {
  const shortcutHint =
    platform === "darwin" ? "⌘ + ⌥ + Esc" : "Ctrl + Alt + Esc";
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>VeloDeck Privacy Curtain</title>
<style>
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: #000000;
    overflow: hidden;
    user-select: none;
    -webkit-user-select: none;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .hint {
    color: rgba(255, 255, 255, 0.14);
    font-size: 13px;
    letter-spacing: 0.04em;
    text-align: center;
    line-height: 1.8;
    pointer-events: none;
  }
</style>
</head>
<body>
  <div class="hint">VeloDeck 隐私防窥保护中<br/>按 ${shortcutHint} 或连点屏幕右下角 3 次立即解除</div>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function buildCornerUnlockDataUrl(): string {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>VeloDeck Unlock Corner</title>
<style>
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: #000000;
    overflow: hidden;
    user-select: none;
    -webkit-user-select: none;
    cursor: default;
  }
</style>
</head>
<body>
<script>
  let clicks = 0;
  let lastClickAt = 0;
  window.addEventListener("mousedown", () => {
    const now = Date.now();
    if (now - lastClickAt > 1500) {
      clicks = 0;
    }
    lastClickAt = now;
    clicks += 1;
    if (clicks >= 3) {
      clicks = 0;
      document.title = "${UNLOCK_TITLE_SENTINEL}";
    }
  });
</script>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function loadElectronRuntime(): typeof import("electron") {
  // Lazy runtime require keeps pure power helpers testable under plain Node.js
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("electron") as typeof import("electron");
}

export interface PrivacyCurtainManagerOptions {
  platform: InputPlatform;
  onVisibilityChanged?: (active: boolean) => void;
}

/**
 * Manages full-screen anti-peep privacy black curtains across all connected displays.
 * Each curtain uses `setContentProtection(true)` so ScreenCaptureKit / DXGI excludes it
 * from remote capture while onlookers see an opaque black screen, and `setIgnoreMouseEvents(true)`
 * so remote clicks pass straight through to the real desktop apps underneath.
 * Local users can always escape via `CommandOrControl+Alt+Escape` or triple-clicking
 * the bottom-right corner of the primary display.
 */
export class PrivacyCurtainManager {
  private readonly platform: InputPlatform;
  private readonly onVisibilityChanged?: (active: boolean) => void;

  private active = false;
  private disposed = false;
  private shortcutRegistered = false;
  private displayListenersAttached = false;
  private curtainWindows = new Set<BrowserWindow>();

  private readonly handleDisplaysChanged = (): void => {
    if (this.active && !this.disposed) {
      this.rebuildCurtainWindows();
    }
  };

  constructor(options: PrivacyCurtainManagerOptions) {
    this.platform = options.platform;
    this.onVisibilityChanged = options.onVisibilityChanged;
  }

  public isActive(): boolean {
    return this.active;
  }

  public isCurtainWindow(win: BrowserWindow | null | undefined): boolean {
    return Boolean(win && this.curtainWindows.has(win));
  }

  public show(): boolean {
    if (this.disposed) {
      return false;
    }
    if (this.active) {
      return true;
    }

    const electron = loadElectronRuntime();
    this.active = true;
    this.rebuildCurtainWindows();
    this.attachDisplayListeners(electron);

    try {
      this.shortcutRegistered = electron.globalShortcut.register(
        EMERGENCY_SHORTCUT,
        () => {
          this.hide();
        },
      );
    } catch {
      this.shortcutRegistered = false;
    }

    this.onVisibilityChanged?.(true);
    return true;
  }

  public hide(): void {
    const wasActive = this.active;
    this.active = false;

    const electron = loadElectronRuntime();
    if (this.shortcutRegistered) {
      try {
        electron.globalShortcut.unregister(EMERGENCY_SHORTCUT);
      } catch {
        // Ignore shortcut cleanup errors during shutdown
      }
      this.shortcutRegistered = false;
    }

    this.detachDisplayListeners(electron);
    this.destroyAllCurtainWindows();

    if (wasActive) {
      this.onVisibilityChanged?.(false);
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.hide();
  }

  private attachDisplayListeners(electron: typeof import("electron")): void {
    if (this.displayListenersAttached) return;
    this.displayListenersAttached = true;
    electron.screen.on("display-added", this.handleDisplaysChanged);
    electron.screen.on("display-removed", this.handleDisplaysChanged);
    electron.screen.on("display-metrics-changed", this.handleDisplaysChanged);
  }

  private detachDisplayListeners(electron: typeof import("electron")): void {
    if (!this.displayListenersAttached) return;
    this.displayListenersAttached = false;
    electron.screen.removeListener("display-added", this.handleDisplaysChanged);
    electron.screen.removeListener("display-removed", this.handleDisplaysChanged);
    electron.screen.removeListener(
      "display-metrics-changed",
      this.handleDisplaysChanged,
    );
  }

  private destroyAllCurtainWindows(): void {
    const windows = Array.from(this.curtainWindows);
    this.curtainWindows.clear();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        try {
          win.destroy();
        } catch {
          // Best-effort cleanup
        }
      }
    }
  }

  private rebuildCurtainWindows(): void {
    this.destroyAllCurtainWindows();

    const electron = loadElectronRuntime();
    const { BrowserWindow: ElectronBrowserWindow, screen } = electron;
    const displays: Display[] = screen.getAllDisplays();
    const primaryDisplay = screen.getPrimaryDisplay();
    const mainDataUrl = buildMainCurtainDataUrl(this.platform);

    for (const display of displays) {
      const win = new ElectronBrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        frame: false,
        transparent: false,
        backgroundColor: "#000000",
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        hasShadow: false,
        enableLargerThanScreen: true,
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });

      this.curtainWindows.add(win);
      this.configureCurtainWindow(win, display.bounds, true);
      win.on("closed", () => {
        this.curtainWindows.delete(win);
      });

      void win.loadURL(mainDataUrl);
      win.once("ready-to-show", () => {
        if (!win.isDestroyed() && this.active) {
          win.showInactive();
        }
      });
    }

    // Small 40x40 bottom-right corner escape window on primary display (triple-click to unlock)
    const cornerSize = 40;
    const cornerBounds = {
      x: primaryDisplay.bounds.x + Math.max(0, primaryDisplay.bounds.width - cornerSize),
      y: primaryDisplay.bounds.y + Math.max(0, primaryDisplay.bounds.height - cornerSize),
      width: cornerSize,
      height: cornerSize,
    };

    const cornerWin = new ElectronBrowserWindow({
      ...cornerBounds,
      frame: false,
      transparent: false,
      backgroundColor: "#000000",
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      hasShadow: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });

    this.curtainWindows.add(cornerWin);
    this.configureCurtainWindow(cornerWin, cornerBounds, false);
    cornerWin.on("page-title-updated", (_event, title) => {
      if (title === UNLOCK_TITLE_SENTINEL && this.active) {
        this.hide();
      }
    });
    cornerWin.on("closed", () => {
      this.curtainWindows.delete(cornerWin);
    });

    void cornerWin.loadURL(buildCornerUnlockDataUrl());
    cornerWin.once("ready-to-show", () => {
      if (!cornerWin.isDestroyed() && this.active) {
        cornerWin.showInactive();
      }
    });
  }

  private configureCurtainWindow(
    win: BrowserWindow,
    bounds: { x: number; y: number; width: number; height: number },
    ignoreMouseEvents: boolean,
  ): void {
    try {
      // Exclude from ScreenCaptureKit (macOS) & DXGI/WDA_EXCLUDEFROMCAPTURE (Windows)
      win.setContentProtection(true);
    } catch {
      // Platform may not support content protection (e.g. Linux)
    }

    if (this.platform === "darwin") {
      win.setAlwaysOnTop(true, "screen-saver", ignoreMouseEvents ? 0 : 1);
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } else {
      win.setAlwaysOnTop(true, "screen-saver");
    }

    win.setBounds(bounds);
    if (ignoreMouseEvents) {
      win.setIgnoreMouseEvents(true);
    }
  }
}
