import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  screen,
  shell,
  systemPreferences,
  type Display,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import {
  NativeInputInjector,
  type DisplayBounds,
  type InputPlatform,
} from "./inputInjector";
import {
  ensureHostSettings,
  generateHostControlPassword,
  normalizeServerUrl,
  sanitizeHostAuthToken,
  sanitizeHostControlPassword,
  sanitizeHostDeviceName,
  sanitizeHostDisplayId,
  type DesktopSettings,
} from "./settings";
import type {
  HostCaptureSourceResult,
  HostWorkerCommand,
  HostWorkerConfig,
  HostWorkerStateReport,
} from "./hostWorkerPreload.cjs";

export const HOST_WORKER_HOST = "velodeck-host";
export const HOST_WORKER_ORIGIN = `app://${HOST_WORKER_HOST}`;
export const HOST_WORKER_ENTRY_URL = `${HOST_WORKER_ORIGIN}/hostWorker.html`;

export type DesktopPlatform = InputPlatform;

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
}

export interface DesktopHostConfigPatch {
  deviceName?: string;
  controlPassword?: string;
  activeDisplayId?: string;
}

export interface HostManagerDeps {
  getSettings: () => DesktopSettings;
  updateSettings: (mutator: (draft: DesktopSettings) => void) => DesktopSettings;
  getEffectiveServerUrl: () => string;
  desktopRootDir: string;
  onStateChanged: (state: DesktopHostState) => void;
}

interface ActiveIncomingFile {
  sessionId: string;
  transferId: string;
  sanitizedName: string;
  expectedSize: number;
  expectedSha256: string | null;
  tempPath: string;
  fd: number;
  hash: crypto.Hash;
  receivedBytes: number;
  lastProgressBytes: number;
  lastProgressAt: number;
}

const MAX_INCOMING_FILE_BYTES = 256 * 1024 * 1024;
const PROGRESS_INTERVAL_BYTES = 262_144;
const PROGRESS_INTERVAL_MS = 250;
const MAX_FILE_NAME_LENGTH = 120;

export function formatHostControlCode(raw: string): string {
  const digits = raw.replace(/[\s-]+/g, "").trim();
  if (digits.length !== 9) return digits;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 9)}`;
}

function deriveRelayWsUrl(baseUrl: string): string {
  const normalized = normalizeServerUrl(baseUrl);
  if (!normalized) {
    return "";
  }
  try {
    const parsed = new URL(normalized);
    const wsProto = parsed.protocol === "https:" ? "wss:" : "ws:";
    const basePath = parsed.pathname.replace(/\/+$/, "");
    return `${wsProto}//${parsed.host}${basePath}/ws`;
  } catch {
    return "";
  }
}

function getDesktopPlatform(): DesktopPlatform {
  if (process.platform === "darwin" || process.platform === "win32") {
    return process.platform;
  }
  return "linux";
}

function getOsVersionLabel(platform: DesktopPlatform): string {
  let ver = "";
  try {
    ver =
      typeof process.getSystemVersion === "function"
        ? process.getSystemVersion()
        : "";
  } catch {
    ver = "";
  }
  if (platform === "darwin") {
    const major = ver.split(".")[0];
    return major ? `macOS ${major}` : "macOS";
  }
  if (platform === "win32") {
    const build = Number(ver.split(".")[2] ?? 0);
    if (build >= 22000) return "Windows 11";
    return ver ? `Windows ${ver.split(".")[0]}` : "Windows";
  }
  return ver ? `Linux ${ver}` : "Linux";
}

function getModelLabel(platform: DesktopPlatform): string {
  const arch = process.arch;
  if (platform === "darwin") {
    return arch === "arm64" ? "Apple Silicon Mac" : "Intel Mac";
  }
  if (platform === "win32") {
    return `Windows PC (${arch})`;
  }
  return `Linux Desktop (${arch})`;
}

function sanitizeIncomingFileName(raw: unknown): string {
  const fallback = "received_file";
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return fallback;
  }
  let cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .split("/")
    .pop()!
    .split("\\")
    .pop()!
    .replace(/[<>:"|?*]/g, "-");

  while (cleaned.includes("..")) {
    cleaned = cleaned.replace("..", ".");
  }
  cleaned = cleaned.replace(/^[\s.]+|[\s.]+$/g, "");
  if (!cleaned) {
    return fallback;
  }
  if (cleaned.length > MAX_FILE_NAME_LENGTH) {
    const lastDot = cleaned.lastIndexOf(".");
    if (lastDot > 0 && lastDot < cleaned.length - 1) {
      const ext = cleaned.slice(lastDot);
      if (ext.length >= 2 && ext.length <= 20) {
        const stemBudget = Math.max(1, MAX_FILE_NAME_LENGTH - ext.length);
        const stem = cleaned.slice(0, stemBudget).replace(/[\s.]+$/g, "");
        cleaned = (stem || "file") + ext;
      } else {
        cleaned = cleaned.slice(0, MAX_FILE_NAME_LENGTH).replace(/[\s.]+$/g, "");
      }
    } else {
      cleaned = cleaned.slice(0, MAX_FILE_NAME_LENGTH).replace(/[\s.]+$/g, "");
    }
  }
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return fallback;
  }
  return cleaned;
}

