import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  Notification,
  powerSaveBlocker,
  screen,
  shell,
  systemPreferences,
  type DesktopCapturerSource,
  type Display,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import {
  NativeInputInjector,
  type CursorShape,
  type DisplayBounds,
  type InputPlatform,
} from "./inputInjector";
import {
  collectLocalNetworkInfo,
  LanDiscoveryService,
  sendWakeOnLan,
  type LanPeerInfo,
} from "./lanDiscovery";
import {
  executePowerAction,
  isPowerOperation,
  PrivacyCurtainManager,
} from "./powerAndPrivacy";
import {
  createDirectory,
  getDefaultRoots,
  listDirectory,
  openDownloadStream,
  resolveValidUploadTargetDir,
  trashPath,
  type RemoteDownloadStream,
} from "./remoteFileManager";
import {
  RemoteTerminalManager,
  type RemoteTerminalEvent,
} from "./remoteTerminal";
import {
  ensureHostSettings,
  generateHostControlPassword,
  normalizeServerUrl,
  sanitizeHostAccessMode,
  sanitizeHostAuthToken,
  sanitizeHostControlPassword,
  sanitizeHostDeviceName,
  sanitizeHostDisplayId,
  type DesktopSettings,
  type HostAccessMode,
} from "./settings";
import {
  sanitizeWhiteboardStroke,
  WhiteboardOverlayManager,
} from "./whiteboardOverlay";
import type {
  HostCaptureSourceResult,
  HostChatMessagePayload,
  HostFsDownloadChunkResult,
  HostFsDownloadOpenResult,
  HostSessionApprovalResult,
  HostSessionPermissions,
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
  scaleFactor?: number;
}

export interface DesktopHostPermissions {
  accessibility: boolean;
  screenCapture: boolean;
  platform: DesktopPlatform;
}

export type DesktopSessionPermissions = HostSessionPermissions;
export type DesktopChatMessage = HostChatMessagePayload;

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
  accessMode: HostAccessMode;
  blockInputActive: boolean;
  lanIp: string;
  macAddresses: string[];
  pendingApproval: { sessionId: string; requestedAt: number } | null;
  chatMessages: DesktopChatMessage[];
}

export interface DesktopHostConfigPatch {
  deviceName?: string;
  controlPassword?: string;
  activeDisplayId?: string;
  autoLaunch?: boolean;
  preventSleep?: boolean;
  audioCaptureEnabled?: boolean;
  clipboardAutoSync?: boolean;
  accessMode?: HostAccessMode;
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
  targetDir: string;
  expectedSize: number;
  expectedSha256: string | null;
  tempPath: string;
  fd: number;
  hash: crypto.Hash;
  receivedBytes: number;
  lastProgressBytes: number;
  lastProgressAt: number;
}

interface PendingDisplayMediaCapture {
  source: DesktopCapturerSource;
  wantAudio: boolean;
  expiresAt: number;
}

interface ActiveRemoteDownload {
  sessionId: string;
  stream: RemoteDownloadStream;
}

interface PendingApprovalEntry {
  sessionId: string;
  requestedAt: number;
  timer: NodeJS.Timeout;
  resolve: (result: HostSessionApprovalResult) => void;
}

const MAX_INCOMING_FILE_BYTES = 256 * 1024 * 1024;
const PROGRESS_INTERVAL_BYTES = 262_144;
const PROGRESS_INTERVAL_MS = 250;
const MAX_FILE_NAME_LENGTH = 120;
const CLIPBOARD_POLL_INTERVAL_MS = 600;
const CLIPBOARD_MAX_CHARS = 64 * 1024;
const CLIPBOARD_ECHO_GUARD_MS = 4000;
const CURSOR_POLL_INTERVAL_MS = 140;
const APPROVAL_TIMEOUT_MS = 60_000;
const MAX_CHAT_MESSAGES = 50;
const MAX_CHAT_TEXT_LENGTH = 1000;

const FULL_SESSION_PERMISSIONS: Readonly<Required<HostSessionPermissions>> = {
  keyboard: true,
  mouse: true,
  clipboard: true,
  fileTransfer: true,
  audio: true,
  terminal: true,
};

function normalizeSessionPermissions(
  raw?: HostSessionPermissions | null,
): Required<HostSessionPermissions> {
  return {
    keyboard: raw?.keyboard !== false,
    mouse: raw?.mouse !== false,
    clipboard: raw?.clipboard !== false,
    fileTransfer: raw?.fileTransfer !== false,
    audio: raw?.audio !== false,
    terminal: raw?.terminal !== false,
  };
}

function isMouseControlAction(action: string): boolean {
  return (
    action === "mouse_move" ||
    action === "mouse_move_relative" ||
    action === "mouse_down" ||
    action === "mouse_up" ||
    action === "mouse_wheel" ||
    action === "tap" ||
    action === "long_press" ||
    action === "swipe" ||
    action === "touch_down" ||
    action === "touch_move" ||
    action === "touch_up" ||
    action === "pinch" ||
    action === "wake"
  );
}

