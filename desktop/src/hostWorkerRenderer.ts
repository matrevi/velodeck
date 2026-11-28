/**
 * VeloDeck Desktop Host Hidden Worker (runs inside sandboxed BrowserWindow at app://velodeck-host/hostWorker.html).
 * Flagship Pro Remote Desktop Engine:
 * - High-refresh 30/60/90/120fps & up to 4K (3840x2160) capture
 * - Multi-codec selection (auto | h264 | hevc | av1 | vp9) with RTX preservation
 * - Real-time loopback system audio (Electron 35 display-media loopback + graceful video-only fallback + live audio_toggle)
 * - Adaptive QoS: up to 30 Mbps on Direct LAN/P2P while keeping 2.4 Mbps TURN anti-bufferbloat cap tight
 * - Privacy curtain, remote power management, two-way clipboard sync, and two-way remote file manager over "file" DataChannel
 */

type HostPlatform = "darwin" | "win32" | "linux";
type TransportMode = "webrtc" | "ws-jpeg";
type VideoCodecPreference = "auto" | "h264" | "hevc" | "av1" | "vp9";

interface HostDisplayInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  primary: boolean;
  scaleFactor?: number;
}

interface HostPermissions {
  accessibility: boolean;
  screenCapture: boolean;
  platform: HostPlatform;
}

interface HostWorkerConfig {
  wsUrl: string;
  deviceId: string;
  deviceSecret: string;
  authToken?: string;
  unbindOwner?: boolean;
  controlPassword: string;
  name: string;
  model: string;
  osVersion: string;
  osPlatform: HostPlatform;
  displays: HostDisplayInfo[];
  activeDisplayId: string;
  permissions: HostPermissions;
  audioCaptureEnabled: boolean;
  privacyScreenActive: boolean;
}

type HostWorkerCommand =
  | { type: "start"; config: HostWorkerConfig }
  | {
      type: "update-config";
      config: HostWorkerConfig;
      reconnect: boolean;
      switchDisplayId?: string;
    }
  | { type: "clipboard-push"; text: string }
  | { type: "privacy-state-changed"; active: boolean }
  | { type: "disconnect-session"; reason?: string }
  | { type: "stop" };

interface HostWorkerStateReport {
  status?: "stopped" | "connecting" | "online" | "controlling" | "error";
  controlCode?: string;
  ownerUsername?: string;
  activeSessionId?: string | null;
  activeTransport?: TransportMode | null;
  activeDisplayId?: string;
  lastError?: string | null;
  privacyScreenActive?: boolean;
  audioEnabled?: boolean;
}

interface HostCaptureSourceResult {
  ok: boolean;
  sourceId?: string;
  display?: HostDisplayInfo;
  displays?: HostDisplayInfo[];
  error?: string;
}

interface HostFsDownloadOpenResult {
  ok: boolean;
  fileName?: string;
  size?: number;
  mimeType?: string;
  error?: string;
}

interface HostFsDownloadChunkResult {
  ok: boolean;
  chunk?: Uint8Array;
  done?: boolean;
  sha256?: string;
  size?: number;
  error?: string;
}

interface StreamQuality {
  maxWidth: number;
  fps: number;
  bitrateKbps: number;
  jpegQuality: number;
  auto?: boolean;
  codec?: VideoCodecPreference;
  audioEnabled?: boolean;
}

interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface HostWorkerBridge {
  ready(): void;
  onCommand(cb: (command: HostWorkerCommand) => void): () => void;
  reportState(report: HostWorkerStateReport): void;
  requestCaptureSource(
    displayId?: string,
    wantAudio?: boolean,
  ): Promise<HostCaptureSourceResult>;
  dispatchControl(
    cmd: Record<string, unknown>,
    displayId?: string,
  ): Promise<{ ok: boolean; message?: string }>;
  setClipboard(text: string): Promise<boolean>;
  setPrivacyScreen(
    enabled: boolean,
  ): Promise<{ ok: boolean; active: boolean; message?: string }>;
  executePower(
    operation: string,
  ): Promise<{ ok: boolean; message?: string }>;
  fileTransferText(sessionId: string, text: string): Promise<string | null>;
  fileTransferBinary(sessionId: string, chunk: Uint8Array): Promise<string | null>;
  fileTransferAbort(sessionId: string): void;
  fsRequest(
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  fsDownloadOpen(
    sessionId: string,
    reqId: string,
    filePath: string,
  ): Promise<HostFsDownloadOpenResult>;
  fsDownloadReadChunk(reqId: string): Promise<HostFsDownloadChunkResult>;
  fsDownloadCancel(reqId: string): void;
}

declare global {
  interface Window {
    velodeckHostWorker?: HostWorkerBridge;
  }
}

const FRAME_MAGIC = 0x4d; // 'M'
const FRAME_TYPE_JPEG = 0x01;
const FRAME_FLAG_KEYFRAME = 0x01;
const FRAME_HEADER_FIXED_SIZE = 20;

const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 15000];
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_WATCHDOG_MS = 40_000;
const WS_JPEG_MAX_BUFFERED_BYTES = 128 * 1024;
const FILE_DC_HIGH_WATERMARK = 512 * 1024;
const FILE_DC_LOW_THRESHOLD = 256 * 1024;
const MAX_LAN_BITRATE_KBPS = 30_000;
const TURN_AUTO_CEILING_KBPS = 2400;
const TURN_MANUAL_CEILING_KBPS = 2600;
const MAX_CAPTURE_WIDTH = 3840;
const MAX_CAPTURE_FPS = 120;
const OPUS_AUDIO_MAX_BITRATE_BPS = 128_000;

const DEFAULT_QUALITY: StreamQuality = {
  maxWidth: 1920,
  fps: 60,
  bitrateKbps: 6000,
  jpegQuality: 58,
  auto: true,
  codec: "auto",
  audioEnabled: true,
};

const textEncoder = new TextEncoder();

function getBridge(): HostWorkerBridge | null {
  return window.velodeckHostWorker ?? null;
}

function normalizeCodecPreference(raw: unknown): VideoCodecPreference {
  if (
    raw === "auto" ||
    raw === "h264" ||
    raw === "hevc" ||
    raw === "av1" ||
    raw === "vp9"
  ) {
    return raw;
  }
  return "auto";
}

function encodeJpegMediaFrame(
  sessionId: string,
  width: number,
  height: number,
  timestampMs: number,
  payload: Uint8Array,
): Uint8Array {
  const sessionBytes = sessionId ? textEncoder.encode(sessionId) : new Uint8Array(0);
  const totalLen =
    FRAME_HEADER_FIXED_SIZE + sessionBytes.byteLength + payload.byteLength;
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  out[0] = FRAME_MAGIC;
  out[1] = FRAME_TYPE_JPEG;
  view.setUint16(2, width & 0xffff, false);
  view.setUint16(4, height & 0xffff, false);
  out[6] = 0; // rotation = 0
  out[7] = FRAME_FLAG_KEYFRAME;

  const ts = Math.max(0, Math.floor(timestampMs));
  const hi = Math.floor(ts / 0x100000000);
  const lo = ts >>> 0;
  view.setUint32(8, hi >>> 0, false);
  view.setUint32(12, lo, false);

  view.setUint32(16, sessionBytes.byteLength, false);
  if (sessionBytes.byteLength > 0) {
    out.set(sessionBytes, FRAME_HEADER_FIXED_SIZE);
  }
  out.set(payload, FRAME_HEADER_FIXED_SIZE + sessionBytes.byteLength);
  return out;
}

function sortH264Bucket(h264Codecs: RTCRtpCodec[]): RTCRtpCodec[] {
  const highPm1: RTCRtpCodec[] = [];
  const highOther: RTCRtpCodec[] = [];
  const basePm1: RTCRtpCodec[] = [];
  const baseOther: RTCRtpCodec[] = [];
  const other: RTCRtpCodec[] = [];

  for (const codec of h264Codecs) {
    const fmtp = (codec.sdpFmtpLine ?? "").toLowerCase();
    if (fmtp.includes("profile-level-id=640c")) {
      if (fmtp.includes("packetization-mode=1")) highPm1.push(codec);
      else highOther.push(codec);
    } else if (fmtp.includes("profile-level-id=42e0")) {
      if (fmtp.includes("packetization-mode=1")) basePm1.push(codec);
      else baseOther.push(codec);
    } else {
      other.push(codec);
    }
  }

  return [...highPm1, ...highOther, ...basePm1, ...baseOther, ...other];
}

