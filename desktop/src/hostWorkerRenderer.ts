/**
 * VeloDeck Desktop Host Hidden Worker (runs inside sandboxed BrowserWindow at app://velodeck-host/hostWorker.html).
 * Handles:
 * - Relay WebSocket connection, agent.register, heartbeat & exponential reconnect
 * - Desktop screen capture via Electron getUserMedia (chromeMediaSource: "desktop")
 * - WebRTC low-latency streaming (H.264 preferred, 1s Adaptive QoS for TURN/P2P, hot display track swap)
 * - WebRTC DataChannels ("control", "pointer", "file") + WS-JPEG 20-byte VeloDeck binary frame fallback
 */

type HostPlatform = "darwin" | "win32" | "linux";
type TransportMode = "webrtc" | "ws-jpeg";

interface HostDisplayInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  primary: boolean;
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
}

type HostWorkerCommand =
  | { type: "start"; config: HostWorkerConfig }
  | {
      type: "update-config";
      config: HostWorkerConfig;
      reconnect: boolean;
      switchDisplayId?: string;
    }
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
}

interface HostCaptureSourceResult {
  ok: boolean;
  sourceId?: string;
  display?: HostDisplayInfo;
  displays?: HostDisplayInfo[];
  error?: string;
}

interface StreamQuality {
  maxWidth: number;
  fps: number;
  bitrateKbps: number;
  jpegQuality: number;
  auto?: boolean;
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
  requestCaptureSource(displayId?: string): Promise<HostCaptureSourceResult>;
  dispatchControl(
    cmd: Record<string, unknown>,
    displayId?: string,
  ): Promise<{ ok: boolean; message?: string }>;
  setClipboard(text: string): Promise<boolean>;
  fileTransferText(sessionId: string, text: string): Promise<string | null>;
  fileTransferBinary(sessionId: string, chunk: Uint8Array): Promise<string | null>;
  fileTransferAbort(sessionId: string): void;
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
const DEFAULT_QUALITY: StreamQuality = {
  maxWidth: 900,
  fps: 60,
  bitrateKbps: 4500,
  jpegQuality: 54,
  auto: true,
};

const textEncoder = new TextEncoder();

function getBridge(): HostWorkerBridge | null {
  return window.velodeckHostWorker ?? null;
}

function encodeJpegMediaFrame(
  sessionId: string,
  width: number,
  height: number,
  timestampMs: number,
  payload: Uint8Array,
): Uint8Array {
  const sessionBytes = sessionId ? textEncoder.encode(sessionId) : new Uint8Array(0);
  const totalLen = FRAME_HEADER_FIXED_SIZE + sessionBytes.byteLength + payload.byteLength;
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

function sortPreferredVideoCodecs(
  codecs: readonly RTCRtpCodec[],
): RTCRtpCodec[] {
  const h264HighPm1: RTCRtpCodec[] = [];
  const h264HighOther: RTCRtpCodec[] = [];
  const h264BasePm1: RTCRtpCodec[] = [];
  const h264BaseOther: RTCRtpCodec[] = [];
  const h264Other: RTCRtpCodec[] = [];
  const vp8: RTCRtpCodec[] = [];
  const rest: RTCRtpCodec[] = [];

  for (const codec of codecs) {
    const mime = codec.mimeType.toLowerCase();
    if (mime === "video/h264") {
      const fmtp = (codec.sdpFmtpLine ?? "").toLowerCase();
      if (fmtp.includes("profile-level-id=640c")) {
        if (fmtp.includes("packetization-mode=1")) h264HighPm1.push(codec);
        else h264HighOther.push(codec);
      } else if (fmtp.includes("profile-level-id=42e0")) {
        if (fmtp.includes("packetization-mode=1")) h264BasePm1.push(codec);
        else h264BaseOther.push(codec);
      } else {
        h264Other.push(codec);
      }
    } else if (mime === "video/vp8") {
      vp8.push(codec);
    } else {
      rest.push(codec);
    }
  }

  return [
    ...h264HighPm1,
    ...h264HighOther,
    ...h264BasePm1,
    ...h264BaseOther,
    ...h264Other,
    ...vp8,
    ...rest,
  ];
}

function computeDesktopCaptureBounds(
  display: HostDisplayInfo,
  quality: StreamQuality,
): { width: number; height: number; fps: number } {
  const srcW = Math.max(320, Math.round(display.width || 1920));
  const srcH = Math.max(240, Math.round(display.height || 1080));
  const targetFps = Math.max(10, Math.min(60, Math.round(quality.fps || 60)));

  // Desktop screens are typically wide (16:9 / 16:10); scale preset long edge cleanly for crisp text
  const maxLongEdge =
    quality.maxWidth >= 1080 ? 1920 : quality.maxWidth >= 800 ? 1600 : 1280;
  const longEdge = Math.max(srcW, srcH);
  const scale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;

  const w = Math.max(320, Math.round((srcW * scale) / 2) * 2);
  const h = Math.max(240, Math.round((srcH * scale) / 2) * 2);
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
    quality.maxWidth >= 1080 ? 1440 : quality.maxWidth >= 800 ? 1200 : 960;
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
  private activeDisplay: HostDisplayInfo | null = null;
  private mediaStream: MediaStream | null = null;
  private pc: RTCPeerConnection | null = null;
  private videoSender: RTCRtpSender | null = null;
  private controlDc: RTCDataChannel | null = null;
  private pointerDc: RTCDataChannel | null = null;
  private fileDc: RTCDataChannel | null = null;
  private remoteDescriptionReady = false;
  private pendingRemoteIce: RTCIceCandidateInit[] = [];
  private fileMsgChain: Promise<void> = Promise.resolve();

  // Adaptive QoS state
  private qosTimer: ReturnType<typeof setInterval> | null = null;
  private qosRouteTurn = false;
  private qosBaselineRttMs: number | null = null;
  private qosBitrateKbps = 4500;
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
    this.report({
      status: "stopped",
      activeSessionId: null,
      activeTransport: null,
      lastError: null,
    });
  }

  public updateConfig(
    config: HostWorkerConfig,
    reconnect: boolean,
    switchDisplayId?: string,
  ): void {
    this.config = config;
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

    if (switchDisplayId && this.sessionId) {
      void this.hotSwapDisplay(switchDisplayId);
    } else {
      this.sendTelemetry();
    }
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
        displays: this.config.displays,
        activeDisplayId: activeDisp.id,
        capabilities: {
          webrtc: typeof RTCPeerConnection !== "undefined",
          wsJpeg: true,
          wsH264: false,
          wake: true,
          unlock: false,
          accessibility: this.config.permissions.accessibility,
          mediaProjection: this.config.permissions.screenCapture,
          p2pFileTransfer: true,
        },
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
      displays: this.config.displays,
      activeDisplayId: disp.id,
      capabilities: {
        webrtc: typeof RTCPeerConnection !== "undefined",
        wsJpeg: true,
        wsH264: false,
        wake: true,
        unlock: false,
        accessibility: this.config.permissions.accessibility,
        mediaProjection: this.config.permissions.screenCapture,
        p2pFileTransfer: true,
      },
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
  ): Promise<{ stream: MediaStream; display: HostDisplayInfo }> {
    const bridge = getBridge();
    if (!bridge) {
      throw new Error("Host worker bridge unavailable");
    }
    const sourceRes = await bridge.requestCaptureSource(displayId);
    if (!sourceRes.ok || !sourceRes.sourceId || !sourceRes.display) {
      throw new Error(
        sourceRes.error ||
          "无法获取屏幕采集源，请检查系统屏幕录制权限设置",
      );
    }

    if (this.config && Array.isArray(sourceRes.displays) && sourceRes.displays.length > 0) {
      this.config = {
        ...this.config,
        displays: sourceRes.displays,
        activeDisplayId: sourceRes.display.id,
      };
    }

    const bounds = computeDesktopCaptureBounds(sourceRes.display, quality);
    const constraints = {
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

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("未获取到桌面视频轨道");
    }
    try {
      track.contentHint = "detail";
    } catch {
      // Optional browser hint
    }
    return { stream, display: sourceRes.display };
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
          ? rawQuality.maxWidth
          : DEFAULT_QUALITY.maxWidth,
      fps:
        typeof rawQuality.fps === "number" && rawQuality.fps > 0
          ? rawQuality.fps
          : DEFAULT_QUALITY.fps,
      bitrateKbps:
        typeof rawQuality.bitrateKbps === "number" && rawQuality.bitrateKbps > 0
          ? rawQuality.bitrateKbps
          : DEFAULT_QUALITY.bitrateKbps,
      jpegQuality:
        typeof rawQuality.jpegQuality === "number" && rawQuality.jpegQuality > 0
          ? rawQuality.jpegQuality
          : DEFAULT_QUALITY.jpegQuality,
      auto: typeof rawQuality.auto === "boolean" ? rawQuality.auto : true,
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

    let captured: { stream: MediaStream; display: HostDisplayInfo };
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

    if (this.sessionGeneration !== gen || !this.running || this.ws?.readyState !== WebSocket.OPEN) {
      captured.stream.getTracks().forEach((t) => t.stop());
      return;
    }

    this.mediaStream = captured.stream;
    this.activeDisplay = captured.display;

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
      lastError: null,
    });

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
    this.preferH264Codec(pc, sender);