function isKeyboardControlAction(action: string): boolean {
  return action === "key_event" || action === "key" || action === "text";
}

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
  private readonly privacyCurtain: PrivacyCurtainManager;
  private readonly whiteboardOverlay: WhiteboardOverlayManager;
  private readonly remoteTerminal: RemoteTerminalManager;
  private readonly lanDiscovery: LanDiscoveryService;

  private workerWindow: BrowserWindow | null = null;
  private workerReady = false;
  private workerReadyResolvers: Array<() => void> = [];
  private workerRestartTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private pendingUnbindOwner = false;
  private ipcRegistered = false;
  private displayMediaHandlerRegistered = false;
  private screenListenersAttached = false;
  private activeFileTransfer: ActiveIncomingFile | null = null;
  private activeDownloads = new Map<string, ActiveRemoteDownload>();
  private pendingDisplayMediaCapture: PendingDisplayMediaCapture | null = null;

  // Power save blocker & two-way clipboard sync state
  private powerBlockerId: number | null = null;
  private clipboardTimer: NodeJS.Timeout | null = null;
  private lastObservedClipboardText = "";
  private lastInjectedClipboardText: string | null = null;
  private lastInjectedClipboardAt = 0;

  // Cursor polling, approval gating & per-session permissions
  private cursorPollTimer: NodeJS.Timeout | null = null;
  private cursorPollInFlight = false;
  private lastEmittedCursorShape: CursorShape | null = null;
  private activeSessionPermissions: Required<HostSessionPermissions> = {
    ...FULL_SESSION_PERMISSIONS,
  };
  private lastApprovedSessionId: string | null = null;
  private pendingApprovalRequest: PendingApprovalEntry | null = null;

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
      onBlockInputChanged: (active) => {
        if (this.disposed) return;
        if (this.state.blockInputActive !== active) {
          this.patchState({ blockInputActive: active });
        }
        if (this.workerWindow && !this.workerWindow.isDestroyed() && this.workerReady) {
          this.sendWorkerCommand({ type: "block-input-changed", active });
        }
      },
    });

    this.privacyCurtain = new PrivacyCurtainManager({
      platform: this.platform,
      onVisibilityChanged: (active) => {
        if (this.disposed) return;
        if (this.state.privacyScreenActive !== active) {
          this.patchState({ privacyScreenActive: active });
        }
        if (this.workerWindow && !this.workerWindow.isDestroyed() && this.workerReady) {
          this.sendWorkerCommand({ type: "privacy-state-changed", active });
        }
      },
    });

    this.whiteboardOverlay = new WhiteboardOverlayManager({
      platform: this.platform,
    });

    this.remoteTerminal = new RemoteTerminalManager({
      platform: this.platform,
      resourcesPath: process.resourcesPath,
      desktopRootDir: deps.desktopRootDir,
      isPackaged: app.isPackaged,
      onEvent: (event: RemoteTerminalEvent) => {
        if (this.disposed) return;
        if (this.workerWindow && !this.workerWindow.isDestroyed() && this.workerReady) {
          this.sendWorkerCommand({ type: "terminal-event", event });
        }
      },
    });

    this.lanDiscovery = new LanDiscoveryService({
      getAnnouncement: () => {
        if (this.disposed || !this.state.enabled || !this.state.deviceId) {
          return null;
        }
        return {
          deviceId: this.state.deviceId,
          name: this.state.deviceName,
          osPlatform: this.platform,
          controlCode: this.state.controlCode,
        };
      },
    });

    const ensured = ensureHostSettings(deps.getSettings());
    if (ensured.changed) {
      deps.updateSettings((draft) => {
        draft.hostDeviceId = ensured.settings.hostDeviceId;
        draft.hostDeviceSecret = ensured.settings.hostDeviceSecret;
        draft.hostDeviceName = ensured.settings.hostDeviceName;
        draft.hostControlPassword = ensured.settings.hostControlPassword;
        draft.hostAutoLaunch = ensured.settings.hostAutoLaunch;
        draft.hostPreventSleep = ensured.settings.hostPreventSleep;
        draft.hostAudioEnabled = ensured.settings.hostAudioEnabled;
        draft.hostClipboardAutoSync = ensured.settings.hostClipboardAutoSync;
        draft.hostAccessMode = ensured.settings.hostAccessMode;
      });
    }
    const currentSettings = deps.getSettings();
    const displays = this.collectDisplays();
    const activeDisplayId = this.resolveActiveDisplayId(
      currentSettings.hostDisplayId,
      displays,
    );
    const netInfo = collectLocalNetworkInfo();

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
      autoLaunch: Boolean(currentSettings.hostAutoLaunch ?? false),
      preventSleep: currentSettings.hostPreventSleep !== false,
      audioCaptureEnabled: currentSettings.hostAudioEnabled !== false,
      clipboardAutoSync: currentSettings.hostClipboardAutoSync !== false,
      privacyScreenActive: false,
      accessMode: sanitizeHostAccessMode(currentSettings.hostAccessMode) ?? "auto",
      blockInputActive: false,
      lanIp: netInfo.lanIp,
      macAddresses: netInfo.macAddresses,
      pendingApproval: null,
      chatMessages: [],
    };
  }

  public init(): void {
    this.registerWorkerIpcHandlers();
    this.attachScreenListeners();
    if (this.state.autoLaunch) {
      this.applyAutoLaunchSetting(true);
    }
    this.syncPowerSaveBlocker();
    void this.refreshHostPermissions().then(() => {
      if (!this.disposed && this.deps.getSettings().hostEnabled) {
        void this.startHost();
      }
    });
  }

  public isWorkerWindow(win: BrowserWindow | null | undefined): boolean {
    return Boolean(win && this.workerWindow && win === this.workerWindow);
  }

  public isPrivacyCurtainWindow(win: BrowserWindow | null | undefined): boolean {
    return this.privacyCurtain.isCurtainWindow(win);
  }

  public isInternalWindow(win: BrowserWindow | null | undefined): boolean {
    return (
      this.isWorkerWindow(win) ||
      this.isPrivacyCurtainWindow(win) ||
      this.whiteboardOverlay.isOverlayWindow(win)
    );
  }

  public getHostState(): DesktopHostState {
    return {
      ...this.state,
      displays: this.state.displays.map((d) => ({ ...d })),
      permissions: { ...this.state.permissions },
      lastReceivedFile: this.state.lastReceivedFile
        ? { ...this.state.lastReceivedFile }
        : null,
      macAddresses: [...this.state.macAddresses],
      pendingApproval: this.state.pendingApproval
        ? { ...this.state.pendingApproval }
        : null,
      chatMessages: this.state.chatMessages.map((m) => ({ ...m })),
    };
  }

  public async setHostPrivacyScreen(enabled: boolean): Promise<DesktopHostState> {
    if (this.disposed) {
      return this.getHostState();
    }
    if (enabled) {
      this.privacyCurtain.show();
    } else {
      this.privacyCurtain.hide();
    }
    return this.getHostState();
  }

  public async setHostBlockInput(enabled: boolean): Promise<DesktopHostState> {
    if (this.disposed) {
      return this.getHostState();
    }
    const target = Boolean(enabled);
    const res = await this.injector.setBlockInput(target);
    const active = target ? res.ok && res.active : false;
    if (this.state.blockInputActive !== active) {
      this.patchState({ blockInputActive: active });
    }
    if (this.workerWindow && !this.workerWindow.isDestroyed() && this.workerReady) {
      this.sendWorkerCommand({ type: "block-input-changed", active });
    }
    return this.getHostState();
  }

  public async discoverLanPeers(timeoutMs = 1200): Promise<LanPeerInfo[]> {
    return this.lanDiscovery.discoverPeers(timeoutMs, this.state.deviceId);
  }

  public async sendWolPacket(
    macAddress: string,
    broadcastIp?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return sendWakeOnLan(macAddress, broadcastIp);
  }

  public async approveHostSession(
    sessionId: string,
    permissions: HostSessionPermissions,
  ): Promise<DesktopHostState> {
    const pending = this.pendingApprovalRequest;
    if (!pending || pending.sessionId !== sessionId) {
      return this.getHostState();
    }
    clearTimeout(pending.timer);
    this.pendingApprovalRequest = null;

    const normalized = normalizeSessionPermissions(permissions);
    this.activeSessionPermissions = normalized;
    this.lastApprovedSessionId = sessionId;
    this.patchState({ pendingApproval: null });

    pending.resolve({
      approved: true,
      permissions: normalized,
    });
    return this.getHostState();
  }

  public async rejectHostSession(sessionId: string): Promise<DesktopHostState> {
    const pending = this.pendingApprovalRequest;
    if (!pending || pending.sessionId !== sessionId) {
      return this.getHostState();
    }
    this.resolvePendingApprovalAsRejected("rejected_by_host");
    return this.getHostState();
  }

  public async sendHostChatMessage(text: string): Promise<DesktopHostState> {
    if (this.disposed || !this.state.activeSessionId) {
      return this.getHostState();
    }
    const clean = typeof text === "string" ? text.trim().slice(0, MAX_CHAT_TEXT_LENGTH) : "";
    if (!clean) {
      return this.getHostState();
    }
    const message: DesktopChatMessage = {
      id: crypto.randomUUID(),
      sender: "host",
      senderName: this.state.deviceName || "Host",
      text: clean,
      ts: Date.now(),
    };
    this.appendChatMessage(message);
    if (this.workerWindow && !this.workerWindow.isDestroyed() && this.workerReady) {
      this.sendWorkerCommand({ type: "chat-send", message });
    }
    return this.getHostState();
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
      draft.hostAutoLaunch = ensured.settings.hostAutoLaunch;
      draft.hostPreventSleep = ensured.settings.hostPreventSleep;
      draft.hostAudioEnabled = ensured.settings.hostAudioEnabled;
      draft.hostClipboardAutoSync = ensured.settings.hostClipboardAutoSync;
      draft.hostAccessMode = ensured.settings.hostAccessMode;
      if (cleanToken) {
        draft.hostAuthToken = cleanToken;
      }
    });

    if (cleanToken) {
      this.pendingUnbindOwner = false;
    }

    await this.refreshHostPermissionsInternal(false);
    this.syncDisplays(false);

    const netInfo = collectLocalNetworkInfo();
    const cfg = this.buildWorkerConfig(netInfo);
    if (!cfg.wsUrl) {
      this.patchState({
        enabled: true,
        status: "error",
        deviceId: cfg.deviceId,
        deviceName: cfg.name,
        controlPassword: cfg.controlPassword,
        lanIp: netInfo.lanIp,
        macAddresses: netInfo.macAddresses,
        lastError: "请先配置 VeloDeck 服务器地址后再开启本机被控",
      });
      this.lanDiscovery.start();
      this.syncPowerSaveBlocker();
      return this.getHostState();
    }

    this.patchState({
      enabled: true,
      status: "connecting",
      deviceId: cfg.deviceId,
      deviceName: cfg.name,
      controlPassword: cfg.controlPassword,
      lanIp: netInfo.lanIp,
      macAddresses: netInfo.macAddresses,
      lastError: null,
    });
    this.lanDiscovery.start();
    this.syncPowerSaveBlocker();

    await this.ensureWorkerReady();
    this.sendWorkerCommand({ type: "start", config: cfg });
    return this.getHostState();
  }

  public async stopHost(): Promise<DesktopHostState> {
    this.clearWorkerRestartTimer();
    this.deps.updateSettings((draft) => {
      draft.hostEnabled = false;
    });
    this.lanDiscovery.stop();
    this.cleanupActiveSessionState("host_stopped");
    if (this.workerWindow && !this.workerWindow.isDestroyed() && this.workerReady) {
      this.sendWorkerCommand({ type: "stop" });
    }
    this.patchState({
      enabled: false,
      status: "stopped",
      activeSessionId: null,
      activeTransport: null,
      lastError: null,
      privacyScreenActive: false,
      blockInputActive: false,
      pendingApproval: null,
      chatMessages: [],
    });
    this.syncPowerSaveBlocker();
    return this.getHostState();
  }

  public async updateHostConfig(
    patch: DesktopHostConfigPatch,
  ): Promise<DesktopHostState> {
    let needsReconnect = false;
    let switchDisplayId: string | undefined;
    let shouldNotifyWorker = false;

    const current = this.deps.getSettings();
    let nextName = current.hostDeviceName;
    let nextPassword = current.hostControlPassword;
    let nextDisplayId = this.state.activeDisplayId;
    let nextAutoLaunch = this.state.autoLaunch;
    let nextPreventSleep = this.state.preventSleep;
    let nextAudioEnabled = this.state.audioCaptureEnabled;
    let nextClipboardAutoSync = this.state.clipboardAutoSync;
    let nextAccessMode = this.state.accessMode;

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
          shouldNotifyWorker = true;
        }
      } else {
        throw new Error("指定的显示器不存在或已断开");
      }
    }

    if (typeof patch.autoLaunch === "boolean") {
      nextAutoLaunch = patch.autoLaunch;
      this.applyAutoLaunchSetting(nextAutoLaunch);
    }

    if (typeof patch.preventSleep === "boolean") {
      nextPreventSleep = patch.preventSleep;
    }

    if (typeof patch.audioCaptureEnabled === "boolean") {
      if (patch.audioCaptureEnabled !== nextAudioEnabled) {
        shouldNotifyWorker = true;
      }
      nextAudioEnabled = patch.audioCaptureEnabled;
    }

    if (typeof patch.clipboardAutoSync === "boolean") {
      nextClipboardAutoSync = patch.clipboardAutoSync;
    }

    if (patch.accessMode !== undefined) {
      const sanitizedMode = sanitizeHostAccessMode(patch.accessMode);
      if (!sanitizedMode) {
        throw new Error("无效的接入审批模式");
      }
      if (sanitizedMode !== nextAccessMode) {
        shouldNotifyWorker = true;
      }
      nextAccessMode = sanitizedMode;
    }

    this.deps.updateSettings((draft) => {
      if (nextName) draft.hostDeviceName = nextName;
      if (nextPassword) draft.hostControlPassword = nextPassword;
      if (nextDisplayId) draft.hostDisplayId = nextDisplayId;
      draft.hostAutoLaunch = nextAutoLaunch;
      draft.hostPreventSleep = nextPreventSleep;
      draft.hostAudioEnabled = nextAudioEnabled;
      draft.hostClipboardAutoSync = nextClipboardAutoSync;
      draft.hostAccessMode = nextAccessMode;
    });

    this.patchState({
      deviceName: nextName ?? this.state.deviceName,
      controlPassword: nextPassword ?? this.state.controlPassword,
      activeDisplayId: nextDisplayId,
      autoLaunch: nextAutoLaunch,
      preventSleep: nextPreventSleep,
      audioCaptureEnabled: nextAudioEnabled,
      clipboardAutoSync: nextClipboardAutoSync,
      accessMode: nextAccessMode,
    });

    this.syncPowerSaveBlocker();
    this.syncClipboardWatcher();

    if (this.state.enabled && (needsReconnect || shouldNotifyWorker)) {
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
    this.cleanupActiveSessionState("host_owner_disconnected");
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
      privacyScreenActive: false,
      blockInputActive: false,
      pendingApproval: null,
      chatMessages: [],
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
    this.clearWorkerRestartTimer();
    const cfg = this.buildWorkerConfig();
    if (!cfg.wsUrl) {
      this.cleanupActiveSessionState("server_url_cleared");
      if (this.workerWindow && !this.workerWindow.isDestroyed() && this.workerReady) {
        this.sendWorkerCommand({ type: "stop" });
      }
      this.patchState({
        status: "error",
        activeSessionId: null,
        activeTransport: null,
        privacyScreenActive: false,
        blockInputActive: false,
        pendingApproval: null,
        chatMessages: [],
        lastError: "未配置有效的 VeloDeck 服务器地址",
      });
      return;
    }
    this.cleanupActiveSessionState("server_url_changed");
    this.patchState({
      status: "connecting",
      activeSessionId: null,
      activeTransport: null,
      privacyScreenActive: false,
      blockInputActive: false,
      pendingApproval: null,
      chatMessages: [],
      lastError: null,
    });
    await this.ensureWorkerReady();
    if (!this.disposed && this.state.enabled) {
      this.sendWorkerCommand({ type: "start", config: cfg });
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.clearWorkerRestartTimer();
    this.lanDiscovery.stop();
    this.cleanupActiveSessionState("app_quit");
    this.privacyCurtain.dispose();
    this.whiteboardOverlay.dispose();
    this.stopPowerSaveBlocker();
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

  private hasActiveFullControlPermission(): boolean {
    return (
      this.state.activeSessionId !== null &&
      this.activeSessionPermissions.keyboard !== false &&
      this.activeSessionPermissions.mouse !== false
    );
  }

  private cleanupActiveSessionState(
    reason: string,
    options: { preservePermissions?: boolean } = {},
  ): void {
    this.resolvePendingApprovalAsRejected(reason);
    void this.injector.setBlockInput(false);
    this.injector.releaseAll();
    this.privacyCurtain.hide();
    this.whiteboardOverlay.clear();
    this.remoteTerminal.closeAll();
    this.stopClipboardWatcher();
    this.stopCursorWatcher();
    this.cleanupActiveFileTransfer();
    this.cleanupAllDownloads();
    this.pendingDisplayMediaCapture = null;
    if (!options.preservePermissions) {
      this.activeSessionPermissions = { ...FULL_SESSION_PERMISSIONS };
      this.lastApprovedSessionId = null;
    }
  }

  private clearWorkerRestartTimer(): void {
    if (this.workerRestartTimer !== null) {
      clearTimeout(this.workerRestartTimer);
      this.workerRestartTimer = null;
    }
  }

  private handleWorkerUnexpectedExit(win: BrowserWindow, reason: string): void {
    if (this.workerWindow !== win) {
      return;
    }
    this.workerWindow = null;
    this.workerReady = false;

    const resolvers = this.workerReadyResolvers.splice(
      0,
      this.workerReadyResolvers.length,
    );
    resolvers.forEach((fn) => fn());

    if (!win.isDestroyed()) {
      try {
        win.destroy();
      } catch {
        // Ignore destroy errors during crash cleanup
      }
    }

    this.cleanupActiveSessionState(reason);
    if (this.disposed) {
      return;
    }

    this.patchState({
      status: this.state.enabled ? "connecting" : "stopped",
      activeSessionId: null,
      activeTransport: null,
      privacyScreenActive: false,
      blockInputActive: false,
      pendingApproval: null,
      chatMessages: [],
      lastError: this.state.enabled
        ? "被控端工作进程异常退出，正在自动恢复连接..."
        : null,
    });

    if (this.state.enabled) {
      this.scheduleWorkerRestart();
    }
  }

  private scheduleWorkerRestart(): void {
    this.clearWorkerRestartTimer();
    this.workerRestartTimer = setTimeout(() => {
      this.workerRestartTimer = null;
      if (this.disposed || !this.state.enabled) {
        return;
      }
      const cfg = this.buildWorkerConfig();
      if (!cfg.wsUrl) {
        return;
      }
      void this.ensureWorkerReady()
        .then(() => {
          if (!this.disposed && this.state.enabled) {
            this.sendWorkerCommand({ type: "start", config: cfg });
          }
        })
        .catch(() => undefined);
    }, 500);
    this.workerRestartTimer.unref?.();
  }

  private applyAutoLaunchSetting(enabled: boolean): void {
    if (!app.isPackaged) {
      return;
    }
    if (this.platform !== "darwin" && this.platform !== "win32") {
      return;
    }
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: true,
      });
    } catch (error) {
      console.warn("[velodeck-host] Failed to update login item settings:", error);
    }
  }

  private syncPowerSaveBlocker(): void {
    const shouldBlock =
      !this.disposed && this.state.enabled && this.state.preventSleep;
    if (shouldBlock) {
      if (
        this.powerBlockerId === null ||
        !powerSaveBlocker.isStarted(this.powerBlockerId)
      ) {
        try {
          this.powerBlockerId = powerSaveBlocker.start("prevent-display-sleep");
        } catch (error) {
          console.warn("[velodeck-host] Failed to start powerSaveBlocker:", error);
        }
      }
    } else {
      this.stopPowerSaveBlocker();
    }
  }

  private stopPowerSaveBlocker(): void {
    if (this.powerBlockerId !== null) {
      try {
        if (powerSaveBlocker.isStarted(this.powerBlockerId)) {
          powerSaveBlocker.stop(this.powerBlockerId);
        }
      } catch {
        // Ignore
      }
      this.powerBlockerId = null;
    }
  }

  private syncClipboardWatcher(): void {
    const shouldWatch =
      !this.disposed &&
      Boolean(this.state.activeSessionId) &&
      this.state.clipboardAutoSync &&
      this.activeSessionPermissions.clipboard !== false;
    if (shouldWatch) {
      if (this.clipboardTimer === null) {
        try {
          this.lastObservedClipboardText = clipboard
            .readText()
            .slice(0, CLIPBOARD_MAX_CHARS);
        } catch {
          this.lastObservedClipboardText = "";
        }
        this.clipboardTimer = setInterval(() => {
          this.pollHostClipboard();
        }, CLIPBOARD_POLL_INTERVAL_MS);
        this.clipboardTimer.unref?.();
      }
    } else {
      this.stopClipboardWatcher();
    }
  }

  private stopClipboardWatcher(): void {
    if (this.clipboardTimer !== null) {
      clearInterval(this.clipboardTimer);
      this.clipboardTimer = null;
    }
  }

  private syncCursorWatcher(): void {
    const shouldPoll = !this.disposed && Boolean(this.state.activeSessionId);
    if (shouldPoll) {
      if (this.cursorPollTimer === null) {
        this.lastEmittedCursorShape = null;
        this.cursorPollInFlight = false;
        this.cursorPollTimer = setInterval(() => {
          void this.pollCursorShape();
        }, CURSOR_POLL_INTERVAL_MS);
        this.cursorPollTimer.unref?.();
        void this.pollCursorShape();
      }
    } else {
      this.stopCursorWatcher();
    }
  }

  private stopCursorWatcher(): void {
    if (this.cursorPollTimer !== null) {
      clearInterval(this.cursorPollTimer);
      this.cursorPollTimer = null;
    }
    this.cursorPollInFlight = false;
    this.lastEmittedCursorShape = null;
  }

  private async pollCursorShape(): Promise<void> {
    if (this.disposed || !this.state.activeSessionId || this.cursorPollInFlight) {
      return;
    }
    this.cursorPollInFlight = true;
    try {
      const shape = await this.injector.queryCursorShape(200);
      if (this.disposed || !this.state.activeSessionId) {
        return;
      }
      if (shape !== this.lastEmittedCursorShape) {
        this.lastEmittedCursorShape = shape;
        if (this.workerWindow && !this.workerWindow.isDestroyed() && this.workerReady) {
          this.sendWorkerCommand({
            type: "cursor-update",
            shape,
            visible: shape !== "none",
          });
        }
      }
    } catch {
      // Ignore transient cursor query errors
    } finally {
      this.cursorPollInFlight = false;
    }
  }

  private resolvePendingApprovalAsRejected(reason: string): void {
    const pending = this.pendingApprovalRequest;
    if (!pending) {
      if (this.state.pendingApproval !== null) {
        this.patchState({ pendingApproval: null });
      }
      return;
    }
    clearTimeout(pending.timer);
    this.pendingApprovalRequest = null;
    if (!this.disposed) {
      this.patchState({ pendingApproval: null });
    }
    pending.resolve({
      approved: false,
      permissions: {},
      reason,
    });
  }

  private appendChatMessage(message: DesktopChatMessage): void {
    if (this.state.chatMessages.some((m) => m.id === message.id)) {
      return;
    }
    const next = [...this.state.chatMessages, message].slice(-MAX_CHAT_MESSAGES);
    this.patchState({ chatMessages: next });
  }

  private showOsNotification(title: string, body: string): void {
    try {
      if (Notification.isSupported()) {
        const notif = new Notification({ title, body });
        notif.show();
      }
    } catch {
      // Ignore notification errors on unsupported desktops
    }
  }

  private hasFocusedControllerWindow(): boolean {
    try {
      const focused = BrowserWindow.getFocusedWindow();
      return Boolean(focused && !focused.isDestroyed() && !this.isInternalWindow(focused));
    } catch {
      return false;
    }
  }

  private pollHostClipboard(): void {
    if (
      this.disposed ||
      !this.state.activeSessionId ||
      !this.state.clipboardAutoSync
    ) {
      this.stopClipboardWatcher();
      return;
    }
    let current = "";
    try {
      current = clipboard.readText().slice(0, CLIPBOARD_MAX_CHARS);
    } catch {
      return;
    }
    if (!current || current === this.lastObservedClipboardText) {
      return;
    }
    this.lastObservedClipboardText = current;

    // Loop-prevention guard: never echo text that was just written by the remote controller
    if (
      this.lastInjectedClipboardText !== null &&
      current === this.lastInjectedClipboardText &&
      Date.now() - this.lastInjectedClipboardAt < CLIPBOARD_ECHO_GUARD_MS
    ) {
      return;
    }

    if (this.workerWindow && !this.workerWindow.isDestroyed() && this.workerReady) {
      this.sendWorkerCommand({ type: "clipboard-push", text: current });
    }
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
        const scaleFactor =
          typeof d.scaleFactor === "number" && Number.isFinite(d.scaleFactor) && d.scaleFactor > 0
            ? d.scaleFactor
            : 1;
        return {
          id: String(d.id),
          name: label,
          width: Math.max(1, Math.round(d.bounds.width)),
          height: Math.max(1, Math.round(d.bounds.height)),
          primary: isPrimary,
          scaleFactor,
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
          scaleFactor: 1,
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
    this.whiteboardOverlay.updateBounds(this.resolveDisplayBounds(nextActiveId));
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

  private buildWorkerConfig(
    precomputedNet?: ReturnType<typeof collectLocalNetworkInfo>,
  ): HostWorkerConfig {
    const s = this.deps.getSettings();
    const wsUrl = deriveRelayWsUrl(this.deps.getEffectiveServerUrl());
    const displays =
      this.state.displays.length > 0 ? this.state.displays : this.collectDisplays();
    const activeDisplayId = this.resolveActiveDisplayId(
      s.hostDisplayId ?? this.state.activeDisplayId,
      displays,
    );
    const net = precomputedNet ?? collectLocalNetworkInfo();

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
      audioCaptureEnabled: this.state.audioCaptureEnabled,
      privacyScreenActive: this.state.privacyScreenActive,
      accessMode: this.state.accessMode,
      blockInputActive: this.state.blockInputActive,
      lanIp: net.lanIp,
      macAddresses: net.macAddresses,
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

  private registerDisplayMediaHandler(win: BrowserWindow): void {
    if (this.displayMediaHandlerRegistered) return;
    this.displayMediaHandlerRegistered = true;

    win.webContents.session.setDisplayMediaRequestHandler(
      async (request, callback) => {
        const frameUrl = request.frame?.url ?? request.securityOrigin ?? "";
        if (!frameUrl.startsWith(`${HOST_WORKER_ORIGIN}/`)) {
          callback({});
          return;
        }

        const pending = this.pendingDisplayMediaCapture;
        const now = Date.now();
        let source: DesktopCapturerSource | undefined;
        const audioAllowed =
          this.state.audioCaptureEnabled &&
          this.activeSessionPermissions.audio !== false;
        let wantAudio = Boolean(request.audioRequested && audioAllowed);

        if (pending && pending.expiresAt >= now) {
          source = pending.source;
          wantAudio = Boolean(
            request.audioRequested && pending.wantAudio && audioAllowed,
          );
          this.pendingDisplayMediaCapture = null;
        } else {
          try {
            const sources = await desktopCapturer.getSources({
              types: ["screen"],
              thumbnailSize: { width: 0, height: 0 },
            });
            source =
              sources.find((s) => s.display_id === this.state.activeDisplayId) ??
              sources.find(
                (s) => s.display_id === String(screen.getPrimaryDisplay().id),
              ) ??
              sources[0];
          } catch {
            source = undefined;
          }
        }

        if (!source) {
          callback({});
          return;
        }

        try {
          if (wantAudio) {
            callback({ video: source, audio: "loopback" });
          } else {
            callback({ video: source });
          }
        } catch {
          // Fallback to video-only if loopback audio is unsupported on this OS build
          try {
            callback({ video: source });
          } catch {
            callback({});
          }
        }
      },
    );
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
      this.registerDisplayMediaHandler(win);

      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event, targetUrl) => {
        if (!targetUrl.startsWith(`${HOST_WORKER_ORIGIN}/`)) {
          event.preventDefault();
        }
      });

      win.webContents.on("render-process-gone", (_event, details) => {
        console.warn(
          `[velodeck-host] Worker render process gone (reason=${details.reason}, exitCode=${details.exitCode})`,
        );
        this.handleWorkerUnexpectedExit(win, `worker_${details.reason}`);
      });

      win.on("closed", () => {
        if (this.workerWindow === win) {
          if (this.disposed) {
            this.workerWindow = null;
            this.workerReady = false;
          } else {
            this.handleWorkerUnexpectedExit(win, "worker_closed");
          }
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
        let sessionEnded = false;
        let sessionChanged = false;

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
          const prevSessionId = this.state.activeSessionId;
          const nextSessionId = rawReport.activeSessionId;
          if (prevSessionId !== nextSessionId) {
            sessionChanged = true;
            if (prevSessionId) {
              sessionEnded = true;
              const keepApproved = Boolean(
                nextSessionId && nextSessionId === this.lastApprovedSessionId,
              );
              this.cleanupActiveSessionState("session_ended", {
                preservePermissions: keepApproved,
              });
              patch.blockInputActive = false;
              patch.privacyScreenActive = false;
              patch.chatMessages = [];
            }
            if (nextSessionId) {
              if (nextSessionId !== this.lastApprovedSessionId) {
                this.activeSessionPermissions = { ...FULL_SESSION_PERMISSIONS };
              }
              patch.chatMessages = [];
            }
          }
          patch.activeSessionId = nextSessionId;
        }
        if (rawReport.activeTransport !== undefined) {
          patch.activeTransport = rawReport.activeTransport;
        }
        if (
          typeof rawReport.activeDisplayId === "string" &&
          rawReport.activeDisplayId
        ) {
          patch.activeDisplayId = rawReport.activeDisplayId;
          this.whiteboardOverlay.updateBounds(
            this.resolveDisplayBounds(rawReport.activeDisplayId),
          );
        }
        if (rawReport.lastError !== undefined) {
          patch.lastError = rawReport.lastError;
        }
        if (typeof rawReport.privacyScreenActive === "boolean") {
          patch.privacyScreenActive = rawReport.privacyScreenActive;
        }
        if (typeof rawReport.blockInputActive === "boolean") {
          patch.blockInputActive = rawReport.blockInputActive;
        }

        if (sessionEnded && this.privacyCurtain.isActive()) {
          this.privacyCurtain.hide();
          patch.privacyScreenActive = false;
        }

        this.patchState(patch);

        if (sessionChanged) {
          this.syncClipboardWatcher();
          this.syncCursorWatcher();
        }
      },
    );

    ipcMain.handle(
      "velodeck-host:get-capture-source",
      async (event, rawArg: unknown): Promise<HostCaptureSourceResult> => {
        if (!this.isTrustedWorkerEvent(event)) {
          return { ok: false, error: "Untrusted worker IPC sender" };
        }
        let requestedDisplayId = "";
        const audioAllowed =
          this.state.audioCaptureEnabled &&
          this.activeSessionPermissions.audio !== false;
        let wantAudio = audioAllowed;
        if (typeof rawArg === "string") {
          requestedDisplayId = rawArg;
        } else if (rawArg && typeof rawArg === "object") {
          const obj = rawArg as { displayId?: unknown; wantAudio?: unknown };
          if (typeof obj.displayId === "string") {
            requestedDisplayId = obj.displayId;
          }
          if (typeof obj.wantAudio === "boolean") {
            wantAudio = obj.wantAudio && audioAllowed;
          }
        }

        const displays = this.collectDisplays();
        const targetId = this.resolveActiveDisplayId(
          requestedDisplayId || this.state.activeDisplayId,
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

          this.pendingDisplayMediaCapture = {
            source: matched,
            wantAudio,
            expiresAt: Date.now() + 15_000,
          };

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
        if (!this.state.activeSessionId) {
          return { ok: false, message: "当前没有活跃的远控会话" };
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
        const action = typeof cmd.action === "string" ? cmd.action : "";
        if (
          isMouseControlAction(action) &&
          this.activeSessionPermissions.mouse === false
        ) {
          return { ok: false, message: "被控端未授予鼠标控制权限" };
        }
        if (
          isKeyboardControlAction(action) &&
          this.activeSessionPermissions.keyboard === false
        ) {
          return { ok: false, message: "被控端未授予键盘控制权限" };
        }
        if (this.platform === "darwin" && !this.state.permissions.accessibility) {
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
        if (!this.state.activeSessionId) {
          return false;
        }
        if (typeof text !== "string") {
          return false;
        }
        if (this.activeSessionPermissions.clipboard === false) {
          return false;
        }
        const clean = text.slice(0, CLIPBOARD_MAX_CHARS);
        this.lastInjectedClipboardText = clean;
        this.lastInjectedClipboardAt = Date.now();
        this.lastObservedClipboardText = clean;
        clipboard.writeText(clean);
        return true;
      },
    );

    ipcMain.handle(
      "velodeck-host:privacy-screen",
      (
        event,
        enabled: unknown,
      ): { ok: boolean; active: boolean; message?: string } => {
        if (!this.isTrustedWorkerEvent(event)) {
          return { ok: false, active: false, message: "Untrusted worker IPC sender" };
        }
        if (!this.hasActiveFullControlPermission()) {
          return {
            ok: false,
            active: this.privacyCurtain.isActive(),
            message: "被控端未授予完整键鼠控制权限，无法控制隐私黑屏",
          };
        }
        const target = Boolean(enabled);
        if (target) {
          const shown = this.privacyCurtain.show();
          return { ok: shown, active: this.privacyCurtain.isActive() };
        }
        this.privacyCurtain.hide();
        return { ok: true, active: this.privacyCurtain.isActive() };
      },
    );

    ipcMain.handle(
      "velodeck-host:block-input",
      async (
        event,
        enabled: unknown,
      ): Promise<{ ok: boolean; active: boolean; message?: string }> => {
        if (!this.isTrustedWorkerEvent(event)) {
          return { ok: false, active: false, message: "Untrusted worker IPC sender" };
        }
        if (!this.hasActiveFullControlPermission()) {
          return {
            ok: false,
            active: this.state.blockInputActive,
            message: "被控端未授予完整键鼠控制权限，无法锁定本机输入",
          };
        }
        const target = Boolean(enabled);
        await this.setHostBlockInput(target);
        const active = this.state.blockInputActive;
        if (target && !active) {
          return {
            ok: false,
            active: false,
            message:
              this.platform === "darwin"
                ? "锁定本机键鼠失败，请确认已授予「辅助功能」权限"
                : "无法锁定本机键鼠输入",
          };
        }
        return { ok: true, active };
      },
    );

    ipcMain.handle(
      "velodeck-host:wol",
      async (
        event,
        rawPayload: unknown,
      ): Promise<{ ok: boolean; error?: string }> => {
        if (!this.isTrustedWorkerEvent(event)) {
          return { ok: false, error: "Untrusted worker IPC sender" };
        }
        if (!rawPayload || typeof rawPayload !== "object") {
          return { ok: false, error: "无效的 Wake-on-LAN 参数" };
        }
        const { macAddress, broadcastIp, sessionId } = rawPayload as {
          macAddress?: unknown;
          broadcastIp?: unknown;
          sessionId?: unknown;
        };
        const sid = typeof sessionId === "string" ? sessionId.trim() : "";
        if (sid) {
          if (sid !== this.state.activeSessionId || !this.hasActiveFullControlPermission()) {
            return { ok: false, error: "被控端未授予完整键鼠控制权限，无法发送局域网唤醒" };
          }
        }
        if (typeof macAddress !== "string" || !macAddress.trim()) {
          return { ok: false, error: "缺少 MAC 地址" };
        }
        return sendWakeOnLan(
          macAddress.trim(),
          typeof broadcastIp === "string" && broadcastIp.trim()
            ? broadcastIp.trim()
            : undefined,
        );
      },
    );

    ipcMain.handle(
      "velodeck-host:whiteboard",
      (
        event,
        rawPayload: unknown,
      ): { ok: boolean; message?: string } => {
        if (!this.isTrustedWorkerEvent(event)) {
          return { ok: false, message: "Untrusted worker IPC sender" };
        }
        if (!this.state.activeSessionId) {
          return { ok: false, message: "当前没有活跃的远控会话" };
        }
        if (!rawPayload || typeof rawPayload !== "object") {
          return { ok: false, message: "无效的白板标注参数" };
        }
        const { op, stroke, displayId } = rawPayload as {
          op?: unknown;
          stroke?: unknown;
          displayId?: unknown;
        };
        if (op === "clear") {
          this.whiteboardOverlay.clear();
          return { ok: true };
        }
        if (op === "stroke") {
          const sanitized = sanitizeWhiteboardStroke(stroke);
          if (!sanitized) {
            return { ok: false, message: "无效的白板笔迹数据" };
          }
          const bounds = this.resolveDisplayBounds(
            typeof displayId === "string" && displayId ? displayId : undefined,
          );
          this.whiteboardOverlay.drawStroke(sanitized, bounds);
          return { ok: true };
        }
        return { ok: false, message: "不支持的白板操作" };
      },
    );

    ipcMain.handle(
      "velodeck-host:terminal-cmd",
      (
        event,
        rawPayload: unknown,
      ): { ok: boolean; error?: string } => {
        if (!this.isTrustedWorkerEvent(event)) {
          return { ok: false, error: "Untrusted worker IPC sender" };
        }
        if (!this.state.activeSessionId) {
          return { ok: false, error: "当前没有活跃的远控会话" };
        }
        if (this.activeSessionPermissions.terminal === false) {
          return { ok: false, error: "被控端未授予远程终端权限" };
        }
        if (!rawPayload || typeof rawPayload !== "object") {
          return { ok: false, error: "无效的终端命令" };
        }
        const { sessionId, cmd } = rawPayload as {
          sessionId?: unknown;
          cmd?: Record<string, unknown>;
        };
        if (typeof sessionId !== "string" || sessionId !== this.state.activeSessionId) {
          return { ok: false, error: "终端命令会话 ID 不匹配" };
        }
        if (!cmd || typeof cmd !== "object") {
          return { ok: false, error: "缺少终端命令对象" };
        }
        const type = typeof cmd.type === "string" ? cmd.type : "";
        const termId = typeof cmd.termId === "string" ? cmd.termId : "";
        switch (type) {
          case "term_open": {
            const cols = typeof cmd.cols === "number" ? cmd.cols : undefined;
            const rows = typeof cmd.rows === "number" ? cmd.rows : undefined;
            const cwd = typeof cmd.cwd === "string" ? cmd.cwd : undefined;
            const ok = this.remoteTerminal.open(termId, cols, rows, cwd);
            return { ok };
          }
          case "term_data": {
            const data = typeof cmd.data === "string" ? cmd.data : "";
            const ok = this.remoteTerminal.write(termId, data);
            return { ok };
          }
          case "term_resize": {
            const cols = typeof cmd.cols === "number" ? cmd.cols : undefined;
            const rows = typeof cmd.rows === "number" ? cmd.rows : undefined;
            const ok = this.remoteTerminal.resize(termId, cols, rows);
            return { ok };
          }
          case "term_close": {
            this.remoteTerminal.close(termId);
            return { ok: true };
          }
          default:
            return { ok: false, error: `不支持的终端指令: ${type}` };
        }
      },
    );

    ipcMain.on("velodeck-host:terminal-close-all", (event) => {
      if (!this.isTrustedWorkerEvent(event)) return;
      this.remoteTerminal.closeAll();
    });

    ipcMain.handle(
      "velodeck-host:request-approval",
      (event, sessionId: unknown): Promise<HostSessionApprovalResult> => {
        if (!this.isTrustedWorkerEvent(event)) {
          return Promise.resolve({
            approved: false,
            permissions: {},
            reason: "untrusted_sender",
          });
        }
        const sid = typeof sessionId === "string" ? sessionId.trim() : "";
        if (!sid) {
          return Promise.resolve({
            approved: false,
            permissions: {},
            reason: "invalid_session",
          });
        }

        // Reject any stale pending request first
        this.resolvePendingApprovalAsRejected("replaced_by_new_request");

        const requestedAt = Date.now();
        return new Promise<HostSessionApprovalResult>((resolve) => {
          const timer = setTimeout(() => {
            if (this.pendingApprovalRequest?.sessionId === sid) {
              this.resolvePendingApprovalAsRejected("rejected_by_host");
            }
          }, APPROVAL_TIMEOUT_MS);
          timer.unref?.();

          this.pendingApprovalRequest = {
            sessionId: sid,
            requestedAt,
            timer,
            resolve,
          };

          this.patchState({
            pendingApproval: { sessionId: sid, requestedAt },
          });

          this.showOsNotification(
            "VeloDeck 远程连接请求",
            "VeloDeck 收到远程连接请求，请打开应用确认",
          );
        });
      },
    );

    ipcMain.on("velodeck-host:cancel-approval", (event, sessionId: unknown) => {
      if (!this.isTrustedWorkerEvent(event)) return;
      const sid = typeof sessionId === "string" ? sessionId.trim() : "";
      if (
        this.pendingApprovalRequest &&
        (!sid || this.pendingApprovalRequest.sessionId === sid)
      ) {
        this.resolvePendingApprovalAsRejected("cancelled");
      }
    });

    ipcMain.on("velodeck-host:chat-incoming", (event, rawPayload: unknown) => {
      if (!this.isTrustedWorkerEvent(event)) return;
      if (!this.state.activeSessionId) return;
      if (!rawPayload || typeof rawPayload !== "object") return;
      const { sessionId, message } = rawPayload as {
        sessionId?: unknown;
        message?: Record<string, unknown>;
      };
      if (!message || typeof message !== "object") return;
      if (typeof sessionId !== "string" || sessionId !== this.state.activeSessionId) {
        return;
      }
      const rawText = typeof message.text === "string" ? message.text.trim() : "";
      if (!rawText) return;
      const id =
        typeof message.id === "string" && message.id.trim()
          ? message.id.trim().slice(0, 64)
          : crypto.randomUUID();
      const senderName =
        typeof message.senderName === "string" && message.senderName.trim()
          ? message.senderName.trim().slice(0, 64)
          : undefined;
      const ts =
        typeof message.ts === "number" && Number.isFinite(message.ts)
          ? message.ts
          : Date.now();
      const entry: DesktopChatMessage = {
        id,
        sender: "controller",
        ...(senderName ? { senderName } : {}),
        text: rawText.slice(0, MAX_CHAT_TEXT_LENGTH),
        ts,
      };
      this.appendChatMessage(entry);
      if (!this.hasFocusedControllerWindow()) {
        this.showOsNotification(
          senderName ? `来自 ${senderName} 的远控消息` : "VeloDeck 远程会话消息",
          entry.text.slice(0, 120),
        );
      }
    });

    ipcMain.handle(
      "velodeck-host:power",
      async (
        event,
        operation: unknown,
      ): Promise<{ ok: boolean; message?: string }> => {
        if (!this.isTrustedWorkerEvent(event)) {
          return { ok: false, message: "Untrusted worker IPC sender" };
        }
        if (!this.hasActiveFullControlPermission()) {
          return {
            ok: false,
            message: "被控端未授予完整键鼠控制权限，无法执行电源操作",
          };
        }
        if (!isPowerOperation(operation)) {
          return { ok: false, message: "不支持的电源操作指令" };
        }
        return executePowerAction(operation, this.platform, () =>
          this.injector.sendPayload({ action: "lock" }),
        );
      },
    );

    ipcMain.handle(
      "velodeck-host:file-text",
      (event, payload: unknown): string | null => {
        if (!this.isTrustedWorkerEvent(event)) {
          return null;
        }
        if (!this.state.activeSessionId) {
          return null;
        }
        if (this.activeSessionPermissions.fileTransfer === false) {
          return JSON.stringify({
            type: "file.error",
            transferId: "",
            error: "被控端未授予文件传输权限",
          });
        }
        if (!payload || typeof payload !== "object") return null;
        const { sessionId, text } = payload as {
          sessionId?: string;
          text?: string;
        };
        if (
          typeof sessionId !== "string" ||
          sessionId !== this.state.activeSessionId ||
          typeof text !== "string"
        ) {
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
        if (
          !this.state.activeSessionId ||
          this.activeSessionPermissions.fileTransfer === false
        ) {
          return null;
        }
        if (!payload || typeof payload !== "object") return null;
        const { sessionId, chunk } = payload as {
          sessionId?: string;
          chunk?: Uint8Array | Buffer;
        };
        if (
          typeof sessionId !== "string" ||
          sessionId !== this.state.activeSessionId ||
          !(chunk instanceof Uint8Array)
        ) {
          return null;
        }
        return this.handleFileTransferBinary(sessionId, chunk);
      },
    );

    ipcMain.on("velodeck-host:file-abort", (event, sessionId: unknown) => {
      if (!this.isTrustedWorkerEvent(event)) return;
      if (typeof sessionId === "string") {
        if (this.activeFileTransfer?.sessionId === sessionId) {
          this.cleanupActiveFileTransfer();
        }
        this.cleanupSessionDownloads(sessionId);
      }
    });

    ipcMain.handle(
      "velodeck-host:fs-request",
      async (
        event,
        rawRequest: unknown,
      ): Promise<Record<string, unknown>> => {
        if (!this.isTrustedWorkerEvent(event)) {
          return { type: "fs_error", reqId: "", error: "Untrusted worker IPC sender" };
        }
        if (!this.state.activeSessionId) {
          const reqId =
            rawRequest &&
            typeof rawRequest === "object" &&
            typeof (rawRequest as Record<string, unknown>).reqId === "string"
              ? ((rawRequest as Record<string, unknown>).reqId as string)
              : "";
          return { type: "fs_error", reqId, error: "当前没有活跃的远控会话" };
        }
        if (this.activeSessionPermissions.fileTransfer === false) {
          const reqId =
            rawRequest &&
            typeof rawRequest === "object" &&
            typeof (rawRequest as Record<string, unknown>).reqId === "string"
              ? ((rawRequest as Record<string, unknown>).reqId as string)
              : "";
          return { type: "fs_error", reqId, error: "被控端未授予文件传输权限" };
        }
        if (!rawRequest || typeof rawRequest !== "object") {
          return { type: "fs_error", reqId: "", error: "无效的文件管理请求" };
        }
        return this.handleRemoteFsRequest(rawRequest as Record<string, unknown>);
      },
    );

    ipcMain.handle(
      "velodeck-host:fs-download-open",
      (event, rawPayload: unknown): HostFsDownloadOpenResult => {
        if (!this.isTrustedWorkerEvent(event)) {
          return { ok: false, error: "Untrusted worker IPC sender" };
        }
        if (!this.state.activeSessionId) {
          return { ok: false, error: "当前没有活跃的远控会话" };
        }
        if (this.activeSessionPermissions.fileTransfer === false) {
          return { ok: false, error: "被控端未授予文件传输权限" };
        }
        if (!rawPayload || typeof rawPayload !== "object") {
          return { ok: false, error: "无效的下载请求参数" };
        }
        const { sessionId, reqId, filePath } = rawPayload as {
          sessionId?: unknown;
          reqId?: unknown;
          filePath?: unknown;
        };
        if (
          typeof sessionId !== "string" ||
          sessionId !== this.state.activeSessionId ||
          typeof reqId !== "string" ||
          !reqId ||
          typeof filePath !== "string"
        ) {
          return { ok: false, error: "缺少下载请求 ID 或文件路径" };
        }

        this.closeDownload(reqId);
        try {
          const stream = openDownloadStream(filePath);
          this.activeDownloads.set(reqId, { sessionId, stream });
          return {
            ok: true,
            fileName: stream.meta.fileName,
            size: stream.meta.size,
            mimeType: stream.meta.mimeType,
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "打开下载文件失败",
          };
        }
      },
    );

    ipcMain.handle(
      "velodeck-host:fs-download-read",
      (event, reqId: unknown): HostFsDownloadChunkResult => {
        if (!this.isTrustedWorkerEvent(event)) {
          return { ok: false, error: "Untrusted worker IPC sender" };
        }
        if (
          !this.state.activeSessionId ||
          this.activeSessionPermissions.fileTransfer === false
        ) {
          return { ok: false, error: "被控端未授予文件传输权限或会话已结束" };
        }
        if (typeof reqId !== "string" || !reqId) {
          return { ok: false, error: "缺少下载请求 ID" };
        }
        const active = this.activeDownloads.get(reqId);
        if (!active || active.sessionId !== this.state.activeSessionId) {
          return { ok: false, error: "下载任务已取消或不存在" };
        }
        try {
          const res = active.stream.readNextChunk();
          if (res.done) {
            this.activeDownloads.delete(reqId);
            return {
              ok: true,
              done: true,
              sha256: res.sha256 ?? "",
              size: res.size ?? active.stream.totalBytesRead,
            };
          }
          return {
            ok: true,
            done: false,
            chunk: res.chunk,
          };
        } catch (error) {
          this.closeDownload(reqId);
          return {
            ok: false,
            error: error instanceof Error ? error.message : "读取文件块失败",
          };
        }
      },
    );

    ipcMain.on("velodeck-host:fs-download-cancel", (event, reqId: unknown) => {
      if (!this.isTrustedWorkerEvent(event)) return;
      if (typeof reqId === "string" && reqId) {
        this.closeDownload(reqId);
      }
    });
  }

  private async handleRemoteFsRequest(
    req: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const type = typeof req.type === "string" ? req.type : "";
    const reqId = typeof req.reqId === "string" ? req.reqId : "";

    switch (type) {
      case "fs_roots_req": {
        try {
          const roots = getDefaultRoots(this.platform);
          return { type: "fs_roots_res", reqId, roots };
        } catch (error) {
          return {
            type: "fs_error",
            reqId,
            error: error instanceof Error ? error.message : "获取磁盘目录失败",
          };
        }
      }

      case "fs_list_req": {
        const targetPath = typeof req.path === "string" ? req.path : "";
        try {
          const result = listDirectory(targetPath);
          return {
            type: "fs_list_res",
            reqId,
            path: result.path,
            parentPath: result.parentPath,
            entries: result.entries,
          };
        } catch (error) {
          return {
            type: "fs_error",
            reqId,
            error: error instanceof Error ? error.message : "读取目录失败",
          };
        }
      }

      case "fs_mkdir_req": {
        const parentPath = typeof req.parentPath === "string" ? req.parentPath : "";
        const name = typeof req.name === "string" ? req.name : "";
        const res = createDirectory(parentPath, name);
        return {
          type: "fs_mkdir_res",
          reqId,
          ok: res.ok,
          ...(res.createdPath ? { createdPath: res.createdPath } : {}),
          ...(res.error ? { error: res.error } : {}),
        };
      }

      case "fs_delete_req": {
        const targetPath = typeof req.targetPath === "string" ? req.targetPath : "";
        const res = await trashPath(targetPath, (p) => shell.trashItem(p));
        return {
          type: "fs_delete_res",
          reqId,
          ok: res.ok,
          ...(res.error ? { error: res.error } : {}),
        };
      }

      default:
        return {
          type: "fs_error",
          reqId,
          error: `不支持的文件管理请求类型: ${type}`,
        };
    }
  }

  private closeDownload(reqId: string): void {
    const active = this.activeDownloads.get(reqId);
    if (!active) return;
    this.activeDownloads.delete(reqId);
    try {
      active.stream.close();
    } catch {
      // Ignore
    }
  }

  private cleanupSessionDownloads(sessionId: string): void {
    for (const [reqId, item] of this.activeDownloads.entries()) {
      if (item.sessionId === sessionId) {
        this.activeDownloads.delete(reqId);
        try {
          item.stream.close();
        } catch {
          // Ignore
        }
      }
    }
  }

  private cleanupAllDownloads(): void {
    for (const item of this.activeDownloads.values()) {
      try {
        item.stream.close();
      } catch {
        // Ignore
      }
    }
    this.activeDownloads.clear();
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
      case "file_offer":
        return this.handleFileOffer(sessionId, parsed);
      case "file.complete":
      case "file_complete":
        return this.handleFileComplete(sessionId, parsed);
      case "file.cancel":
      case "file_cancel": {
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
    const customTargetDir = resolveValidUploadTargetDir(msg.targetDir);
    const targetDir =
      customTargetDir ?? path.join(app.getPath("downloads"), "VeloDeck");
    const safeId =
      transferId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "transfer";
    const tempPath = path.join(targetDir, `.velodeck-incoming-${safeId}.tmp`);

    try {
      fs.mkdirSync(targetDir, { recursive: true });
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      const fd = fs.openSync(tempPath, "w", 0o644);
      this.activeFileTransfer = {
        sessionId,
        transferId,
        sanitizedName,
        targetDir,
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

    if (
      transfer.expectedSha256 &&
      completeSha &&
      transfer.expectedSha256 !== completeSha
    ) {
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
      const saveDir = transfer.targetDir;
      fs.mkdirSync(saveDir, { recursive: true });
      const finalPath = resolveUniqueFilePath(saveDir, transfer.sanitizedName);
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