function sortPreferredVideoCodecs(
  codecs: readonly RTCRtpCodec[],
  preferred: VideoCodecPreference = "auto",
): RTCRtpCodec[] {
  const h264Raw: RTCRtpCodec[] = [];
  const hevc: RTCRtpCodec[] = [];
  const vp9: RTCRtpCodec[] = [];
  const av1: RTCRtpCodec[] = [];
  const vp8: RTCRtpCodec[] = [];
  const otherVideo: RTCRtpCodec[] = [];
  const auxiliary: RTCRtpCodec[] = []; // RTX, RED, ULPFEC, FlexFEC

  for (const codec of codecs) {
    const mime = codec.mimeType.toLowerCase();
    if (
      mime === "video/rtx" ||
      mime === "video/red" ||
      mime === "video/ulpfec" ||
      mime.startsWith("video/flexfec")
    ) {
      auxiliary.push(codec);
    } else if (mime === "video/h264") {
      h264Raw.push(codec);
    } else if (mime === "video/h265" || mime === "video/hevc") {
      hevc.push(codec);
    } else if (mime === "video/vp9") {
      vp9.push(codec);
    } else if (mime === "video/av1") {
      av1.push(codec);
    } else if (mime === "video/vp8") {
      vp8.push(codec);
    } else {
      otherVideo.push(codec);
    }
  }

  const h264 = sortH264Bucket(h264Raw);

  let orderedPrimary: RTCRtpCodec[];
  switch (preferred) {
    case "hevc":
      orderedPrimary = [...hevc, ...h264, ...vp9, ...av1, ...vp8, ...otherVideo];
      break;
    case "av1":
      orderedPrimary = [...av1, ...hevc, ...vp9, ...h264, ...vp8, ...otherVideo];
      break;
    case "vp9":
      orderedPrimary = [...vp9, ...hevc, ...h264, ...av1, ...vp8, ...otherVideo];
      break;
    case "h264":
    case "auto":
    default:
      orderedPrimary = [...h264, ...hevc, ...vp9, ...av1, ...vp8, ...otherVideo];
      break;
  }

  // Preserve RTX & FEC auxiliary entries so WebRTC NACK retransmission stays enabled
  return [...orderedPrimary, ...auxiliary];
}

function computeDesktopCaptureBounds(
  display: HostDisplayInfo,
  quality: StreamQuality,
): { width: number; height: number; fps: number } {
  const scaleFactor =
    typeof display.scaleFactor === "number" &&
    Number.isFinite(display.scaleFactor) &&
    display.scaleFactor >= 1
      ? Math.min(3, display.scaleFactor)
      : 1;
  const logicalW = Math.max(320, Math.round(display.width || 1920));
  const logicalH = Math.max(240, Math.round(display.height || 1080));
  const physW = Math.round(logicalW * scaleFactor);
  const physH = Math.round(logicalH * scaleFactor);

  const targetFps = Math.max(
    10,
    Math.min(MAX_CAPTURE_FPS, Math.round(quality.fps || 60)),
  );

  // Respect explicit 2K (2560) / 4K (3840) widths while keeping legacy presets crisp
  let maxLongEdge: number;
  if (quality.maxWidth >= 2560) {
    maxLongEdge = Math.min(MAX_CAPTURE_WIDTH, Math.round(quality.maxWidth));
  } else if (quality.maxWidth >= 1920) {
    maxLongEdge = Math.round(quality.maxWidth);
  } else if (quality.maxWidth >= 1080) {
    maxLongEdge = 1920;
  } else if (quality.maxWidth >= 800) {
    maxLongEdge = 1600;
  } else {
    maxLongEdge = 1280;
  }

  const srcW = maxLongEdge > logicalW ? physW : logicalW;
  const srcH = maxLongEdge > logicalW ? physH : logicalH;
  const longEdge = Math.max(srcW, srcH);
  const scale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;

  const w = Math.min(
    MAX_CAPTURE_WIDTH,
    Math.max(320, Math.round((srcW * scale) / 2) * 2),
  );
  const h = Math.min(
    2160,
    Math.max(240, Math.round((srcH * scale) / 2) * 2),
  );
  return { width: w, height: h, fps: targetFps };
}

function computeWsJpegDimensions(
  srcW: number,
  srcH: number,
  quality: StreamQuality,
): { width: number; height: number } {
  const safeW = Math.max(320, srcW || 1280);
  const safeH = Math.max(240, srcH || 720);
  const maxLongEdge =
    quality.maxWidth >= 2560
      ? 1920
      : quality.maxWidth >= 1080
        ? 1440
        : quality.maxWidth >= 800
          ? 1200
          : 960;
  const longEdge = Math.max(safeW, safeH);
  const scale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;
  return {
    width: Math.max(320, Math.round((safeW * scale) / 2) * 2),
    height: Math.max(240, Math.round((safeH * scale) / 2) * 2),
  };
}

class DesktopHostWorkerEngine {
  private config: HostWorkerConfig | null = null;
  private running = false;
  private ws: WebSocket | null = null;
  private wsGeneration = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastWsActivityAt = 0;
  private registered = false;
  private iceServers: IceServerConfig[] = [];

  // Active session state
  private sessionId: string | null = null;
  private sessionGeneration = 0;
  private activeTransport: TransportMode | null = null;
  private activeQuality: StreamQuality = { ...DEFAULT_QUALITY };
  private activeCaptureBounds: { width: number; height: number; fps: number } | null = null;
  private activeDisplay: HostDisplayInfo | null = null;
  private mediaStream: MediaStream | null = null;
  private pc: RTCPeerConnection | null = null;
  private videoSender: RTCRtpSender | null = null;
  private audioSender: RTCRtpSender | null = null;
  private controlDc: RTCDataChannel | null = null;
  private pointerDc: RTCDataChannel | null = null;
  private fileDc: RTCDataChannel | null = null;
  private remoteDescriptionReady = false;
  private pendingRemoteIce: RTCIceCandidateInit[] = [];
  private fileMsgChain: Promise<void> = Promise.resolve();
  private downloadChain: Promise<void> = Promise.resolve();
  private cancelledDownloads = new Set<string>();

  // Pro runtime state
  private audioEnabled = true;
  private privacyScreenActive = false;

  // Adaptive QoS state
  private qosTimer: ReturnType<typeof setInterval> | null = null;
  private qosRouteTurn = false;
  private qosBaselineRttMs: number | null = null;
  private qosBitrateKbps = 6000;
  private qosFps = 60;
  private qosScaleDown = 1.0;
  private qosHealthyStreak = 0;
  private qosPrevRetx = -1;

  // WS-JPEG fallback state
  private jpegTimer: ReturnType<typeof setInterval> | null = null;
  private jpegEncoding = false;
  private jpegVideo: HTMLVideoElement | null = null;
  private jpegCanvas: HTMLCanvasElement | null = null;

  public start(config: HostWorkerConfig): void {
    this.config = config;
    this.privacyScreenActive = Boolean(config.privacyScreenActive);
    this.audioEnabled = Boolean(config.audioCaptureEnabled);
    this.running = true;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    this.teardownSession(false);
    this.closeSocket();
    this.connectSocket();
  }

  public stop(): void {
    this.running = false;
    this.clearReconnectTimer();
    this.teardownSession(true, "host_stopped");
    this.closeSocket();
    this.privacyScreenActive = false;
    this.report({
      status: "stopped",
      activeSessionId: null,
      activeTransport: null,
      lastError: null,
      privacyScreenActive: false,
    });
  }

  public updateConfig(
    config: HostWorkerConfig,
    reconnect: boolean,
    switchDisplayId?: string,
  ): void {
    const prevAudioCapture = this.config?.audioCaptureEnabled;
    this.config = config;
    this.privacyScreenActive = Boolean(config.privacyScreenActive);

    if (!this.running) {
      return;
    }

    if (reconnect) {
      this.reconnectAttempt = 0;
      this.clearReconnectTimer();
      this.teardownSession(true, "host_config_changed");
      this.closeSocket();
      this.connectSocket();
      return;
    }

    if (prevAudioCapture !== config.audioCaptureEnabled) {
      if (!config.audioCaptureEnabled) {
        this.audioEnabled = false;
        this.syncAudioTrackMuteState();
      } else {
        this.audioEnabled = this.activeQuality.audioEnabled !== false;
        this.syncAudioTrackMuteState();
      }
    }

    if (switchDisplayId && this.sessionId) {
      void this.hotSwapDisplay(switchDisplayId);
    } else {
      this.sendTelemetry();
    }
  }

  public onPrivacyStateChanged(active: boolean): void {
    this.privacyScreenActive = Boolean(active);
    this.sendTelemetry();
  }

  public pushLocalClipboard(text: string): void {
    if (!this.sessionId || !this.config || !text) {
      return;
    }
    const payload: Record<string, unknown> = {
      type: "clipboard.sync",
      sessionId: this.sessionId,
      deviceId: this.config.deviceId,
      text,
    };
    if (this.controlDc && this.controlDc.readyState === "open") {
      try {
        this.controlDc.send(JSON.stringify(payload));
        return;
      } catch {
        // Fall through to Relay WS
      }
    }
    this.sendJson(payload);
  }

  public disconnectSession(reason = "host_disconnected"): void {
    if (!this.sessionId) {
      return;
    }
    this.teardownSession(true, reason);
    if (this.running && this.registered && this.ws?.readyState === WebSocket.OPEN) {
      this.report({
        status: "online",
        activeSessionId: null,
        activeTransport: null,
      });
    }
  }

  private report(patch: HostWorkerStateReport): void {
    getBridge()?.reportState(patch);
  }

  private isAudioEffectivelyEnabled(): boolean {
    if (!this.config?.audioCaptureEnabled || !this.audioEnabled) {
      return false;
    }
    if (!this.mediaStream) {
      return true;
    }
    const audioTracks = this.mediaStream.getAudioTracks();
    return audioTracks.length > 0 && audioTracks.some((t) => t.enabled && t.readyState === "live");
  }

  private syncAudioTrackMuteState(): void {
    if (!this.mediaStream) return;
    const allow = Boolean(this.config?.audioCaptureEnabled && this.audioEnabled);
    for (const track of this.mediaStream.getAudioTracks()) {
      track.enabled = allow;
    }
  }