    pc.onicecandidate = (event) => {
      if (this.sessionGeneration !== gen || this.pc !== pc || !event.candidate || !this.config) {
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

  private preferH264Codec(pc: RTCPeerConnection, sender: RTCRtpSender): void {
    try {
      const capabilities =
        typeof RTCRtpSender !== "undefined" &&
        typeof RTCRtpSender.getCapabilities === "function"
          ? RTCRtpSender.getCapabilities("video")
          : null;
      if (!capabilities || capabilities.codecs.length === 0) {
        return;
      }
      const ordered = sortPreferredVideoCodecs(capabilities.codecs);
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
      this.fileDc = dc;
      dc.onmessage = (event) => {
        if (this.sessionGeneration !== gen) return;
        const payload = event.data;
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
          getBridge()?.fileTransferAbort(sid);
        }
      };
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
        this.preferH264Codec(pc, this.videoSender);
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
    if (this.activeQuality.auto) {
      this.qosBitrateKbps = this.qosRouteTurn ? 1800 : 4500;
      this.qosFps = this.qosRouteTurn ? 30 : 60;
    } else {
      this.qosBitrateKbps = Math.max(400, this.activeQuality.bitrateKbps || 4500);
      this.qosFps = Math.max(15, Math.min(60, this.activeQuality.fps || 60));
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
        Math.round(bitrateKbpsOverride ?? this.qosBitrateKbps),
      );
      const targetFps = Math.max(
        15,
        Math.min(60, Math.round(fpsOverride ?? this.qosFps)),
      );
      const targetScale = Math.max(1.0, Math.min(2.0, scaleDownOverride ?? this.qosScaleDown));
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
        if ((pair.nominated === true || pair.selected === true) && pair.state === "succeeded") {
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

    if (!this.activeQuality.auto) {
      if (routeChanged) {
        const manualKbps = isTurn
          ? Math.min(this.activeQuality.bitrateKbps, 2600)
          : this.activeQuality.bitrateKbps;
        this.qosBitrateKbps = Math.max(500, manualKbps);
        this.qosFps = Math.max(15, Math.min(60, this.activeQuality.fps));
        this.qosScaleDown = 1.0;
        void this.applyVideoSenderParameters();
      }
      return;
    }

    const ceilingKbps = isTurn ? 2400 : 6000;
    const floorKbps = 500;
    const maxFps = isTurn ? 45 : 60;

    let nextKbps = routeChanged ? (isTurn ? 1800 : 4500) : this.qosBitrateKbps;
    let nextFps = routeChanged ? (isTurn ? 30 : 60) : this.qosFps;
    let nextScale = routeChanged ? 1.0 : this.qosScaleDown;

    const baseline = this.qosBaselineRttMs ?? 40;
    const severeSpike =
      (rttMs !== null && (rttMs > baseline + 130 || rttMs > 260)) || retxDelta > 40;
    const mildSpike =
      (rttMs !== null && (rttMs > baseline + 70 || rttMs > 160)) || retxDelta > 15;

    if (severeSpike) {
      this.qosHealthyStreak = 0;
      nextKbps = Math.max(floorKbps, Math.round(nextKbps * 0.72));
      nextFps = Math.max(20, nextFps > 30 ? 30 : 20);
      nextScale = nextKbps <= 900 ? 1.5 : 1.25;
    } else if (mildSpike) {
      this.qosHealthyStreak = 0;
      nextKbps = Math.max(floorKbps, Math.round(nextKbps * 0.85));
      nextFps = Math.max(24, Math.min(nextFps, 30));
    } else {
      this.qosHealthyStreak += 1;
      if (this.qosHealthyStreak >= 3) {
        nextKbps = Math.min(ceilingKbps, Math.round(nextKbps * 1.15) + 100);
        if (nextScale > 1.0 && nextKbps >= 1400) {
          nextScale = nextScale > 1.25 ? 1.25 : 1.0;
        }
        if (nextFps < maxFps && nextKbps >= (isTurn ? 1600 : 2800)) {
          nextFps = Math.min(maxFps, nextFps + 15);
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
    const jpegQ = Math.max(0.25, Math.min(0.92, (this.activeQuality.jpegQuality || 55) / 100));

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

    let captured: { stream: MediaStream; display: HostDisplayInfo };
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
    const newTrack = captured.stream.getVideoTracks()[0];
    if (!newTrack) {
      captured.stream.getTracks().forEach((t) => t.stop());
      return false;
    }

    if (this.activeTransport === "webrtc" && this.videoSender) {
      try {
        await this.videoSender.replaceTrack(newTrack);
      } catch (err) {
        console.warn("[hostWorker] replaceTrack failed:", err);
        captured.stream.getTracks().forEach((t) => t.stop());
        return false;
      }
    } else if (this.activeTransport === "ws-jpeg" && this.jpegVideo) {
      this.jpegVideo.srcObject = captured.stream;
      void this.jpegVideo.play().catch(() => undefined);
    }

    this.mediaStream = captured.stream;
    this.activeDisplay = captured.display;
    oldStream?.getTracks().forEach((t) => t.stop());

    this.report({ activeDisplayId: captured.display.id });
    this.sendTelemetry();
    return true;
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
    const sid = typeof msg.sessionId === "string" ? msg.sessionId : this.sessionId ?? "";
    const seq = typeof msg.seq === "number" ? msg.seq : undefined;

    let ok = true;
    let detail: string | undefined;

    switch (action) {
      case "quality": {
        const q = cmd.quality as Partial<StreamQuality> | undefined;
        if (q && typeof q === "object") {
          this.activeQuality = {
            maxWidth: typeof q.maxWidth === "number" && q.maxWidth > 0 ? q.maxWidth : this.activeQuality.maxWidth,
            fps: typeof q.fps === "number" && q.fps > 0 ? q.fps : this.activeQuality.fps,
            bitrateKbps:
              typeof q.bitrateKbps === "number" && q.bitrateKbps > 0
                ? q.bitrateKbps
                : this.activeQuality.bitrateKbps,
            jpegQuality:
              typeof q.jpegQuality === "number" && q.jpegQuality > 0
                ? q.jpegQuality
                : this.activeQuality.jpegQuality,
            auto: typeof q.auto === "boolean" ? q.auto : false,
          };
          if (this.activeTransport === "webrtc") {
            this.resetAdaptiveQosState();
            await this.applyVideoSenderParameters();
          } else if (this.activeTransport === "ws-jpeg" && this.mediaStream && this.sessionId) {
            this.startWsJpegLoop(this.sessionId, this.sessionGeneration, this.mediaStream);
          }
        }
        break;
      }

      case "request_keyframe": {
        if (this.activeTransport === "webrtc") {
          // Nudge sender bitrate slightly to encourage an immediate IDR keyframe refresh
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
