import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  screen,
  session,
  shell,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type SaveDialogOptions,
} from "electron";
import {
  formatHostControlCode,
  HOST_WORKER_HOST,
  HOST_WORKER_ORIGIN,
  HostManager,
  type DesktopHostConfigPatch,
  type DesktopHostState,
} from "./hostManager";
import {
  APP_ORIGIN,
  APP_SCHEME,
  getMimeType,
  isAllowedRendererUrl,
  isSafeExternalUrl,
  resolveStaticAssetPath,
} from "./protocol";
import {
  clampWindowBounds,
  computePresetBounds,
  loadSettings,
  MAX_RECENT_SERVERS,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  normalizeServerUrl,
  PRESET_SIZES,
  saveSettingsAtomic,
  upsertRecentServer,
  type DesktopSettings,
  type WindowBounds,
  type WindowPreset,
  type WorkArea,
} from "./settings";

type DesktopPlatform = "darwin" | "win32" | "linux";
type DesktopMenuCommand =
  | "toggle-black-screen"
  | "toggle-force-portrait"
  | "copy-screenshot"
  | "save-screenshot"
  | "open-server-settings"
  | "reconnect";

interface DesktopWindowState {
  alwaysOnTop: boolean;
  preset: WindowPreset;
  isFullScreen: boolean;
}

interface DesktopServerConfig {
  serverUrl: string;
  recentServers: string[];
}

interface CreateWindowOptions {
  preset?: WindowPreset;
  isSecondary?: boolean;
}

const MAX_PNG_BYTES = 25 * 1024 * 1024;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WINDOW_BG_COLOR = "#111318";

const desktopRootDir = path.resolve(__dirname, "..");
const rendererDistDir = path.join(desktopRootDir, "renderer-dist");
const assetsDir = path.join(desktopRootDir, "assets");
const buildConfigPath = path.join(desktopRootDir, "build-config.json");

// Register custom app:// scheme BEFORE app.whenReady()
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

// Enable Chromium hardware video decode/encode flags (never disabling GPU acceleration)
app.commandLine.appendSwitch(
  "enable-features",
  "PlatformHEVCDecoderSupport,PlatformHEVCEncoderSupport,VaapiVideoDecoder",
);

function getDesktopPlatform(): DesktopPlatform {
  if (process.platform === "darwin" || process.platform === "win32") {
    return process.platform;
  }
  return "linux";
}

function loadDefaultServerUrl(): string {
  try {
    if (!fs.existsSync(buildConfigPath)) {
      return "";
    }
    const raw = JSON.parse(fs.readFileSync(buildConfigPath, "utf8")) as {
      defaultServerUrl?: unknown;
    };
    return typeof raw.defaultServerUrl === "string"
      ? normalizeServerUrl(raw.defaultServerUrl)
      : "";
  } catch {
    return "";
  }
}

function resolveDevUrl(): string {
  const raw = process.env.VELODECK_DESKTOP_DEV_URL?.trim() ?? "";
  if (!raw) {
    return "";
  }
  return isSafeExternalUrl(raw) ? raw : "";
}

const defaultServerUrl = loadDefaultServerUrl();
const devServerUrl = resolveDevUrl();
const allowedRendererOrigin = devServerUrl
  ? new URL(devServerUrl).origin
  : APP_ORIGIN;

let settingsFilePath = "";
let settings: DesktopSettings = {
  serverUrl: "",
  recentServers: [],
  alwaysOnTop: false,
  lastPreset: "dashboard",
};

let tray: Tray | null = null;
let primaryWindow: BrowserWindow | null = null;
let hostManager: HostManager | null = null;
let isQuitting = false;
let saveBoundsTimer: NodeJS.Timeout | null = null;
const windowPresetMap = new WeakMap<BrowserWindow, WindowPreset>();

function getControllerWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (w) => !w.isDestroyed() && !hostManager?.isInternalWindow(w),
  );
}

function broadcastHostState(state: DesktopHostState): void {
  for (const win of getControllerWindows()) {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send("velodeck:host-state-changed", state);
    }
  }
  refreshMenus();
}

function isValidPreset(value: unknown): value is WindowPreset {
  return value === "phone" || value === "compact" || value === "dashboard";
}

function isTrustedIpcEvent(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frameUrl = event.senderFrame?.url ?? event.sender.getURL();
  return isAllowedRendererUrl(frameUrl, allowedRendererOrigin);
}

function persistSettings(): void {
  if (!settingsFilePath) {
    return;
  }
  try {
    saveSettingsAtomic(settingsFilePath, settings);
  } catch (error) {
    console.error("[velodeck-desktop] Failed to persist settings:", error);
  }
}