function normalizeSha256(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null;
}

function resolveUniqueFilePath(dir: string, fileName: string): string {
  let candidate = path.join(dir, fileName);
  if (!fs.existsSync(candidate)) {
    return candidate;
  }
  const ext = path.extname(fileName);
  const stem = ext ? fileName.slice(0, -ext.length) : fileName;
  for (let i = 1; i <= 999; i += 1) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(dir, `${stem}_${Date.now()}${ext}`);
}

export class HostManager {
  private readonly deps: HostManagerDeps;
  private readonly platform: DesktopPlatform;
  private readonly injector: NativeInputInjector;

  private workerWindow: BrowserWindow | null = null;
  private workerReady = false;
  private workerReadyResolvers: Array<() => void> = [];
  private disposed = false;
  private pendingUnbindOwner = false;
  private ipcRegistered = false;
  private screenListenersAttached = false;
  private activeFileTransfer: ActiveIncomingFile | null = null;

  private state: DesktopHostState;

  private readonly handleDisplayTopologyChanged = (): void => {
    this.syncDisplays(true);
  };

  constructor(deps: HostManagerDeps) {
    this.deps = deps;
    this.platform = getDesktopPlatform();
    this.injector = new NativeInputInjector({
      platform: this.platform,
      resourcesPath: process.resourcesPath,
      desktopRootDir: deps.desktopRootDir,
      isPackaged: app.isPackaged,
      mapPoint:
        this.platform === "win32"
          ? (pt) => screen.dipToScreenPoint(pt)
          : undefined,
    });

    const ensured = ensureHostSettings(deps.getSettings());
    if (ensured.changed) {
      deps.updateSettings((draft) => {
        draft.hostDeviceId = ensured.settings.hostDeviceId;
        draft.hostDeviceSecret = ensured.settings.hostDeviceSecret;
        draft.hostDeviceName = ensured.settings.hostDeviceName;
        draft.hostControlPassword = ensured.settings.hostControlPassword;
      });
    }
    const currentSettings = deps.getSettings();
    const displays = this.collectDisplays();
    const activeDisplayId = this.resolveActiveDisplayId(
      currentSettings.hostDisplayId,
      displays,
    );

    this.state = {
      enabled: Boolean(currentSettings.hostEnabled),
      status: "stopped",
      deviceId: currentSettings.hostDeviceId ?? "",
      deviceName: currentSettings.hostDeviceName ?? "",
      controlCode: "",
      controlPassword: currentSettings.hostControlPassword ?? "",
      ownerUsername: "",
      activeSessionId: null,
      activeTransport: null,
      activeDisplayId,
      displays,
      permissions: {
        accessibility: this.platform !== "darwin",
        screenCapture: this.platform !== "darwin",
        platform: this.platform,
      },
      lastError: null,
      lastReceivedFile: null,
    };
  }

  public init(): void {
    this.registerWorkerIpcHandlers();
    this.attachScreenListeners();
    void this.refreshHostPermissions().then(() => {
      if (!this.disposed && this.deps.getSettings().hostEnabled) {
        void this.startHost();
      }
    });
  }

  public isWorkerWindow(win: BrowserWindow | null | undefined): boolean {
    return Boolean(win && this.workerWindow && win === this.workerWindow);
  }

  public getHostState(): DesktopHostState {
    return {
      ...this.state,
      displays: this.state.displays.map((d) => ({ ...d })),
      permissions: { ...this.state.permissions },
      lastReceivedFile: this.state.lastReceivedFile
        ? { ...this.state.lastReceivedFile }
        : null,
    };
  }

  public async startHost(authToken?: string | null): Promise<DesktopHostState> {
    if (this.disposed) {
      return this.getHostState();
    }

    const ensured = ensureHostSettings(this.deps.getSettings());
    const cleanToken = sanitizeHostAuthToken(authToken);

    this.deps.updateSettings((draft) => {
      draft.hostEnabled = true;
      draft.hostDeviceId = ensured.settings.hostDeviceId;
      draft.hostDeviceSecret = ensured.settings.hostDeviceSecret;
      draft.hostDeviceName = ensured.settings.hostDeviceName;
      draft.hostControlPassword = ensured.settings.hostControlPassword;
      if (cleanToken) {
        draft.hostAuthToken = cleanToken;
      }
    });

    if (cleanToken) {
      this.pendingUnbindOwner = false;
    }

    await this.refreshHostPermissionsInternal(false);
    this.syncDisplays(false);

    const cfg = this.buildWorkerConfig();
    if (!cfg.wsUrl) {
      this.patchState({
        enabled: true,
        status: "error",
        deviceId: cfg.deviceId,
        deviceName: cfg.name,
        controlPassword: cfg.controlPassword,
        lastError: "请先配置 VeloDeck 服务器地址后再开启本机被控",
      });
      return this.getHostState();
    }

    this.patchState({
      enabled: true,
      status: "connecting",
      deviceId: cfg.deviceId,
      deviceName: cfg.name,
      controlPassword: cfg.controlPassword,
      lastError: null,
    });

    await this.ensureWorkerReady();
    this.sendWorkerCommand({ type: "start", config: cfg });
    return this.getHostState();
  }