  private buildCapabilities(): Record<string, boolean> {
    const cfg = this.config;
    return {
      webrtc: typeof RTCPeerConnection !== "undefined",
      wsJpeg: true,
      wsH264: false,
      wake: true,
      unlock: false,
      accessibility: Boolean(cfg?.permissions.accessibility),
      mediaProjection: Boolean(cfg?.permissions.screenCapture),
      p2pFileTransfer: true,
      desktopAudio: Boolean(cfg?.audioCaptureEnabled),
      privacyScreen: true,
      fileManager: true,
      powerControl: true,
      highRefresh: true,
    };
  }

  private getActiveDisplayFromConfig(): HostDisplayInfo {
    const cfg = this.config;
    if (cfg && cfg.displays.length > 0) {
      const matched = cfg.displays.find((d) => d.id === cfg.activeDisplayId);
      if (matched) return matched;
      const primary = cfg.displays.find((d) => d.primary);
      if (primary) return primary;
      return cfg.displays[0]!;
    }
    return {
      id: "0",
      name: "Primary Display",
      width: 1920,
      height: 1080,
      primary: true,
      scaleFactor: 1,
    };
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.lastWsActivityAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
        this.stopHeartbeat();
        return;
      }
      const now = Date.now();
      if (now - this.lastWsActivityAt > HEARTBEAT_WATCHDOG_MS) {
        try {
          ws.close(4000, "Heartbeat timeout");
        } catch {
          // Ignore
        }
        return;
      }
      this.sendJson({ type: "ping", ts: now });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private closeSocket(): void {
    this.wsGeneration += 1;
    this.stopHeartbeat();
    this.registered = false;
    const old = this.ws;
    this.ws = null;
    if (old) {
      old.onopen = null;
      old.onmessage = null;
      old.onerror = null;
      old.onclose = null;
      try {
        old.close(1000, "Client closing");
      } catch {
        // Ignore
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || !this.config) {
      return;
    }
    this.clearReconnectTimer();
    const delay =
      RECONNECT_BACKOFF_MS[
        Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)
      ] ?? 15_000;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) {
        this.connectSocket();
      }
    }, delay);
  }

  private connectSocket(): void {
    const cfg = this.config;
    if (!this.running || !cfg || !cfg.wsUrl) {
      return;
    }

    const gen = ++this.wsGeneration;
    this.registered = false;
    this.report({
      status: "connecting",
      activeSessionId: null,
      activeTransport: null,
    });

    let ws: WebSocket;
    try {
      ws = new WebSocket(cfg.wsUrl);
      ws.binaryType = "arraybuffer";
    } catch (err) {
      this.report({
        status: "error",
        lastError: err instanceof Error ? err.message : "WebSocket 初始化失败",
      });
      this.scheduleReconnect();
      return;
    }

    this.ws = ws;

    ws.onopen = () => {
      if (this.wsGeneration !== gen || this.ws !== ws || !this.config) {
        return;
      }
      this.lastWsActivityAt = Date.now();
      const activeDisp = this.getActiveDisplayFromConfig();
      const registerMsg: Record<string, unknown> = {
        type: "agent.register",
        deviceId: this.config.deviceId,
        deviceSecret: this.config.deviceSecret,
        controlPassword: this.config.controlPassword,
        deviceType: "desktop",
        osPlatform: this.config.osPlatform,
        name: this.config.name,
        model: this.config.model,
        androidVersion: this.config.osVersion,
        screenWidth: activeDisp.width,
        screenHeight: activeDisp.height,
        rotation: 0,
        battery: 100,
        charging: true,
        locked: false,
        screenOn: true,
        privacyScreenActive: this.privacyScreenActive,
        audioEnabled: this.isAudioEffectivelyEnabled(),
        displays: this.config.displays,
        activeDisplayId: activeDisp.id,
        capabilities: this.buildCapabilities(),
      };

      if (this.config.unbindOwner) {
        registerMsg.unbindOwner = true;
      } else if (this.config.authToken) {
        registerMsg.authToken = this.config.authToken;
      }

      this.sendJson(registerMsg);
      this.startHeartbeat(ws);
    };

    ws.onmessage = (event) => {
      if (this.wsGeneration !== gen || this.ws !== ws) {
        return;
      }
      this.lastWsActivityAt = Date.now();
      if (typeof event.data !== "string") {
        return;
      }
      let msg: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (!parsed || typeof parsed !== "object") return;
        msg = parsed as Record<string, unknown>;
      } catch {
        return;
      }
      this.handleRelayMessage(msg);
    };

    ws.onerror = () => {
      if (this.wsGeneration !== gen) return;
      // Close event handles reporting & backoff
    };

    ws.onclose = (event) => {
      if (this.wsGeneration !== gen) {
        return;
      }
      this.stopHeartbeat();
      this.ws = null;
      this.registered = false;
      this.teardownSession(false);

      if (!this.running) {
        return;
      }

      if (event.code === 4003) {
        this.report({
          status: "error",
          activeSessionId: null,
          activeTransport: null,
          lastError: "设备密钥冲突（DEVICE_SECRET_MISMATCH），请重置设备配置",
        });
        return;
      }

      this.report({
        status: "connecting",
        activeSessionId: null,
        activeTransport: null,
      });
      this.scheduleReconnect();
    };
  }

  private sendJson(obj: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  private sendTelemetry(): void {
    if (!this.config || !this.registered || this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    const disp = this.activeDisplay ?? this.getActiveDisplayFromConfig();
    this.sendJson({
      type: "agent.telemetry",
      deviceId: this.config.deviceId,
      screenWidth: disp.width,
      screenHeight: disp.height,
      rotation: 0,
      privacyScreenActive: this.privacyScreenActive,
      audioEnabled: this.isAudioEffectivelyEnabled(),
      displays: this.config.displays,
      activeDisplayId: disp.id,
      capabilities: this.buildCapabilities(),
    });
  }

  private handleRelayMessage(msg: Record<string, unknown>): void {
    const type = typeof msg.type === "string" ? msg.type : "";
    switch (type) {
      case "ping": {
        this.sendJson({
          type: "pong",
          ts: typeof msg.ts === "number" ? msg.ts : Date.now(),
        });
        break;
      }

      case "pong":
        break;

      case "agent.registered": {
        this.registered = true;
        this.reconnectAttempt = 0;
        if (Array.isArray(msg.iceServers)) {
          this.iceServers = msg.iceServers as IceServerConfig[];
        }
        const controlCode =
          typeof msg.controlCode === "string" ? msg.controlCode : "";
        const ownerUsername =
          typeof msg.ownerUsername === "string" ? msg.ownerUsername : "";
        if (this.config && this.config.unbindOwner && !ownerUsername) {
          this.config = { ...this.config, unbindOwner: false };
        }
        this.report({
          status: this.sessionId ? "controlling" : "online",
          controlCode,
          ownerUsername,
          lastError: null,
        });
        break;
      }

      case "session.request": {
        void this.handleSessionRequest(msg);
        break;
      }

      case "session.end": {
        const sid = typeof msg.sessionId === "string" ? msg.sessionId : "";
        if (sid && sid === this.sessionId) {
          this.teardownSession(false);
          if (this.running && this.registered) {
            this.report({
              status: "online",
              activeSessionId: null,
              activeTransport: null,
            });
          }
        }
        break;
      }

      case "rtc.offer": {
        const sid = typeof msg.sessionId === "string" ? msg.sessionId : "";
        const sdp = typeof msg.sdp === "string" ? msg.sdp : "";
        if (sid && sdp && sid === this.sessionId) {
          void this.handleRemoteOffer(sid, sdp);
        }
        break;
      }

      case "rtc.answer": {
        const sid = typeof msg.sessionId === "string" ? msg.sessionId : "";
        const sdp = typeof msg.sdp === "string" ? msg.sdp : "";
        if (sid && sdp && sid === this.sessionId) {
          void this.handleRemoteAnswer(sid, sdp);
        }
        break;
      }

      case "rtc.ice": {
        const sid = typeof msg.sessionId === "string" ? msg.sessionId : "";
        const candidate = msg.candidate as RTCIceCandidateInit | undefined;
        if (sid && candidate && sid === this.sessionId) {
          void this.handleRemoteIce(sid, candidate);
        }
        break;
      }

      case "control.cmd": {
        void this.handleControlCmd(msg, false);
        break;
      }

      case "clipboard.sync": {
        const text = typeof msg.text === "string" ? msg.text : "";
        if (text) {
          void getBridge()?.setClipboard(text);
        }
        break;
      }

      case "error": {
        const code = typeof msg.code === "string" ? msg.code : "INTERNAL_ERROR";
        const message =
          typeof msg.message === "string" ? msg.message : "Relay error";
        if (code === "UNAUTHORIZED" || code === "DEVICE_SECRET_MISMATCH") {
          this.report({
            status: "error",
            lastError: message,
          });
        }
        break;
      }

      default:
        break;
    }
  }

  private async acquireDesktopStream(
    displayId: string | undefined,
    quality: StreamQuality,
  ): Promise<{
    stream: MediaStream;
    display: HostDisplayInfo;
    bounds: { width: number; height: number; fps: number };
  }> {
    const bridge = getBridge();
    if (!bridge) {
      throw new Error("Host worker bridge unavailable");
    }

    const wantAudio = Boolean(this.config?.audioCaptureEnabled);
    const sourceRes = await bridge.requestCaptureSource(displayId, wantAudio);
    if (!sourceRes.ok || !sourceRes.sourceId || !sourceRes.display) {
      throw new Error(
        sourceRes.error ||
          "无法获取屏幕采集源，请检查系统屏幕录制权限设置",
      );
    }

    if (
      this.config &&
      Array.isArray(sourceRes.displays) &&
      sourceRes.displays.length > 0
    ) {
      this.config = {
        ...this.config,
        displays: sourceRes.displays,
        activeDisplayId: sourceRes.display.id,
      };
    }

    const bounds = computeDesktopCaptureBounds(sourceRes.display, quality);
    let stream: MediaStream | null = null;

    // 1) Primary path: Electron 35 getDisplayMedia backed by setDisplayMediaRequestHandler with native loopback audio
    if (
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getDisplayMedia === "function"
    ) {
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: { ideal: bounds.fps, max: bounds.fps },
            width: { max: bounds.width },
            height: { max: bounds.height },
          },
          audio: wantAudio,
        });
      } catch (err) {
        console.warn(
          "[hostWorker] getDisplayMedia with loopback audio failed, falling back to video-only:",
          err,
        );
        stream = null;
      }
    }

    // 2) Graceful fallback: Electron desktop getUserMedia (video-only)
    if (!stream) {
      const legacyConstraints = {
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: sourceRes.sourceId,
            minWidth: 320,
            maxWidth: bounds.width,
            minHeight: 240,
            maxHeight: bounds.height,
            maxFrameRate: bounds.fps,
          },
        },
      } as unknown as MediaStreamConstraints;
      stream = await navigator.mediaDevices.getUserMedia(legacyConstraints);
    }

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("未获取到桌面视频轨道");
    }

    try {
      videoTrack.contentHint = bounds.fps >= 90 ? "motion" : "detail";
    } catch {
      // Optional browser hint
    }

    const allowAudioNow = Boolean(
      this.config?.audioCaptureEnabled && this.audioEnabled,
    );
    for (const audioTrack of stream.getAudioTracks()) {
      audioTrack.enabled = allowAudioNow;
    }

    return { stream, display: sourceRes.display, bounds };
  }

  private async handleSessionRequest(msg: Record<string, unknown>): Promise<void> {
    if (!this.config || !this.running) {
      return;
    }
    const sid = typeof msg.sessionId === "string" ? msg.sessionId : "";
    const preferred: TransportMode =
      msg.preferredTransport === "ws-jpeg" ? "ws-jpeg" : "webrtc";
    if (!sid) {
      return;
    }

    const rawQuality =
      msg.quality && typeof msg.quality === "object"
        ? (msg.quality as Partial<StreamQuality>)
        : {};
    const quality: StreamQuality = {
      maxWidth:
        typeof rawQuality.maxWidth === "number" && rawQuality.maxWidth > 0
          ? Math.min(MAX_CAPTURE_WIDTH, rawQuality.maxWidth)
          : DEFAULT_QUALITY.maxWidth,
      fps:
        typeof rawQuality.fps === "number" && rawQuality.fps > 0
          ? Math.min(MAX_CAPTURE_FPS, rawQuality.fps)
          : DEFAULT_QUALITY.fps,
      bitrateKbps:
        typeof rawQuality.bitrateKbps === "number" && rawQuality.bitrateKbps > 0
          ? Math.min(MAX_LAN_BITRATE_KBPS, rawQuality.bitrateKbps)
          : DEFAULT_QUALITY.bitrateKbps,
      jpegQuality:
        typeof rawQuality.jpegQuality === "number" && rawQuality.jpegQuality > 0
          ? rawQuality.jpegQuality
          : DEFAULT_QUALITY.jpegQuality,
      auto: typeof rawQuality.auto === "boolean" ? rawQuality.auto : true,
      codec: normalizeCodecPreference(rawQuality.codec),
      audioEnabled:
        typeof rawQuality.audioEnabled === "boolean"
          ? rawQuality.audioEnabled
          : true,
    };

    const sessionIceServers: IceServerConfig[] =
      Array.isArray(msg.iceServers) && msg.iceServers.length > 0
        ? (msg.iceServers as IceServerConfig[])
        : this.iceServers;

    // Tear down any previous session cleanly before starting new one
    if (this.sessionId && this.sessionId !== sid) {
      this.teardownSession(true, "replaced_by_new_session");
    } else {
      this.teardownSession(false);
    }

    const gen = ++this.sessionGeneration;
    this.sessionId = sid;
    this.activeQuality = quality;
    this.audioEnabled = Boolean(
      this.config.audioCaptureEnabled && quality.audioEnabled !== false,
    );

    let captured: {
      stream: MediaStream;
      display: HostDisplayInfo;
      bounds: { width: number; height: number; fps: number };
    };
    try {
      captured = await this.acquireDesktopStream(this.config.activeDisplayId, quality);
    } catch (err) {
      if (this.sessionGeneration !== gen) return;
      const errMsg =
        err instanceof Error && err.message
          ? err.message
          : "电脑尚未授予屏幕录制权限，请在系统设置中允许 VeloDeck 录制屏幕";
      this.sessionId = null;
      this.sendJson({
        type: "error",
        code: "INTERNAL_ERROR",
        message: errMsg,
        sessionId: sid,
        deviceId: this.config.deviceId,
      });
      this.report({
        status: this.registered ? "online" : "error",
        activeSessionId: null,
        activeTransport: null,
        lastError: errMsg,
      });
      return;
    }

    if (
      this.sessionGeneration !== gen ||
      !this.running ||
      this.ws?.readyState !== WebSocket.OPEN
    ) {
      captured.stream.getTracks().forEach((t) => t.stop());
      return;
    }

    this.mediaStream = captured.stream;
    this.activeDisplay = captured.display;
    this.activeCaptureBounds = captured.bounds;

    const useWebRtc =
      preferred === "webrtc" && typeof RTCPeerConnection !== "undefined";

    if (useWebRtc) {
      try {
        this.setupWebRtcPeerConnection(sid, gen, captured.stream, sessionIceServers);
        this.activeTransport = "webrtc";
      } catch (err) {
        console.warn("[hostWorker] WebRTC init failed, falling back to ws-jpeg:", err);
        this.closePeerConnection();
        this.activeTransport = "ws-jpeg";
      }
    } else {
      this.activeTransport = "ws-jpeg";
    }

    this.sendJson({
      type: "session.ready",
      sessionId: sid,
      deviceId: this.config.deviceId,
      transport: this.activeTransport,
      screenWidth: captured.display.width,
      screenHeight: captured.display.height,
      rotation: 0,
    });

    this.report({
      status: "controlling",
      activeSessionId: sid,
      activeTransport: this.activeTransport,
      activeDisplayId: captured.display.id,
      audioEnabled: this.isAudioEffectivelyEnabled(),
      lastError: null,
    });

    this.sendTelemetry();

    if (this.activeTransport === "ws-jpeg") {
      this.startWsJpegLoop(sid, gen, captured.stream);
    }
  }

  private setupWebRtcPeerConnection(
    sid: string,
    gen: number,
    stream: MediaStream,
    iceServers: IceServerConfig[],
  ): void {
    this.closePeerConnection();

    const pc = new RTCPeerConnection({
      iceServers: iceServers.length > 0 ? iceServers : [],
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    });
    this.pc = pc;
    this.remoteDescriptionReady = false;
    this.pendingRemoteIce = [];

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      throw new Error("Missing desktop video track");
    }

    const sender = pc.addTrack(videoTrack, stream);
    this.videoSender = sender;
    this.applyPreferredVideoCodec(pc, sender, this.activeQuality.codec ?? "auto");

    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      this.audioSender = pc.addTrack(audioTrack, stream);
    }

    pc.onicecandidate = (event) => {
      if (
        this.sessionGeneration !== gen ||
        this.pc !== pc ||
        !event.candidate ||
        !this.config
      ) {
        return;
      }
      this.sendJson({
        type: "rtc.ice",
        sessionId: sid,
        deviceId: this.config.deviceId,
        candidate: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        },
      });
    };

    pc.ondatachannel = (event) => {
      if (this.sessionGeneration !== gen || this.pc !== pc) {
        try {
          event.channel.close();
        } catch {
          // Ignore
        }
        return;
      }
      this.attachIncomingDataChannel(sid, gen, event.channel);
    };

    const handleConnected = () => {
      if (this.sessionGeneration !== gen || this.pc !== pc) return;
      void this.applyVideoSenderParameters();
      void this.applyAudioSenderParameters();
      this.startAdaptiveQosLoop(sid, gen, pc);
    };

    const handleFailed = () => {
      if (this.sessionGeneration !== gen || this.pc !== pc) return;
      this.teardownSession(false);
      if (this.running && this.registered) {
        this.report({
          status: "online",
          activeSessionId: null,
          activeTransport: null,
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (this.sessionGeneration !== gen || this.pc !== pc) return;
      if (pc.connectionState === "connected") {
        handleConnected();
      } else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        handleFailed();
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (this.sessionGeneration !== gen || this.pc !== pc) return;
      if (
        pc.iceConnectionState === "connected" ||
        pc.iceConnectionState === "completed"
      ) {
        handleConnected();
      } else if (
        pc.iceConnectionState === "failed" ||
        pc.iceConnectionState === "closed"
      ) {
        handleFailed();
      }
    };
  }

  private applyPreferredVideoCodec(
    pc: RTCPeerConnection,
    sender: RTCRtpSender,
    preferred: VideoCodecPreference,
  ): void {
    try {
      const capabilities =
        typeof RTCRtpSender !== "undefined" &&
        typeof RTCRtpSender.getCapabilities === "function"
          ? RTCRtpSender.getCapabilities("video")
          : null;
      if (!capabilities || capabilities.codecs.length === 0) {
        return;
      }
      const ordered = sortPreferredVideoCodecs(capabilities.codecs, preferred);
      if (ordered.length === 0) {
        return;
      }
      const transceiver = pc
        .getTransceivers()
        .find((t) => t.sender === sender || t.sender.track?.kind === "video");
      if (transceiver && typeof transceiver.setCodecPreferences === "function") {
        transceiver.setCodecPreferences(ordered);
      }
    } catch {
      // Fall back to default browser codec negotiation
    }
  }

  private async applyAudioSenderParameters(): Promise<void> {
    const sender = this.audioSender;
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      for (const enc of params.encodings) {
        enc.maxBitrate = OPUS_AUDIO_MAX_BITRATE_BPS;
      }
      await sender.setParameters(params);
    } catch {
      // Ignore if audio sender isn't negotiated in remote SDP
    }
  }

  private attachIncomingDataChannel(
    sid: string,
    gen: number,
    dc: RTCDataChannel,
  ): void {
    const label = dc.label;
    if (label === "control") {
      this.controlDc = dc;
      dc.onmessage = (event) => {
        if (this.sessionGeneration !== gen || typeof event.data !== "string") return;
        this.handleDataChannelControlText(sid, event.data);
      };
      dc.onclose = () => {
        if (this.controlDc === dc) this.controlDc = null;
      };
      return;
    }

    if (label === "pointer") {
      this.pointerDc = dc;
      dc.onmessage = (event) => {
        if (this.sessionGeneration !== gen || typeof event.data !== "string") return;
        this.handleDataChannelControlText(sid, event.data);
      };
      dc.onclose = () => {
        if (this.pointerDc === dc) this.pointerDc = null;
      };
      return;
    }

    if (label === "file") {
      dc.binaryType = "arraybuffer";
      try {
        dc.bufferedAmountLowThreshold = FILE_DC_LOW_THRESHOLD;
      } catch {
        // Optional threshold
      }
      this.fileDc = dc;
      dc.onmessage = (event) => {
        if (this.sessionGeneration !== gen) return;
        const payload = event.data;

        if (typeof payload === "string") {
          const fsHandled = this.tryDispatchRemoteFsMessage(sid, gen, dc, payload);
          if (fsHandled) {
            return;
          }
        }

        this.fileMsgChain = this.fileMsgChain
          .then(async () => {
            if (this.sessionGeneration !== gen || this.fileDc !== dc) return;
            const bridge = getBridge();
            if (!bridge) return;
            let reply: string | null = null;
            if (typeof payload === "string") {
              reply = await bridge.fileTransferText(sid, payload);
            } else if (payload instanceof ArrayBuffer) {
              reply = await bridge.fileTransferBinary(sid, new Uint8Array(payload));
            } else if (payload instanceof Blob) {
              const buf = await payload.arrayBuffer();
              reply = await bridge.fileTransferBinary(sid, new Uint8Array(buf));
            }
            if (reply && this.fileDc === dc && dc.readyState === "open") {
              try {
                dc.send(reply);
              } catch {
                // Ignore closed channel
              }
            }
          })
          .catch(() => undefined);
      };
      dc.onclose = () => {
        if (this.fileDc === dc) {
          this.fileDc = null;
          this.cancelledDownloads.clear();
          getBridge()?.fileTransferAbort(sid);
        }
      };
    }
  }

  private tryDispatchRemoteFsMessage(
    sid: string,
    gen: number,
    dc: RTCDataChannel,
    rawText: string,
  ): boolean {
    let parsed: Record<string, unknown>;
    try {
      const obj: unknown = JSON.parse(rawText);
      if (!obj || typeof obj !== "object") return false;
      parsed = obj as Record<string, unknown>;
    } catch {
      return false;
    }

    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (!type.startsWith("fs_")) {
      return false;
    }

    const reqId = typeof parsed.reqId === "string" ? parsed.reqId : "";
    const bridge = getBridge();
    if (!bridge) {
      return true;
    }

    if (type === "fs_download_cancel") {
      if (reqId) {
        this.cancelledDownloads.add(reqId);
        bridge.fsDownloadCancel(reqId);
      }
      return true;
    }

    if (type === "fs_download_req") {
      const filePath = typeof parsed.filePath === "string" ? parsed.filePath : "";
      this.cancelledDownloads.delete(reqId);
      this.downloadChain = this.downloadChain
        .then(async () => {
          if (
            this.sessionGeneration !== gen ||
            this.fileDc !== dc ||
            dc.readyState !== "open"
          ) {
            return;
          }
          await this.streamFileDownloadToChannel(sid, gen, dc, reqId, filePath);
        })
        .catch(() => undefined);
      return true;
    }

    if (
      type === "fs_roots_req" ||
      type === "fs_list_req" ||
      type === "fs_mkdir_req" ||
      type === "fs_delete_req"
    ) {
      void bridge
        .fsRequest(parsed)
        .then((response) => {
          if (
            this.sessionGeneration === gen &&
            this.fileDc === dc &&
            dc.readyState === "open"
          ) {
            try {
              dc.send(JSON.stringify(response));
            } catch {
              // Ignore closed channel
            }
          }
        })
        .catch((error) => {
          if (
            this.sessionGeneration === gen &&
            this.fileDc === dc &&
            dc.readyState === "open"
          ) {
            try {
              dc.send(
                JSON.stringify({
                  type: "fs_error",
                  reqId,
                  error:
                    error instanceof Error ? error.message : "远程文件操作失败",
                }),
              );
            } catch {
              // Ignore
            }
          }
        });
      return true;
    }

    return false;
  }

  private waitForFileChannelDrain(
    dc: RTCDataChannel,
    gen: number,
    reqId: string,
  ): Promise<void> {
    if (
      dc.readyState !== "open" ||
      dc.bufferedAmount <= FILE_DC_HIGH_WATERMARK ||
      this.sessionGeneration !== gen ||
      this.cancelledDownloads.has(reqId)
    ) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        dc.removeEventListener("bufferedamountlow", onLow);
        dc.removeEventListener("close", onLow);
        resolve();
      };
      const onLow = () => done();
      const timer = setTimeout(done, 50);
      dc.addEventListener("bufferedamountlow", onLow, { once: true });
      dc.addEventListener("close", onLow, { once: true });
    });
  }

  private async streamFileDownloadToChannel(
    sid: string,
    gen: number,
    dc: RTCDataChannel,
    reqId: string,
    filePath: string,
  ): Promise<void> {
    const bridge = getBridge();
    if (!bridge) return;

    const sendJsonSafe = (obj: Record<string, unknown>): boolean => {
      if (
        this.sessionGeneration !== gen ||
        this.fileDc !== dc ||
        dc.readyState !== "open"
      ) {
        return false;
      }
      try {
        dc.send(JSON.stringify(obj));
        return true;
      } catch {
        return false;
      }
    };

    const openRes = await bridge.fsDownloadOpen(sid, reqId, filePath);
    if (!openRes.ok) {
      sendJsonSafe({
        type: "fs_download_error",
        reqId,
        error: openRes.error || "无法打开目标文件",
      });
      return;
    }

    if (
      this.cancelledDownloads.has(reqId) ||
      this.sessionGeneration !== gen ||
      this.fileDc !== dc ||
      dc.readyState !== "open"
    ) {
      bridge.fsDownloadCancel(reqId);
      this.cancelledDownloads.delete(reqId);
      return;
    }

    if (
      !sendJsonSafe({
        type: "fs_download_start",
        reqId,
        fileName: openRes.fileName ?? "download",
        size: openRes.size ?? 0,
        mimeType: openRes.mimeType ?? "application/octet-stream",
      })
    ) {
      bridge.fsDownloadCancel(reqId);
      return;
    }

    while (true) {
      if (
        this.cancelledDownloads.has(reqId) ||
        this.sessionGeneration !== gen ||
        this.fileDc !== dc ||
        dc.readyState !== "open"
      ) {
        bridge.fsDownloadCancel(reqId);
        this.cancelledDownloads.delete(reqId);
        return;
      }

      while (
        dc.readyState === "open" &&
        dc.bufferedAmount > FILE_DC_HIGH_WATERMARK &&
        this.sessionGeneration === gen &&
        !this.cancelledDownloads.has(reqId)
      ) {
        await this.waitForFileChannelDrain(dc, gen, reqId);
      }

      if (
        this.cancelledDownloads.has(reqId) ||
        this.sessionGeneration !== gen ||
        this.fileDc !== dc ||
        dc.readyState !== "open"
      ) {
        bridge.fsDownloadCancel(reqId);
        this.cancelledDownloads.delete(reqId);
        return;
      }

      const chunkRes = await bridge.fsDownloadReadChunk(reqId);
      if (!chunkRes.ok) {
        sendJsonSafe({
          type: "fs_download_error",
          reqId,
          error: chunkRes.error || "读取文件失败",
        });
        return;
      }

      if (chunkRes.done) {
        sendJsonSafe({
          type: "fs_download_end",
          reqId,
          sha256: chunkRes.sha256 ?? "",
          size: chunkRes.size ?? 0,
        });
        this.cancelledDownloads.delete(reqId);
        return;
      }

      if (chunkRes.chunk && chunkRes.chunk.byteLength > 0) {
        const copy = new Uint8Array(chunkRes.chunk.byteLength);
        copy.set(chunkRes.chunk);
        try {
          dc.send(copy.buffer);
        } catch {
          bridge.fsDownloadCancel(reqId);
          return;
        }
      }
    }
  }

  private handleDataChannelControlText(sid: string, raw: string): void {
    if (raw === '{"type":"dc.ping"}') {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      return;
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.type === "dc.ping") {
      return;
    }
    if (obj.type === "control.cmd") {
      const msgSid = typeof obj.sessionId === "string" ? obj.sessionId : "";
      if (msgSid && msgSid !== sid) {
        return;
      }
      void this.handleControlCmd(obj, true);
    } else if (obj.type === "clipboard.sync") {
      const text = typeof obj.text === "string" ? obj.text : "";
      if (text) {
        void getBridge()?.setClipboard(text);
      }
    }
  }

  private async handleRemoteOffer(sid: string, sdp: string): Promise<void> {
    const pc = this.pc;
    const gen = this.sessionGeneration;
    if (!pc || !this.config || this.sessionId !== sid) {
      return;
    }

    try {
      this.remoteDescriptionReady = false;
      if (pc.signalingState !== "stable") {
        try {
          await pc.setLocalDescription({ type: "rollback" });
        } catch {
          // Ignore rollback failure
        }
      }
      await pc.setRemoteDescription({ type: "offer", sdp });
      if (this.sessionGeneration !== gen || this.pc !== pc) return;

      if (this.videoSender) {
        this.applyPreferredVideoCodec(
          pc,
          this.videoSender,
          this.activeQuality.codec ?? "auto",
        );
      }

      const answer = await pc.createAnswer();
      if (this.sessionGeneration !== gen || this.pc !== pc) return;
      await pc.setLocalDescription(answer);
      if (this.sessionGeneration !== gen || this.pc !== pc || !answer.sdp) return;

      this.sendJson({
        type: "rtc.answer",
        sessionId: sid,
        deviceId: this.config.deviceId,
        sdp: answer.sdp,
      });

      this.remoteDescriptionReady = true;
      await this.flushPendingIce(pc, gen);
      await this.applyVideoSenderParameters();
      await this.applyAudioSenderParameters();
    } catch (err) {
      console.warn("[hostWorker] handleRemoteOffer failed:", err);
    }
  }

  private async handleRemoteAnswer(sid: string, sdp: string): Promise<void> {
    const pc = this.pc;
    const gen = this.sessionGeneration;
    if (!pc || this.sessionId !== sid) {
      return;
    }
    try {
      await pc.setRemoteDescription({ type: "answer", sdp });
      if (this.sessionGeneration !== gen || this.pc !== pc) return;
      this.remoteDescriptionReady = true;
      await this.flushPendingIce(pc, gen);
      await this.applyVideoSenderParameters();
      await this.applyAudioSenderParameters();
    } catch (err) {
      console.warn("[hostWorker] handleRemoteAnswer failed:", err);
    }
  }

  private async handleRemoteIce(
    sid: string,
    candidate: RTCIceCandidateInit,
  ): Promise<void> {
    const pc = this.pc;
    if (!pc || this.sessionId !== sid) {
      return;
    }
    if (!this.remoteDescriptionReady) {
      this.pendingRemoteIce.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch {
      // Ignore stale ICE candidates
    }
  }

  private async flushPendingIce(pc: RTCPeerConnection, gen: number): Promise<void> {
    const queued = this.pendingRemoteIce.splice(0, this.pendingRemoteIce.length);
    for (const cand of queued) {
      if (this.sessionGeneration !== gen || this.pc !== pc) return;
      try {
        await pc.addIceCandidate(cand);
      } catch {
        // Ignore stale candidates
      }
    }
  }

  private resetAdaptiveQosState(): void {
    this.qosBaselineRttMs = null;
    this.qosHealthyStreak = 0;
    this.qosPrevRetx = -1;
    this.qosScaleDown = 1.0;

    const requestedKbps = Math.max(
      400,
      Math.min(MAX_LAN_BITRATE_KBPS, this.activeQuality.bitrateKbps || 6000),
    );
    const requestedFps = Math.max(
      15,
      Math.min(MAX_CAPTURE_FPS, this.activeQuality.fps || 60),
    );

    if (this.activeQuality.auto) {
      if (this.qosRouteTurn) {
        this.qosBitrateKbps = 1800;
        this.qosFps = Math.min(30, requestedFps);
      } else {
        const lanCeiling = Math.min(
          MAX_LAN_BITRATE_KBPS,
          Math.max(8000, requestedKbps),
        );
        this.qosBitrateKbps = Math.min(lanCeiling, Math.max(6000, requestedKbps));
        this.qosFps = requestedFps;
      }
    } else {
      this.qosBitrateKbps = this.qosRouteTurn
        ? Math.min(requestedKbps, TURN_MANUAL_CEILING_KBPS)
        : requestedKbps;
      this.qosFps = this.qosRouteTurn
        ? Math.min(requestedFps, 60)
        : requestedFps;
    }
  }

  private async applyVideoSenderParameters(
    bitrateKbpsOverride?: number,
    fpsOverride?: number,
    scaleDownOverride?: number,
  ): Promise<void> {
    const sender = this.videoSender;
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      const targetKbps = Math.max(
        400,
        Math.min(
          MAX_LAN_BITRATE_KBPS,
          Math.round(bitrateKbpsOverride ?? this.qosBitrateKbps),
        ),
      );
      const targetFps = Math.max(
        15,
        Math.min(MAX_CAPTURE_FPS, Math.round(fpsOverride ?? this.qosFps)),
      );
      const targetScale = Math.max(
        1.0,
        Math.min(2.0, scaleDownOverride ?? this.qosScaleDown),
      );
      for (const enc of params.encodings) {
        enc.maxBitrate = targetKbps * 1000;
        enc.maxFramerate = targetFps;
        enc.scaleResolutionDownBy = targetScale;
      }
      await sender.setParameters(params);
    } catch {
      // Some Chromium builds restrict setParameters before negotiation settles
    }
  }

  private startAdaptiveQosLoop(
    sid: string,
    gen: number,
    pc: RTCPeerConnection,
  ): void {
    this.stopAdaptiveQosLoop();
    this.resetAdaptiveQosState();

    this.qosTimer = setInterval(() => {
      if (this.sessionGeneration !== gen || this.pc !== pc || this.sessionId !== sid) {
        this.stopAdaptiveQosLoop();
        return;
      }
      void pc
        .getStats()
        .then((report) => {
          if (this.sessionGeneration !== gen || this.pc !== pc) return;
          this.evaluateQosStats(report);
        })
        .catch(() => undefined);
    }, 1000);
  }

  private stopAdaptiveQosLoop(): void {
    if (this.qosTimer !== null) {
      clearInterval(this.qosTimer);
      this.qosTimer = null;
    }
  }

  private evaluateQosStats(report: RTCStatsReport): void {
    let selectedPairId: string | null = null;
    let retxTotal = 0;
    const candidatePairs = new Map<string, Record<string, unknown>>();
    const candidates = new Map<string, string>();

    report.forEach((stat) => {
      const rec = stat as unknown as Record<string, unknown>;
      if (stat.type === "transport" && typeof rec.selectedCandidatePairId === "string") {
        selectedPairId = rec.selectedCandidatePairId;
      } else if (stat.type === "candidate-pair") {
        candidatePairs.set(stat.id, rec);
      } else if (
        (stat.type === "local-candidate" || stat.type === "remote-candidate") &&
        typeof rec.candidateType === "string"
      ) {
        candidates.set(stat.id, rec.candidateType);
      } else if (
        stat.type === "outbound-rtp" &&
        (rec.kind === "video" || rec.mediaType === "video")
      ) {
        if (typeof rec.retransmittedPacketsSent === "number") {
          retxTotal = rec.retransmittedPacketsSent;
        }
      }
    });

    let activePair = selectedPairId ? candidatePairs.get(selectedPairId) : undefined;
    if (!activePair) {
      for (const pair of candidatePairs.values()) {
        if (
          (pair.nominated === true || pair.selected === true) &&
          pair.state === "succeeded"
        ) {
          activePair = pair;
          break;
        }
      }
    }
    if (!activePair) return;

    const localType =
      typeof activePair.localCandidateId === "string"
        ? candidates.get(activePair.localCandidateId)
        : undefined;
    const remoteType =
      typeof activePair.remoteCandidateId === "string"
        ? candidates.get(activePair.remoteCandidateId)
        : undefined;
    const isTurn = localType === "relay" || remoteType === "relay";
    const routeChanged = isTurn !== this.qosRouteTurn;
    this.qosRouteTurn = isTurn;

    const rttSec =
      typeof activePair.currentRoundTripTime === "number" &&
      Number.isFinite(activePair.currentRoundTripTime)
        ? activePair.currentRoundTripTime
        : null;
    const rttMs = rttSec !== null ? Math.round(rttSec * 1000) : null;
    if (rttMs !== null && rttMs > 0) {
      this.qosBaselineRttMs =
        this.qosBaselineRttMs === null
          ? rttMs
          : Math.min(this.qosBaselineRttMs, rttMs);
    }

    const retxDelta =
      this.qosPrevRetx >= 0 && retxTotal >= this.qosPrevRetx
        ? retxTotal - this.qosPrevRetx
        : 0;
    this.qosPrevRetx = retxTotal;

    const requestedKbps = Math.max(
      500,
      Math.min(MAX_LAN_BITRATE_KBPS, this.activeQuality.bitrateKbps || 6000),
    );
    const requestedFps = Math.max(
      15,
      Math.min(MAX_CAPTURE_FPS, this.activeQuality.fps || 60),
    );

    if (!this.activeQuality.auto) {
      if (routeChanged) {
        const manualKbps = isTurn
          ? Math.min(requestedKbps, TURN_MANUAL_CEILING_KBPS)
          : requestedKbps;
        this.qosBitrateKbps = Math.max(500, manualKbps);
        this.qosFps = isTurn ? Math.min(requestedFps, 60) : requestedFps;
        this.qosScaleDown = 1.0;
        void this.applyVideoSenderParameters();
      }
      return;
    }

    // TURN stays tightly capped at 2.4 Mbps anti-bufferbloat; Direct LAN/P2P scales up to 30 Mbps @ 90/120fps
    const ceilingKbps = isTurn
      ? TURN_AUTO_CEILING_KBPS
      : Math.min(MAX_LAN_BITRATE_KBPS, Math.max(12_000, requestedKbps));
    const floorKbps = 500;
    const maxFps = isTurn ? Math.min(45, requestedFps) : requestedFps;

    let nextKbps = routeChanged
      ? isTurn
        ? 1800
        : Math.min(ceilingKbps, Math.max(6000, requestedKbps))
      : this.qosBitrateKbps;
    let nextFps = routeChanged
      ? isTurn
        ? Math.min(30, requestedFps)
        : requestedFps
      : this.qosFps;
    let nextScale = routeChanged ? 1.0 : this.qosScaleDown;

    const baseline = this.qosBaselineRttMs ?? 40;
    const severeSpike =
      (rttMs !== null && (rttMs > baseline + 130 || rttMs > 260)) ||
      retxDelta > 40;
    const mildSpike =
      (rttMs !== null && (rttMs > baseline + 70 || rttMs > 160)) ||
      retxDelta > 15;

    if (severeSpike) {
      this.qosHealthyStreak = 0;
      nextKbps = Math.max(floorKbps, Math.round(nextKbps * 0.7));
      nextFps = Math.max(20, nextFps > 60 ? 60 : nextFps > 30 ? 30 : 20);
      nextScale = nextKbps <= 900 ? 1.5 : 1.25;
    } else if (mildSpike) {
      this.qosHealthyStreak = 0;
      nextKbps = Math.max(floorKbps, Math.round(nextKbps * 0.85));
      nextFps = Math.max(24, nextFps > 60 ? 60 : Math.min(nextFps, 30));
    } else {
      this.qosHealthyStreak += 1;
      if (this.qosHealthyStreak >= 3) {
        const stepUp = isTurn
          ? Math.round(nextKbps * 1.15) + 100
          : Math.round(nextKbps * 1.22) + 400;
        nextKbps = Math.min(ceilingKbps, stepUp);
        if (nextScale > 1.0 && nextKbps >= 1400) {
          nextScale = nextScale > 1.25 ? 1.25 : 1.0;
        }
        if (nextFps < maxFps && nextKbps >= (isTurn ? 1600 : 3500)) {
          nextFps = Math.min(maxFps, nextFps + (maxFps > 60 ? 30 : 15));
        }
        this.qosHealthyStreak = 0;
      }
    }

    const changed =
      routeChanged ||
      Math.abs(nextKbps - this.qosBitrateKbps) >= 120 ||
      nextFps !== this.qosFps ||
      nextScale !== this.qosScaleDown;

    if (changed) {
      this.qosBitrateKbps = nextKbps;
      this.qosFps = nextFps;
      this.qosScaleDown = nextScale;
      void this.applyVideoSenderParameters();
    }
  }

  private startWsJpegLoop(
    sid: string,
    gen: number,
    stream: MediaStream,
  ): void {
    this.stopWsJpegLoop();
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = stream;
    void video.play().catch(() => undefined);

    const canvas = document.createElement("canvas");
    this.jpegVideo = video;
    this.jpegCanvas = canvas;
    this.jpegEncoding = false;

    const fps = Math.max(5, Math.min(30, Math.round(this.activeQuality.fps || 20)));
    const intervalMs = Math.max(33, Math.round(1000 / fps));

    this.jpegTimer = setInterval(() => {
      if (this.sessionGeneration !== gen || this.sessionId !== sid) {
        this.stopWsJpegLoop();
        return;
      }
      this.captureAndSendJpegFrame(sid, gen);
    }, intervalMs);

    // Emit initial frame promptly once video metadata is ready
    video.onloadeddata = () => {
      if (this.sessionGeneration === gen && this.sessionId === sid) {
        this.captureAndSendJpegFrame(sid, gen);
      }
    };
  }

  private captureAndSendJpegFrame(sid: string, gen: number): void {
    if (this.jpegEncoding) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > WS_JPEG_MAX_BUFFERED_BYTES) return;
    const video = this.jpegVideo;
    const canvas = this.jpegCanvas;
    if (!video || !canvas || video.videoWidth <= 0 || video.videoHeight <= 0) {
      return;
    }

    const dims = computeWsJpegDimensions(
      video.videoWidth,
      video.videoHeight,
      this.activeQuality,
    );
    if (canvas.width !== dims.width || canvas.height !== dims.height) {
      canvas.width = dims.width;
      canvas.height = dims.height;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, dims.width, dims.height);
    this.jpegEncoding = true;
    const jpegQ = Math.max(
      0.25,
      Math.min(0.92, (this.activeQuality.jpegQuality || 55) / 100),
    );

    canvas.toBlob(
      (blob) => {
        if (!blob || this.sessionGeneration !== gen || this.sessionId !== sid) {
          this.jpegEncoding = false;
          return;
        }
        void blob
          .arrayBuffer()
          .then((buf) => {
            if (
              this.sessionGeneration !== gen ||
              this.sessionId !== sid ||
              !this.ws ||
              this.ws.readyState !== WebSocket.OPEN
            ) {
              return;
            }
            const frame = encodeJpegMediaFrame(
              sid,
              dims.width,
              dims.height,
              Date.now(),
              new Uint8Array(buf),
            );
            try {
              this.ws.send(frame);
            } catch {
              // Ignore socket close races
            }
          })
          .finally(() => {
            this.jpegEncoding = false;
          });
      },
      "image/jpeg",
      jpegQ,
    );
  }

  private stopWsJpegLoop(): void {
    if (this.jpegTimer !== null) {
      clearInterval(this.jpegTimer);
      this.jpegTimer = null;
    }
    this.jpegEncoding = false;
    if (this.jpegVideo) {
      this.jpegVideo.onloadeddata = null;
      this.jpegVideo.srcObject = null;
      this.jpegVideo = null;
    }
    this.jpegCanvas = null;
  }

  private async hotSwapDisplay(displayId: string): Promise<boolean> {
    if (!this.config || !this.sessionId) {
      return false;
    }
    const sid = this.sessionId;
    const gen = this.sessionGeneration;

    let captured: {
      stream: MediaStream;
      display: HostDisplayInfo;
      bounds: { width: number; height: number; fps: number };
    };
    try {
      captured = await this.acquireDesktopStream(displayId, this.activeQuality);
    } catch (err) {
      console.warn("[hostWorker] Display switch capture failed:", err);
      return false;
    }

    if (this.sessionGeneration !== gen || this.sessionId !== sid) {
      captured.stream.getTracks().forEach((t) => t.stop());
      return false;
    }

    const oldStream = this.mediaStream;
    const newVideoTrack = captured.stream.getVideoTracks()[0];
    if (!newVideoTrack) {
      captured.stream.getTracks().forEach((t) => t.stop());
      return false;
    }

    const newAudioTrack = captured.stream.getAudioTracks()[0] ?? null;

    if (this.activeTransport === "webrtc" && this.videoSender) {
      try {
        await this.videoSender.replaceTrack(newVideoTrack);
      } catch (err) {
        console.warn("[hostWorker] replaceTrack failed:", err);
        captured.stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      if (this.audioSender && newAudioTrack) {
        try {
          await this.audioSender.replaceTrack(newAudioTrack);
        } catch {
          // Keep video swap even if audio track swap fails
        }
      }
    } else if (this.activeTransport === "ws-jpeg" && this.jpegVideo) {
      this.jpegVideo.srcObject = captured.stream;
      void this.jpegVideo.play().catch(() => undefined);
    }

    this.mediaStream = captured.stream;
    this.activeDisplay = captured.display;
    this.activeCaptureBounds = captured.bounds;
    oldStream?.getTracks().forEach((t) => t.stop());

    this.report({ activeDisplayId: captured.display.id });
    this.sendTelemetry();
    return true;
  }

  private async applyLiveQualityChange(): Promise<void> {
    if (!this.sessionId) return;

    if (this.activeTransport === "webrtc") {
      if (this.pc && this.videoSender) {
        this.applyPreferredVideoCodec(
          this.pc,
          this.videoSender,
          this.activeQuality.codec ?? "auto",
        );
      }

      // Check if requested resolution or refresh rate exceeds current capture track bounds
      const disp = this.activeDisplay ?? this.getActiveDisplayFromConfig();
      const desired = computeDesktopCaptureBounds(disp, this.activeQuality);
      const prev = this.activeCaptureBounds;
      const needsCaptureUpgrade =
        !prev ||
        desired.width > prev.width ||
        desired.height > prev.height ||
        desired.fps > prev.fps;

      const videoTrack = this.mediaStream?.getVideoTracks()[0];
      if (needsCaptureUpgrade && videoTrack) {
        try {
          await videoTrack.applyConstraints({
            width: { max: desired.width },
            height: { max: desired.height },
            frameRate: { ideal: desired.fps, max: desired.fps },
          });
          videoTrack.contentHint = desired.fps >= 90 ? "motion" : "detail";
          this.activeCaptureBounds = desired;
        } catch {
          // Re-acquire desktop track cleanly if live applyConstraints isn't supported
          await this.hotSwapDisplay(disp.id);
        }
      }

      this.resetAdaptiveQosState();
      await this.applyVideoSenderParameters();
    } else if (this.activeTransport === "ws-jpeg" && this.mediaStream) {
      this.startWsJpegLoop(this.sessionId, this.sessionGeneration, this.mediaStream);
    }
  }

  private async handleControlCmd(
    msg: Record<string, unknown>,
    viaDataChannel: boolean,
  ): Promise<void> {
    const cmd =
      msg.command && typeof msg.command === "object"
        ? (msg.command as Record<string, unknown>)
        : null;
    if (!cmd) return;

    const action = typeof cmd.action === "string" ? cmd.action : "";
    const sid =
      typeof msg.sessionId === "string" ? msg.sessionId : this.sessionId ?? "";
    const seq = typeof msg.seq === "number" ? msg.seq : undefined;

    let ok = true;
    let detail: string | undefined;

    switch (action) {
      case "quality": {
        const q = cmd.quality as Partial<StreamQuality> | undefined;
        if (q && typeof q === "object") {
          this.activeQuality = {
            maxWidth:
              typeof q.maxWidth === "number" && q.maxWidth > 0
                ? Math.min(MAX_CAPTURE_WIDTH, q.maxWidth)
                : this.activeQuality.maxWidth,
            fps:
              typeof q.fps === "number" && q.fps > 0
                ? Math.min(MAX_CAPTURE_FPS, q.fps)
                : this.activeQuality.fps,
            bitrateKbps:
              typeof q.bitrateKbps === "number" && q.bitrateKbps > 0
                ? Math.min(MAX_LAN_BITRATE_KBPS, q.bitrateKbps)
                : this.activeQuality.bitrateKbps,
            jpegQuality:
              typeof q.jpegQuality === "number" && q.jpegQuality > 0
                ? q.jpegQuality
                : this.activeQuality.jpegQuality,
            auto: typeof q.auto === "boolean" ? q.auto : false,
            codec:
              q.codec !== undefined
                ? normalizeCodecPreference(q.codec)
                : this.activeQuality.codec,
            audioEnabled:
              typeof q.audioEnabled === "boolean"
                ? q.audioEnabled
                : this.activeQuality.audioEnabled,
          };
          if (typeof q.audioEnabled === "boolean") {
            this.audioEnabled = Boolean(
              this.config?.audioCaptureEnabled && q.audioEnabled,
            );
            this.syncAudioTrackMuteState();
          }
          await this.applyLiveQualityChange();
        }
        break;
      }

      case "request_keyframe": {
        if (this.activeTransport === "webrtc") {
          const currentKbps = this.qosBitrateKbps;
          await this.applyVideoSenderParameters(Math.max(400, currentKbps - 50));
          await this.applyVideoSenderParameters(currentKbps);
        } else if (this.activeTransport === "ws-jpeg" && this.sessionId) {
          this.captureAndSendJpegFrame(this.sessionId, this.sessionGeneration);
        }
        break;
      }

      case "select_display": {
        const displayId = typeof cmd.displayId === "string" ? cmd.displayId : "";
        if (!displayId) {
          ok = false;
          detail = "无效的显示器 ID";
        } else {
          ok = await this.hotSwapDisplay(displayId);
          if (!ok) detail = "切换显示器失败";
        }
        break;
      }

      case "clipboard_set": {
        const text = typeof cmd.text === "string" ? cmd.text : "";
        ok = (await getBridge()?.setClipboard(text)) ?? false;
        break;
      }

      case "audio_toggle": {
        const enabled = Boolean(cmd.enabled);
        if (enabled && !this.config?.audioCaptureEnabled) {
          ok = false;
          detail = "被控电脑已关闭系统音频采集";
        } else {
          this.audioEnabled = enabled;
          this.syncAudioTrackMuteState();
          const hasTrack = (this.mediaStream?.getAudioTracks().length ?? 0) > 0;
          if (enabled && !hasTrack) {
            ok = false;
            detail = "当前系统未能采集到桌面音频轨道";
          } else {
            this.report({ audioEnabled: this.isAudioEffectivelyEnabled() });
            this.sendTelemetry();
          }
        }
        break;
      }

      case "privacy_screen": {
        const enabled = Boolean(cmd.enabled);
        const res = await getBridge()?.setPrivacyScreen(enabled);
        ok = res?.ok ?? false;
        detail = res?.message;
        this.privacyScreenActive = res?.active ?? false;
        this.sendTelemetry();
        break;
      }

      case "power": {
        const operation =
          typeof cmd.operation === "string"
            ? cmd.operation
            : typeof cmd.op === "string"
              ? cmd.op
              : "";
        const res = await getBridge()?.executePower(operation);
        ok = res?.ok ?? false;
        detail = res?.message;
        break;
      }

      default: {
        const res = await getBridge()?.dispatchControl(
          cmd,
          this.activeDisplay?.id ?? this.config?.activeDisplayId,
        );
        ok = res?.ok ?? false;
        detail = res?.message;
        break;
      }
    }

    // Avoid flooding ACKs for high-frequency pointer moves when ok
    const isHighFreq =
      action === "mouse_move" || action === "touch_move" || action === "mouse_wheel";
    if (ok && isHighFreq) {
      return;
    }

    if (this.config) {
      const ackPayload: Record<string, unknown> = {
        type: "control.ack",
        sessionId: sid,
        deviceId: this.config.deviceId,
        ok,
      };
      if (seq !== undefined) ackPayload.seq = seq;
      if (detail) ackPayload.message = detail;

      const serialized = JSON.stringify(ackPayload);
      if (
        viaDataChannel &&
        this.controlDc &&
        this.controlDc.readyState === "open"
      ) {
        try {
          this.controlDc.send(serialized);
          return;
        } catch {
          // Fall back to WS
        }
      }
      this.sendJson(ackPayload);
    }
  }

  private closePeerConnection(): void {
    this.stopAdaptiveQosLoop();
    this.remoteDescriptionReady = false;
    this.pendingRemoteIce = [];
    this.videoSender = null;
    this.audioSender = null;
    this.cancelledDownloads.clear();

    for (const dc of [this.controlDc, this.pointerDc, this.fileDc]) {
      if (dc) {
        dc.onopen = null;
        dc.onmessage = null;
        dc.onclose = null;
        try {
          dc.close();
        } catch {
          // Ignore
        }
      }
    }
    this.controlDc = null;
    this.pointerDc = null;
    this.fileDc = null;

    const pc = this.pc;
    this.pc = null;
    if (pc) {
      pc.onicecandidate = null;
      pc.ondatachannel = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        // Ignore
      }
    }
  }

  private teardownSession(notifyPeer: boolean, reason?: string): void {
    const prevSid = this.sessionId;
    this.sessionGeneration += 1;
    this.sessionId = null;
    this.activeTransport = null;
    this.activeCaptureBounds = null;
    this.stopWsJpegLoop();
    this.closePeerConnection();

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // Ignore
        }
      });
      this.mediaStream = null;
    }

    if (prevSid) {
      getBridge()?.fileTransferAbort(prevSid);
      if (notifyPeer && this.config && this.ws?.readyState === WebSocket.OPEN) {
        this.sendJson({
          type: "session.end",
          sessionId: prevSid,
          deviceId: this.config.deviceId,
          ...(reason ? { reason } : {}),
        });
      }
    }
  }
}

const engine = new DesktopHostWorkerEngine();
const bridge = getBridge();

if (bridge) {
  bridge.onCommand((command) => {
    switch (command.type) {
      case "start":
        engine.start(command.config);
        break;
      case "update-config":
        engine.updateConfig(
          command.config,
          command.reconnect,
          command.switchDisplayId,
        );
        break;
      case "clipboard-push":
        engine.pushLocalClipboard(command.text);
        break;
      case "privacy-state-changed":
        engine.onPrivacyStateChanged(command.active);
        break;
      case "disconnect-session":
        engine.disconnectSession(command.reason);
        break;
      case "stop":
        engine.stop();
        break;
    }
  });
  bridge.ready();
}

export {};