function getAllWorkAreas(): WorkArea[] {
  const primary = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays().filter((d) => d.id !== primary.id);
  return [primary, ...others].map((d) => ({
    x: d.workArea.x,
    y: d.workArea.y,
    width: d.workArea.width,
    height: d.workArea.height,
  }));
}

function getWindowState(win: BrowserWindow): DesktopWindowState {
  return {
    alwaysOnTop: win.isAlwaysOnTop(),
    preset: windowPresetMap.get(win) ?? settings.lastPreset,
    isFullScreen: win.isFullScreen(),
  };
}

function emitWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) {
    return;
  }
  const state = getWindowState(win);
  if (!win.webContents.isDestroyed()) {
    win.webContents.send("velodeck:window-state-changed", state);
  }
  refreshMenus();
}

function getTargetWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed() && !hostManager?.isInternalWindow(focused)) {
    return focused;
  }
  if (primaryWindow && !primaryWindow.isDestroyed()) {
    return primaryWindow;
  }
  const all = getControllerWindows();
  return all[0] ?? null;
}

function showWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) {
    return;
  }
  if (win.isMinimized()) {
    win.restore();
  }
  win.show();
  win.focus();
}

function focusOrCreateWindow(): BrowserWindow {
  const existing = getTargetWindow();
  if (existing) {
    showWindow(existing);
    return existing;
  }
  return createMainWindow();
}

function setWindowAlwaysOnTop(
  win: BrowserWindow,
  enabled: boolean,
): DesktopWindowState {
  if (process.platform === "darwin") {
    win.setAlwaysOnTop(enabled, "floating");
    win.setVisibleOnAllWorkspaces(enabled, { visibleOnFullScreen: false });
  } else {
    win.setAlwaysOnTop(enabled);
  }
  settings.alwaysOnTop = enabled;
  persistSettings();
  emitWindowState(win);
  return getWindowState(win);
}

function applyWindowPreset(
  win: BrowserWindow,
  preset: WindowPreset,
): DesktopWindowState {
  if (win.isFullScreen()) {
    win.setFullScreen(false);
  }
  if (win.isMaximized()) {
    win.unmaximize();
  }
  const current = win.getBounds();
  const display = screen.getDisplayMatching(current);
  const nextBounds = computePresetBounds(preset, current, display.workArea);
  win.setBounds(nextBounds, true);
  windowPresetMap.set(win, preset);
  settings.lastPreset = preset;
  settings.windowBounds = nextBounds;
  persistSettings();
  emitWindowState(win);
  return getWindowState(win);
}

function dispatchMenuCommand(
  command: DesktopMenuCommand,
  target?: BrowserWindow | null,
): void {
  const win = target && !target.isDestroyed() ? target : focusOrCreateWindow();
  showWindow(win);
  const send = (): void => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send("velodeck:menu-command", command);
    }
  };
  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once("did-finish-load", send);
  } else {
    send();
  }
}

function scheduleSaveBounds(win: BrowserWindow): void {
  if (win !== primaryWindow || win.isDestroyed()) {
    return;
  }
  if (win.isMinimized() || win.isMaximized() || win.isFullScreen()) {
    return;
  }
  if (saveBoundsTimer) {
    clearTimeout(saveBoundsTimer);
  }
  saveBoundsTimer = setTimeout(() => {
    saveBoundsTimer = null;
    if (
      win.isDestroyed() ||
      win.isMinimized() ||
      win.isMaximized() ||
      win.isFullScreen()
    ) {
      return;
    }
    const b = win.getBounds();
    settings.windowBounds = {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
    };
    persistSettings();
  }, 300);
}

function computeInitialBounds(options: CreateWindowOptions): {
  bounds: WindowBounds;
  preset: WindowPreset;
} {
  const workAreas = getAllWorkAreas();
  const primaryWorkArea = workAreas[0] ?? {
    x: 0,
    y: 0,
    width: 1440,
    height: 900,
  };

  if (options.preset) {
    const anchor =
      options.isSecondary && primaryWindow && !primaryWindow.isDestroyed()
        ? primaryWindow.getBounds()
        : undefined;
    const presetBounds = computePresetBounds(
      options.preset,
      anchor
        ? {
            x: anchor.x + 28,
            y: anchor.y + 28,
            width: anchor.width,
            height: anchor.height,
          }
        : undefined,
      primaryWorkArea,
    );
    return { bounds: presetBounds, preset: options.preset };
  }

  if (options.isSecondary) {
    const refWin = getTargetWindow();
    const basePreset = refWin
      ? windowPresetMap.get(refWin) ?? settings.lastPreset
      : settings.lastPreset;
    const baseBounds = refWin ? refWin.getBounds() : settings.windowBounds;
    if (baseBounds) {
      const shifted: WindowBounds = {
        x: baseBounds.x + 32,
        y: baseBounds.y + 32,
        width: baseBounds.width,
        height: baseBounds.height,
      };
      return {
        bounds: clampWindowBounds(shifted, workAreas),
        preset: basePreset,
      };
    }
    return {
      bounds: computePresetBounds(basePreset, undefined, primaryWorkArea),
      preset: basePreset,
    };
  }

  if (settings.windowBounds) {
    return {
      bounds: clampWindowBounds(settings.windowBounds, workAreas),
      preset: settings.lastPreset,
    };
  }

  const defaultPreset: WindowPreset = settings.lastPreset ?? "dashboard";
  if (defaultPreset === "dashboard") {
    const fallback = clampWindowBounds(
      {
        x: Math.round(
          primaryWorkArea.x +
            (primaryWorkArea.width - PRESET_SIZES.dashboard.width) / 2,
        ),
        y: Math.round(
          primaryWorkArea.y +
            (primaryWorkArea.height - PRESET_SIZES.dashboard.height) / 2,
        ),
        width: PRESET_SIZES.dashboard.width,
        height: PRESET_SIZES.dashboard.height,
      },
      workAreas,
    );
    return { bounds: fallback, preset: "dashboard" };
  }

  return {
    bounds: computePresetBounds(defaultPreset, undefined, primaryWorkArea),
    preset: defaultPreset,
  };
}

