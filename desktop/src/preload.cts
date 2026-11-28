import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

export type DesktopPlatform = "darwin" | "win32" | "linux";
export type DesktopWindowPreset = "phone" | "compact" | "dashboard";
export type DesktopMenuCommand =
  | "toggle-black-screen"
  | "toggle-force-portrait"
  | "copy-screenshot"
  | "save-screenshot"
  | "open-server-settings"
  | "reconnect";

export interface DesktopBootstrapInfo {
  platform: DesktopPlatform;
  appVersion: string;
  defaultServerUrl: string;
}

export interface DesktopWindowState {
  alwaysOnTop: boolean;
  preset: DesktopWindowPreset;
  isFullScreen: boolean;
}

export interface DesktopServerConfig {
  serverUrl: string;
  recentServers: string[];
}

export interface DesktopDisplayInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  primary: boolean;
}

export interface DesktopHostPermissions {
  accessibility: boolean;
  screenCapture: boolean;
  platform: DesktopPlatform;
}

export interface DesktopHostState {
  enabled: boolean;
  status: "stopped" | "connecting" | "online" | "controlling" | "error";
  deviceId: string;
  deviceName: string;
  controlCode: string;
  controlPassword: string;
  ownerUsername: string;
  activeSessionId: string | null;
  activeTransport: "webrtc" | "ws-jpeg" | null;
  activeDisplayId: string;
  displays: DesktopDisplayInfo[];
  permissions: DesktopHostPermissions;
  lastError: string | null;
  lastReceivedFile: { fileName: string; savedPath: string; at: number } | null;
  autoLaunch: boolean;
  preventSleep: boolean;
  audioCaptureEnabled: boolean;
  clipboardAutoSync: boolean;
  privacyScreenActive: boolean;
}

export interface DesktopHostConfigPatch {
  deviceName?: string;
  controlPassword?: string;
  activeDisplayId?: string;
  autoLaunch?: boolean;
  preventSleep?: boolean;
  audioCaptureEnabled?: boolean;
  clipboardAutoSync?: boolean;
}

export interface VeloDeckDesktopBridge {
  readonly platform: DesktopPlatform;
  readonly appVersion: string;
  readonly defaultServerUrl: string;
  getWindowState(): Promise<DesktopWindowState>;
  onWindowStateChange(cb: (state: DesktopWindowState) => void): () => void;
  setAlwaysOnTop(enabled: boolean): Promise<DesktopWindowState>;
  setWindowPreset(preset: DesktopWindowPreset): Promise<DesktopWindowState>;
  openNewWindow(): Promise<void>;
  copyScreenshotPng(dataUrl: string): Promise<{ ok: boolean; error?: string }>;
  saveScreenshotPng(
    dataUrl: string,
    suggestedName: string,
  ): Promise<{
    ok: boolean;
    savedPath?: string;
    cancelled?: boolean;
    error?: string;
  }>;
  getServerConfig(): Promise<DesktopServerConfig>;
  setServerConfig(serverUrl: string): Promise<DesktopServerConfig>;
  removeRecentServer(serverUrl: string): Promise<DesktopServerConfig>;
  onCommand(cb: (command: DesktopMenuCommand) => void): () => void;
  getHostState(): Promise<DesktopHostState>;
  onHostStateChange(cb: (state: DesktopHostState) => void): () => void;
  startHost(authToken?: string | null): Promise<DesktopHostState>;
  stopHost(): Promise<DesktopHostState>;
  updateHostConfig(patch: DesktopHostConfigPatch): Promise<DesktopHostState>;
  regenerateHostPassword(): Promise<DesktopHostState>;
  bindHostAccount(authToken: string): Promise<DesktopHostState>;
  unbindHostAccount(): Promise<DesktopHostState>;
  selectHostDisplay(displayId: string): Promise<DesktopHostState>;
  disconnectHostSession(): Promise<DesktopHostState>;
  refreshHostPermissions(): Promise<DesktopHostPermissions>;
  openPermissionSettings(kind: "accessibility" | "screen"): Promise<void>;
  setHostPrivacyScreen(enabled: boolean): Promise<DesktopHostState>;
  writeClipboardText(text: string): Promise<boolean>;
  readClipboardText(): Promise<string>;
}

function readBootstrapInfo(): DesktopBootstrapInfo {
  try {
    const raw = ipcRenderer.sendSync("velodeck:get-bootstrap") as
      | Partial<DesktopBootstrapInfo>
      | undefined;
    const platform: DesktopPlatform =
      raw?.platform === "darwin" ||
      raw?.platform === "win32" ||
      raw?.platform === "linux"
        ? raw.platform
        : process.platform === "darwin" || process.platform === "win32"
          ? process.platform
          : "linux";
    return {
      platform,
      appVersion: typeof raw?.appVersion === "string" ? raw.appVersion : "0.0.0",
      defaultServerUrl:
        typeof raw?.defaultServerUrl === "string" ? raw.defaultServerUrl : "",
    };
  } catch {
    return {
      platform:
        process.platform === "darwin" || process.platform === "win32"
          ? process.platform
          : "linux",
      appVersion: "0.0.0",
      defaultServerUrl: "",
    };
  }
}

const bootstrap = readBootstrapInfo();