  public async stopHost(): Promise<DesktopHostState> {
    this.deps.updateSettings((draft) => {
      draft.hostEnabled = false;
    });
    this.cleanupActiveFileTransfer();
    this.injector.releaseAll();
    if (this.workerWindow && !this.workerWindow.isDestroyed() && this.workerReady) {
      this.sendWorkerCommand({ type: "stop" });
    }
    this.patchState({
      enabled: false,
      status: "stopped",
      activeSessionId: null,
      activeTransport: null,
      lastError: null,
    });
    return this.getHostState();
  }

  public async updateHostConfig(
    patch: DesktopHostConfigPatch,
  ): Promise<DesktopHostState> {
    let needsReconnect = false;
    let switchDisplayId: string | undefined;

    const current = this.deps.getSettings();
    let nextName = current.hostDeviceName;
    let nextPassword = current.hostControlPassword;
    let nextDisplayId = this.state.activeDisplayId;

    if (patch.deviceName !== undefined) {
      const sanitized = sanitizeHostDeviceName(patch.deviceName);
      if (!sanitized) {
        throw new Error("设备名称不能为空");
      }
      if (sanitized !== current.hostDeviceName) {
        nextName = sanitized;
        needsReconnect = true;
      }
    }

    if (patch.controlPassword !== undefined) {
      const sanitized = sanitizeHostControlPassword(patch.controlPassword);
      if (!sanitized) {
        throw new Error("无人值守密码需为 8-64 位非空字符");
      }
      if (sanitized !== current.hostControlPassword) {
        nextPassword = sanitized;
        needsReconnect = true;
      }
    }

    if (patch.activeDisplayId !== undefined) {
      const sanitized = sanitizeHostDisplayId(patch.activeDisplayId);
      const displays = this.collectDisplays();
      if (sanitized && displays.some((d) => d.id === sanitized)) {
        if (sanitized !== this.state.activeDisplayId) {
          nextDisplayId = sanitized;
          switchDisplayId = sanitized;
        }
      } else {
        throw new Error("指定的显示器不存在或已断开");
      }
    }

    this.deps.updateSettings((draft) => {
      if (nextName) draft.hostDeviceName = nextName;
      if (nextPassword) draft.hostControlPassword = nextPassword;
      if (nextDisplayId) draft.hostDisplayId = nextDisplayId;
    });

    this.patchState({
      deviceName: nextName ?? this.state.deviceName,
      controlPassword: nextPassword ?? this.state.controlPassword,
      activeDisplayId: nextDisplayId,
    });

    if (this.state.enabled) {
      await this.pushConfigToWorker(needsReconnect, switchDisplayId);
    }

    return this.getHostState();
  }

  public async regenerateHostPassword(): Promise<DesktopHostState> {
    const nextPassword = generateHostControlPassword(8);
    this.deps.updateSettings((draft) => {
      draft.hostControlPassword = nextPassword;
    });
    this.patchState({
      controlPassword: nextPassword,
    });
    if (this.state.enabled) {
      await this.pushConfigToWorker(true);
    }
    return this.getHostState();
  }

  public async bindHostAccount(authToken: string): Promise<DesktopHostState> {
    const cleanToken = sanitizeHostAuthToken(authToken);
    if (!cleanToken) {
      throw new Error("无效的账号登录凭证");
    }
    this.pendingUnbindOwner = false;
    this.deps.updateSettings((draft) => {
      draft.hostAuthToken = cleanToken;
    });
    if (this.state.enabled) {
      await this.pushConfigToWorker(true);
    }
    return this.getHostState();
  }

  public async unbindHostAccount(): Promise<DesktopHostState> {
    this.pendingUnbindOwner = true;
    this.deps.updateSettings((draft) => {
      delete draft.hostAuthToken;
    });
    this.patchState({ ownerUsername: "" });
    if (this.state.enabled) {
      await this.pushConfigToWorker(true);
    }
    return this.getHostState();
  }

  public async selectHostDisplay(displayId: string): Promise<DesktopHostState> {
    return this.updateHostConfig({ activeDisplayId: displayId });
  }

  public async disconnectHostSession(): Promise<DesktopHostState> {
    this.cleanupActiveFileTransfer();
    this.injector.releaseAll();
    if (this.workerWindow && !this.workerWindow.isDestroyed() && this.workerReady) {
      this.sendWorkerCommand({
        type: "disconnect-session",
        reason: "host_owner_disconnected",
      });
    }
    this.patchState({
      status: this.state.enabled ? "online" : "stopped",
      activeSessionId: null,
      activeTransport: null,
    });
    return this.getHostState();
  }