function createMainWindow(options: CreateWindowOptions = {}): BrowserWindow {
  const { bounds, preset } = computeInitialBounds(options);
  const isMac = process.platform === "darwin";

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    title: "VeloDeck 极控",
    backgroundColor: WINDOW_BG_COLOR,
    ...(isMac
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 14, y: 15 },
        }
      : {
          autoHideMenuBar: true,
          icon: path.join(assetsDir, "icon.png"),
        }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // CRITICAL: prevent Chromium from throttling video/WebRTC timers when pinned/unfocused
      backgroundThrottling: false,
    },
  });

  windowPresetMap.set(win, preset);
  if (!primaryWindow || primaryWindow.isDestroyed()) {
    primaryWindow = win;
    if (settings.alwaysOnTop) {
      if (isMac) {
        win.setAlwaysOnTop(true, "floating");
      } else {
        win.setAlwaysOnTop(true);
      }
    }
  }

  // Strictly block popups and open safe http/https links in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Prevent navigation away from the bundled app://velodeck (or local Vite dev) origin
  win.webContents.on("will-navigate", (event, targetUrl) => {
    if (isAllowedRendererUrl(targetUrl, allowedRendererOrigin)) {
      return;
    }
    event.preventDefault();
    if (isSafeExternalUrl(targetUrl)) {
      void shell.openExternal(targetUrl);
    }
  });

  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) {
      win.show();
      emitWindowState(win);
    }
  });

  win.on("resize", () => scheduleSaveBounds(win));
  win.on("move", () => scheduleSaveBounds(win));
  win.on("maximize", () => emitWindowState(win));
  win.on("unmaximize", () => emitWindowState(win));
  win.on("enter-full-screen", () => emitWindowState(win));
  win.on("leave-full-screen", () => emitWindowState(win));
  win.on("focus", () => refreshMenus());

  // Close-to-tray for the last window when tray is active (unless quitting)
  win.on("close", (event) => {
    if (isQuitting || !tray) {
      return;
    }
    const openWindows = getControllerWindows();
    if (openWindows.length <= 1) {
      event.preventDefault();
      if (process.platform === "darwin" && win.isFullScreen()) {
        win.once("leave-full-screen", () => {
          if (!win.isDestroyed()) {
            win.hide();
          }
        });
        win.setFullScreen(false);
      } else {
        win.hide();
      }
    }
  });

  win.on("closed", () => {
    if (primaryWindow === win) {
      const remaining = getControllerWindows().filter((w) => w !== win);
      primaryWindow = remaining[0] ?? null;
    }
    refreshMenus();
  });

  const entryUrl = devServerUrl || `${APP_ORIGIN}/`;
  void win.loadURL(entryUrl);
  return win;
}

