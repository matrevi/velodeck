import {
  QUALITY_PRESETS,
  decodeMediaFrame,
  isWireMessage,
  normalizeControlCode,
  type ClipboardSyncMessage,
  type ControlAckMessage,
  type ControlCommand,
  type DeviceSummary,
  type ErrorMessage,
  type IceServerConfig,
  type MediaFrame,
  type SessionReadyMessage,
  type StreamQuality,
  type TransportMode,
  type UserProfile,
  type WireMessage,
} from "@velodeck/protocol";
import {
  detectDefaultTransport,
  getOrCreateClientId,
  type ConnectionMode,
  type ConnectionProfile,
  type QualityPreset,
} from "../state/profiles";
import { computeSha256Hex } from "../utils/sha256";

export type AuthType = "account" | "code" | "token";

export interface AccountConnectRequest {
  kind: "account";
  wsUrl: string;
  authToken: string;
  user?: UserProfile;
  preferredTransport?: TransportMode;
  qualityPreset?: QualityPreset;
}

export interface ControlCodeConnectRequest {
  kind: "code";
  wsUrl: string;
  controlCode: string;
  controlPassword: string;
  preferredTransport?: TransportMode;
  qualityPreset?: QualityPreset;
}

export interface ProfileConnectRequest {
  kind: "token";
  profile: ConnectionProfile;
}

export type ConnectRequest =
  | AccountConnectRequest
  | ControlCodeConnectRequest
  | ProfileConnectRequest;

export type ConnectWithAccountOptions = Omit<AccountConnectRequest, "kind">;
export type ConnectWithControlCodeOptions = Omit<ControlCodeConnectRequest, "kind">;

export type SocketStatus =
  | "idle"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "error";

export type SessionStatus =
  | "idle"
  | "requesting"
  | "negotiating"
  | "streaming"
  | "fallback"
  | "ended"
  | "error";

export interface RemoteClientNotice {
  id: number;
  level: "info" | "warn" | "error";
  text: string;
}

export interface WebRtcTelemetry {
  codec: string | null;
  width: number;
  height: number;
  bitrateKbps: number;
  jitterMs: number | null;
  jitterBufferMs: number | null;
  decodeMs: number | null;
  packetsLost: number;
  framesDropped: number;
  freezeCount: number;
  icePair: string | null; // e.g. "P2P直连 (IPv4)", "P2P直连 (IPv6)", "P2P穿透 (NAT)", "TURN Relay"
}

export type FileTransferPurpose = "file" | "apk_install";

export type FileTransferStatus =
  | "idle"
  | "preparing"
  | "sending"
  | "verifying"
  | "done"
  | "error"
  | "cancelled";

export interface FileTransferState {
  transferId: string | null;
  fileName: string;
  purpose: FileTransferPurpose;
  status: FileTransferStatus;
  sentBytes: number;
  confirmedBytes: number;
  totalBytes: number;
  speedBytesPerSec: number;
  message: string | null;
  savedPath: string | null;
  installLaunched: boolean;
  needsInstallPermission: boolean;
}

export interface SendFileOptions {
  fileName: string;
  mimeType?: string;
  purpose?: FileTransferPurpose;
  expectedSha256?: string;
}

export interface RemoteClientState {
  profile: ConnectionProfile | null;
  authType: AuthType | null;
  user: UserProfile | null;
  wsUrl: string | null;
  activeControlCode: string | null;
  socketStatus: SocketStatus;
  serverMode: ConnectionMode | null;
  errorCode: ErrorMessage["code"] | null;
  errorMessage: string | null;
  reconnectAttempt: number;
  nextReconnectAt: number | null;
  rttMs: number | null;
  fps: number;
  devices: DeviceSummary[];
  activeDeviceId: string | null;
  sessionId: string | null;
  sessionStatus: SessionStatus;
  activeTransport: TransportMode | null;
  desiredTransport: TransportMode;
  webrtcRoute: "p2p" | "turn" | null;
  webrtcTelemetry: WebRtcTelemetry | null;
  qualityPreset: QualityPreset;
  dataChannelOpen: boolean;
  fileChannelOpen: boolean;
  fileTransfer: FileTransferState | null;
  mediaStream: MediaStream | null;
  screenWidth: number;
  screenHeight: number;
  rotation: 0 | 1 | 2 | 3;
  remoteClipboard: string;
  lastNotice: RemoteClientNotice | null;
}

export interface RemoteTelemetrySnapshot {
  rttMs: number | null;
  fps: number;
  webrtcRoute: "p2p" | "turn" | null;
  webrtcTelemetry: WebRtcTelemetry | null;
}

export interface CommandDispatchResult {
  sent: boolean;
  seq: number;
  channel: "datachannel" | "websocket" | "none";
}

type StateListener = (state: RemoteClientState) => void;
type TelemetryListener = (telemetry: RemoteTelemetrySnapshot) => void;
type FrameListener = (frame: MediaFrame) => void;
type AckListener = (ack: ControlAckMessage) => void;
type ClipboardListener = (msg: ClipboardSyncMessage) => void;

const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_WATCHDOG_CHECK_MS = 5_000;
const DEAD_CONNECTION_TIMEOUT_MS = 35_000;
const VISIBILITY_WATCHDOG_GRACE_MS = 6_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 15_000;
const WEBRTC_CONNECT_TIMEOUT_MS = 7_500;
const WEBRTC_DISCONNECT_WATCHDOG_MS = 4_000;
const WEBRTC_ICE_RESTART_TIMEOUT_MS = 5_000;
const WEBRTC_STATS_INTERVAL_MS = 1_000;
const WS_JPEG_FPS_DECAY_INTERVAL_MS = 500;
const POINTER_KEEPALIVE_INTERVAL_MS = 180;
const POINTER_KEEPALIVE_PAYLOAD = '{"type":"dc.ping"}';
const POINTER_DC_MAX_BUFFERED_BYTES = 4_096;
const CONTROL_DC_MAX_BUFFERED_BYTES = 65_536;
const AGENT_RECONNECT_RESUME_DELAY_MS = 250;
const FILE_CHUNK_SIZE = 16_384;
const FILE_DC_LOW_THRESHOLD = 65_536;
const FILE_DC_HIGH_WATERMARK = 262_144;
const FILE_DC_BACKPRESSURE_POLL_MS = 40;
const FILE_ACCEPT_TIMEOUT_MS = 10_000;
const FILE_DONE_TIMEOUT_MS = 30_000;
const FILE_MAX_BYTES = 256 * 1024 * 1024;
const APK_MAX_BYTES = 128 * 1024 * 1024;
const FILE_PROGRESS_THROTTLE_MS = 120;

interface FileDonePayload {
  savedPath?: string;
  sha256?: string;
  installLaunched?: boolean;
  needsInstallPermission?: boolean;
  message?: string;
}

interface ActiveFileTransfer {
  transferId: string;
  generation: number;
  fileName: string;
  purpose: FileTransferPurpose;
  totalBytes: number;
  sentBytes: number;
  confirmedBytes: number;
  speedBytesPerSec: number;
  offerSent: boolean;
  accepted: boolean;
  donePayload: FileDonePayload | null;
  errorMessage: string | null;
  errorEmitted: boolean;
  cancelled: boolean;
  wakeups: Set<() => void>;
  lastProgressEmitAt: number;
}

function createSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createTransferId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `ft-${crypto.randomUUID()}`;
  }
  return `ft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function toUint8Array(
  data: Blob | Uint8Array | ArrayBuffer,
): Promise<Uint8Array> {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    const buf = await data.arrayBuffer();
    return new Uint8Array(buf);
  }
  if (
    typeof data === "object" &&
    data !== null &&
    "arrayBuffer" in data &&
    typeof (data as Blob).arrayBuffer === "function"
  ) {
    const buf = await (data as Blob).arrayBuffer();
    return new Uint8Array(buf);
  }
  throw new Error("不支持的文件数据格式");
}

function getClientDisplayName(): string {
  if (typeof navigator === "undefined") return "VeloDeck Web";
  const ua = navigator.userAgent || "";
  if (/iPhone/i.test(ua)) return "iPhone Controller";
  if (/iPad/i.test(ua)) return "iPad Controller";
  if (/Android/i.test(ua)) return "Android Controller";
  if (/Macintosh/i.test(ua)) return "Mac Controller";
  return "VeloDeck Controller";
}

function mapServerErrorMessage(
  code: string,
  fallback: string,
  authType: AuthType | null,
): string {
  switch (code) {
    case "UNAUTHORIZED": {
      if (authType === "code") {
        const lower = fallback.toLowerCase();
        if (lower.includes("password")) {
          return "无人值守控制密码不正确，请核对被控手机上的控制密码";
        }
        if (lower.includes("not found") || lower.includes("unknown") || lower.includes("code")) {
          return "未找到该 9 位控制码对应的设备，请确认控制码无误且手机已上线";
        }
        return "控制码或无人值守密码验证失败，请核对后重试";
      }
      if (authType === "account") {
        return "账号登录状态已失效，请重新登录";
      }
      return "访问密钥验证失败，请检查 Token 是否正确";
    }
    case "DEVICE_OFFLINE":
      return "目标设备当前不在线";
    case "SESSION_NOT_FOUND":
      return "控制会话已失效，正在等待重新建立";
    case "RATE_LIMITED":
      return "尝试过于频繁，请稍后再试";
    default:
      return fallback || "连接发生未知错误";
  }
}

function getRequestWsUrl(req: ConnectRequest): string {
  return req.kind === "token" ? req.profile.wsUrl : req.wsUrl;
}

/**
 * Strict DataChannel message allowlist guard (P1-10):
 * Only `control.ack` and `clipboard.sync` matching the active sessionId are allowed
 * from the WebRTC peer DataChannel. All signaling/auth/status messages are rejected.
 */
export function isAllowedDataChannelMessage(
  value: unknown,
  expectedSessionId: string | null,
): value is ControlAckMessage | ClipboardSyncMessage {
  if (!expectedSessionId || !isWireMessage(value)) {
    return false;
  }
  if (value.type === "control.ack") {
    const candidate = value as Partial<ControlAckMessage>;
    return (
      typeof candidate.sessionId === "string" &&
      candidate.sessionId === expectedSessionId &&
      typeof candidate.deviceId === "string" &&
      typeof candidate.ok === "boolean"
    );
  }
  if (value.type === "clipboard.sync") {
    const candidate = value as Partial<ClipboardSyncMessage>;
    return (
      typeof candidate.sessionId === "string" &&
      candidate.sessionId === expectedSessionId &&
      typeof candidate.deviceId === "string" &&
      typeof candidate.text === "string"
    );
  }
  return false;
}

export interface VideoCodecPreferenceLike {
  mimeType: string;
  sdpFmtpLine?: string;
}

/**
 * Order preferred video codecs for sharp, ultra-low-latency hardware encoding/decoding:
 * 1. H.264 Constrained High (profile-level-id=640c*, CABAC + 8x8 DCT + zero B-frames; pm=1 first)
 * 2. H.264 Constrained Baseline (profile-level-id=42e0*, zero B-frames; pm=1 first)
 * 3. Remaining H.264 profiles
 * 4. VP8
 * 5. Remaining codecs
 */
export function sortPreferredVideoCodecs<T extends VideoCodecPreferenceLike>(
  codecs: readonly T[],
): T[] {
  const h264ConstrainedHighPm1: T[] = [];
  const h264ConstrainedHighOther: T[] = [];
  const h264ConstrainedBaselinePm1: T[] = [];
  const h264ConstrainedBaselineOther: T[] = [];
  const h264Other: T[] = [];
  const vp8: T[] = [];
  const rest: T[] = [];

  for (const codec of codecs) {
    const mime = codec.mimeType.toLowerCase();
    if (mime === "video/h264") {
      const fmtp = (codec.sdpFmtpLine ?? "").toLowerCase();
      if (fmtp.includes("profile-level-id=640c")) {
        if (fmtp.includes("packetization-mode=1")) {
          h264ConstrainedHighPm1.push(codec);
        } else {
          h264ConstrainedHighOther.push(codec);
        }
      } else if (fmtp.includes("profile-level-id=42e0")) {
        if (fmtp.includes("packetization-mode=1")) {
          h264ConstrainedBaselinePm1.push(codec);
        } else {
          h264ConstrainedBaselineOther.push(codec);
        }
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
    ...h264ConstrainedHighPm1,
    ...h264ConstrainedHighOther,
    ...h264ConstrainedBaselinePm1,
    ...h264ConstrainedBaselineOther,
    ...h264Other,
    ...vp8,
    ...rest,
  ];
}

export type PlayoutDelayBucketMs = 0;

/**
 * Interactive remote control uses a 0ms minimum jitter-buffer floor on both P2P and TURN,
 * letting the browser's built-in VCMJitterEstimator adapt organically without imposing
 * an artificial minimum playout delay or mid-burst stalls on RTT jumps.
 */
export function selectAdaptivePlayoutDelayMs(
  _route: "p2p" | "turn" | null,
  _rttMs: number | null,
  _fallbackMs: PlayoutDelayBucketMs = 0,
): PlayoutDelayBucketMs {
  return 0;
}

export function isWebRtcStaticIdle(
  activeTransport: TransportMode | null,
  sessionStatus: SessionStatus,
  fps: number,
  bitrateKbps: number | null,
): boolean {
  if (activeTransport !== "webrtc" || sessionStatus !== "streaming") {
    return false;
  }
  return (
    fps === 0 ||
    (fps <= 2 && bitrateKbps !== null && bitrateKbps <= 120)
  );
}

type AdaptiveRtpReceiver = Omit<
  RTCRtpReceiver,
  "jitterBufferTarget" | "playoutDelayHint"
> & {
  playoutDelayHint?: number;
  jitterBufferTarget?: number | null;
};

export class RemoteClient {
  private readonly clientId: string;
  private readonly stateListeners = new Set<StateListener>();
  private readonly telemetryListeners = new Set<TelemetryListener>();
  private readonly frameListeners = new Set<FrameListener>();
  private readonly ackListeners = new Set<AckListener>();
  private readonly clipboardListeners = new Set<ClipboardListener>();

  private activeRequest: ConnectRequest | null = null;
  private ws: WebSocket | null = null;
  private connectionGeneration = 0;
  private intentionalDisconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private autoReRequestTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private wsJpegFpsTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt = 0;
  private watchdogGraceUntil = 0;
  private browserListenersAttached = false;

  private iceServers: IceServerConfig[] = [];
  private pc: RTCPeerConnection | null = null;
  private activeVideoReceiver: AdaptiveRtpReceiver | null = null;
  private lastAppliedPlayoutDelayMs: PlayoutDelayBucketMs | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private pointerDataChannel: RTCDataChannel | null = null;
  private fileDataChannel: RTCDataChannel | null = null;
  private activeTouchViaWs = false;
  private activeTouchFirstMovePending = false;
  private activeFileTransfer: ActiveFileTransfer | null = null;
  private fileTransferGeneration = 0;
  private pointerKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastCommandSentAt = 0;
  private pendingRemoteIce: RTCIceCandidateInit[] = [];
  private remoteDescriptionReady = false;
  private webrtcFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private webrtcDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private webrtcIceRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private webrtcIceRestartAttempted = false;
  private webrtcIceRestartInFlight = false;
  private webrtcStatsTimer: ReturnType<typeof setInterval> | null = null;
  private webrtcFallbackInFlight = false;
  private webrtcDowngradedByAgent = false;
  private webrtcDowngradedClientSide = false;

  private prevBytesReceived: number | null = null;
  private prevStatsTsMs: number | null = null;
  private prevJitterBufferDelay: number | null = null;
  private prevJitterBufferEmitted: number | null = null;
  private prevTotalDecodeTime: number | null = null;
  private prevDecodeFrames: number | null = null;
  private prevFramesDecoded: number | null = null;
  private prevFramesDecodedTsMs: number | null = null;
  private prevRawFramesPerSecond: number | null = null;

  private cmdSeq = 0;
  private noticeSeq = 0;
  private frameTimestamps: number[] = [];
  private lastFpsEmitAt = 0;

  private telemetrySnapshot: RemoteTelemetrySnapshot = {
    rttMs: null,
    fps: 0,
    webrtcRoute: null,
    webrtcTelemetry: null,
  };

  private readonly handleVisibilityChange = (): void => {
    if (typeof document === "undefined" || document.visibilityState !== "visible") {
      return;
    }
    const now = Date.now();
    this.watchdogGraceUntil = now + VISIBILITY_WATCHDOG_GRACE_MS;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendJson({ type: "ping", ts: now });
    } else if (this.state.socketStatus === "reconnecting") {
      this.reconnectNow();
    }
  };

  private readonly handleWindowOnline = (): void => {
    if (this.state.socketStatus === "reconnecting") {
      this.reconnectNow();
    }
  };

  private state: RemoteClientState = {
    profile: null,
    authType: null,
    user: null,
    wsUrl: null,
    activeControlCode: null,
    socketStatus: "idle",
    serverMode: null,
    errorCode: null,
    errorMessage: null,
    reconnectAttempt: 0,
    nextReconnectAt: null,
    rttMs: null,
    fps: 0,
    devices: [],
    activeDeviceId: null,
    sessionId: null,
    sessionStatus: "idle",
    activeTransport: null,
    desiredTransport: detectDefaultTransport(),
    webrtcRoute: null,
    webrtcTelemetry: null,
    qualityPreset: "balanced",
    dataChannelOpen: false,
    fileChannelOpen: false,
    fileTransfer: null,
    mediaStream: null,
    screenWidth: 1080,
    screenHeight: 2400,
    rotation: 0,
    remoteClipboard: "",
    lastNotice: null,
  };

  constructor(clientId?: string) {
    this.clientId = clientId ?? getOrCreateClientId();
  }

  getState(): RemoteClientState {
    return this.state;
  }

  getAuthToken(): string | null {
    return this.activeRequest?.kind === "account"
      ? this.activeRequest.authToken
      : null;
  }

  subscribe(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  readonly getTelemetrySnapshot = (): RemoteTelemetrySnapshot => {
    return this.telemetrySnapshot;
  };

  readonly subscribeTelemetry = (listener: TelemetryListener): (() => void) => {
    this.telemetryListeners.add(listener);
    return () => {
      this.telemetryListeners.delete(listener);
    };
  };

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  onAck(listener: AckListener): () => void {
    this.ackListeners.add(listener);
    return () => {
      this.ackListeners.delete(listener);
    };
  }

  onClipboard(listener: ClipboardListener): () => void {
    this.clipboardListeners.add(listener);
    return () => {
      this.clipboardListeners.delete(listener);
    };
  }

  connect(profile: ConnectionProfile): void {
    this.connectRequest({
      kind: "token",
      profile,
    });
  }

  connectWithAccount(options: ConnectWithAccountOptions): void {
    this.connectRequest({
      kind: "account",
      wsUrl: options.wsUrl,
      authToken: options.authToken,
      user: options.user,
      preferredTransport: options.preferredTransport,
      qualityPreset: options.qualityPreset,
    });
  }

  connectWithControlCode(options: ConnectWithControlCodeOptions): void {
    this.connectRequest({
      kind: "code",
      wsUrl: options.wsUrl,
      controlCode: normalizeControlCode(options.controlCode),
      controlPassword: options.controlPassword,
      preferredTransport: options.preferredTransport,
      qualityPreset: options.qualityPreset,
    });
  }

  connectRequest(request: ConnectRequest): void {
    this.clearReconnectTimer();
    this.clearAutoReRequestTimer();
    this.stopWsJpegFpsTimer();
    this.abortActiveFileTransferSilent();
    this.teardownPeerConnection();
    this.teardownSocket();
    this.attachBrowserListeners();

    this.activeRequest = request;
    this.intentionalDisconnect = false;
    this.webrtcFallbackInFlight = false;
    this.webrtcDowngradedByAgent = false;
    this.webrtcDowngradedClientSide = false;

    const desiredTransport =
      request.kind === "token"
        ? request.profile.preferredTransport
        : request.preferredTransport ?? detectDefaultTransport();
    const qualityPreset =
      request.kind === "token"
        ? request.profile.qualityPreset
        : request.qualityPreset ?? "balanced";
    const wsUrl = getRequestWsUrl(request);

    this.setState({
      profile: request.kind === "token" ? request.profile : null,
      authType: request.kind,
      user: request.kind === "account" ? (request.user ?? null) : null,
      wsUrl,
      activeControlCode: request.kind === "code" ? request.controlCode : null,
      socketStatus: "connecting",
      serverMode: request.kind === "token" ? request.profile.mode : "relay",
      errorCode: null,
      errorMessage: null,
      reconnectAttempt: 0,
      nextReconnectAt: null,
      rttMs: null,
      fps: 0,
      devices: [],
      activeDeviceId: null,
      sessionId: null,
      sessionStatus: "idle",
      activeTransport: null,
      desiredTransport,
      webrtcRoute: null,
      webrtcTelemetry: null,
      qualityPreset,
      dataChannelOpen: false,
      fileChannelOpen: false,
      fileTransfer: null,
      mediaStream: null,
      remoteClipboard: "",
    });

    this.openSocket(request);
  }

  reconnectNow(): void {
    const request = this.activeRequest;
    if (!request) return;
    this.clearReconnectTimer();
    this.clearAutoReRequestTimer();
    this.stopWsJpegFpsTimer();
    this.teardownPeerConnection();
    this.teardownSocket();
    this.attachBrowserListeners();
    this.intentionalDisconnect = false;
    this.webrtcFallbackInFlight = false;
    this.webrtcDowngradedByAgent = false;
    this.webrtcDowngradedClientSide = false;
    this.setState({
      socketStatus: "connecting",
      errorCode: null,
      errorMessage: null,
      nextReconnectAt: null,
      rttMs: null,
      fps: 0,
      sessionId: null,
      sessionStatus: this.state.activeDeviceId ? "requesting" : "idle",
      activeTransport: null,
      webrtcRoute: null,
      webrtcTelemetry: null,
      dataChannelOpen: false,
      fileChannelOpen: false,
      mediaStream: null,
    });
    this.openSocket(request);
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.activeRequest = null;
    this.detachBrowserListeners();
    this.clearReconnectTimer();
    this.clearAutoReRequestTimer();
    this.stopWsJpegFpsTimer();
    this.abortActiveFileTransferSilent();
    this.stopSession("client_disconnect");
    this.teardownSocket();
    this.webrtcDowngradedByAgent = false;
    this.webrtcDowngradedClientSide = false;
    this.setState({
      profile: null,
      authType: null,
      user: null,
      wsUrl: null,
      activeControlCode: null,
      socketStatus: "idle",
      serverMode: null,
      errorCode: null,
      errorMessage: null,
      reconnectAttempt: 0,
      nextReconnectAt: null,
      rttMs: null,
      fps: 0,
      devices: [],
      activeDeviceId: null,
      sessionId: null,
      sessionStatus: "idle",
      activeTransport: null,
      webrtcRoute: null,
      webrtcTelemetry: null,
      dataChannelOpen: false,
      fileChannelOpen: false,
      fileTransfer: null,
      mediaStream: null,
      remoteClipboard: "",
    });
  }

  removeDevice(deviceId: string): void {
    const nextDevices = this.state.devices.filter((d) => d.deviceId !== deviceId);
    if (nextDevices.length === this.state.devices.length) return;
    this.setState({ devices: nextDevices });
  }

  startSession(
    deviceId: string,
    options?: {
      preferredTransport?: TransportMode;
      qualityPreset?: QualityPreset;
    },
  ): void {
    const preferredTransport =
      options?.preferredTransport ??
      this.state.desiredTransport ??
      this.state.profile?.preferredTransport ??
      detectDefaultTransport();
    const qualityPreset =
      options?.qualityPreset ??
      this.state.qualityPreset ??
      this.state.profile?.qualityPreset ??
      "balanced";

    if (this.state.sessionId && this.state.activeDeviceId) {
      this.sendJson({
        type: "session.end",
        sessionId: this.state.sessionId,
        deviceId: this.state.activeDeviceId,
        reason: "switch_session",
      });
    }

    this.clearAutoReRequestTimer();
    this.stopWsJpegFpsTimer();
    this.abortActiveFileTransferSilent();
    this.teardownPeerConnection();
    this.frameTimestamps = [];
    this.webrtcFallbackInFlight = false;
    this.webrtcDowngradedByAgent = false;

    const device = this.state.devices.find((d) => d.deviceId === deviceId);
    const effectivePreferred = this.resolveInitialTransport(preferredTransport, device);
    this.webrtcDowngradedClientSide =
      preferredTransport === "webrtc" &&
      effectivePreferred === "ws-jpeg" &&
      typeof RTCPeerConnection !== "undefined";
    const sessionId = createSessionId();

    this.setState({
      activeDeviceId: deviceId,
      sessionId,
      sessionStatus: "requesting",
      activeTransport: null,
      desiredTransport: preferredTransport,
      webrtcRoute: null,
      webrtcTelemetry: null,
      qualityPreset,
      fps: 0,
      mediaStream: null,
      dataChannelOpen: false,
      fileChannelOpen: false,
      fileTransfer: null,
      errorCode: null,
      errorMessage: null,
      remoteClipboard: "",
      screenWidth: device?.screenWidth ?? this.state.screenWidth,
      screenHeight: device?.screenHeight ?? this.state.screenHeight,
      rotation: device?.rotation ?? this.state.rotation,
    });

    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }

    this.sendJson({
      type: "session.request",
      sessionId,
      deviceId,
      preferredTransport: effectivePreferred,
      quality: QUALITY_PRESETS[qualityPreset],
    });
  }

  stopSession(reason = "user_exit"): void {
    this.clearAutoReRequestTimer();
    this.stopWsJpegFpsTimer();
    const { sessionId, activeDeviceId } = this.state;
    if (sessionId && activeDeviceId && this.ws?.readyState === WebSocket.OPEN) {
      this.sendJson({
        type: "session.end",
        sessionId,
        deviceId: activeDeviceId,
        reason,
      });
    }
    this.abortActiveFileTransferSilent();
    this.teardownPeerConnection();
    this.frameTimestamps = [];
    this.webrtcFallbackInFlight = false;
    this.webrtcDowngradedByAgent = false;
    this.webrtcDowngradedClientSide = false;
    this.setState({
      activeDeviceId: null,
      sessionId: null,
      sessionStatus: "idle",
      activeTransport: null,
      webrtcRoute: null,
      webrtcTelemetry: null,
      fps: 0,
      mediaStream: null,
      dataChannelOpen: false,
      fileChannelOpen: false,
      fileTransfer: null,
      remoteClipboard: "",
    });
  }

  setQuality(preset: QualityPreset): void {
    const quality: StreamQuality = QUALITY_PRESETS[preset];
    this.setState({ qualityPreset: preset });
    if (this.state.activeDeviceId && this.state.sessionId) {
      this.sendCommand({ action: "quality", quality });
      this.pushNotice(
        "info",
        `画质已切换为 ${preset.toUpperCase()} (${quality.maxWidth}p · ${quality.fps}fps)`,
      );
    }
  }

  setTransport(mode: TransportMode): void {
    if (
      this.state.desiredTransport === mode &&
      this.state.activeTransport === mode &&
      this.state.sessionStatus === "streaming"
    ) {
      return;
    }
    this.setState({ desiredTransport: mode });
    if (this.state.activeDeviceId) {
      this.startSession(this.state.activeDeviceId, {
        preferredTransport: mode,
        qualityPreset: this.state.qualityPreset,
      });
      this.pushNotice(
        "info",
        mode === "webrtc" ? "正在切换至 WebRTC 低延迟通道..." : "正在切换至 WS 帧流通道...",
      );
    }
  }

  sendCommand(command: ControlCommand, targetDeviceId?: string): CommandDispatchResult {
    const deviceId = targetDeviceId ?? this.state.activeDeviceId ?? "";
    if (!deviceId) {
      return { sent: false, seq: 0, channel: "none" };
    }

    const seq = ++this.cmdSeq;
    const hasLiveSession =
      Boolean(this.state.sessionId) &&
      this.state.sessionStatus !== "error" &&
      this.state.sessionStatus !== "ended" &&
      this.state.sessionStatus !== "idle";
    const isCurrentSessionDevice =
      hasLiveSession && deviceId === this.state.activeDeviceId;
    const sessionId = isCurrentSessionDevice ? (this.state.sessionId ?? "") : "";

    const msg: WireMessage = {
      type: "control.cmd",
      sessionId,
      deviceId,
      seq,
      command,
    };

    const payload = JSON.stringify(msg);

    const isTouchDown = command.action === "touch_down";
    const isTouchMove = command.action === "touch_move";
    const isTouchUp = command.action === "touch_up";

    if (isTouchDown) {
      this.activeTouchViaWs = false;
      this.activeTouchFirstMovePending = false;
    }

    const pinTouchToWs = (isTouchMove || isTouchUp) && this.activeTouchViaWs;
    const routeFirstMoveOnControlDc = isTouchMove && this.activeTouchFirstMovePending;
    if (routeFirstMoveOnControlDc) {
      this.activeTouchFirstMovePending = false;
    }
    if (isTouchUp) {
      this.activeTouchViaWs = false;
      this.activeTouchFirstMovePending = false;
    }

    // Route steady-state touch_move over partially-reliable, in-order "pointer" DataChannel
    // (ordered: true, maxRetransmits: 0) to avoid HoL retransmit stalls without backward jumps.
    // Never split a gesture started on WS onto DC, and send the first touch_move right after
    // touch_down on the ordered "control" DC so it cannot overtake touch_down across SCTP streams.
    if (
      isTouchMove &&
      !pinTouchToWs &&
      !routeFirstMoveOnControlDc &&
      isCurrentSessionDevice &&
      this.pointerDataChannel &&
      this.pointerDataChannel.readyState === "open"
    ) {
      const buffered =
        typeof this.pointerDataChannel.bufferedAmount === "number"
          ? this.pointerDataChannel.bufferedAmount
          : 0;
      if (buffered > POINTER_DC_MAX_BUFFERED_BYTES) {
        return { sent: false, seq, channel: "none" };
      }
      try {
        this.pointerDataChannel.send(payload);
        this.lastCommandSentAt = Date.now();
        return { sent: true, seq, channel: "datachannel" };
      } catch {
        // Fall through to ordered control DataChannel / WebSocket
      }
    }

    if (
      !pinTouchToWs &&
      isCurrentSessionDevice &&
      this.dataChannel &&
      this.dataChannel.readyState === "open"
    ) {
      const buffered =
        typeof this.dataChannel.bufferedAmount === "number"
          ? this.dataChannel.bufferedAmount
          : 0;
      if (buffered <= CONTROL_DC_MAX_BUFFERED_BYTES) {
        try {
          this.dataChannel.send(payload);
          this.lastCommandSentAt = Date.now();
          if (isTouchDown) {
            this.activeTouchViaWs = false;
            this.activeTouchFirstMovePending = true;
          }
          return { sent: true, seq, channel: "datachannel" };
        } catch {
          // Fall through to WebSocket if DataChannel send fails
        }
      }
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(payload);
        this.lastCommandSentAt = Date.now();
        if (isTouchDown) {
          this.activeTouchViaWs = true;
          this.activeTouchFirstMovePending = false;
        }
        return { sent: true, seq, channel: "websocket" };
      } catch {
        return { sent: false, seq, channel: "none" };
      }
    }

    return { sent: false, seq, channel: "none" };
  }

  requestKeyframe(): CommandDispatchResult {
    return this.sendCommand({ action: "request_keyframe" });
  }

  async sendFileOverWebRtc(
    data: Blob | Uint8Array | ArrayBuffer,
    options: SendFileOptions,
  ): Promise<FileTransferState> {
    const purpose: FileTransferPurpose = options.purpose ?? "file";
    const fileName =
      options.fileName.trim() ||
      (purpose === "apk_install" ? "velodeck-agent.apk" : "unnamed.bin");
    const mimeType =
      options.mimeType?.trim() ||
      (purpose === "apk_install"
        ? "application/vnd.android.package-archive"
        : "application/octet-stream");

    if (this.activeFileTransfer) {
      const msg = "已有文件正在传输，请等待当前传输完成或取消后再试";
      this.pushNotice("warn", msg);
      throw new Error(msg);
    }

    const fileDc = this.fileDataChannel;
    if (!fileDc || fileDc.readyState !== "open") {
      const msg =
        "WebRTC P2P 文件通道未就绪（请确保处于 WebRTC 模式且手机端已升级至 v0.2.16+）";
      this.setState({
        fileTransfer: {
          transferId: null,
          fileName,
          purpose,
          status: "error",
          sentBytes: 0,
          confirmedBytes: 0,
          totalBytes: 0,
          speedBytesPerSec: 0,
          message: msg,
          savedPath: null,
          installLaunched: false,
          needsInstallPermission: false,
        },
      });
      this.pushNotice("error", msg);
      throw new Error(msg);
    }

    const transferId = createTransferId();
    const generation = ++this.fileTransferGeneration;
    const active: ActiveFileTransfer = {
      transferId,
      generation,
      fileName,
      purpose,
      totalBytes: 0,
      sentBytes: 0,
      confirmedBytes: 0,
      speedBytesPerSec: 0,
      offerSent: false,
      accepted: false,
      donePayload: null,
      errorMessage: null,
      errorEmitted: false,
      cancelled: false,
      wakeups: new Set(),
      lastProgressEmitAt: 0,
    };
    this.activeFileTransfer = active;

    const buildTransferState = (
      status: FileTransferStatus,
      message: string | null,
      extra?: Partial<FileTransferState>,
    ): FileTransferState => ({
      transferId: active.transferId,
      fileName: active.fileName,
      purpose: active.purpose,
      status,
      sentBytes: active.sentBytes,
      confirmedBytes: active.confirmedBytes,
      totalBytes: active.totalBytes,
      speedBytesPerSec: active.speedBytesPerSec,
      message,
      savedPath: extra?.savedPath ?? null,
      installLaunched: extra?.installLaunched ?? false,
      needsInstallPermission: extra?.needsInstallPermission ?? false,
    });

    const emitStateIfCurrent = (next: FileTransferState): FileTransferState => {
      if (this.fileTransferGeneration === generation) {
        this.setState({ fileTransfer: next });
      }
      return next;
    };

    const finishError = (errMsg: string): never => {
      if (this.activeFileTransfer === active) {
        this.activeFileTransfer = null;
      }
      active.speedBytesPerSec = 0;
      if (this.fileTransferGeneration === generation && !active.errorEmitted) {
        active.errorEmitted = true;
        emitStateIfCurrent(buildTransferState("error", errMsg));
        this.pushNotice("error", errMsg);
      }
      throw new Error(errMsg);
    };

    const finishCancelled = (): FileTransferState => {
      if (this.activeFileTransfer === active) {
        this.activeFileTransfer = null;
      }
      active.speedBytesPerSec = 0;
      const cancelledState = buildTransferState("cancelled", "已取消传输");
      if (
        this.fileTransferGeneration === generation &&
        this.state.fileTransfer?.status !== "cancelled"
      ) {
        this.setState({ fileTransfer: cancelledState });
      }
      return cancelledState;
    };

    emitStateIfCurrent(buildTransferState("preparing", "正在读取文件并准备校验..."));

    let bytes: Uint8Array;
    try {
      bytes = await toUint8Array(data);
    } catch (err) {
      if (active.cancelled) return finishCancelled();
      return finishError(err instanceof Error ? err.message : "读取文件失败");
    }

    if (active.cancelled) return finishCancelled();
    if (active.errorMessage) return finishError(active.errorMessage);

    const totalBytes = bytes.byteLength;
    active.totalBytes = totalBytes;
    const maxBytes = purpose === "apk_install" ? APK_MAX_BYTES : FILE_MAX_BYTES;
    if (totalBytes <= 0) {
      return finishError("不能传输空文件（大小为 0 字节）");
    }
    if (totalBytes > maxBytes) {
      const limitMb = Math.round(maxBytes / (1024 * 1024));
      return finishError(
        purpose === "apk_install"
          ? `APK 文件超过 ${limitMb} MB 大小限制`
          : `文件超过 ${limitMb} MB 大小限制`,
      );
    }

    const expectedSha = options.expectedSha256?.trim().toLowerCase();
    const sha256 = expectedSha || (await computeSha256Hex(bytes));

    if (active.cancelled) return finishCancelled();
    if (active.errorMessage) return finishError(active.errorMessage);
    if (this.fileDataChannel !== fileDc || fileDc.readyState !== "open") {
      return finishError("WebRTC 连接已断开");
    }

    emitStateIfCurrent(buildTransferState("preparing", "等待手机端确认接收..."));

    try {
      fileDc.bufferedAmountLowThreshold = FILE_DC_LOW_THRESHOLD;
    } catch {
      // Ignore if mock/browser disallows setting threshold
    }

    try {
      active.offerSent = true;
      fileDc.send(
        JSON.stringify({
          type: "file.offer",
          transferId,
          fileName,
          size: totalBytes,
          mimeType,
          sha256,
          purpose,
        }),
      );
    } catch {
      if (active.cancelled) return finishCancelled();
      return finishError("发送文件传输请求失败");
    }

    const acceptOutcome = await this.waitForFileAccept(active, fileDc);
    if (active.cancelled) return finishCancelled();
    if (active.errorMessage) return finishError(active.errorMessage);
    if (acceptOutcome === "timeout") {
      this.trySendFileCancel(fileDc, transferId, "accept_timeout");
      return finishError("等待手机端确认超时（请确认手机端已升级至 v0.2.16+）");
    }
    if (acceptOutcome !== "accepted") {
      return finishError("WebRTC 连接已断开");
    }

    const sendStartedAt = Date.now();
    let lastYieldAt = sendStartedAt;
    active.lastProgressEmitAt = sendStartedAt;
    emitStateIfCurrent(buildTransferState("sending", "正在通过 WebRTC P2P 直传..."));

    for (let offset = 0; offset < totalBytes; offset += FILE_CHUNK_SIZE) {
      if (active.cancelled) return finishCancelled();
      if (active.errorMessage) return finishError(active.errorMessage);
      if (this.fileDataChannel !== fileDc || fileDc.readyState !== "open") {
        return finishError("WebRTC 连接已断开");
      }

      while (
        !active.cancelled &&
        active.errorMessage === null &&
        this.fileDataChannel === fileDc &&
        fileDc.readyState === "open" &&
        (typeof fileDc.bufferedAmount === "number" ? fileDc.bufferedAmount : 0) >=
          FILE_DC_HIGH_WATERMARK
      ) {
        await this.waitForFileChannelDrain(fileDc, active);
        lastYieldAt = Date.now();
      }

      if (active.cancelled) return finishCancelled();
      if (active.errorMessage) return finishError(active.errorMessage);
      if (this.fileDataChannel !== fileDc || fileDc.readyState !== "open") {
        return finishError("WebRTC 连接已断开");
      }

      const end = Math.min(offset + FILE_CHUNK_SIZE, totalBytes);
      const chunkBuf = bytes.slice(offset, end).buffer;
      try {
        fileDc.send(chunkBuf);
      } catch {
        if (active.cancelled) return finishCancelled();
        if (active.errorMessage) return finishError(active.errorMessage);
        return finishError("发送文件分片失败，连接可能已中断");
      }

      active.sentBytes = end;
      const now = Date.now();
      const elapsedMs = now - sendStartedAt;
      if (elapsedMs > 0) {
        active.speedBytesPerSec = Math.round((end * 1000) / elapsedMs);
      }

      if (
        end === totalBytes ||
        now - active.lastProgressEmitAt >= FILE_PROGRESS_THROTTLE_MS
      ) {
        active.lastProgressEmitAt = now;
        emitStateIfCurrent(buildTransferState("sending", "正在通过 WebRTC P2P 直传..."));
      }

      if (now - lastYieldAt >= 16) {
        lastYieldAt = now;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }

    if (active.cancelled) return finishCancelled();
    if (active.errorMessage) return finishError(active.errorMessage);
    if (this.fileDataChannel !== fileDc || fileDc.readyState !== "open") {
      return finishError("WebRTC 连接已断开");
    }

    emitStateIfCurrent(buildTransferState("verifying", "正在校验 SHA-256 完整性..."));

    try {
      fileDc.send(
        JSON.stringify({
          type: "file.complete",
          transferId,
          sha256,
        }),
      );
    } catch {
      if (active.cancelled) return finishCancelled();
      if (active.errorMessage) return finishError(active.errorMessage);
      return finishError("发送文件校验完成信号失败");
    }

    const doneOutcome = await this.waitForFileDone(active, fileDc);
    if (active.cancelled) return finishCancelled();
    if (active.errorMessage) return finishError(active.errorMessage);
    if (doneOutcome === "timeout") {
      this.trySendFileCancel(fileDc, transferId, "verify_timeout");
      return finishError("等待手机端校验完成超时");
    }
    if (doneOutcome !== "done" || !active.donePayload) {
      return finishError("WebRTC 连接已断开");
    }

    const done = active.donePayload;
    active.confirmedBytes = totalBytes;
    const savedPath = done.savedPath ?? null;
    const installLaunched = Boolean(done.installLaunched);
    const needsInstallPermission = Boolean(done.needsInstallPermission);
    const fallbackMsg = needsInstallPermission
      ? "已打开「允许未知来源安装」授权页，请在手机画面点击允许"
      : installLaunched
        ? "已拉起系统安装界面，请在手机画面点击确认安装"
        : savedPath
          ? `已保存至 ${savedPath}`
          : "文件直传完成";
    const finalMessage = done.message?.trim() || fallbackMsg;

    if (this.activeFileTransfer === active) {
      this.activeFileTransfer = null;
    }

    const finalState = emitStateIfCurrent(
      buildTransferState("done", finalMessage, {
        savedPath,
        installLaunched,
        needsInstallPermission,
      }),
    );

    if (this.fileTransferGeneration === generation) {
      this.pushNotice(
        needsInstallPermission ? "warn" : "info",
        purpose === "apk_install"
          ? finalMessage
          : `文件「${fileName}」已传至手机`,
      );
    }

    return finalState;
  }

  cancelFileTransfer(): void {
    const active = this.activeFileTransfer;
    if (!active || active.cancelled) return;
    active.cancelled = true;
    active.speedBytesPerSec = 0;
    this.activeFileTransfer = null;

    if (active.offerSent && this.fileDataChannel?.readyState === "open") {
      this.trySendFileCancel(this.fileDataChannel, active.transferId, "user_cancelled");
    }

    if (this.fileTransferGeneration === active.generation) {
      this.setState({
        fileTransfer: {
          transferId: active.transferId,
          fileName: active.fileName,
          purpose: active.purpose,
          status: "cancelled",
          sentBytes: active.sentBytes,
          confirmedBytes: active.confirmedBytes,
          totalBytes: active.totalBytes,
          speedBytesPerSec: 0,
          message: "已取消传输",
          savedPath: null,
          installLaunched: false,
          needsInstallPermission: false,
        },
      });
      this.pushNotice("info", "已取消文件传输");
    }

    this.wakeActiveFileTransfer(active);
  }

  clearFileTransfer(): void {
    if (this.activeFileTransfer) {
      return;
    }
    if (this.state.fileTransfer !== null) {
      this.setState({ fileTransfer: null });
    }
  }

  private resolveInitialTransport(
    preferred: TransportMode,
    device?: DeviceSummary,
  ): TransportMode {
    if (preferred !== "webrtc") return "ws-jpeg";
    if (typeof RTCPeerConnection === "undefined") return "ws-jpeg";
    // Only downgrade if MediaProjection is already active and the device explicitly lacks WebRTC.
    // When MediaProjection is not yet active, still request "webrtc" so auto-projection starts directly in WebRTC.
    if (device && device.capabilities.mediaProjection && !device.capabilities.webrtc) {
      return "ws-jpeg";
    }
    return "webrtc";
  }

  private openSocket(request: ConnectRequest): void {
    const gen = ++this.connectionGeneration;
    const wsUrl = getRequestWsUrl(request);
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "WebSocket 地址无效";
      this.setState({
        socketStatus: "error",
        errorMessage: `无法创建连接：${msg}`,
      });
      return;
    }

    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.lastActivityAt = Date.now();

    ws.onopen = () => {
      if (gen !== this.connectionGeneration) return;
      this.lastActivityAt = Date.now();
      this.setState({
        socketStatus: "authenticating",
        errorCode: null,
        errorMessage: null,
      });
      this.startHeartbeat();

      if (request.kind === "account") {
        this.sendJson({
          type: "controller.auth",
          authToken: request.authToken,
          clientId: this.clientId,
          clientName: getClientDisplayName(),
        });
      } else if (request.kind === "code") {
        this.sendJson({
          type: "controller.auth",
          controlCode: request.controlCode,
          controlPassword: request.controlPassword,
          clientId: this.clientId,
          clientName: getClientDisplayName(),
        });
      } else {
        this.sendJson({
          type: "controller.auth",
          accessToken: request.profile.accessToken,
          clientId: this.clientId,
          clientName: getClientDisplayName(),
        });
      }
    };

    ws.onmessage = (event) => {
      if (gen !== this.connectionGeneration) return;
      this.lastActivityAt = Date.now();

      if (event.data instanceof ArrayBuffer) {
        this.handleBinaryFrame(event.data);
        return;
      }

      if (typeof Blob !== "undefined" && event.data instanceof Blob) {
        void event.data
          .arrayBuffer()
          .then((buf) => {
            if (gen === this.connectionGeneration) {
              this.handleBinaryFrame(buf);
            }
          })
          .catch(() => undefined);
        return;
      }

      if (typeof event.data === "string") {
        this.handleTextMessage(event.data);
      }
    };

    ws.onerror = () => {
      if (gen !== this.connectionGeneration) return;
      // onclose will handle scheduling reconnect or terminal error
    };

    ws.onclose = (event) => {
      if (gen !== this.connectionGeneration) return;
      this.stopHeartbeat();
      this.teardownPeerConnection();
      this.ws = null;

      if (this.intentionalDisconnect) {
        return;
      }

      if (this.state.socketStatus === "error") {
        return;
      }

      if (event.code === 4001) {
        this.intentionalDisconnect = true;
        this.clearReconnectTimer();
        this.setState({
          socketStatus: "error",
          errorCode: "UNAUTHORIZED",
          errorMessage: mapServerErrorMessage(
            "UNAUTHORIZED",
            event.reason || "",
            request.kind,
          ),
        });
        return;
      }

      if (event.code === 4003) {
        this.intentionalDisconnect = true;
        this.clearReconnectTimer();
        this.setState({
          socketStatus: "error",
          errorCode: "UNAUTHORIZED",
          errorMessage: event.reason
            ? `连接被设备拒绝（来源不受信任）：${event.reason}`
            : "连接被设备拒绝：当前网页来源不在允许范围内 (FORBIDDEN_ORIGIN)",
        });
        return;
      }

      if (event.code === 4029) {
        this.intentionalDisconnect = true;
        this.clearReconnectTimer();
        this.setState({
          socketStatus: "error",
          errorCode: "RATE_LIMITED",
          errorMessage: mapServerErrorMessage(
            "RATE_LIMITED",
            event.reason || "",
            request.kind,
          ),
        });
        return;
      }

      this.scheduleReconnect(
        event.reason || `连接已断开 (code ${event.code})`,
      );
    };
  }

  private teardownSocket(): void {
    this.connectionGeneration++;
    this.stopHeartbeat();
    this.clearAutoReRequestTimer();
    this.stopWsJpegFpsTimer();
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        if (
          this.ws.readyState === WebSocket.OPEN ||
          this.ws.readyState === WebSocket.CONNECTING
        ) {
          this.ws.close(1000, "client_reset");
        }
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
  }

  private attachBrowserListeners(): void {
    if (this.browserListenersAttached) return;
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
    }
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("online", this.handleWindowOnline);
    }
    this.browserListenersAttached = true;
  }

  private detachBrowserListeners(): void {
    if (!this.browserListenersAttached) return;
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    }
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("online", this.handleWindowOnline);
    }
    this.browserListenersAttached = false;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendJson({ type: "ping", ts: Date.now() });
      }
    }, HEARTBEAT_INTERVAL_MS);

    this.watchdogTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      if (now < this.watchdogGraceUntil) return;
      const idleMs = now - this.lastActivityAt;
      if (idleMs > DEAD_CONNECTION_TIMEOUT_MS) {
        try {
          this.ws.close(4000, "心跳超时");
        } catch {
          // Ignore
        }
      }
    }, HEARTBEAT_WATCHDOG_CHECK_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearAutoReRequestTimer(): void {
    if (this.autoReRequestTimer !== null) {
      clearTimeout(this.autoReRequestTimer);
      this.autoReRequestTimer = null;
    }
  }

  private startWsJpegFpsTimer(): void {
    if (this.wsJpegFpsTimer !== null) return;
    this.wsJpegFpsTimer = setInterval(() => {
      if (this.state.activeTransport !== "ws-jpeg") {
        this.stopWsJpegFpsTimer();
        return;
      }
      const cutoff = Date.now() - 1_000;
      while (this.frameTimestamps.length > 0 && (this.frameTimestamps[0] ?? 0) <= cutoff) {
        this.frameTimestamps.shift();
      }
      if (this.state.fps !== this.frameTimestamps.length) {
        this.setTelemetry({ fps: this.frameTimestamps.length });
      }
    }, WS_JPEG_FPS_DECAY_INTERVAL_MS);
  }

  private stopWsJpegFpsTimer(): void {
    if (this.wsJpegFpsTimer !== null) {
      clearInterval(this.wsJpegFpsTimer);
      this.wsJpegFpsTimer = null;
    }
  }

  private scheduleReconnect(reason: string): void {
    const request = this.activeRequest;
    if (!request || this.intentionalDisconnect) return;

    this.clearReconnectTimer();
    const attempt = this.state.reconnectAttempt + 1;
    const baseDelay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1),
    );
    const jitter = baseDelay * (Math.random() * 0.3 - 0.15);
    const delayMs = Math.max(500, Math.round(baseDelay + jitter));
    const nextReconnectAt = Date.now() + delayMs;

    this.setState({
      socketStatus: "reconnecting",
      errorMessage: reason,
      reconnectAttempt: attempt,
      nextReconnectAt,
      rttMs: null,
      fps: 0,
      webrtcRoute: null,
      webrtcTelemetry: null,
      dataChannelOpen: false,
      fileChannelOpen: false,
      mediaStream: null,
      sessionStatus: this.state.activeDeviceId ? "requesting" : "idle",
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionalDisconnect || !this.activeRequest) return;
      this.setState({
        socketStatus: "connecting",
        nextReconnectAt: null,
      });
      this.openSocket(this.activeRequest);
    }, delayMs);
  }

  private handleTextMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (!isWireMessage(parsed)) return;

    switch (parsed.type) {
      case "pong": {
        if (this.state.activeTransport === "webrtc") {
          break;
        }
        const rtt = Math.max(0, Date.now() - parsed.ts);
        if (this.state.sessionId) {
          this.setTelemetry({ rttMs: rtt });
        } else {
          this.setState({ rttMs: rtt });
        }
        break;
      }

      case "controller.authed": {
        this.iceServers = parsed.iceServers ?? [];
        const sortedDevices = this.sortDevices(parsed.devices ?? []);
        const resumeDeviceId = this.state.activeDeviceId;
        const resolvedAuthType: AuthType | null =
          parsed.authType ?? this.activeRequest?.kind ?? this.state.authType;

        this.setState({
          socketStatus: "connected",
          serverMode: parsed.mode,
          authType: resolvedAuthType,
          user: parsed.user ?? this.state.user,
          errorCode: null,
          errorMessage: null,
          reconnectAttempt: 0,
          nextReconnectAt: null,
          devices: sortedDevices,
        });

        // Immediately send an initial ping so RTT displays right away
        this.sendJson({ type: "ping", ts: Date.now() });

        // Automatically resume remote viewport session after reconnect
        if (resumeDeviceId) {
          const target = sortedDevices.find((d) => d.deviceId === resumeDeviceId);
          if (target?.online) {
            this.startSession(resumeDeviceId, {
              preferredTransport: this.state.desiredTransport,
              qualityPreset: this.state.qualityPreset,
            });
          } else {
            this.setState({
              sessionStatus: "error",
              errorMessage: "设备当前离线，等待上线或点击唤醒",
            });
          }
        }
        break;
      }

      case "device.status": {
        const updatedDevice = parsed.device;
        const existingIdx = this.state.devices.findIndex(
          (d) => d.deviceId === updatedDevice.deviceId,
        );
        const nextDevices = [...this.state.devices];
        if (existingIdx >= 0) {
          nextDevices[existingIdx] = updatedDevice;
        } else {
          nextDevices.push(updatedDevice);
        }

        const patch: Partial<RemoteClientState> = {
          devices: this.sortDevices(nextDevices),
        };

        if (updatedDevice.deviceId === this.state.activeDeviceId) {
          if (updatedDevice.screenWidth > 0 && updatedDevice.screenHeight > 0) {
            patch.screenWidth = updatedDevice.screenWidth;
            patch.screenHeight = updatedDevice.screenHeight;
            patch.rotation = updatedDevice.rotation;
          }
          // Auto-resume cleanly once device is online with MediaProjection ready after an error
          if (
            updatedDevice.online &&
            updatedDevice.capabilities.mediaProjection &&
            this.state.sessionStatus === "error" &&
            this.state.socketStatus === "connected"
          ) {
            this.setState(patch);
            this.startSession(updatedDevice.deviceId, {
              preferredTransport: this.state.desiredTransport,
              qualityPreset: this.state.qualityPreset,
            });
            return;
          }
          // Seamlessly upgrade ws-jpeg -> hardware WebRTC once the device advertises webrtc capability,
          // ONLY when client initially downgraded because !device.capabilities.webrtc (never loop if agent downgraded or ICE fell back).
          if (
            updatedDevice.online &&
            updatedDevice.capabilities.webrtc &&
            this.state.desiredTransport === "webrtc" &&
            this.state.activeTransport === "ws-jpeg" &&
            this.state.sessionStatus === "streaming" &&
            this.state.socketStatus === "connected" &&
            !this.webrtcFallbackInFlight &&
            !this.webrtcDowngradedByAgent &&
            this.webrtcDowngradedClientSide
          ) {
            this.setState(patch);
            this.pushNotice("info", "设备 WebRTC 已就绪，正在自动切换至低延迟通道...");
            this.startSession(updatedDevice.deviceId, {
              preferredTransport: "webrtc",
              qualityPreset: this.state.qualityPreset,
            });
            return;
          }
        }

        this.setState(patch);
        break;
      }

      case "session.ready": {
        this.handleSessionReady(parsed);
        break;
      }

      case "session.end": {
        if (parsed.sessionId !== this.state.sessionId) return;
        this.teardownPeerConnection();
        this.stopWsJpegFpsTimer();
        this.clearAutoReRequestTimer();

        const activeDeviceId = this.state.activeDeviceId;
        if (
          parsed.reason === "agent_reconnected" &&
          activeDeviceId &&
          this.ws?.readyState === WebSocket.OPEN &&
          !this.intentionalDisconnect
        ) {
          this.setState({
            sessionId: null,
            sessionStatus: "requesting",
            activeTransport: null,
            webrtcRoute: null,
            webrtcTelemetry: null,
            mediaStream: null,
            dataChannelOpen: false,
            fileChannelOpen: false,
            fps: 0,
            errorCode: null,
            errorMessage: null,
          });
          this.autoReRequestTimer = setTimeout(() => {
            this.autoReRequestTimer = null;
            if (
              this.intentionalDisconnect ||
              this.state.activeDeviceId !== activeDeviceId ||
              this.ws?.readyState !== WebSocket.OPEN
            ) {
              return;
            }
            this.startSession(activeDeviceId, {
              preferredTransport: this.state.desiredTransport,
              qualityPreset: this.state.qualityPreset,
            });
          }, AGENT_RECONNECT_RESUME_DELAY_MS);
          break;
        }

        this.setState({
          sessionId: null,
          sessionStatus: "ended",
          activeTransport: null,
          webrtcRoute: null,
          webrtcTelemetry: null,
          mediaStream: null,
          dataChannelOpen: false,
          fileChannelOpen: false,
          fps: 0,
          errorMessage: parsed.reason
            ? `会话已结束：${parsed.reason}`
            : "设备端已结束会话",
        });
        break;
      }

      case "rtc.answer": {
        if (parsed.sessionId !== this.state.sessionId) return;
        void this.handleRtcAnswer(parsed.sdp);
        break;
      }

      case "rtc.ice": {
        if (parsed.sessionId !== this.state.sessionId) return;
        void this.handleRemoteIce(parsed.candidate);
        break;
      }

      case "control.ack": {
        this.handleControlAck(parsed);
        break;
      }

      case "clipboard.sync": {
        this.handleClipboardSync(parsed);
        break;
      }

      case "error": {
        const authKind = this.activeRequest?.kind ?? this.state.authType;
        const readable = mapServerErrorMessage(parsed.code, parsed.message, authKind);
        const isTerminalSessionError =
          parsed.code === "INTERNAL_ERROR" ||
          parsed.code === "SESSION_NOT_FOUND" ||
          parsed.code === "DEVICE_OFFLINE";
        if (
          parsed.code === "UNAUTHORIZED" ||
          (parsed.code === "RATE_LIMITED" &&
            this.state.socketStatus !== "connected")
        ) {
          this.intentionalDisconnect = true;
          this.clearReconnectTimer();
          this.setState({
            socketStatus: "error",
            errorCode: parsed.code,
            errorMessage: readable,
          });
          this.teardownSocket();
        } else if (
          parsed.sessionId &&
          parsed.sessionId === this.state.sessionId
        ) {
          if (isTerminalSessionError) {
            this.teardownPeerConnection();
            this.stopWsJpegFpsTimer();
            this.clearAutoReRequestTimer();
            this.setState({
              sessionId: null,
              sessionStatus: "error",
              activeTransport: null,
              webrtcRoute: null,
              webrtcTelemetry: null,
              mediaStream: null,
              dataChannelOpen: false,
              fileChannelOpen: false,
              fps: 0,
              errorCode: parsed.code,
              errorMessage: readable,
            });
          } else {
            this.setState({
              sessionStatus: "error",
              errorCode: parsed.code,
              errorMessage: readable,
            });
          }
        } else if (
          parsed.code === "DEVICE_OFFLINE" &&
          parsed.deviceId === this.state.activeDeviceId
        ) {
          this.teardownPeerConnection();
          this.stopWsJpegFpsTimer();
          this.clearAutoReRequestTimer();
          this.setState({
            sessionId: null,
            sessionStatus: "error",
            activeTransport: null,
            webrtcRoute: null,
            webrtcTelemetry: null,
            mediaStream: null,
            dataChannelOpen: false,
            fileChannelOpen: false,
            fps: 0,
            errorCode: parsed.code,
            errorMessage: readable,
          });
        } else {
          this.pushNotice("error", readable);
        }
        break;
      }

      default:
        break;
    }
  }

  private handleControlAck(msg: ControlAckMessage): void {
    for (const listener of this.ackListeners) {
      listener(msg);
    }
    if (!msg.ok && msg.message) {
      this.pushNotice("warn", msg.message);
    }
  }

  private handleClipboardSync(msg: ClipboardSyncMessage): void {
    this.setState({ remoteClipboard: msg.text });
    for (const listener of this.clipboardListeners) {
      listener(msg);
    }
    this.pushNotice("info", "已同步远端剪贴板内容");
  }

  private handleDataChannelMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (!isAllowedDataChannelMessage(parsed, this.state.sessionId)) {
      return;
    }

    if (parsed.type === "control.ack") {
      this.handleControlAck(parsed);
    } else if (parsed.type === "clipboard.sync") {
      this.handleClipboardSync(parsed);
    }
  }

  private handleSessionReady(msg: SessionReadyMessage): void {
    if (msg.sessionId !== this.state.sessionId) {
      return;
    }

    if (Array.isArray(msg.iceServers) && msg.iceServers.length > 0) {
      this.iceServers = msg.iceServers;
    }

    const basePatch: Partial<RemoteClientState> = {
      screenWidth: msg.screenWidth > 0 ? msg.screenWidth : this.state.screenWidth,
      screenHeight: msg.screenHeight > 0 ? msg.screenHeight : this.state.screenHeight,
      rotation: msg.rotation,
      activeTransport: msg.transport,
      errorCode: null,
      errorMessage: null,
    };

    if (msg.transport === "webrtc" && typeof RTCPeerConnection !== "undefined") {
      this.stopWsJpegFpsTimer();
      this.setState({
        ...basePatch,
        sessionStatus: "negotiating",
      });
      void this.startWebRtcNegotiation(msg.sessionId, msg.deviceId);
      return;
    }

    if (this.state.desiredTransport === "webrtc" && !this.webrtcDowngradedClientSide) {
      this.webrtcDowngradedByAgent = true;
    }

    this.teardownPeerConnection();
    this.setState({
      ...basePatch,
      activeTransport: "ws-jpeg",
      webrtcRoute: null,
      webrtcTelemetry: null,
      sessionStatus: "streaming",
      mediaStream: null,
      dataChannelOpen: false,
      fileChannelOpen: false,
    });
    this.startWsJpegFpsTimer();
  }

  private async startWebRtcNegotiation(
    sessionId: string,
    deviceId: string,
  ): Promise<void> {
    this.teardownPeerConnection();
    this.stopWsJpegFpsTimer();

    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({
        iceServers: this.iceServers.length > 0 ? this.iceServers : [],
        iceCandidatePoolSize: 0,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
      });
    } catch (err) {
      console.warn(`[RemoteClient] RTCPeerConnection init failed (${sessionId}):`, err);
      this.fallbackToWsJpeg(sessionId, deviceId, "浏览器不支持 WebRTC，已切换至 WS 帧流");
      return;
    }

    this.pc = pc;
    this.pendingRemoteIce = [];
    this.remoteDescriptionReady = false;
    this.webrtcIceRestartAttempted = false;
    this.webrtcIceRestartInFlight = false;
    this.activeVideoReceiver = null;
    this.lastAppliedPlayoutDelayMs = null;
    this.activeTouchViaWs = false;
    this.activeTouchFirstMovePending = false;
    let localIceCount = 0;

    const videoTransceiver = pc.addTransceiver("video", { direction: "recvonly" });
    try {
      const capabilities =
        typeof RTCRtpReceiver !== "undefined" &&
        typeof RTCRtpReceiver.getCapabilities === "function"
          ? RTCRtpReceiver.getCapabilities("video")
          : null;
      if (
        capabilities &&
        capabilities.codecs.length > 0 &&
        typeof videoTransceiver.setCodecPreferences === "function"
      ) {
        // Prioritize H.264 Constrained Baseline (zero B-frames, matches LowLatencyH264Encoder),
        // then remaining H.264, then VP8, then remaining codecs.
        const ordered = sortPreferredVideoCodecs(capabilities.codecs);
        if (ordered.length > 0) {
          videoTransceiver.setCodecPreferences(ordered);
        }
      }
    } catch {
      // Fall back to default browser codec negotiation
    }

    const dc = pc.createDataChannel("control", { ordered: true });
    this.dataChannel = dc;
    dc.onopen = () => {
      if (this.pc !== pc) return;
      this.setState({ dataChannelOpen: true });
    };
    dc.onclose = () => {
      if (this.pc !== pc) return;
      this.setState({ dataChannelOpen: false });
    };
    dc.onmessage = (event) => {
      if (this.pc !== pc) return;
      if (typeof event.data === "string") {
        this.handleDataChannelMessage(event.data);
      }
    };

    try {
      const pointerDc = pc.createDataChannel("pointer", {
        ordered: true,
        maxRetransmits: 0,
      });
      this.pointerDataChannel = pointerDc;
      pointerDc.onopen = () => {
        if (this.pc !== pc) return;
        this.startPointerKeepalive(pc);
      };
      pointerDc.onclose = () => {
        if (this.pc !== pc) return;
        this.stopPointerKeepalive();
      };
    } catch {
      this.pointerDataChannel = null;
    }

    try {
      const fileDc = pc.createDataChannel("file", { ordered: true });
      fileDc.binaryType = "arraybuffer";
      try {
        fileDc.bufferedAmountLowThreshold = FILE_DC_LOW_THRESHOLD;
      } catch {
        // Ignore if environment disallows setting threshold before open
      }
      this.fileDataChannel = fileDc;
      fileDc.onopen = () => {
        if (this.pc !== pc) return;
        try {
          fileDc.bufferedAmountLowThreshold = FILE_DC_LOW_THRESHOLD;
        } catch {
          // Ignore
        }
        this.setState({ fileChannelOpen: true });
      };
      fileDc.onclose = () => {
        if (this.pc !== pc) return;
        this.setState({ fileChannelOpen: false });
        this.failActiveFileTransfer("WebRTC 连接已断开");
      };
      fileDc.onmessage = (event) => {
        if (this.pc !== pc) return;
        if (typeof event.data === "string") {
          this.handleFileChannelMessage(event.data);
        }
      };
    } catch {
      this.fileDataChannel = null;
    }

    pc.ontrack = (event) => {
      if (this.pc !== pc) return;
      // Use a 0ms minimum jitter-buffer floor so Chrome's VCMJitterEstimator adapts organically
      // for interactive remote control without artificial playout delay or mid-burst stalls.
      const receiver = event.receiver as AdaptiveRtpReceiver | undefined;
      const isVideoTrack = !event.track?.kind || event.track.kind === "video";
      if (receiver && isVideoTrack) {
        this.activeVideoReceiver = receiver;
        this.applyReceiverPlayoutDelay(receiver, 0, true);
      }
      const existingStream = event.streams[0];
      const stream = existingStream ?? new MediaStream([event.track]);
      // P0-2: Only attach mediaStream here; keep sessionStatus = "negotiating" until ICE connects
      this.setState({
        mediaStream: stream,
      });
    };

    pc.onicecandidate = (event) => {
      if (this.pc !== pc || !event.candidate) return;
      localIceCount += 1;
      this.sendJson({
        type: "rtc.ice",
        sessionId,
        deviceId,
        candidate: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        },
      });
    };

    const handleConnected = () => {
      if (this.pc !== pc) return;
      this.clearWebRtcFallbackTimer();
      this.clearWebRtcDisconnectTimer();
      this.clearWebRtcIceRestartTimer();
      this.webrtcIceRestartInFlight = false;
      this.webrtcIceRestartAttempted = false;
      this.startWebRtcStatsPolling(pc);
      if (this.pointerDataChannel?.readyState === "open") {
        this.startPointerKeepalive(pc);
      }
      this.setState({
        sessionStatus: "streaming",
        activeTransport: "webrtc",
        errorCode: null,
        errorMessage: null,
      });
    };

    const handleFailed = (trigger: "ice" | "connection") => {
      if (this.pc !== pc) return;
      const diag = `trigger=${trigger} ice=${pc.iceConnectionState} conn=${pc.connectionState} gathering=${pc.iceGatheringState ?? "unknown"} remoteAnswer=${this.remoteDescriptionReady} localCandidates=${localIceCount} iceServers=${this.iceServers.length}`;
      console.warn(`[RemoteClient] WebRTC fallback (${sessionId}): ${diag}`);
      const detail =
        trigger === "ice"
          ? `ICE=${pc.iceConnectionState}, answer=${this.remoteDescriptionReady ? "ok" : "none"}`
          : `conn=${pc.connectionState}, ICE=${pc.iceConnectionState}`;
      this.fallbackToWsJpeg(
        sessionId,
        deviceId,
        `WebRTC 连接失败 (${detail})，已自动切换至 WS 帧流`,
      );
    };

    const attemptIceRestart = async () => {
      if (this.pc !== pc) return;
      if (this.webrtcIceRestartAttempted) {
        this.fallbackToWsJpeg(
          sessionId,
          deviceId,
          "WebRTC 连接中断且重试未恢复，已自动切换至 WS 帧流",
        );
        return;
      }

      this.webrtcIceRestartAttempted = true;
      this.webrtcIceRestartInFlight = true;
      this.clearWebRtcIceRestartTimer();
      this.webrtcIceRestartTimer = setTimeout(() => {
        this.webrtcIceRestartTimer = null;
        if (this.pc !== pc) return;
        const recovered =
          (pc.connectionState === "connected" ||
            pc.iceConnectionState === "connected" ||
            pc.iceConnectionState === "completed") &&
          pc.connectionState !== "disconnected" &&
          pc.iceConnectionState !== "disconnected";
        if (!recovered) {
          console.warn(
            `[RemoteClient] WebRTC ICE restart recovery timeout (${sessionId}): ice=${pc.iceConnectionState} conn=${pc.connectionState}`,
          );
          this.fallbackToWsJpeg(
            sessionId,
            deviceId,
            "WebRTC 网络中断恢复超时，已自动切换至 WS 帧流",
          );
        }
      }, WEBRTC_ICE_RESTART_TIMEOUT_MS);

      try {
        const restartOffer = await pc.createOffer({ iceRestart: true });
        if (this.pc !== pc) return;
        this.remoteDescriptionReady = false;
        this.pendingRemoteIce = [];
        await pc.setLocalDescription(restartOffer);
        if (this.pc !== pc || !restartOffer.sdp) {
          throw new Error("ICE restart offer SDP missing");
        }
        this.sendJson({
          type: "rtc.offer",
          sessionId,
          deviceId,
          sdp: restartOffer.sdp,
        });
      } catch (err) {
        if (this.pc === pc) {
          console.warn(`[RemoteClient] WebRTC ICE restart failed (${sessionId}):`, err);
          this.fallbackToWsJpeg(
            sessionId,
            deviceId,
            "WebRTC 网络中断恢复失败，已自动切换至 WS 帧流",
          );
        }
      }
    };

    const handleDisconnected = () => {
      if (this.pc !== pc) return;
      if (this.webrtcIceRestartInFlight || this.webrtcDisconnectTimer !== null) {
        return;
      }
      this.webrtcDisconnectTimer = setTimeout(() => {
        this.webrtcDisconnectTimer = null;
        if (this.pc !== pc) return;
        const stillDisconnected =
          pc.iceConnectionState === "disconnected" ||
          pc.connectionState === "disconnected";
        if (!stillDisconnected) return;
        console.warn(
          `[RemoteClient] WebRTC disconnected for ${WEBRTC_DISCONNECT_WATCHDOG_MS}ms (${sessionId}), attempting ICE restart`,
        );
        void attemptIceRestart();
      }, WEBRTC_DISCONNECT_WATCHDOG_MS);
    };

    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === "connected") {
        handleConnected();
      } else if (pc.connectionState === "disconnected") {
        handleDisconnected();
      } else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        handleFailed("connection");
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (
        pc.iceConnectionState === "connected" ||
        pc.iceConnectionState === "completed"
      ) {
        handleConnected();
      } else if (pc.iceConnectionState === "disconnected") {
        handleDisconnected();
      } else if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "closed") {
        handleFailed("ice");
      }
    };

    // Seamless fallback if WebRTC cannot establish within WEBRTC_CONNECT_TIMEOUT_MS
    this.clearWebRtcFallbackTimer();
    this.webrtcFallbackTimer = setTimeout(() => {
      if (this.pc !== pc) return;
      const connected =
        pc.connectionState === "connected" ||
        pc.iceConnectionState === "connected" ||
        pc.iceConnectionState === "completed";
      if (!connected) {
        const diag = `timeout=${WEBRTC_CONNECT_TIMEOUT_MS}ms ice=${pc.iceConnectionState} conn=${pc.connectionState} gathering=${pc.iceGatheringState ?? "unknown"} remoteAnswer=${this.remoteDescriptionReady} localCandidates=${localIceCount} iceServers=${this.iceServers.length}`;
        console.warn(`[RemoteClient] WebRTC fallback timeout (${sessionId}): ${diag}`);
        const stage = !this.remoteDescriptionReady
          ? "未收到设备端 SDP 应答"
          : `ICE=${pc.iceConnectionState}`;
        this.fallbackToWsJpeg(
          sessionId,
          deviceId,
          `WebRTC 连接超时 (${stage})，已自动切换至 WS 帧流`,
        );
      }
    }, WEBRTC_CONNECT_TIMEOUT_MS);

    try {
      const offer = await pc.createOffer();
      if (this.pc !== pc) return;
      await pc.setLocalDescription(offer);
      if (this.pc !== pc || !offer.sdp) return;

      this.sendJson({
        type: "rtc.offer",
        sessionId,
        deviceId,
        sdp: offer.sdp,
      });
    } catch (err) {
      if (this.pc === pc) {
        console.warn(`[RemoteClient] WebRTC offer/SDP failed (${sessionId}):`, err);
        this.fallbackToWsJpeg(sessionId, deviceId, "WebRTC 协商异常，已自动切换至 WS 帧流");
      }
    }
  }

  private async handleRtcAnswer(sdp: string): Promise<void> {
    const pc = this.pc;
    if (!pc) return;

    try {
      await pc.setRemoteDescription({ type: "answer", sdp });
      if (this.pc !== pc) return;
      this.remoteDescriptionReady = true;

      const queued = this.pendingRemoteIce.splice(0, this.pendingRemoteIce.length);
      for (const candidate of queued) {
        if (this.pc !== pc) return;
        try {
          await pc.addIceCandidate(candidate);
        } catch {
          // Ignore invalid trickle candidates
        }
      }
    } catch {
      if (this.pc === pc && this.state.sessionId && this.state.activeDeviceId) {
        this.fallbackToWsJpeg(
          this.state.sessionId,
          this.state.activeDeviceId,
          "WebRTC 应答解析失败，已自动切换至 WS 帧流",
        );
      }
    }
  }

  private async handleRemoteIce(candidate: RTCIceCandidateInit): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    if (!this.remoteDescriptionReady) {
      this.pendingRemoteIce.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch {
      // Ignore late or invalid ICE candidates
    }
  }

  private fallbackToWsJpeg(
    failedSessionId: string,
    deviceId: string,
    reasonText: string,
  ): void {
    if (this.webrtcFallbackInFlight) return;
    if (this.state.activeDeviceId !== deviceId) return;

    this.webrtcFallbackInFlight = true;
    this.webrtcDowngradedClientSide = false;
    this.teardownPeerConnection();

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendJson({
        type: "session.end",
        sessionId: failedSessionId,
        deviceId,
        reason: "webrtc_fallback",
      });
    }

    const nextSessionId = createSessionId();
    this.frameTimestamps = [];
    this.setState({
      sessionId: nextSessionId,
      sessionStatus: "fallback",
      activeTransport: "ws-jpeg",
      webrtcRoute: null,
      webrtcTelemetry: null,
      mediaStream: null,
      dataChannelOpen: false,
      fileChannelOpen: false,
      fps: 0,
      errorCode: null,
      errorMessage: null,
    });
    this.pushNotice("warn", reasonText);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendJson({
        type: "session.request",
        sessionId: nextSessionId,
        deviceId,
        preferredTransport: "ws-jpeg",
        quality: QUALITY_PRESETS[this.state.qualityPreset],
      });
    }
  }

  private resetWebRtcStatsDeltas(): void {
    this.prevBytesReceived = null;
    this.prevStatsTsMs = null;
    this.prevJitterBufferDelay = null;
    this.prevJitterBufferEmitted = null;
    this.prevTotalDecodeTime = null;
    this.prevDecodeFrames = null;
    this.prevFramesDecoded = null;
    this.prevFramesDecodedTsMs = null;
    this.prevRawFramesPerSecond = null;
  }

  private startWebRtcStatsPolling(pc: RTCPeerConnection): void {
    if (this.webrtcStatsTimer !== null && this.pc === pc) {
      return;
    }
    this.stopWebRtcStatsPolling();
    this.webrtcStatsTimer = setInterval(() => {
      if (this.pc !== pc) {
        this.stopWebRtcStatsPolling();
        return;
      }
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      void pc
        .getStats()
        .then((stats) => {
          if (this.pc !== pc) return;
          let rawFps: number | null = null;
          let fps: number | null = null;
          let rttMs: number | null = null;
          let activeLocalCandidateId: string | null = null;
          let activeRemoteCandidateId: string | null = null;
          let selectedTransportPairId: string | null = null;

          let hasInboundVideo = false;
          let inboundCodecId: string | null = null;
          let frameWidth = 0;
          let frameHeight = 0;
          let packetsLost = 0;
          let framesDropped = 0;
          let freezeCount = 0;
          let jitterMs: number | null = null;
          let bytesReceived: number | null = null;
          let statsTsMs =
            typeof performance !== "undefined" && typeof performance.now === "function"
              ? performance.now()
              : Date.now();
          let jitterBufferDelay: number | null = null;
          let jitterBufferEmittedCount: number | null = null;
          let totalDecodeTime: number | null = null;
          let framesDecoded: number | null = null;

          const codecs = new Map<string, string>();
          const candidates = new Map<
            string,
            {
              candidateType: string;
              address: string | null;
              protocol: string | null;
              relayProtocol: string | null;
            }
          >();
          const candidatePairs = new Map<string, Record<string, unknown>>();

          stats.forEach((report) => {
            const rec = report as Record<string, unknown>;
            if (
              report.type === "inbound-rtp" &&
              (rec.kind === "video" || rec.mediaType === "video")
            ) {
              hasInboundVideo = true;
              if (typeof rec.framesPerSecond === "number" && Number.isFinite(rec.framesPerSecond)) {
                rawFps = rec.framesPerSecond;
              }
              if (typeof rec.codecId === "string") {
                inboundCodecId = rec.codecId;
              }
              if (typeof rec.frameWidth === "number" && Number.isFinite(rec.frameWidth)) {
                frameWidth = Math.max(0, Math.round(rec.frameWidth));
              }
              if (typeof rec.frameHeight === "number" && Number.isFinite(rec.frameHeight)) {
                frameHeight = Math.max(0, Math.round(rec.frameHeight));
              }
              if (typeof rec.packetsLost === "number" && Number.isFinite(rec.packetsLost)) {
                packetsLost = Math.max(0, Math.round(rec.packetsLost));
              }
              if (typeof rec.framesDropped === "number" && Number.isFinite(rec.framesDropped)) {
                framesDropped = Math.max(0, Math.round(rec.framesDropped));
              }
              if (typeof rec.freezeCount === "number" && Number.isFinite(rec.freezeCount)) {
                freezeCount = Math.max(0, Math.round(rec.freezeCount));
              }
              if (typeof rec.jitter === "number" && Number.isFinite(rec.jitter)) {
                jitterMs = Math.max(0, Math.round(rec.jitter * 1000));
              }
              if (typeof rec.bytesReceived === "number" && Number.isFinite(rec.bytesReceived)) {
                bytesReceived = rec.bytesReceived;
              }
              if (typeof report.timestamp === "number" && Number.isFinite(report.timestamp)) {
                statsTsMs = report.timestamp;
              }
              if (
                typeof rec.jitterBufferDelay === "number" &&
                Number.isFinite(rec.jitterBufferDelay)
              ) {
                jitterBufferDelay = rec.jitterBufferDelay;
              }
              if (
                typeof rec.jitterBufferEmittedCount === "number" &&
                Number.isFinite(rec.jitterBufferEmittedCount)
              ) {
                jitterBufferEmittedCount = rec.jitterBufferEmittedCount;
              }
              if (
                typeof rec.totalDecodeTime === "number" &&
                Number.isFinite(rec.totalDecodeTime)
              ) {
                totalDecodeTime = rec.totalDecodeTime;
              }
              if (
                typeof rec.framesDecoded === "number" &&
                Number.isFinite(rec.framesDecoded)
              ) {
                framesDecoded = rec.framesDecoded;
              }
            } else if (report.type === "codec") {
              if (typeof rec.mimeType === "string") {
                codecs.set(report.id, rec.mimeType);
              }
            } else if (report.type === "transport") {
              if (typeof rec.selectedCandidatePairId === "string") {
                selectedTransportPairId = rec.selectedCandidatePairId;
              }
            } else if (report.type === "candidate-pair") {
              candidatePairs.set(report.id, rec);
            } else if (
              report.type === "local-candidate" ||
              report.type === "remote-candidate"
            ) {
              const candidateType =
                typeof rec.candidateType === "string" ? rec.candidateType : "";
              const address =
                typeof rec.address === "string" && rec.address.length > 0
                  ? rec.address
                  : typeof rec.ip === "string" && rec.ip.length > 0
                    ? rec.ip
                    : null;
              const protocol =
                typeof rec.protocol === "string" && rec.protocol.trim().length > 0
                  ? rec.protocol.trim().toLowerCase()
                  : null;
              const relayProtocol =
                typeof rec.relayProtocol === "string" && rec.relayProtocol.trim().length > 0
                  ? rec.relayProtocol.trim().toLowerCase()
                  : null;
              if (candidateType) {
                candidates.set(report.id, {
                  candidateType,
                  address,
                  protocol,
                  relayProtocol,
                });
              }
            }
          });

          // P1-2: Resolve transport.selectedCandidatePairId FIRST before scanning nominated && succeeded
          let activePair: Record<string, unknown> | undefined =
            selectedTransportPairId ? candidatePairs.get(selectedTransportPairId) : undefined;
          if (!activePair) {
            for (const rec of candidatePairs.values()) {
              if (
                (rec.nominated === true || rec.selected === true) &&
                rec.state === "succeeded"
              ) {
                activePair = rec;
                break;
              }
            }
          }
          if (activePair) {
            if (
              typeof activePair.currentRoundTripTime === "number" &&
              Number.isFinite(activePair.currentRoundTripTime)
            ) {
              rttMs = Math.max(1, Math.round(activePair.currentRoundTripTime * 1000));
            }
            if (typeof activePair.localCandidateId === "string") {
              activeLocalCandidateId = activePair.localCandidateId;
            }
            if (typeof activePair.remoteCandidateId === "string") {
              activeRemoteCandidateId = activePair.remoteCandidateId;
            }
          }

          let route: "p2p" | "turn" | null = this.state.webrtcRoute;
          let icePair: string | null = this.state.webrtcTelemetry?.icePair ?? null;
          if (activeLocalCandidateId || activeRemoteCandidateId) {
            const localCand = activeLocalCandidateId
              ? candidates.get(activeLocalCandidateId)
              : undefined;
            const remoteCand = activeRemoteCandidateId
              ? candidates.get(activeRemoteCandidateId)
              : undefined;
            const localType = localCand?.candidateType;
            const remoteType = remoteCand?.candidateType;
            if (localType === "relay" || remoteType === "relay") {
              route = "turn";
              const relayCand = localType === "relay" ? localCand : remoteCand;
              const proto =
                relayCand?.relayProtocol ??
                relayCand?.protocol ??
                localCand?.relayProtocol ??
                localCand?.protocol ??
                remoteCand?.relayProtocol ??
                remoteCand?.protocol ??
                null;
              if (proto === "udp" || proto === "tcp" || proto === "tls") {
                icePair = `TURN (${proto.toUpperCase()})`;
              } else {
                icePair = "TURN Relay";
              }
            } else if (localType === "host" && remoteType === "host") {
              route = "p2p";
              const addrs = [localCand?.address, remoteCand?.address].filter(
                (a): a is string => typeof a === "string" && a.length > 0,
              );
              if (addrs.some((a) => a.includes(":"))) {
                icePair = "P2P直连 (IPv6)";
              } else if (addrs.some((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a))) {
                icePair = "P2P直连 (IPv4)";
              } else {
                icePair = "P2P直连 (host)";
              }
            } else if (
              localType === "srflx" ||
              remoteType === "srflx" ||
              localType === "prflx" ||
              remoteType === "prflx"
            ) {
              route = "p2p";
              icePair = "P2P穿透 (NAT)";
            } else if (localType || remoteType) {
              route = "p2p";
              icePair = "P2P";
            }
          }

          const rawMime = inboundCodecId ? codecs.get(inboundCodecId) : undefined;
          const codec = rawMime
            ? rawMime.replace(/^video\//i, "").toUpperCase()
            : (this.state.webrtcTelemetry?.codec ?? null);

          // P1-2: Compute delta FPS from framesDecoded / deltaSec whenever framesPerSecond is missing or unchanged
          if (framesDecoded !== null) {
            const hasTimeDelta =
              this.prevFramesDecoded !== null &&
              this.prevFramesDecodedTsMs !== null &&
              statsTsMs > this.prevFramesDecodedTsMs &&
              framesDecoded >= this.prevFramesDecoded;
            const fpsMissingOrUnchanged =
              rawFps === null ||
              (this.prevRawFramesPerSecond !== null &&
                rawFps === this.prevRawFramesPerSecond);
            if (hasTimeDelta && fpsMissingOrUnchanged) {
              const deltaSec = (statsTsMs - this.prevFramesDecodedTsMs!) / 1000;
              const deltaFrames = framesDecoded - this.prevFramesDecoded!;
              fps = Math.max(0, Math.round(deltaFrames / deltaSec));
            } else if (rawFps !== null) {
              fps = Math.max(0, Math.round(rawFps));
            }
            if (
              this.prevFramesDecodedTsMs === null ||
              statsTsMs > this.prevFramesDecodedTsMs
            ) {
              this.prevFramesDecoded = framesDecoded;
              this.prevFramesDecodedTsMs = statsTsMs;
              this.prevRawFramesPerSecond = rawFps;
            }
          } else if (rawFps !== null) {
            fps = Math.max(0, Math.round(rawFps));
            this.prevRawFramesPerSecond = rawFps;
          }

          let bitrateKbps = this.state.webrtcTelemetry?.bitrateKbps ?? 0;
          if (bytesReceived !== null) {
            const isCachedSample =
              this.prevStatsTsMs !== null && statsTsMs === this.prevStatsTsMs;
            if (!isCachedSample) {
              if (
                this.prevBytesReceived !== null &&
                this.prevStatsTsMs !== null &&
                bytesReceived >= this.prevBytesReceived &&
                statsTsMs > this.prevStatsTsMs
              ) {
                const deltaBytes = bytesReceived - this.prevBytesReceived;
                const deltaSec = (statsTsMs - this.prevStatsTsMs) / 1000;
                bitrateKbps = Math.round((deltaBytes * 8) / deltaSec / 1000);
              } else if (
                this.prevBytesReceived === null ||
                bytesReceived < this.prevBytesReceived
              ) {
                bitrateKbps = 0;
              }
              this.prevBytesReceived = bytesReceived;
              this.prevStatsTsMs = statsTsMs;
            }
          }

          let jitterBufferMs: number | null =
            this.state.webrtcTelemetry?.jitterBufferMs ?? null;
          if (jitterBufferDelay !== null && jitterBufferEmittedCount !== null) {
            if (
              this.prevJitterBufferDelay !== null &&
              this.prevJitterBufferEmitted !== null &&
              jitterBufferEmittedCount > this.prevJitterBufferEmitted &&
              jitterBufferDelay >= this.prevJitterBufferDelay
            ) {
              const avgMs =
                ((jitterBufferDelay - this.prevJitterBufferDelay) /
                  (jitterBufferEmittedCount - this.prevJitterBufferEmitted)) *
                1000;
              jitterBufferMs = Math.round(avgMs * 10) / 10;
            } else if (
              this.prevJitterBufferDelay === null &&
              jitterBufferEmittedCount > 0
            ) {
              const avgMs = (jitterBufferDelay / jitterBufferEmittedCount) * 1000;
              jitterBufferMs = Math.round(avgMs * 10) / 10;
            }
            this.prevJitterBufferDelay = jitterBufferDelay;
            this.prevJitterBufferEmitted = jitterBufferEmittedCount;
          }

          let decodeMs: number | null = this.state.webrtcTelemetry?.decodeMs ?? null;
          if (totalDecodeTime !== null && framesDecoded !== null) {
            if (
              this.prevTotalDecodeTime !== null &&
              this.prevDecodeFrames !== null &&
              framesDecoded > this.prevDecodeFrames &&
              totalDecodeTime >= this.prevTotalDecodeTime
            ) {
              const avgMs =
                ((totalDecodeTime - this.prevTotalDecodeTime) /
                  (framesDecoded - this.prevDecodeFrames)) *
                1000;
              decodeMs = Math.round(avgMs * 10) / 10;
            } else if (this.prevTotalDecodeTime === null && framesDecoded > 0) {
              const avgMs = (totalDecodeTime / framesDecoded) * 1000;
              decodeMs = Math.round(avgMs * 10) / 10;
            }
            this.prevTotalDecodeTime = totalDecodeTime;
            this.prevDecodeFrames = framesDecoded;
          }

          const telemetryPatch: Partial<RemoteTelemetrySnapshot> = {};
          if (fps !== null && fps !== this.state.fps) telemetryPatch.fps = fps;
          if (rttMs !== null && rttMs !== this.state.rttMs) telemetryPatch.rttMs = rttMs;
          if (route !== this.state.webrtcRoute) telemetryPatch.webrtcRoute = route;

          if (hasInboundVideo || icePair !== null) {
            const nextTelemetry: WebRtcTelemetry = {
              codec,
              width:
                frameWidth > 0 ? frameWidth : (this.state.webrtcTelemetry?.width ?? 0),
              height:
                frameHeight > 0
                  ? frameHeight
                  : (this.state.webrtcTelemetry?.height ?? 0),
              bitrateKbps,
              jitterMs,
              jitterBufferMs,
              decodeMs,
              packetsLost,
              framesDropped,
              freezeCount,
              icePair,
            };
            const prev = this.state.webrtcTelemetry;
            const telemetryChanged =
              prev === null ||
              prev.codec !== nextTelemetry.codec ||
              prev.width !== nextTelemetry.width ||
              prev.height !== nextTelemetry.height ||
              prev.bitrateKbps !== nextTelemetry.bitrateKbps ||
              prev.jitterMs !== nextTelemetry.jitterMs ||
              prev.jitterBufferMs !== nextTelemetry.jitterBufferMs ||
              prev.decodeMs !== nextTelemetry.decodeMs ||
              prev.packetsLost !== nextTelemetry.packetsLost ||
              prev.framesDropped !== nextTelemetry.framesDropped ||
              prev.freezeCount !== nextTelemetry.freezeCount ||
              prev.icePair !== nextTelemetry.icePair;
            if (telemetryChanged) {
              telemetryPatch.webrtcTelemetry = nextTelemetry;
            }
          }

          if (this.activeVideoReceiver) {
            const targetPlayoutDelayMs = selectAdaptivePlayoutDelayMs(
              route,
              rttMs,
              this.lastAppliedPlayoutDelayMs ?? 0,
            );
            this.applyReceiverPlayoutDelay(this.activeVideoReceiver, targetPlayoutDelayMs);
          }

          if (Object.keys(telemetryPatch).length > 0) {
            this.setTelemetry(telemetryPatch);
          }
        })
        .catch(() => undefined);
    }, WEBRTC_STATS_INTERVAL_MS);
  }

  private applyReceiverPlayoutDelay(
    receiver: AdaptiveRtpReceiver | null,
    delayMs: PlayoutDelayBucketMs,
    force = false,
  ): void {
    if (!receiver) return;
    if (!force && this.lastAppliedPlayoutDelayMs === delayMs) {
      return;
    }
    if ("jitterBufferTarget" in receiver) {
      try {
        receiver.jitterBufferTarget = delayMs;
      } catch {
        // Ignore browsers without jitterBufferTarget support
      }
    } else if ("playoutDelayHint" in receiver) {
      try {
        receiver.playoutDelayHint = delayMs / 1000;
      } catch {
        // Ignore browsers without playoutDelayHint support
      }
    }
    this.lastAppliedPlayoutDelayMs = delayMs;
  }

  private stopWebRtcStatsPolling(): void {
    if (this.webrtcStatsTimer !== null) {
      clearInterval(this.webrtcStatsTimer);
      this.webrtcStatsTimer = null;
    }
    this.resetWebRtcStatsDeltas();
  }

  private clearWebRtcFallbackTimer(): void {
    if (this.webrtcFallbackTimer !== null) {
      clearTimeout(this.webrtcFallbackTimer);
      this.webrtcFallbackTimer = null;
    }
  }

  private clearWebRtcDisconnectTimer(): void {
    if (this.webrtcDisconnectTimer !== null) {
      clearTimeout(this.webrtcDisconnectTimer);
      this.webrtcDisconnectTimer = null;
    }
  }

  private clearWebRtcIceRestartTimer(): void {
    if (this.webrtcIceRestartTimer !== null) {
      clearTimeout(this.webrtcIceRestartTimer);
      this.webrtcIceRestartTimer = null;
    }
  }

  private startPointerKeepalive(pc: RTCPeerConnection): void {
    if (this.pointerKeepaliveTimer !== null) return;
    this.pointerKeepaliveTimer = setInterval(() => {
      if (this.pc !== pc) {
        this.stopPointerKeepalive();
        return;
      }
      if (
        this.state.sessionStatus !== "streaming" ||
        this.state.activeTransport !== "webrtc"
      ) {
        return;
      }
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      const pointerDc = this.pointerDataChannel;
      if (!pointerDc || pointerDc.readyState !== "open") {
        return;
      }
      if (Date.now() - this.lastCommandSentAt < POINTER_KEEPALIVE_INTERVAL_MS) {
        return;
      }
      const buffered =
        typeof pointerDc.bufferedAmount === "number" ? pointerDc.bufferedAmount : 0;
      if (buffered > POINTER_DC_MAX_BUFFERED_BYTES) {
        return;
      }
      try {
        pointerDc.send(POINTER_KEEPALIVE_PAYLOAD);
      } catch {
        // Ignore keepalive send errors
      }
    }, POINTER_KEEPALIVE_INTERVAL_MS);
  }

  private stopPointerKeepalive(): void {
    if (this.pointerKeepaliveTimer !== null) {
      clearInterval(this.pointerKeepaliveTimer);
      this.pointerKeepaliveTimer = null;
    }
  }

  private teardownPeerConnection(): void {
    this.clearWebRtcFallbackTimer();
    this.clearWebRtcDisconnectTimer();
    this.clearWebRtcIceRestartTimer();
    this.stopPointerKeepalive();
    this.stopWebRtcStatsPolling();
    this.pendingRemoteIce = [];
    this.remoteDescriptionReady = false;
    this.webrtcIceRestartAttempted = false;
    this.webrtcIceRestartInFlight = false;
    this.activeVideoReceiver = null;
    this.lastAppliedPlayoutDelayMs = null;
    this.activeTouchViaWs = false;
    this.activeTouchFirstMovePending = false;

    if (this.fileDataChannel) {
      try {
        this.fileDataChannel.onopen = null;
        this.fileDataChannel.onclose = null;
        this.fileDataChannel.onmessage = null;
        this.fileDataChannel.onbufferedamountlow = null;
        this.fileDataChannel.close();
      } catch {
        // Ignore
      }
      this.fileDataChannel = null;
    }

    this.failActiveFileTransfer("WebRTC 连接已断开");

    if (this.pointerDataChannel) {
      try {
        this.pointerDataChannel.onopen = null;
        this.pointerDataChannel.onclose = null;
        this.pointerDataChannel.onmessage = null;
        this.pointerDataChannel.close();
      } catch {
        // Ignore
      }
      this.pointerDataChannel = null;
    }

    if (this.dataChannel) {
      try {
        this.dataChannel.onopen = null;
        this.dataChannel.onclose = null;
        this.dataChannel.onmessage = null;
        this.dataChannel.close();
      } catch {
        // Ignore
      }
      this.dataChannel = null;
    }

    if (this.pc) {
      try {
        this.pc.ontrack = null;
        this.pc.onicecandidate = null;
        this.pc.onconnectionstatechange = null;
        this.pc.oniceconnectionstatechange = null;
        this.pc.close();
      } catch {
        // Ignore
      }
      this.pc = null;
    }

    const teardownPatch: Partial<RemoteClientState> = {};
    if (this.state.webrtcTelemetry !== null) {
      teardownPatch.webrtcTelemetry = null;
    }
    if (this.state.fileChannelOpen) {
      teardownPatch.fileChannelOpen = false;
    }
    if (Object.keys(teardownPatch).length > 0) {
      this.setState(teardownPatch);
    }
  }

  private handleFileChannelMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const msg = parsed as Record<string, unknown>;
    const type = typeof msg.type === "string" ? msg.type : "";
    const active = this.activeFileTransfer;
    if (!active) return;

    const transferId = typeof msg.transferId === "string" ? msg.transferId : null;

    if (type === "file.accept") {
      if (transferId !== active.transferId) return;
      active.accepted = true;
      this.wakeActiveFileTransfer(active);
      return;
    }

    if (type === "file.progress") {
      if (transferId !== active.transferId) return;
      const receivedBytes =
        typeof msg.receivedBytes === "number" && Number.isFinite(msg.receivedBytes)
          ? Math.max(0, Math.min(active.totalBytes, Math.round(msg.receivedBytes)))
          : active.confirmedBytes;
      if (receivedBytes > active.confirmedBytes) {
        active.confirmedBytes = receivedBytes;
        const now = Date.now();
        if (
          this.fileTransferGeneration === active.generation &&
          now - active.lastProgressEmitAt >= FILE_PROGRESS_THROTTLE_MS &&
          this.state.fileTransfer?.transferId === active.transferId &&
          this.state.fileTransfer.status === "sending"
        ) {
          active.lastProgressEmitAt = now;
          this.setState({
            fileTransfer: {
              ...this.state.fileTransfer,
              confirmedBytes: active.confirmedBytes,
            },
          });
        }
      }
      return;
    }

    if (type === "file.done") {
      if (transferId !== active.transferId) return;
      active.donePayload = {
        savedPath: typeof msg.savedPath === "string" ? msg.savedPath : undefined,
        sha256: typeof msg.sha256 === "string" ? msg.sha256 : undefined,
        installLaunched:
          typeof msg.installLaunched === "boolean" ? msg.installLaunched : undefined,
        needsInstallPermission:
          typeof msg.needsInstallPermission === "boolean"
            ? msg.needsInstallPermission
            : undefined,
        message: typeof msg.message === "string" ? msg.message : undefined,
      };
      this.wakeActiveFileTransfer(active);
      return;
    }

    if (type === "file.error") {
      if (transferId && transferId !== active.transferId) return;
      const errText =
        typeof msg.error === "string" && msg.error.trim().length > 0
          ? msg.error.trim()
          : "手机端接收文件失败";
      this.failActiveFileTransfer(errText);
    }
  }

  private trySendFileCancel(
    fileDc: RTCDataChannel,
    transferId: string,
    reason: string,
  ): void {
    try {
      if (fileDc.readyState === "open") {
        fileDc.send(
          JSON.stringify({
            type: "file.cancel",
            transferId,
            reason,
          }),
        );
      }
    } catch {
      // Ignore cancel send errors on closing channel
    }
  }

  private wakeActiveFileTransfer(active: ActiveFileTransfer): void {
    const callbacks = Array.from(active.wakeups);
    active.wakeups.clear();
    for (const wake of callbacks) {
      wake();
    }
  }

  private failActiveFileTransfer(reason: string): void {
    const active = this.activeFileTransfer;
    if (!active || active.cancelled || active.errorMessage !== null) return;
    active.errorMessage = reason;
    active.speedBytesPerSec = 0;
    active.errorEmitted = true;
    this.activeFileTransfer = null;

    if (this.fileTransferGeneration === active.generation) {
      this.setState({
        fileTransfer: {
          transferId: active.transferId,
          fileName: active.fileName,
          purpose: active.purpose,
          status: "error",
          sentBytes: active.sentBytes,
          confirmedBytes: active.confirmedBytes,
          totalBytes: active.totalBytes,
          speedBytesPerSec: 0,
          message: reason,
          savedPath: null,
          installLaunched: false,
          needsInstallPermission: false,
        },
      });
      this.pushNotice("error", reason);
    }

    this.wakeActiveFileTransfer(active);
  }

  private abortActiveFileTransferSilent(): void {
    this.fileTransferGeneration++;
    const active = this.activeFileTransfer;
    if (!active) return;
    active.errorMessage = "会话已关闭";
    active.errorEmitted = true;
    this.activeFileTransfer = null;
    this.wakeActiveFileTransfer(active);
  }

  private waitForFileAccept(
    active: ActiveFileTransfer,
    fileDc: RTCDataChannel,
  ): Promise<"accepted" | "aborted" | "timeout"> {
    if (active.accepted) return Promise.resolve("accepted");
    if (active.cancelled || active.errorMessage !== null || fileDc.readyState !== "open") {
      return Promise.resolve("aborted");
    }

    return new Promise((resolve) => {
      let settled = false;
      let timerId: ReturnType<typeof setTimeout> | null = null;

      const finish = (outcome: "accepted" | "aborted" | "timeout") => {
        if (settled) return;
        settled = true;
        if (timerId !== null) {
          clearTimeout(timerId);
          timerId = null;
        }
        active.wakeups.delete(onWake);
        resolve(outcome);
      };

      const onWake = () => {
        if (active.accepted) {
          finish("accepted");
        } else if (
          active.cancelled ||
          active.errorMessage !== null ||
          fileDc.readyState !== "open"
        ) {
          finish("aborted");
        }
      };

      active.wakeups.add(onWake);
      timerId = setTimeout(() => finish("timeout"), FILE_ACCEPT_TIMEOUT_MS);
    });
  }

  private waitForFileDone(
    active: ActiveFileTransfer,
    fileDc: RTCDataChannel,
  ): Promise<"done" | "aborted" | "timeout"> {
    if (active.donePayload) return Promise.resolve("done");
    if (active.cancelled || active.errorMessage !== null || fileDc.readyState !== "open") {
      return Promise.resolve("aborted");
    }

    return new Promise((resolve) => {
      let settled = false;
      let timerId: ReturnType<typeof setTimeout> | null = null;

      const finish = (outcome: "done" | "aborted" | "timeout") => {
        if (settled) return;
        settled = true;
        if (timerId !== null) {
          clearTimeout(timerId);
          timerId = null;
        }
        active.wakeups.delete(onWake);
        resolve(outcome);
      };

      const onWake = () => {
        if (active.donePayload) {
          finish("done");
        } else if (
          active.cancelled ||
          active.errorMessage !== null ||
          fileDc.readyState !== "open"
        ) {
          finish("aborted");
        }
      };

      active.wakeups.add(onWake);
      timerId = setTimeout(() => finish("timeout"), FILE_DONE_TIMEOUT_MS);
    });
  }

  private waitForFileChannelDrain(
    fileDc: RTCDataChannel,
    active: ActiveFileTransfer,
  ): Promise<void> {
    if (
      active.cancelled ||
      active.errorMessage !== null ||
      fileDc.readyState !== "open" ||
      (typeof fileDc.bufferedAmount === "number" ? fileDc.bufferedAmount : 0) <
        FILE_DC_HIGH_WATERMARK
    ) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let settled = false;
      let timerId: ReturnType<typeof setTimeout> | null = null;
      const supportsEventListener =
        typeof fileDc.addEventListener === "function" &&
        typeof fileDc.removeEventListener === "function";

      const finish = () => {
        if (settled) return;
        settled = true;
        if (timerId !== null) {
          clearTimeout(timerId);
          timerId = null;
        }
        if (supportsEventListener) {
          fileDc.removeEventListener("bufferedamountlow", finish);
        } else if (fileDc.onbufferedamountlow === finish) {
          fileDc.onbufferedamountlow = null;
        }
        active.wakeups.delete(finish);
        resolve();
      };

      active.wakeups.add(finish);
      if (supportsEventListener) {
        fileDc.addEventListener("bufferedamountlow", finish);
      } else {
        fileDc.onbufferedamountlow = finish;
      }
      timerId = setTimeout(finish, FILE_DC_BACKPRESSURE_POLL_MS);
    });
  }

  private handleBinaryFrame(buffer: ArrayBuffer): void {
    let frame: MediaFrame;
    try {
      frame = decodeMediaFrame(buffer);
    } catch {
      return;
    }

    if (
      this.state.sessionId &&
      frame.sessionId &&
      frame.sessionId !== this.state.sessionId
    ) {
      return;
    }

    for (const listener of this.frameListeners) {
      listener(frame);
    }

    const now = Date.now();
    this.frameTimestamps.push(now);
    const cutoff = now - 1_000;
    while (this.frameTimestamps.length > 0 && (this.frameTimestamps[0] ?? 0) < cutoff) {
      this.frameTimestamps.shift();
    }

    const structuralChanged =
      this.state.sessionStatus !== "streaming" ||
      this.state.activeTransport !== "ws-jpeg" ||
      (frame.width > 0 && frame.width !== this.state.screenWidth) ||
      (frame.height > 0 && frame.height !== this.state.screenHeight) ||
      frame.rotation !== this.state.rotation;

    if (structuralChanged) {
      this.lastFpsEmitAt = now;
      this.setState({
        sessionStatus: "streaming",
        activeTransport: "ws-jpeg",
        fps: this.frameTimestamps.length,
        screenWidth: frame.width > 0 ? frame.width : this.state.screenWidth,
        screenHeight: frame.height > 0 ? frame.height : this.state.screenHeight,
        rotation: frame.rotation,
      });
      this.startWsJpegFpsTimer();
    } else if (now - this.lastFpsEmitAt >= 500) {
      this.lastFpsEmitAt = now;
      this.setTelemetry({ fps: this.frameTimestamps.length });
    }
  }

  private sendJson(message: WireMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private sortDevices(devices: DeviceSummary[]): DeviceSummary[] {
    return [...devices].sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return b.lastSeen - a.lastSeen;
    });
  }

  private pushNotice(level: RemoteClientNotice["level"], text: string): void {
    this.setState({
      lastNotice: {
        id: ++this.noticeSeq,
        level,
        text,
      },
    });
  }

  private syncTelemetrySnapshot(notify: boolean): void {
    const prev = this.telemetrySnapshot;
    if (
      prev.rttMs === this.state.rttMs &&
      prev.fps === this.state.fps &&
      prev.webrtcRoute === this.state.webrtcRoute &&
      prev.webrtcTelemetry === this.state.webrtcTelemetry
    ) {
      return;
    }
    this.telemetrySnapshot = {
      rttMs: this.state.rttMs,
      fps: this.state.fps,
      webrtcRoute: this.state.webrtcRoute,
      webrtcTelemetry: this.state.webrtcTelemetry,
    };
    if (notify) {
      for (const listener of this.telemetryListeners) {
        listener(this.telemetrySnapshot);
      }
    }
  }

  private setTelemetry(patch: Partial<RemoteTelemetrySnapshot>): void {
    let changed = false;
    if (patch.rttMs !== undefined && patch.rttMs !== this.state.rttMs) {
      this.state.rttMs = patch.rttMs;
      changed = true;
    }
    if (patch.fps !== undefined && patch.fps !== this.state.fps) {
      this.state.fps = patch.fps;
      changed = true;
    }
    if (patch.webrtcRoute !== undefined && patch.webrtcRoute !== this.state.webrtcRoute) {
      this.state.webrtcRoute = patch.webrtcRoute;
      changed = true;
    }
    if (
      patch.webrtcTelemetry !== undefined &&
      patch.webrtcTelemetry !== this.state.webrtcTelemetry
    ) {
      this.state.webrtcTelemetry = patch.webrtcTelemetry;
      changed = true;
    }
    if (!changed) return;
    this.syncTelemetrySnapshot(true);
  }

  private setState(patch: Partial<RemoteClientState>): void {
    this.state = {
      ...this.state,
      ...patch,
    };
    this.syncTelemetrySnapshot(true);
    for (const listener of this.stateListeners) {
      listener(this.state);
    }
  }
}