  public async refreshHostPermissions(): Promise<DesktopHostPermissions> {
    return this.refreshHostPermissionsInternal(true);
  }

  public async openPermissionSettings(
    kind: "accessibility" | "screen",
  ): Promise<void> {
    if (this.platform !== "darwin") {
      return;
    }
    if (kind === "accessibility") {
      try {
        systemPreferences.isTrustedAccessibilityClient(true);
      } catch {
        // Ignore
      }
      await this.injector.requestAccessibility();
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
      return;
    }
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    );
  }

  public async onServerUrlChanged(): Promise<void> {
    if (!this.state.enabled || this.disposed) {
      return;
    }
    const cfg = this.buildWorkerConfig();
    if (!cfg.wsUrl) {
      if (this.workerWindow && !this.workerWindow.isDestroyed() && this.workerReady) {
        this.sendWorkerCommand({ type: "stop" });
      }
      this.patchState({
        status: "error",
        activeSessionId: null,
        activeTransport: null,
        lastError: "未配置有效的 VeloDeck 服务器地址",
      });
      return;
    }
    await this.ensureWorkerReady();
    this.sendWorkerCommand({ type: "start", config: cfg });
  }

  public dispose(): void {
    this.disposed = true;
    this.cleanupActiveFileTransfer();
    this.detachScreenListeners();
    this.injector.dispose();
    if (this.workerWindow && !this.workerWindow.isDestroyed()) {
      try {
        this.workerWindow.destroy();
      } catch {
        // Ignore
      }
    }
    this.workerWindow = null;
    this.workerReady = false;
  }

  private async refreshHostPermissionsInternal(
    notifyWorker: boolean,
  ): Promise<DesktopHostPermissions> {
    let permissions: DesktopHostPermissions;
    if (this.platform !== "darwin") {
      permissions = {
        accessibility: true,
        screenCapture: true,
        platform: this.platform,
      };
    } else {
      const helperCheck = await this.injector.checkPermissions();
      let electronAcc = false;
      let electronScreen = false;
      try {
        electronAcc = systemPreferences.isTrustedAccessibilityClient(false);
      } catch {
        electronAcc = false;
      }
      try {
        electronScreen =
          systemPreferences.getMediaAccessStatus("screen") === "granted";
      } catch {
        electronScreen = false;
      }
      permissions = {
        accessibility: Boolean(helperCheck.accessibility || electronAcc),
        screenCapture: Boolean(helperCheck.screenCapture || electronScreen),
        platform: "darwin",
      };
    }

    const changed =
      permissions.accessibility !== this.state.permissions.accessibility ||
      permissions.screenCapture !== this.state.permissions.screenCapture;

    if (changed) {
      this.patchState({ permissions });
      if (notifyWorker && this.state.enabled) {
        await this.pushConfigToWorker(false);
      }
    }
    return { ...permissions };
  }

  private collectDisplays(): DesktopDisplayInfo[] {
    try {
      const primary = screen.getPrimaryDisplay();
      const all = screen.getAllDisplays();
      const sorted = [
        primary,
        ...all.filter((d) => d.id !== primary.id),
      ];
      return sorted.map((d, idx) => {
        const isPrimary = d.id === primary.id;
        const label =
          typeof d.label === "string" && d.label.trim().length > 0
            ? d.label.trim()
            : isPrimary
              ? "主显示器"
              : `显示器 ${idx + 1}`;
        return {
          id: String(d.id),
          name: label,
          width: Math.max(1, Math.round(d.bounds.width)),
          height: Math.max(1, Math.round(d.bounds.height)),
          primary: isPrimary,
        };
      });
    } catch {
      return [
        {
          id: "0",
          name: "主显示器",
          width: 1920,
          height: 1080,
          primary: true,
        },
      ];
    }
  }

  private resolveActiveDisplayId(
    preferredId: string | undefined,
    displays: DesktopDisplayInfo[],
  ): string {
    if (preferredId && displays.some((d) => d.id === preferredId)) {
      return preferredId;
    }
    const primary = displays.find((d) => d.primary);
    return primary?.id ?? displays[0]?.id ?? "0";
  }

  private resolveDisplayBounds(displayId?: string): DisplayBounds {
    try {
      const all: Display[] = screen.getAllDisplays();
      const targetId = displayId || this.state.activeDisplayId;
      const matched =
        all.find((d) => String(d.id) === targetId) ?? screen.getPrimaryDisplay();
      return {
        x: matched.bounds.x,
        y: matched.bounds.y,
        width: matched.bounds.width,
        height: matched.bounds.height,
      };
    } catch {
      return { x: 0, y: 0, width: 1920, height: 1080 };
    }
  }

  private syncDisplays(notifyWorker: boolean): void {
    const displays = this.collectDisplays();
    const nextActiveId = this.resolveActiveDisplayId(
      this.state.activeDisplayId,
      displays,
    );
    const activeChanged = nextActiveId !== this.state.activeDisplayId;
    this.patchState({
      displays,
      activeDisplayId: nextActiveId,
    });
    if (notifyWorker && this.state.enabled) {
      void this.pushConfigToWorker(false, activeChanged ? nextActiveId : undefined);
    }
  }

  private attachScreenListeners(): void {
    if (this.screenListenersAttached) return;
    this.screenListenersAttached = true;
    screen.on("display-added", this.handleDisplayTopologyChanged);
    screen.on("display-removed", this.handleDisplayTopologyChanged);
    screen.on("display-metrics-changed", this.handleDisplayTopologyChanged);
  }

  private detachScreenListeners(): void {
    if (!this.screenListenersAttached) return;
    this.screenListenersAttached = false;
    screen.removeListener("display-added", this.handleDisplayTopologyChanged);
    screen.removeListener("display-removed", this.handleDisplayTopologyChanged);
    screen.removeListener("display-metrics-changed", this.handleDisplayTopologyChanged);
  }

  private buildWorkerConfig(): HostWorkerConfig {
    const s = this.deps.getSettings();
    const wsUrl = deriveRelayWsUrl(this.deps.getEffectiveServerUrl());
    const displays = this.state.displays.length > 0 ? this.state.displays : this.collectDisplays();
    const activeDisplayId = this.resolveActiveDisplayId(
      s.hostDisplayId ?? this.state.activeDisplayId,
      displays,
    );

    return {
      wsUrl,
      deviceId: s.hostDeviceId ?? this.state.deviceId,
      deviceSecret: s.hostDeviceSecret ?? "",
      authToken: this.pendingUnbindOwner ? undefined : s.hostAuthToken,
      unbindOwner: this.pendingUnbindOwner || undefined,
      controlPassword: s.hostControlPassword ?? this.state.controlPassword,
      name: s.hostDeviceName ?? this.state.deviceName,
      model: getModelLabel(this.platform),
      osVersion: getOsVersionLabel(this.platform),
      osPlatform: this.platform,
      displays,
      activeDisplayId,
      permissions: { ...this.state.permissions },
    };
  }

  private async pushConfigToWorker(
    reconnect: boolean,
    switchDisplayId?: string,
  ): Promise<void> {
    const cfg = this.buildWorkerConfig();
    if (!cfg.wsUrl) {
      return;
    }
    await this.ensureWorkerReady();
    this.sendWorkerCommand({
      type: "update-config",
      config: cfg,
      reconnect,
      switchDisplayId,
    });
  }

  private async ensureWorkerReady(): Promise<void> {
    if (
      this.workerWindow &&
      !this.workerWindow.isDestroyed() &&
      this.workerReady
    ) {
      return;
    }

    if (!this.workerWindow || this.workerWindow.isDestroyed()) {
      this.workerReady = false;
      const win = new BrowserWindow({
        width: 320,
        height: 240,
        show: false,
        skipTaskbar: true,
        focusable: false,
        webPreferences: {
          preload: path.join(__dirname, "hostWorkerPreload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          backgroundThrottling: false,
        },
      });
      this.workerWindow = win;

      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event, targetUrl) => {
        if (!targetUrl.startsWith(`${HOST_WORKER_ORIGIN}/`)) {
          event.preventDefault();
        }
      });

      win.on("closed", () => {
        if (this.workerWindow === win) {
          this.workerWindow = null;
          this.workerReady = false;
        }
      });

      void win.loadURL(HOST_WORKER_ENTRY_URL);
    }

    if (this.workerReady) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        resolve();
      }, 5000);
      this.workerReadyResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private sendWorkerCommand(command: HostWorkerCommand): void {
    if (
      !this.workerWindow ||
      this.workerWindow.isDestroyed() ||
      this.workerWindow.webContents.isDestroyed()
    ) {
      return;
    }
    this.workerWindow.webContents.send("velodeck-host:command", command);
  }

  private isTrustedWorkerEvent(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    if (!this.workerWindow || this.workerWindow.isDestroyed()) {
      return false;
    }
    if (event.sender !== this.workerWindow.webContents) {
      return false;
    }
    const frameUrl = event.senderFrame?.url ?? event.sender.getURL();
    return frameUrl.startsWith(`${HOST_WORKER_ORIGIN}/`);
  }

  private registerWorkerIpcHandlers(): void {
    if (this.ipcRegistered) return;
    this.ipcRegistered = true;

    ipcMain.on("velodeck-host:ready", (event) => {
      if (!this.isTrustedWorkerEvent(event)) return;
      this.workerReady = true;
      const resolvers = this.workerReadyResolvers.splice(
        0,
        this.workerReadyResolvers.length,
      );
      resolvers.forEach((fn) => fn());
    });

    ipcMain.on(
      "velodeck-host:state",
      (event, rawReport: HostWorkerStateReport) => {
        if (!this.isTrustedWorkerEvent(event)) return;
        if (!rawReport || typeof rawReport !== "object") return;

        const patch: Partial<DesktopHostState> = {};
        if (rawReport.status) patch.status = rawReport.status;
        if (typeof rawReport.controlCode === "string") {
          patch.controlCode = rawReport.controlCode;
        }
        if (typeof rawReport.ownerUsername === "string") {
          patch.ownerUsername = rawReport.ownerUsername;
          if (!rawReport.ownerUsername && this.pendingUnbindOwner) {
            this.pendingUnbindOwner = false;
          }
        }
        if (rawReport.activeSessionId !== undefined) {
          if (this.state.activeSessionId && !rawReport.activeSessionId) {
            this.injector.releaseAll();
            this.cleanupActiveFileTransfer();
          }
          patch.activeSessionId = rawReport.activeSessionId;
        }
        if (rawReport.activeTransport !== undefined) {
          patch.activeTransport = rawReport.activeTransport;
        }
        if (
          typeof rawReport.activeDisplayId === "string" &&
          rawReport.activeDisplayId
        ) {
          patch.activeDisplayId = rawReport.activeDisplayId;
        }
        if (rawReport.lastError !== undefined) {
          patch.lastError = rawReport.lastError;
        }

        this.patchState(patch);
      },
    );

    ipcMain.handle(
      "velodeck-host:get-capture-source",
      async (event, requestedDisplayId: unknown): Promise<HostCaptureSourceResult> => {
        if (!this.isTrustedWorkerEvent(event)) {
          return { ok: false, error: "Untrusted worker IPC sender" };
        }
        const displays = this.collectDisplays();
        const targetId = this.resolveActiveDisplayId(
          typeof requestedDisplayId === "string" && requestedDisplayId
            ? requestedDisplayId
            : this.state.activeDisplayId,
          displays,
        );
        const targetDisplay =
          displays.find((d) => d.id === targetId) ?? displays[0]!;

        try {
          const sources = await desktopCapturer.getSources({
            types: ["screen"],
            thumbnailSize: { width: 0, height: 0 },
          });
          if (!sources || sources.length === 0) {
            return {
              ok: false,
              error:
                "未检测到可采集的屏幕源，请检查 macOS「屏幕录制」系统权限是否已授予 VeloDeck",
            };
          }
          const matched =
            sources.find((s) => s.display_id && s.display_id === targetDisplay.id) ??
            sources.find((s) => s.display_id === String(screen.getPrimaryDisplay().id)) ??
            sources[0]!;

          if (targetDisplay.id !== this.state.activeDisplayId) {
            this.deps.updateSettings((draft) => {
              draft.hostDisplayId = targetDisplay.id;
            });
            this.patchState({
              displays,
              activeDisplayId: targetDisplay.id,
            });
          }

          return {
            ok: true,
            sourceId: matched.id,
            display: targetDisplay,
            displays,
          };
        } catch (error) {
          return {
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "获取桌面屏幕源失败，请确认已开启屏幕录制权限",
          };
        }
      },
    );

    ipcMain.handle(
      "velodeck-host:control-cmd",
      (
        event,
        payload: unknown,
      ): { ok: boolean; message?: string } => {
        if (!this.isTrustedWorkerEvent(event)) {
          return { ok: false, message: "Untrusted worker IPC sender" };
        }
        if (!payload || typeof payload !== "object") {
          return { ok: false, message: "Invalid control payload" };
        }
        const { cmd, displayId } = payload as {
          cmd?: Record<string, unknown>;
          displayId?: string;
        };
        if (!cmd || typeof cmd !== "object") {
          return { ok: false, message: "Missing command object" };
        }
        if (this.platform === "darwin" && !this.state.permissions.accessibility) {
          // Re-check synchronously once in case user just toggled Accessibility on
          try {
            if (systemPreferences.isTrustedAccessibilityClient(false)) {
              this.patchState({
                permissions: {
                  ...this.state.permissions,
                  accessibility: true,
                },
              });
            }
          } catch {
            // Ignore
          }
        }
        const bounds = this.resolveDisplayBounds(displayId);
        const res = this.injector.injectCommand(cmd, bounds);
        if (!res.ok) {
          return {
            ok: false,
            message:
              this.platform === "darwin"
                ? "输入注入失败，请确认已在系统设置中授予 VeloDeck「辅助功能」权限"
                : "本机输入助手未能执行控制指令",
          };
        }
        return { ok: true };
      },
    );

    ipcMain.handle(
      "velodeck-host:clipboard-set",
      (event, text: unknown): boolean => {
        if (!this.isTrustedWorkerEvent(event)) {
          return false;
        }
        if (typeof text !== "string") {
          return false;
        }
        clipboard.writeText(text.slice(0, 64 * 1024));
        return true;
      },
    );

    ipcMain.handle(
      "velodeck-host:file-text",
      (event, payload: unknown): string | null => {
        if (!this.isTrustedWorkerEvent(event)) {
          return null;
        }
        if (!payload || typeof payload !== "object") return null;
        const { sessionId, text } = payload as {
          sessionId?: string;
          text?: string;
        };
        if (typeof sessionId !== "string" || typeof text !== "string") {
          return null;
        }
        return this.handleFileTransferText(sessionId, text);
      },
    );

    ipcMain.handle(
      "velodeck-host:file-binary",
      (event, payload: unknown): string | null => {
        if (!this.isTrustedWorkerEvent(event)) {
          return null;
        }
        if (!payload || typeof payload !== "object") return null;
        const { sessionId, chunk } = payload as {
          sessionId?: string;
          chunk?: Uint8Array | Buffer;
        };
        if (typeof sessionId !== "string" || !(chunk instanceof Uint8Array)) {
          return null;
        }
        return this.handleFileTransferBinary(sessionId, chunk);
      },
    );

    ipcMain.on("velodeck-host:file-abort", (event, sessionId: unknown) => {
      if (!this.isTrustedWorkerEvent(event)) return;
      if (
        typeof sessionId === "string" &&
        this.activeFileTransfer?.sessionId === sessionId
      ) {
        this.cleanupActiveFileTransfer();
      }
    });
  }

  private handleFileTransferText(sessionId: string, rawText: string): string | null {
    let parsed: Record<string, unknown>;
    try {
      const obj: unknown = JSON.parse(rawText);
      if (!obj || typeof obj !== "object") {
        return JSON.stringify({
          type: "file.error",
          transferId: "",
          error: "无效的文件传输消息格式",
        });
      }
      parsed = obj as Record<string, unknown>;
    } catch {
      return JSON.stringify({
        type: "file.error",
        transferId: "",
        error: "无效的文件传输消息格式",
      });
    }

    const type = typeof parsed.type === "string" ? parsed.type : "";
    switch (type) {
      case "file.offer":
        return this.handleFileOffer(sessionId, parsed);
      case "file.complete":
        return this.handleFileComplete(sessionId, parsed);
      case "file.cancel": {
        const tid = typeof parsed.transferId === "string" ? parsed.transferId.trim() : "";
        if (
          this.activeFileTransfer &&
          this.activeFileTransfer.sessionId === sessionId &&
          (!tid || this.activeFileTransfer.transferId === tid)
        ) {
          this.cleanupActiveFileTransfer();
        }
        return null;
      }
      default:
        return null;
    }
  }

  private handleFileOffer(
    sessionId: string,
    msg: Record<string, unknown>,
  ): string {
    this.cleanupActiveFileTransfer();

    const transferId =
      typeof msg.transferId === "string" ? msg.transferId.trim() : "";
    const rawFileName =
      typeof msg.fileName === "string" ? msg.fileName.trim() : "";
    const size = typeof msg.size === "number" ? Math.floor(msg.size) : -1;
    const rawSha = msg.sha256;

    if (!transferId || transferId.length > 128) {
      return JSON.stringify({
        type: "file.error",
        transferId,
        error: "缺少有效的传输 ID",
      });
    }
    if (!rawFileName) {
      return JSON.stringify({
        type: "file.error",
        transferId,
        error: "缺少有效的文件名",
      });
    }
    if (!Number.isFinite(size) || size <= 0 || size > MAX_INCOMING_FILE_BYTES) {
      return JSON.stringify({
        type: "file.error",
        transferId,
        error: "文件大小无效或超过 256 MB 限制",
      });
    }

    let expectedSha256: string | null = null;
    if (typeof rawSha === "string" && rawSha.trim().length > 0) {
      expectedSha256 = normalizeSha256(rawSha);
      if (!expectedSha256) {
        return JSON.stringify({
          type: "file.error",
          transferId,
          error: "无效的 SHA-256 校验值",
        });
      }
    }

    const sanitizedName = sanitizeIncomingFileName(rawFileName);
    const downloadsDir = path.join(app.getPath("downloads"), "VeloDeck");
    const safeId = transferId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "transfer";
    const tempPath = path.join(downloadsDir, `.velodeck-incoming-${safeId}.tmp`);

    try {
      fs.mkdirSync(downloadsDir, { recursive: true });
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      const fd = fs.openSync(tempPath, "w", 0o644);
      this.activeFileTransfer = {
        sessionId,
        transferId,
        sanitizedName,
        expectedSize: size,
        expectedSha256,
        tempPath,
        fd,
        hash: crypto.createHash("sha256"),
        receivedBytes: 0,
        lastProgressBytes: 0,
        lastProgressAt: Date.now(),
      };
      return JSON.stringify({
        type: "file.accept",
        transferId,
      });
    } catch (error) {
      this.cleanupActiveFileTransfer();
      return JSON.stringify({
        type: "file.error",
        transferId,
        error: `无法创建下载临时文件: ${error instanceof Error ? error.message : "IO error"}`,
      });
    }
  }

  private handleFileTransferBinary(
    sessionId: string,
    chunk: Uint8Array,
  ): string | null {
    const transfer = this.activeFileTransfer;
    if (!transfer || transfer.sessionId !== sessionId || chunk.byteLength === 0) {
      return null;
    }

    const nextTotal = transfer.receivedBytes + chunk.byteLength;
    if (nextTotal > transfer.expectedSize) {
      const tid = transfer.transferId;
      this.cleanupActiveFileTransfer();
      return JSON.stringify({
        type: "file.error",
        transferId: tid,
        error: "接收字节数超出声明大小，传输已中止",
      });
    }

    try {
      const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      fs.writeSync(transfer.fd, buf);
      transfer.hash.update(buf);
      transfer.receivedBytes = nextTotal;

      const now = Date.now();
      if (
        transfer.receivedBytes - transfer.lastProgressBytes >= PROGRESS_INTERVAL_BYTES ||
        now - transfer.lastProgressAt >= PROGRESS_INTERVAL_MS ||
        transfer.receivedBytes === transfer.expectedSize
      ) {
        transfer.lastProgressBytes = transfer.receivedBytes;
        transfer.lastProgressAt = now;
        return JSON.stringify({
          type: "file.progress",
          transferId: transfer.transferId,
          receivedBytes: transfer.receivedBytes,
          totalBytes: transfer.expectedSize,
        });
      }
      return null;
    } catch (error) {
      const tid = transfer.transferId;
      this.cleanupActiveFileTransfer();
      return JSON.stringify({
        type: "file.error",
        transferId: tid,
        error: `写入文件失败: ${error instanceof Error ? error.message : "IO error"}`,
      });
    }
  }

  private handleFileComplete(
    sessionId: string,
    msg: Record<string, unknown>,
  ): string {
    const transferId =
      typeof msg.transferId === "string" ? msg.transferId.trim() : "";
    const transfer = this.activeFileTransfer;
    if (
      !transfer ||
      transfer.sessionId !== sessionId ||
      (transferId && transfer.transferId !== transferId)
    ) {
      return JSON.stringify({
        type: "file.error",
        transferId,
        error: "未找到对应的活跃传输任务",
      });
    }

    this.activeFileTransfer = null;
    try {
      fs.closeSync(transfer.fd);
    } catch {
      // Ignore close error
    }

    const removeTemp = (): void => {
      try {
        if (fs.existsSync(transfer.tempPath)) {
          fs.unlinkSync(transfer.tempPath);
        }
      } catch {
        // Ignore
      }
    };

    if (transfer.receivedBytes !== transfer.expectedSize) {
      removeTemp();
      return JSON.stringify({
        type: "file.error",
        transferId: transfer.transferId,
        error: `文件接收不完整（已接收 ${transfer.receivedBytes} / ${transfer.expectedSize} 字节）`,
      });
    }

    let completeSha: string | null = null;
    if (typeof msg.sha256 === "string" && msg.sha256.trim().length > 0) {
      completeSha = normalizeSha256(msg.sha256);
      if (!completeSha) {
        removeTemp();
        return JSON.stringify({
          type: "file.error",
          transferId: transfer.transferId,
          error: "无效的 SHA-256 校验值",
        });
      }
    }

    if (transfer.expectedSha256 && completeSha && transfer.expectedSha256 !== completeSha) {
      removeTemp();
      return JSON.stringify({
        type: "file.error",
        transferId: transfer.transferId,
        error: "SHA-256 校验失败，文件已丢弃",
      });
    }

    const expectedSha = completeSha ?? transfer.expectedSha256;
    const actualSha = transfer.hash.digest("hex");
    if (expectedSha && actualSha !== expectedSha) {
      removeTemp();
      return JSON.stringify({
        type: "file.error",
        transferId: transfer.transferId,
        error: "SHA-256 校验失败，文件已丢弃",
      });
    }

    try {
      const downloadsDir = path.join(app.getPath("downloads"), "VeloDeck");
      fs.mkdirSync(downloadsDir, { recursive: true });
      const finalPath = resolveUniqueFilePath(downloadsDir, transfer.sanitizedName);
      fs.renameSync(transfer.tempPath, finalPath);
      const finalName = path.basename(finalPath);

      this.patchState({
        lastReceivedFile: {
          fileName: finalName,
          savedPath: finalPath,
          at: Date.now(),
        },
      });

      return JSON.stringify({
        type: "file.done",
        transferId: transfer.transferId,
        savedPath: finalPath,
        sha256: actualSha,
        installLaunched: false,
        needsInstallPermission: false,
        message: `已保存到电脑 ${finalPath}`,
      });
    } catch (error) {
      removeTemp();
      return JSON.stringify({
        type: "file.error",
        transferId: transfer.transferId,
        error: `保存文件失败: ${error instanceof Error ? error.message : "IO error"}`,
      });
    }
  }

  private cleanupActiveFileTransfer(): void {
    const transfer = this.activeFileTransfer;
    if (!transfer) return;
    this.activeFileTransfer = null;
    try {
      fs.closeSync(transfer.fd);
    } catch {
      // Ignore
    }
    try {
      if (fs.existsSync(transfer.tempPath)) {
        fs.unlinkSync(transfer.tempPath);
      }
    } catch {
      // Ignore
    }
  }

  private patchState(patch: Partial<DesktopHostState>): void {
    this.state = {
      ...this.state,
      ...patch,
    };
    this.deps.onStateChanged(this.getHostState());
  }
}