function buildTrayContextMenu(): Menu {
  const activeWin = getTargetWindow();
  const isPinned = activeWin ? activeWin.isAlwaysOnTop() : settings.alwaysOnTop;
  const hostState = hostManager?.getHostState();
  const formattedCode = hostState?.controlCode
    ? formatHostControlCode(hostState.controlCode)
    : "";

  let hostStatusLabel = "本机被控: 未开启";
  if (hostState?.enabled) {
    switch (hostState.status) {
      case "controlling":
        hostStatusLabel = formattedCode
          ? `本机被控: 正在被控 (${formattedCode})`
          : "本机被控: 正在被控";
        break;
      case "online":
        hostStatusLabel = formattedCode
          ? `本机被控: 在线 (${formattedCode})`
          : "本机被控: 在线";
        break;
      case "connecting":
        hostStatusLabel = "本机被控: 连接中...";
        break;
      case "error":
        hostStatusLabel = "本机被控: 连接异常";
        break;
      default:
        hostStatusLabel = "本机被控: 未开启";
        break;
    }
  }

  const hostMenuItems: MenuItemConstructorOptions[] = [
    {
      label: hostStatusLabel,
      enabled: false,
    },
    {
      label: hostState?.enabled ? "关闭本机被控" : "开启本机被控",
      click: () => {
        if (!hostManager) return;
        if (hostManager.getHostState().enabled) {
          void hostManager.stopHost();
        } else {
          void hostManager.startHost();
        }
      },
    },
    ...(formattedCode
      ? [
          {
            label: `复制本机控制码 (${formattedCode})`,
            click: () => {
              clipboard.writeText(hostState?.controlCode ?? "");
            },
          } as MenuItemConstructorOptions,
        ]
      : []),
    ...(hostState?.activeSessionId
      ? [
          {
            label: "断开当前远控会话",
            click: () => {
              void hostManager?.disconnectHostSession();
            },
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "隐私防窥黑屏",
      type: "checkbox",
      checked: Boolean(hostState?.privacyScreenActive),
      click: (item) => {
        void hostManager?.setHostPrivacyScreen(item.checked);
      },
    },
    {
      label: "开机自启",
      type: "checkbox",
      checked: Boolean(hostState?.autoLaunch),
      click: (item) => {
        void hostManager?.updateHostConfig({ autoLaunch: item.checked });
      },
    },
    { type: "separator" },
  ];

  const template: MenuItemConstructorOptions[] = [
    {
      label: "显示主窗口",
      click: () => {
        focusOrCreateWindow();
      },
    },
    {
      label: "新建控制窗口（多机同控）",
      click: () => {
        createMainWindow({ isSecondary: true });
      },
    },
    { type: "separator" },
    ...hostMenuItems,
    {
      label: "置顶当前窗口",
      type: "checkbox",
      checked: isPinned,
      click: (item) => {
        const win = focusOrCreateWindow();
        setWindowAlwaysOnTop(win, item.checked);
      },
    },
    {
      label: "手机竖屏窗口 (430×880)",
      click: () => {
        const win = focusOrCreateWindow();
        applyWindowPreset(win, "phone");
      },
    },
    {
      label: "紧凑浮窗 (360×740)",
      click: () => {
        const win = focusOrCreateWindow();
        applyWindowPreset(win, "compact");
      },
    },
    {
      label: "宽屏工作台 (1100×760)",
      click: () => {
        const win = focusOrCreateWindow();
        applyWindowPreset(win, "dashboard");
      },
    },
    { type: "separator" },
    {
      label: "配置服务器地址",
      click: () => {
        dispatchMenuCommand("open-server-settings");
      },
    },
    { type: "separator" },
    {
      label: "退出 VeloDeck",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ];

  return Menu.buildFromTemplate(template);
}

function buildApplicationMenu(): Menu {
  const isMac = process.platform === "darwin";
  const activeWin = getTargetWindow();
  const isPinned = activeWin ? activeWin.isAlwaysOnTop() : settings.alwaysOnTop;

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: "about", label: "关于 VeloDeck" },
        { type: "separator" },
        {
          label: "服务器设置...",
          accelerator: "CmdOrCtrl+,",
          click: () => dispatchMenuCommand("open-server-settings"),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: "隐藏 VeloDeck" },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "全部显示" },
        { type: "separator" },
        {
          label: "退出 VeloDeck",
          accelerator: "CmdOrCtrl+Q",
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ],
    });
  }

  template.push({
    label: isMac ? "文件" : "File",
    submenu: [
      {
        label: "新建控制窗口",
        accelerator: "CmdOrCtrl+N",
        click: () => {
          createMainWindow({ isSecondary: true });
        },
      },
      ...(!isMac
        ? [
            {
              label: "服务器设置...",
              accelerator: "CmdOrCtrl+,",
              click: () => dispatchMenuCommand("open-server-settings"),
            } as MenuItemConstructorOptions,
          ]
        : []),
      { type: "separator" },
      { role: "close", label: "关闭窗口" },
      ...(!isMac
        ? [
            { type: "separator" } as MenuItemConstructorOptions,
            {
              label: "退出 VeloDeck",
              accelerator: "Alt+F4",
              click: () => {
                isQuitting = true;
                app.quit();
              },
            } as MenuItemConstructorOptions,
          ]
        : []),
    ],
  });

  template.push({
    label: isMac ? "编辑" : "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      ...(isMac
        ? [
            { role: "pasteAndMatchStyle" } as MenuItemConstructorOptions,
            { role: "delete" } as MenuItemConstructorOptions,
            { role: "selectAll" } as MenuItemConstructorOptions,
          ]
        : [
            { role: "delete" } as MenuItemConstructorOptions,
            { type: "separator" } as MenuItemConstructorOptions,
            { role: "selectAll" } as MenuItemConstructorOptions,
          ]),
    ],
  });

  template.push({
    label: isMac ? "视图" : "View",
    submenu: [
      { role: "reload", label: "重新加载" },
      { role: "forceReload", label: "强制重新加载" },
      { role: "toggleDevTools", label: "开发者工具" },
      { type: "separator" },
      { role: "resetZoom", label: "实际大小" },
      { role: "togglefullscreen", label: "切换全屏" },
      { type: "separator" },
      {
        label: "手机竖屏窗口 (430×880)",
        accelerator: "CmdOrCtrl+1",
        click: () => {
          const win = focusOrCreateWindow();
          applyWindowPreset(win, "phone");
        },
      },
      {
        label: "宽屏工作台 (1100×760)",
        accelerator: "CmdOrCtrl+2",
        click: () => {
          const win = focusOrCreateWindow();
          applyWindowPreset(win, "dashboard");
        },
      },
      {
        label: "紧凑浮窗 (360×740)",
        accelerator: "CmdOrCtrl+3",
        click: () => {
          const win = focusOrCreateWindow();
          applyWindowPreset(win, "compact");
        },
      },
      { type: "separator" },
      {
        label: "置顶当前窗口",
        type: "checkbox",
        checked: isPinned,
        accelerator: "CmdOrCtrl+Shift+T",
        click: (item) => {
          const win = focusOrCreateWindow();
          setWindowAlwaysOnTop(win, item.checked);
        },
      },
    ],
  });

  template.push({
    label: isMac ? "设备" : "Device",
    submenu: [
      {
        label: "复制当前截图",
        accelerator: "CmdOrCtrl+Shift+C",
        click: () => dispatchMenuCommand("copy-screenshot"),
      },
      {
        label: "保存当前截图 (PNG)...",
        accelerator: "CmdOrCtrl+Shift+S",
        click: () => dispatchMenuCommand("save-screenshot"),
      },
      { type: "separator" },
      {
        label: "切换息屏隐身模式",
        accelerator: "CmdOrCtrl+Shift+B",
        click: () => dispatchMenuCommand("toggle-black-screen"),
      },
      {
        label: "切换强制竖屏锁定",
        accelerator: "CmdOrCtrl+Shift+P",
        click: () => dispatchMenuCommand("toggle-force-portrait"),
      },
      { type: "separator" },
      {
        label: "重新连接设备",
        accelerator: "CmdOrCtrl+Shift+R",
        click: () => dispatchMenuCommand("reconnect"),
      },
    ],
  });

  template.push({
    label: isMac ? "窗口" : "Window",
    role: "windowMenu",
    submenu: isMac
      ? [
          { role: "minimize", label: "最小化" },
          { role: "zoom", label: "缩放" },
          { type: "separator" },
          { role: "front", label: "前置全部窗口" },
        ]
      : [
          { role: "minimize", label: "最小化" },
          { role: "close", label: "关闭" },
        ],
  });

  return Menu.buildFromTemplate(template);
}