const bridge: VeloDeckDesktopBridge = Object.freeze({
  platform: bootstrap.platform,
  appVersion: bootstrap.appVersion,
  defaultServerUrl: bootstrap.defaultServerUrl,

  getWindowState(): Promise<DesktopWindowState> {
    return ipcRenderer.invoke("velodeck:window-get-state");
  },

  onWindowStateChange(cb: (state: DesktopWindowState) => void): () => void {
    if (typeof cb !== "function") {
      return () => {};
    }
    const wrapped = (
      _event: IpcRendererEvent,
      state: DesktopWindowState,
    ): void => {
      cb(state);
    };
    ipcRenderer.on("velodeck:window-state-changed", wrapped);
    return () => {
      ipcRenderer.removeListener("velodeck:window-state-changed", wrapped);
    };
  },

  setAlwaysOnTop(enabled: boolean): Promise<DesktopWindowState> {
    return ipcRenderer.invoke("velodeck:window-set-aot", Boolean(enabled));
  },

  setWindowPreset(preset: DesktopWindowPreset): Promise<DesktopWindowState> {
    return ipcRenderer.invoke("velodeck:window-set-preset", preset);
  },

  async openNewWindow(): Promise<void> {
    await ipcRenderer.invoke("velodeck:window-new");
  },

  copyScreenshotPng(
    dataUrl: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke("velodeck:screenshot-copy", dataUrl);
  },

  saveScreenshotPng(
    dataUrl: string,
    suggestedName: string,
  ): Promise<{
    ok: boolean;
    savedPath?: string;
    cancelled?: boolean;
    error?: string;
  }> {
    return ipcRenderer.invoke("velodeck:screenshot-save", {
      dataUrl,
      suggestedName,
    });
  },

  getServerConfig(): Promise<DesktopServerConfig> {
    return ipcRenderer.invoke("velodeck:server-get");
  },

  setServerConfig(serverUrl: string): Promise<DesktopServerConfig> {
    return ipcRenderer.invoke("velodeck:server-set", serverUrl);
  },

  removeRecentServer(serverUrl: string): Promise<DesktopServerConfig> {
    return ipcRenderer.invoke("velodeck:server-remove-recent", serverUrl);
  },

  onCommand(cb: (command: DesktopMenuCommand) => void): () => void {
    if (typeof cb !== "function") {
      return () => {};
    }
    const wrapped = (
      _event: IpcRendererEvent,
      command: DesktopMenuCommand,
    ): void => {
      cb(command);
    };
    ipcRenderer.on("velodeck:menu-command", wrapped);
    return () => {
      ipcRenderer.removeListener("velodeck:menu-command", wrapped);
    };
  },

  getHostState(): Promise<DesktopHostState> {
    return ipcRenderer.invoke("velodeck:host-get-state");
  },

  onHostStateChange(cb: (state: DesktopHostState) => void): () => void {
    if (typeof cb !== "function") {
      return () => {};
    }
    const wrapped = (
      _event: IpcRendererEvent,
      state: DesktopHostState,
    ): void => {
      cb(state);
    };
    ipcRenderer.on("velodeck:host-state-changed", wrapped);
    return () => {
      ipcRenderer.removeListener("velodeck:host-state-changed", wrapped);
    };
  },

  startHost(authToken?: string | null): Promise<DesktopHostState> {
    return ipcRenderer.invoke("velodeck:host-start", authToken ?? null);
  },

  stopHost(): Promise<DesktopHostState> {
    return ipcRenderer.invoke("velodeck:host-stop");
  },

  updateHostConfig(patch: DesktopHostConfigPatch): Promise<DesktopHostState> {
    return ipcRenderer.invoke("velodeck:host-update-config", patch);
  },

  regenerateHostPassword(): Promise<DesktopHostState> {
    return ipcRenderer.invoke("velodeck:host-regenerate-password");
  },

  bindHostAccount(authToken: string): Promise<DesktopHostState> {
    return ipcRenderer.invoke("velodeck:host-bind-account", authToken);
  },

  unbindHostAccount(): Promise<DesktopHostState> {
    return ipcRenderer.invoke("velodeck:host-unbind-account");
  },

  selectHostDisplay(displayId: string): Promise<DesktopHostState> {
    return ipcRenderer.invoke("velodeck:host-select-display", displayId);
  },

  disconnectHostSession(): Promise<DesktopHostState> {
    return ipcRenderer.invoke("velodeck:host-disconnect-session");
  },

  refreshHostPermissions(): Promise<DesktopHostPermissions> {
    return ipcRenderer.invoke("velodeck:host-refresh-permissions");
  },

  async openPermissionSettings(kind: "accessibility" | "screen"): Promise<void> {
    await ipcRenderer.invoke("velodeck:host-open-permission-settings", kind);
  },

  setHostPrivacyScreen(enabled: boolean): Promise<DesktopHostState> {
    return ipcRenderer.invoke("velodeck:host-set-privacy-screen", Boolean(enabled));
  },

  writeClipboardText(text: string): Promise<boolean> {
    return ipcRenderer.invoke("velodeck:clipboard-write-text", text);
  },

  readClipboardText(): Promise<string> {
    return ipcRenderer.invoke("velodeck:clipboard-read-text");
  },
});

contextBridge.exposeInMainWorld("velodeckDesktop", bridge);