function refreshMenus(): void {
  if (!app.isReady()) {
    return;
  }
  Menu.setApplicationMenu(buildApplicationMenu());
  if (tray && !tray.isDestroyed()) {
    tray.setContextMenu(buildTrayContextMenu());
  }
}

function createSystemTray(): void {
  const isMac = process.platform === "darwin";
  const iconPath = path.join(
    assetsDir,
    isMac ? "trayTemplate.png" : "tray-win.png",
  );
  if (!fs.existsSync(iconPath)) {
    console.warn(`[velodeck-desktop] Tray icon missing at ${iconPath}`);
    return;
  }
  const icon = nativeImage.createFromPath(iconPath);
  if (isMac) {
    icon.setTemplateImage(true);
  }
  tray = new Tray(icon);
  tray.setToolTip("VeloDeck 极控");
  tray.setContextMenu(buildTrayContextMenu());
  if (!isMac) {
    tray.on("click", () => {
      focusOrCreateWindow();
    });
  }
}

const HOST_WORKER_ALLOWED_FILES: Readonly<Record<string, string>> = {
  "/hostWorker.html": path.join(__dirname, "hostWorker.html"),
  "/hostWorkerRenderer.js": path.join(__dirname, "hostWorkerRenderer.js"),
};

function registerStaticProtocol(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Dedicated isolated origin for the hidden Desktop Host streaming worker
    try {
      const parsed = new URL(request.url);
      if (parsed.hostname.toLowerCase() === HOST_WORKER_HOST) {
        const targetFile = HOST_WORKER_ALLOWED_FILES[parsed.pathname];
        if (!targetFile) {
          return new Response("Not Found", { status: 404 });
        }
        try {
          const stat = await fs.promises.stat(targetFile);
          if (!stat.isFile()) {
            return new Response("Not Found", { status: 404 });
          }
          const headers = new Headers({
            "Content-Type": getMimeType(targetFile),
            "Content-Length": String(stat.size),
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "X-Content-Type-Options": "nosniff",
          });
          if (request.method === "HEAD") {
            return new Response(null, { status: 200, headers });
          }
          const data = await fs.promises.readFile(targetFile);
          return new Response(data, { status: 200, headers });
        } catch {
          return new Response("Not Found", { status: 404 });
        }
      }
    } catch {
      return new Response("Forbidden", { status: 403 });
    }

    const resolvedPath = resolveStaticAssetPath(rendererDistDir, request.url);
    if (!resolvedPath) {
      return new Response("Forbidden", { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(resolvedPath);
      if (!stat.isFile()) {
        return new Response("Not Found", { status: 404 });
      }
    } catch {
      return new Response("Not Found", { status: 404 });
    }

    const fileName = path.basename(resolvedPath).toLowerCase();
    const noCache =
      fileName === "index.html" ||
      fileName === "sw.js" ||
      fileName === "manifest.webmanifest";

    const headers = new Headers({
      "Content-Type": getMimeType(resolvedPath),
      "Content-Length": String(stat.size),
      "Cache-Control": noCache
        ? "no-cache, no-store, must-revalidate"
        : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });

    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }

    const data = await fs.promises.readFile(resolvedPath);
    return new Response(data, { status: 200, headers });
  });
}

function decodeValidatedPngDataUrl(raw: unknown): Buffer | null {
  if (typeof raw !== "string" || !raw.startsWith(PNG_DATA_URL_PREFIX)) {
    return null;
  }
  const base64Body = raw.slice(PNG_DATA_URL_PREFIX.length);
  if (
    base64Body.length === 0 ||
    base64Body.length > Math.ceil((MAX_PNG_BYTES * 4) / 3) + 4
  ) {
    return null;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Body)) {
    return null;
  }
  const buffer = Buffer.from(base64Body, "base64");
  if (buffer.length < PNG_SIGNATURE.length || buffer.length > MAX_PNG_BYTES) {
    return null;
  }
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return null;
  }
  return buffer;
}

function sanitizePngFileName(raw: unknown): string {
  const fallback = `velodeck-screenshot-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19)}.png`;
  if (typeof raw !== "string") {
    return fallback;
  }
  const base = path.basename(raw.trim());
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 120)
    .trim();
  if (!cleaned) {
    return fallback;
  }
  return cleaned.toLowerCase().endsWith(".png") ? cleaned : `${cleaned}.png`;
}

function getServerConfigPayload(): DesktopServerConfig {
  return {
    serverUrl: settings.serverUrl || defaultServerUrl,
    recentServers: [...settings.recentServers],
  };
}

function registerIpcHandlers(): void {
  ipcMain.on("velodeck:get-bootstrap", (event) => {
    if (!isTrustedIpcEvent(event)) {
      event.returnValue = {
        platform: getDesktopPlatform(),
        appVersion: app.getVersion(),
        defaultServerUrl: "",
      };
      return;
    }
    event.returnValue = {
      platform: getDesktopPlatform(),
      appVersion: app.getVersion(),
      defaultServerUrl,
    };
  });

  ipcMain.handle("velodeck:window-get-state", (event) => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error("Untrusted IPC sender");
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) {
      return {
        alwaysOnTop: settings.alwaysOnTop,
        preset: settings.lastPreset,
        isFullScreen: false,
      } satisfies DesktopWindowState;
    }
    return getWindowState(win);
  });

  ipcMain.handle("velodeck:window-set-aot", (event, enabled: unknown) => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error("Untrusted IPC sender");
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) {
      throw new Error("Window unavailable");
    }
    return setWindowAlwaysOnTop(win, Boolean(enabled));
  });

  ipcMain.handle("velodeck:window-set-preset", (event, preset: unknown) => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error("Untrusted IPC sender");
    }
    if (!isValidPreset(preset)) {
      throw new Error("Invalid window preset");
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) {
      throw new Error("Window unavailable");
    }
    return applyWindowPreset(win, preset);
  });

  ipcMain.handle("velodeck:window-new", (event, arg: unknown) => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error("Untrusted IPC sender");
    }
    let preset: WindowPreset | undefined;
    if (isValidPreset(arg)) {
      preset = arg;
    } else if (
      arg &&
      typeof arg === "object" &&
      isValidPreset((arg as { preset?: unknown }).preset)
    ) {
      preset = (arg as { preset: WindowPreset }).preset;
    }
    createMainWindow({ preset, isSecondary: true });
  });

  ipcMain.handle("velodeck:screenshot-copy", (event, dataUrl: unknown) => {
    if (!isTrustedIpcEvent(event)) {
      return { ok: false, error: "Untrusted IPC sender" };
    }
    const pngBuffer = decodeValidatedPngDataUrl(dataUrl);
    if (!pngBuffer) {
      return { ok: false, error: "Invalid PNG screenshot payload" };
    }
    const image = nativeImage.createFromBuffer(pngBuffer);
    if (image.isEmpty()) {
      return { ok: false, error: "Failed to decode PNG image" };
    }
    clipboard.writeImage(image);
    return { ok: true };
  });

  ipcMain.handle(
    "velodeck:screenshot-save",
    async (event, payload: unknown, positionalFileName?: unknown) => {
      if (!isTrustedIpcEvent(event)) {
        return { ok: false, error: "Untrusted IPC sender" };
      }
      let rawDataUrl: unknown;
      let rawFileName: unknown;
      if (typeof payload === "string") {
        rawDataUrl = payload;
        rawFileName = positionalFileName;
      } else if (payload && typeof payload === "object") {
        const obj = payload as {
          dataUrl?: unknown;
          suggestedName?: unknown;
          suggestedFileName?: unknown;
        };
        rawDataUrl = obj.dataUrl;
        rawFileName = obj.suggestedName ?? obj.suggestedFileName;
      }

      const pngBuffer = decodeValidatedPngDataUrl(rawDataUrl);
      if (!pngBuffer) {
        return { ok: false, error: "Invalid PNG screenshot payload" };
      }

      const win = BrowserWindow.fromWebContents(event.sender);
      const safeName = sanitizePngFileName(rawFileName);
      const defaultPath = path.join(app.getPath("desktop"), safeName);
      const dialogOptions: SaveDialogOptions = {
        title: "保存设备截图",
        defaultPath,
        filters: [{ name: "PNG Image", extensions: ["png"] }],
      };

      try {
        const result = win
          ? await dialog.showSaveDialog(win, dialogOptions)
          : await dialog.showSaveDialog(dialogOptions);

        if (result.canceled || !result.filePath) {
          return { ok: false, cancelled: true };
        }

        await fs.promises.writeFile(result.filePath, pngBuffer);
        return { ok: true, savedPath: result.filePath };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "Failed to save PNG",
        };
      }
    },
  );

  ipcMain.handle("velodeck:server-get", (event) => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error("Untrusted IPC sender");
    }
    return getServerConfigPayload();
  });

  ipcMain.handle("velodeck:server-set", (event, rawUrl: unknown) => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error("Untrusted IPC sender");
    }
    if (typeof rawUrl !== "string") {
      throw new Error("Invalid server URL");
    }
    const trimmed = rawUrl.trim();
    if (trimmed === "") {
      settings.serverUrl = "";
      persistSettings();
      void hostManager?.onServerUrlChanged();
      return {
        serverUrl: "",
        recentServers: [...settings.recentServers],
      } satisfies DesktopServerConfig;
    }
    const normalized = normalizeServerUrl(trimmed);
    if (!normalized) {
      throw new Error("Invalid server URL");
    }
    settings.serverUrl = normalized;
    settings.recentServers = upsertRecentServer(
      settings.recentServers,
      normalized,
      MAX_RECENT_SERVERS,
    );
    persistSettings();
    void hostManager?.onServerUrlChanged();
    return getServerConfigPayload();
  });

  ipcMain.handle("velodeck:server-remove-recent", (event, rawUrl: unknown) => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error("Untrusted IPC sender");
    }
    if (typeof rawUrl !== "string") {
      throw new Error("Invalid server URL");
    }
    const normalized = normalizeServerUrl(rawUrl);
    if (normalized) {
      settings.recentServers = settings.recentServers.filter(
        (entry) => entry !== normalized,
      );
      persistSettings();
    }
    return getServerConfigPayload();
  });

  // --- Desktop Host (电脑被控端) IPC Handlers ---

  ipcMain.handle("velodeck:host-get-state", (event) => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error("Untrusted IPC sender");
    }
    if (!hostManager) {
      throw new Error("Host manager unavailable");
    }
    return hostManager.getHostState();
  });

  ipcMain.handle("velodeck:host-start", (event, authToken: unknown) => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error("Untrusted IPC sender");
    }
    if (!hostManager) {
      throw new Error("Host manager unavailable");
    }
    return hostManager.startHost(
      typeof authToken === "string" ? authToken : null,
    );
  });

  ipcMain.handle("velodeck:host-stop", (event) => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error("Untrusted IPC sender");
    }
    if (!hostManager) {
      throw new Error("Host manager unavailable");
    }
    return hostManager.stopHost();
  });

  ipcMain.handle("velodeck:host-update-config", (event, rawPatch: unknown) => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error("Untrusted IPC sender");
    }
    if (!hostManager) {
      throw new Error("Host manager unavailable");
    }
    if (!rawPatch || typeof rawPatch !== "object") {
      throw new Error("Invalid host config patch");
    }
    return hostManager.updateHostConfig(rawPatch as DesktopHostConfigPatch);
  });

  ipcMain.handle("velodeck:host-regenerate-password", (event) => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error("Untrusted IPC sender");
    }
    if (!hostManager) {
      throw new Error("Host manager unavailable");
    }
    return hostManager.regenerateHostPassword();
  });

  ipcMain.handle("velodeck:host-bind-account", (event, authToken: unknown) => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error("Untrusted IPC sender");
    }
    if (!hostManager) {
      throw new Error("Host manager unavailable");
    }
    if (typeof authToken !== "string") {
      throw new Error("Invalid auth token");
    }
    return hostManager.bindHostAccount(authToken);
  });

  ipcMain.handle("velodeck:host-unbind-account", (event) => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error("Untrusted IPC sender");
    }
    if (!hostManager) {
      throw new Error("Host manager unavailable");
    }
    return hostManager.unbindHostAccount();
  });

  ipcMain.handle("velodeck:host-select-display", (event, displayId: unknown) => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error("Untrusted IPC sender");
    }
    if (!hostManager) {
      throw new Error("Host manager unavailable");
    }
    if (typeof displayId !== "string") {
      throw new Error("Invalid display ID");
    }
    return hostManager.selectHostDisplay(displayId);
  });

  ipcMain.handle("velodeck:host-disconnect-session", (event) => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error("Untrusted IPC sender");
    }
    if (!hostManager) {
      throw new Error("Host manager unavailable");
    }
    return hostManager.disconnectHostSession();
  });

  ipcMain.handle("velodeck:host-refresh-permissions", (event) => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error("Untrusted IPC sender");
    }
    if (!hostManager) {
      throw new Error("Host manager unavailable");
    }
    return hostManager.refreshHostPermissions();
  });

  ipcMain.handle(
    "velodeck:host-open-permission-settings",
    (event, kind: unknown) => {
      if (!isTrustedIpcEvent(event)) {
        throw new Error("Untrusted IPC sender");
      }
      if (!hostManager) {
        throw new Error("Host manager unavailable");
      }
      if (kind !== "accessibility" && kind !== "screen") {
        throw new Error("Invalid permission kind");
      }
      return hostManager.openPermissionSettings(kind);
    },
  );

  ipcMain.handle(
    "velodeck:host-set-privacy-screen",
    (event, enabled: unknown) => {
      if (!isTrustedIpcEvent(event)) {
        throw new Error("Untrusted IPC sender");
      }
      if (!hostManager) {
        throw new Error("Host manager unavailable");
      }
      return hostManager.setHostPrivacyScreen(Boolean(enabled));
    },
  );

  ipcMain.handle("velodeck:clipboard-write-text", (event, text: unknown) => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error("Untrusted IPC sender");
    }
    if (typeof text !== "string") {
      return false;
    }
    clipboard.writeText(text.slice(0, 64 * 1024));
    return true;
  });

  ipcMain.handle("velodeck:clipboard-read-text", (event) => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error("Untrusted IPC sender");
    }
    try {
      return clipboard.readText().slice(0, 64 * 1024);
    } catch {
      return "";
    }
  });
}

// Single-instance lock: second launch focuses existing window (or creates one if hidden)
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    focusOrCreateWindow();
  });

  app.on("before-quit", () => {
    isQuitting = true;
    hostManager?.dispose();
  });

  app.on("activate", () => {
    focusOrCreateWindow();
  });

  app.on("window-all-closed", () => {
    if (!tray && process.platform !== "darwin") {
      app.quit();
    }
  });

  void app.whenReady().then(() => {
    settingsFilePath = path.join(
      app.getPath("userData"),
      "desktop-settings.json",
    );
    settings = loadSettings(settingsFilePath);

    // Allow desktop capture permissions strictly for the isolated Host worker origin
    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback) => {
        const url = webContents.getURL();
        if (
          url.startsWith(`${HOST_WORKER_ORIGIN}/`) &&
          (permission === "media" || permission === "display-capture")
        ) {
          callback(true);
          return;
        }
        callback(false);
      },
    );

    registerStaticProtocol();
    hostManager = new HostManager({
      getSettings: () => settings,
      updateSettings: (mutator) => {
        mutator(settings);
        persistSettings();
        return settings;
      },
      getEffectiveServerUrl: () => settings.serverUrl || defaultServerUrl,
      desktopRootDir,
      onStateChanged: (nextState) => {
        broadcastHostState(nextState);
      },
    });
    hostManager.init();

    registerIpcHandlers();
    createSystemTray();
    refreshMenus();
    createMainWindow();
  });
}
