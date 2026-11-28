import {
  DESKTOP_QUALITY_PRESETS,
  QUALITY_PRESETS,
  decodeMediaFrame,
  isWireMessage,
  normalizeControlCode,
  type ChatMessage,
  type ClipboardSyncMessage,
  type ControlAckMessage,
  type ControlCommand,
  type CursorShape,
  type CursorUpdateMessage,
  type DeviceSummary,
  type ErrorMessage,
  type IceServerConfig,
  type MediaFrame,
  type SessionPendingMessage,
  type SessionPermissions,
  type SessionPermissionsMessage,
  type SessionReadyMessage,
  type StreamQuality,
  type TransportMode,
  type UserProfile,
  type VideoCodecPreference,
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
  targetDir?: string;
}

export type DesktopQualityPreset = "auto" | "eco" | "balanced" | "hd" | "ultra";

export interface RemoteFsRoot {
  name: string;
  path: string;
  kind: "home" | "desktop" | "downloads" | "documents" | "drive";
}

export interface RemoteFsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface RemoteFsListResult {
  path: string;
  parentPath: string | null;
  entries: RemoteFsEntry[];
}

export interface RemoteFsDownloadState {
  active: boolean;
  reqId: string | null;
  fileName: string;
  receivedBytes: number;
  totalBytes: number;
  error: string | null;
}

export interface RemoteFsDownloadResult {
  blob: Blob;
  fileName: string;
  sha256: string;
}

export type TerminalEvent =
  | { type: "term_ready"; termId: string; shell: string; cwd: string }
  | { type: "term_data"; termId: string; data: string }
  | { type: "term_exit"; termId: string; exitCode: number }
  | { type: "term_error"; termId: string; error: string };

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
  desktopQuality: StreamQuality | null;
  dataChannelOpen: boolean;
  fileChannelOpen: boolean;
  terminalReady: boolean;
  remoteCursorShape: CursorShape;
  remoteCursorVisible: boolean;
  chatMessages: ChatMessage[];
  unreadChatCount: number;
  pendingApprovalMessage: string | null;
  sessionPermissions: SessionPermissions | null;
  fileTransfer: FileTransferState | null;
  fileDownload: RemoteFsDownloadState;
  mediaStream: MediaStream | null;
  hasRemoteAudio: boolean;
  screenWidth: number;
  screenHeight: number;
  rotation: 0 | 1 | 2 | 3;
  remoteClipboard: string;
  lastClipboardAt: number;
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
type TerminalListener = (ev: TerminalEvent) => void;

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
const WS_JPEG_AUTO_COOLDOWN_MS = 10_000;
const WS_JPEG_AUTO_STEP_DOWN_RTT_MS = 220;
const WS_JPEG_AUTO_STEP_UP_RTT_MS = 100;
const WS_JPEG_AUTO_CONGESTED_STREAK = 2;
const WS_JPEG_AUTO_HEALTHY_STREAK = 3;
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
const FS_RPC_TIMEOUT_MS = 10_000;
const FS_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const FS_DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024;
const MAX_CHAT_MESSAGES = 100;
const MAX_CHAT_TEXT_LENGTH = 1000;
const VALID_CURSOR_SHAPES = new Set<CursorShape>([
  "default",
  "pointer",
  "text",
  "crosshair",
  "move",
  "ew-resize",
  "ns-resize",
  "nwse-resize",
  "nesw-resize",
  "grab",
  "grabbing",
  "not-allowed",
  "wait",
  "none",
]);

const EMPTY_FILE_DOWNLOAD_STATE: RemoteFsDownloadState = {
  active: false,
  reqId: null,
  fileName: "",
  receivedBytes: 0,
  totalBytes: 0,
  error: null,
};

interface PendingFsRequest {
  expectedType: string;
  resolve: (msg: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveRemoteDownload {
  reqId: string;
  filePath: string;
  fileName: string;
  mimeType: string;
  totalBytes: number;
  receivedBytes: number;
  started: boolean;
  chunks: Uint8Array[];
  lastProgressEmitAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  resolve: (result: RemoteFsDownloadResult) => void;
  reject: (err: Error) => void;
}

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

function createChatMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `chat-${crypto.randomUUID()}`;
  }
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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

function formatSessionEndMessage(reason?: string): string {
  switch (reason) {
    case "rejected_by_host":
      return "被控电脑拒绝了接入请求";
    case "host_busy":
      return "被控电脑当前已有活跃控制会话";
    default:
      return reason ? `会话已结束：${reason}` : "设备端已结束会话";
  }
}

function getRequestWsUrl(req: ConnectRequest): string {
  return req.kind === "token" ? req.profile.wsUrl : req.wsUrl;
}

/**
 * Strict DataChannel message allowlist guard (P1-10):
 * Only `control.ack`, `clipboard.sync`, `cursor.update`, and `chat.msg` matching
 * the active sessionId are allowed from WebRTC peer DataChannels.
 * All signaling/auth/status/session control messages are rejected.
 */
export function isAllowedDataChannelMessage(
  value: unknown,
  expectedSessionId: string | null,
): value is
  | ControlAckMessage
  | ClipboardSyncMessage
  | CursorUpdateMessage
  | ChatMessage {
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
  if (value.type === "cursor.update") {
    const candidate = value as Partial<CursorUpdateMessage>;
    return (
      typeof candidate.sessionId === "string" &&
      candidate.sessionId === expectedSessionId &&
      typeof candidate.deviceId === "string" &&
      typeof candidate.shape === "string" &&
      VALID_CURSOR_SHAPES.has(candidate.shape as CursorShape) &&
      (candidate.visible === undefined || typeof candidate.visible === "boolean")
    );
  }
  if (value.type === "chat.msg") {
    const candidate = value as Partial<ChatMessage>;
    return (
      typeof candidate.sessionId === "string" &&
      candidate.sessionId === expectedSessionId &&
      typeof candidate.deviceId === "string" &&
      typeof candidate.id === "string" &&
      candidate.id.length > 0 &&
      candidate.sender === "host" &&
      typeof candidate.text === "string" &&
      typeof candidate.ts === "number" &&
      Number.isFinite(candidate.ts)
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
  preferredCodec: VideoCodecPreference = "auto",
): T[] {
  const preferredBucket: T[] = [];
  const h264ConstrainedHighPm1: T[] = [];
  const h264ConstrainedHighOther: T[] = [];
  const h264ConstrainedBaselinePm1: T[] = [];
  const h264ConstrainedBaselineOther: T[] = [];
  const h264Other: T[] = [];
  const vp8: T[] = [];
  const rest: T[] = [];

  const matchesExplicitPreferred = (mime: string): boolean => {
    if (preferredCodec === "hevc") {
      return mime === "video/h265" || mime === "video/hevc";
    }
    if (preferredCodec === "av1") {
      return mime === "video/av1";
    }
    if (preferredCodec === "vp9") {
      return mime === "video/vp9";
    }
    return false;
  };

  for (const codec of codecs) {
    const mime = codec.mimeType.toLowerCase();
    if (matchesExplicitPreferred(mime)) {
      preferredBucket.push(codec);
    } else if (mime === "video/h264") {
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
    ...preferredBucket,
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
  private readonly terminalListeners = new Set<TerminalListener>();

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
  private terminalDataChannel: RTCDataChannel | null = null;
  private termSeq = 0;
  private activeTouchViaWs = false;
  private activeTouchFirstMovePending = false;
  private activeFileTransfer: ActiveFileTransfer | null = null;
  private fileTransferGeneration = 0;
  private fsReqSeq = 0;
  private pendingFsRequests = new Map<string, PendingFsRequest>();
  private activeFileDownload: ActiveRemoteDownload | null = null;
  private fileDownloadBinaryChain: Promise<void> = Promise.resolve();
  private customDesktopQuality: StreamQuality | null = null;
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
  private readonly pendingWolAcks = new Map<
    number,
    {
      relayDeviceId: string;
      finish: (result: { ok: boolean; message?: string }) => void;
    }
  >();
  private noticeSeq = 0;
  private frameTimestamps: number[] = [];
  private lastFpsEmitAt = 0;
  private wsJpegAutoTier: "balanced" | "eco" = "balanced";
  private wsJpegAutoCongestedCount = 0;
  private wsJpegAutoHealthyCount = 0;
  private wsJpegAutoLastAdjustAt = 0;

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
    qualityPreset: "auto",
    desktopQuality: null,
    dataChannelOpen: false,
    fileChannelOpen: false,
    terminalReady: false,
    remoteCursorShape: "default",
    remoteCursorVisible: true,
    chatMessages: [],
    unreadChatCount: 0,
    pendingApprovalMessage: null,
    sessionPermissions: null,
    fileTransfer: null,
    fileDownload: { ...EMPTY_FILE_DOWNLOAD_STATE },
    mediaStream: null,
    hasRemoteAudio: false,
    screenWidth: 1080,
    screenHeight: 2400,
    rotation: 0,
    remoteClipboard: "",
    lastClipboardAt: 0,
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

  onTerminalEvent(listener: TerminalListener): () => void {
    this.terminalListeners.add(listener);
    return () => {
      this.terminalListeners.delete(listener);
    };
  }

  openTerminal(cols = 100, rows = 30): string {
    const termDc = this.terminalDataChannel;
    if (!termDc || termDc.readyState !== "open") {
      return "";
    }
    const termId = `term-${Date.now().toString(36)}-${++this.termSeq}`;
    const safeCols = Math.max(20, Math.min(300, Math.round(cols || 100)));
    const safeRows = Math.max(5, Math.min(120, Math.round(rows || 30)));
    try {
      termDc.send(
        JSON.stringify({
          type: "term_open",
          termId,
          cols: safeCols,
          rows: safeRows,
        }),
      );
      return termId;
    } catch {
      return "";
    }
  }

  sendTerminalInput(termId: string, data: string): boolean {
    const termDc = this.terminalDataChannel;
    if (!termId || !termDc || termDc.readyState !== "open") {
      return false;
    }
    try {
      termDc.send(
        JSON.stringify({
          type: "term_data",
          termId,
          data,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  resizeTerminal(termId: string, cols: number, rows: number): boolean {
    const termDc = this.terminalDataChannel;
    if (!termId || !termDc || termDc.readyState !== "open") {
      return false;
    }
    const safeCols = Math.max(20, Math.min(300, Math.round(cols || 100)));
    const safeRows = Math.max(5, Math.min(120, Math.round(rows || 30)));
    try {
      termDc.send(
        JSON.stringify({
          type: "term_resize",
          termId,
          cols: safeCols,
          rows: safeRows,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  closeTerminal(termId: string): void {
    const termDc = this.terminalDataChannel;
    if (!termId || !termDc || termDc.readyState !== "open") {
      return;
    }
    try {
      termDc.send(
        JSON.stringify({
          type: "term_close",
          termId,
        }),
      );
    } catch {
      // Ignore send errors on closing channel
    }
  }

  sendChatMessage(text: string): boolean {
    const trimmed = text.trim().slice(0, MAX_CHAT_TEXT_LENGTH);
    if (!trimmed || !this.state.sessionId || !this.state.activeDeviceId) {
      return false;
    }
    const msg: ChatMessage = {
      type: "chat.msg",
      sessionId: this.state.sessionId,
      deviceId: this.state.activeDeviceId,
      id: createChatMessageId(),
      sender: "controller",
      senderName:
        this.state.user?.displayName ||
        this.state.user?.username ||
        getClientDisplayName(),
      text: trimmed,
      ts: Date.now(),
    };

    let sent = false;
    if (this.dataChannel && this.dataChannel.readyState === "open") {
      try {
        this.dataChannel.send(JSON.stringify(msg));
        sent = true;
      } catch {
        sent = false;
      }
    }
    if (!sent) {
      sent = this.sendJson(msg);
    }
    if (!sent) {
      return false;
    }

    const nextMessages = [...this.state.chatMessages, msg].slice(-MAX_CHAT_MESSAGES);
    this.setState({ chatMessages: nextMessages });
    return true;
  }

  markChatRead(): void {
    if (this.state.unreadChatCount !== 0) {
      this.setState({ unreadChatCount: 0 });
    }
  }

  sendWolRelay(
    relayDeviceId: string,
    macAddress: string,
    broadcastIp?: string,
  ): boolean {
    if (this.state.socketStatus !== "connected") {
      return false;
    }
    const cleanRelayId = relayDeviceId.trim();
    const cleanMac = macAddress.trim();
    if (!cleanRelayId || !cleanMac) {
      return false;
    }
    const cleanBroadcast = broadcastIp?.trim() || undefined;
    const command: ControlCommand = cleanBroadcast
      ? { action: "wol", macAddress: cleanMac, broadcastIp: cleanBroadcast }
      : { action: "wol", macAddress: cleanMac };
    return this.sendJson({
      type: "control.cmd",
      sessionId: "",
      deviceId: cleanRelayId,
      seq: ++this.cmdSeq,
      command,
    });
  }

  sendWolRelayWithAck(
    relayDeviceId: string,
    macAddress: string,
    broadcastIp?: string,
    timeoutMs = 4_000,
  ): Promise<{ ok: boolean; message?: string }> {
    if (this.state.socketStatus !== "connected") {
      return Promise.resolve({ ok: false, message: "中继连接未就绪" });
    }
    const cleanRelayId = relayDeviceId.trim();
    const cleanMac = macAddress.trim();
    if (!cleanRelayId || !cleanMac) {
      return Promise.resolve({ ok: false, message: "缺少中继设备或 MAC 地址" });
    }
    const cleanBroadcast = broadcastIp?.trim() || undefined;
    const command: ControlCommand = cleanBroadcast
      ? { action: "wol", macAddress: cleanMac, broadcastIp: cleanBroadcast }
      : { action: "wol", macAddress: cleanMac };
    const seq = ++this.cmdSeq;
    const sent = this.sendJson({
      type: "control.cmd",
      sessionId: "",
      deviceId: cleanRelayId,
      seq,
      command,
    });
    if (!sent) {
      return Promise.resolve({ ok: false, message: "发送 WOL 中继指令失败" });
    }

    const safeTimeoutMs = Math.max(200, Math.min(30_000, Math.round(timeoutMs)));
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = (result: { ok: boolean; message?: string }) => {
        if (settled) return;
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        this.pendingWolAcks.delete(seq);
        resolve(result);
      };

      this.pendingWolAcks.set(seq, { relayDeviceId: cleanRelayId, finish });
      timer = setTimeout(() => {
        finish({ ok: false, message: "等待 WOL 中继设备响应超时" });
      }, safeTimeoutMs);
    });
  }

  private abortPendingWolAcks(reason: string): void {
    if (this.pendingWolAcks.size === 0) return;
    const entries = Array.from(this.pendingWolAcks.values());
    this.pendingWolAcks.clear();
    for (const entry of entries) {
      entry.finish({ ok: false, message: reason });
    }
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
    this.customDesktopQuality = null;
    this.resetWsJpegAutoQuality();

    const desiredTransport =
      request.kind === "token"
        ? request.profile.preferredTransport
        : request.preferredTransport ?? detectDefaultTransport();
    const qualityPreset =
      request.kind === "token"
        ? request.profile.qualityPreset
        : request.qualityPreset ?? "auto";
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
      desktopQuality: null,
      dataChannelOpen: false,
      fileChannelOpen: false,
      terminalReady: false,
      remoteCursorShape: "default",
      remoteCursorVisible: true,
      chatMessages: [],
      unreadChatCount: 0,
      pendingApprovalMessage: null,
      sessionPermissions: null,
      fileTransfer: null,
      fileDownload: { ...EMPTY_FILE_DOWNLOAD_STATE },
      mediaStream: null,
      hasRemoteAudio: false,
      remoteClipboard: "",
      lastClipboardAt: 0,
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
    this.resetWsJpegAutoQuality();
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
      terminalReady: false,
      pendingApprovalMessage: null,
      sessionPermissions: null,
      mediaStream: null,
      hasRemoteAudio: false,
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
    this.abortPendingWolAcks("连接已断开");
    this.abortActiveFileTransferSilent();
    this.abortAllRemoteFsSilent("连接已断开");
    this.stopSession("client_disconnect");
    this.teardownSocket();
    this.webrtcDowngradedByAgent = false;
    this.webrtcDowngradedClientSide = false;
    this.customDesktopQuality = null;
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
      desktopQuality: null,
      dataChannelOpen: false,
      fileChannelOpen: false,
      terminalReady: false,
      remoteCursorShape: "default",
      remoteCursorVisible: true,
      chatMessages: [],
      unreadChatCount: 0,
      pendingApprovalMessage: null,
      sessionPermissions: null,
      fileTransfer: null,
      fileDownload: { ...EMPTY_FILE_DOWNLOAD_STATE },
      mediaStream: null,
      hasRemoteAudio: false,
      remoteClipboard: "",
      lastClipboardAt: 0,
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
      "auto";

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
    this.resetWsJpegAutoQuality();
    this.abortActiveFileTransferSilent();
    this.abortAllRemoteFsSilent("会话已切换");
    this.teardownPeerConnection();
    this.frameTimestamps = [];
    this.webrtcFallbackInFlight = false;
    this.webrtcDowngradedByAgent = false;

    const switchingDevice = this.state.activeDeviceId !== deviceId;
    const device = this.state.devices.find((d) => d.deviceId === deviceId);
    const isDesktop = device?.deviceType === "desktop";
    if (switchingDevice || !isDesktop) {
      this.customDesktopQuality = null;
    }
    const effectiveDesktopQuality = isDesktop
      ? (this.customDesktopQuality
          ? { ...this.customDesktopQuality }
          : { ...DESKTOP_QUALITY_PRESETS[qualityPreset] })
      : null;
    const sessionQuality: StreamQuality = effectiveDesktopQuality ?? QUALITY_PRESETS[qualityPreset];

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
      desktopQuality: effectiveDesktopQuality,
      fps: 0,
      mediaStream: null,
      hasRemoteAudio: false,
      dataChannelOpen: false,
      fileChannelOpen: false,
      terminalReady: false,
      remoteCursorShape: "default",
      remoteCursorVisible: true,
      chatMessages: [],
      unreadChatCount: 0,
      pendingApprovalMessage: null,
      sessionPermissions: null,
      fileTransfer: null,
      fileDownload: { ...EMPTY_FILE_DOWNLOAD_STATE },
      errorCode: null,
      errorMessage: null,
      remoteClipboard: "",
      lastClipboardAt: 0,
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
      quality: sessionQuality,
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
    this.abortAllRemoteFsSilent("会话已结束");
    this.teardownPeerConnection();
    this.frameTimestamps = [];
    this.webrtcFallbackInFlight = false;
    this.webrtcDowngradedByAgent = false;
    this.webrtcDowngradedClientSide = false;
    this.customDesktopQuality = null;
    this.resetWsJpegAutoQuality();
    this.setState({
      activeDeviceId: null,
      sessionId: null,
      sessionStatus: "idle",
      activeTransport: null,
      webrtcRoute: null,
      webrtcTelemetry: null,
      desktopQuality: null,
      fps: 0,
      mediaStream: null,
      hasRemoteAudio: false,
      dataChannelOpen: false,
      fileChannelOpen: false,
      terminalReady: false,
      remoteCursorShape: "default",
      remoteCursorVisible: true,
      chatMessages: [],
      unreadChatCount: 0,
      pendingApprovalMessage: null,
      sessionPermissions: null,
      fileTransfer: null,
      fileDownload: { ...EMPTY_FILE_DOWNLOAD_STATE },
      remoteClipboard: "",
      lastClipboardAt: 0,
    });
  }

  setQuality(preset: QualityPreset): void {
    const activeDevice = this.state.devices.find(
      (d) => d.deviceId === this.state.activeDeviceId,
    );
    const isDesktop = activeDevice?.deviceType === "desktop";
    const quality: StreamQuality = isDesktop
      ? {
          ...DESKTOP_QUALITY_PRESETS[preset],
          ...(this.customDesktopQuality?.codec
            ? { codec: this.customDesktopQuality.codec }
            : {}),
        }
      : QUALITY_PRESETS[preset];
    this.resetWsJpegAutoQuality();
    if (isDesktop) {
      this.customDesktopQuality = { ...quality };
      this.setState({ qualityPreset: preset, desktopQuality: { ...quality } });
    } else {
      this.setState({ qualityPreset: preset });
    }
    if (this.state.activeDeviceId && this.state.sessionId) {
      this.sendCommand({ action: "quality", quality });
      this.pushNotice(
        "info",
        preset === "auto"
          ? "画质已切换为 智能自适应（根据实时网速自动调节）"
          : `画质已切换为 ${preset.toUpperCase()} (${quality.maxWidth}p · ${quality.fps}fps)`,
      );
    }
  }

  setDesktopStreamQuality(
    quality: StreamQuality,
    presetHint?: DesktopQualityPreset,
  ): void {
    const cleanQuality: StreamQuality = { ...quality };
    this.customDesktopQuality = cleanQuality;
    this.resetWsJpegAutoQuality();

    const nextPreset: QualityPreset =
      presetHint === "auto" ||
      presetHint === "eco" ||
      presetHint === "balanced" ||
      presetHint === "hd"
        ? presetHint
        : presetHint === "ultra"
          ? "hd"
          : this.state.qualityPreset;

    this.setState({
      qualityPreset: nextPreset,
      desktopQuality: { ...cleanQuality },
    });

    if (this.state.activeDeviceId && this.state.sessionId) {
      this.sendCommand({ action: "quality", quality: cleanQuality });
      const codecNote =
        cleanQuality.codec && cleanQuality.codec !== "auto"
          ? ` · ${cleanQuality.codec.toUpperCase()}`
          : "";
      const resLabel =
        cleanQuality.maxWidth >= 3840
          ? "4K"
          : cleanQuality.maxWidth >= 2560
            ? "2K"
            : cleanQuality.maxWidth >= 1920
              ? "1080p"
              : "720p";
      this.pushNotice(
        "info",
        cleanQuality.auto
          ? `桌面画质已设为智能自适应（最高 ${cleanQuality.fps}fps${codecNote}）`
          : `桌面画质已切换为 ${resLabel} · ${cleanQuality.fps}fps${codecNote}`,
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
    const isMouseMove = command.action === "mouse_move";
    const isMouseMoveRelative = command.action === "mouse_move_relative";
    const isMouseWheel = command.action === "mouse_wheel";
    const isPointerChannelCommand =
      isTouchMove || isMouseMove || isMouseMoveRelative || isMouseWheel;

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

    // Route high-frequency unreliable pointer commands (steady-state touch_move, mouse_move,
    // mouse_move_relative, mouse_wheel) over the partially-reliable, in-order "pointer" DataChannel
    // (ordered: true, maxRetransmits: 0) to avoid HoL retransmit stalls without backward jumps.
    // State-critical commands (mouse_down, mouse_up, key_event, select_display, block_input,
    // whiteboard, wol, tap, long_press, text, clipboard_set) ALWAYS bypass this branch and use
    // the reliable "control" DataChannel (or WebSocket fallback) so state changes are never dropped.
    if (
      isPointerChannelCommand &&
      !(isTouchMove && (pinTouchToWs || routeFirstMoveOnControlDc)) &&
      isCurrentSessionDevice &&
      this.pointerDataChannel &&
      this.pointerDataChannel.readyState === "open"
    ) {
      const buffered =
        typeof this.pointerDataChannel.bufferedAmount === "number"
          ? this.pointerDataChannel.bufferedAmount
          : 0;
      if (buffered > POINTER_DC_MAX_BUFFERED_BYTES) {
        if (isTouchMove || isMouseMove || isMouseMoveRelative) {
          return { sent: false, seq, channel: "none" };
        }
      } else {
        try {
          this.pointerDataChannel.send(payload);
          this.lastCommandSentAt = Date.now();
          return { sent: true, seq, channel: "datachannel" };
        } catch {
          // Fall through to ordered control DataChannel / WebSocket
        }
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
        "WebRTC P2P 文件通道未就绪（请确保处于 WebRTC 模式且手机端已升级至最新版 Agent）";
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
      const targetDir = options.targetDir?.trim();
      fileDc.send(
        JSON.stringify({
          type: "file.offer",
          transferId,
          fileName,
          size: totalBytes,
          mimeType,
          sha256,
          purpose,
          ...(targetDir ? { targetDir } : {}),
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
      return finishError("等待手机端确认超时（请确认手机端已升级至最新版 Agent）");
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
      const targetDevice = this.state.devices.find(
        (d) => d.deviceId === this.state.activeDeviceId,
      );
      const isDesktopTarget = targetDevice?.deviceType === "desktop";
      this.pushNotice(
        needsInstallPermission ? "warn" : "info",
        purpose === "apk_install"
          ? finalMessage
          : `文件「${fileName}」已传至${isDesktopTarget ? "远端电脑" : "手机"}`,
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

  private createFsReqId(): string {
    this.fsReqSeq += 1;
    return `fs-${Date.now().toString(36)}-${this.fsReqSeq}`;
  }

  private sendFsRpc(
    payload: Record<string, unknown>,
    expectedType: string,
    timeoutLabel: string,
  ): Promise<Record<string, unknown>> {
    const fileDc = this.fileDataChannel;
    if (!fileDc || fileDc.readyState !== "open") {
      return Promise.reject(
        new Error("WebRTC P2P 文件通道未就绪（请确保处于 WebRTC 模式）"),
      );
    }

    const reqId = this.createFsReqId();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingFsRequests.delete(reqId);
        reject(new Error(timeoutLabel));
      }, FS_RPC_TIMEOUT_MS);

      this.pendingFsRequests.set(reqId, {
        expectedType,
        resolve,
        reject,
        timer,
      });

      try {
        fileDc.send(JSON.stringify({ ...payload, reqId }));
      } catch {
        clearTimeout(timer);
        this.pendingFsRequests.delete(reqId);
        reject(new Error("发送远端文件请求失败，连接可能已断开"));
      }
    });
  }

  async listRemoteFsRoots(): Promise<RemoteFsRoot[]> {
    const res = await this.sendFsRpc(
      { type: "fs_roots_req" },
      "fs_roots_res",
      "获取远端快捷目录超时",
    );
    if (typeof res.error === "string" && res.error.trim().length > 0) {
      throw new Error(res.error.trim());
    }
    const rawRoots = Array.isArray(res.roots) ? res.roots : [];
    const validKinds = new Set<RemoteFsRoot["kind"]>([
      "home",
      "desktop",
      "downloads",
      "documents",
      "drive",
    ]);
    const roots: RemoteFsRoot[] = [];
    for (const item of rawRoots) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.name !== "string" || typeof rec.path !== "string") continue;
      const rawKind = typeof rec.kind === "string" ? rec.kind : "drive";
      const kind: RemoteFsRoot["kind"] = validKinds.has(rawKind as RemoteFsRoot["kind"])
        ? (rawKind as RemoteFsRoot["kind"])
        : "drive";
      roots.push({ name: rec.name, path: rec.path, kind });
    }
    return roots;
  }

  async listRemoteFsDir(dirPath: string): Promise<RemoteFsListResult> {
    const res = await this.sendFsRpc(
      { type: "fs_list_req", path: dirPath },
      "fs_list_res",
      "读取远端目录内容超时",
    );
    if (typeof res.error === "string" && res.error.trim().length > 0) {
      throw new Error(res.error.trim());
    }
    const resolvedPath = typeof res.path === "string" ? res.path : dirPath;
    const parentPath =
      typeof res.parentPath === "string" && res.parentPath.length > 0
        ? res.parentPath
        : null;
    const rawEntries = Array.isArray(res.entries) ? res.entries : [];
    const entries: RemoteFsEntry[] = [];
    for (const item of rawEntries) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.name !== "string" || typeof rec.path !== "string") continue;
      entries.push({
        name: rec.name,
        path: rec.path,
        isDir: Boolean(rec.isDir),
        size:
          typeof rec.size === "number" && Number.isFinite(rec.size)
            ? Math.max(0, Math.floor(rec.size))
            : 0,
        mtimeMs:
          typeof rec.mtimeMs === "number" && Number.isFinite(rec.mtimeMs)
            ? Math.round(rec.mtimeMs)
            : 0,
      });
    }
    return { path: resolvedPath, parentPath, entries };
  }

  async mkdirRemoteFs(
    parentPath: string,
    name: string,
  ): Promise<{ ok: boolean; createdPath?: string; error?: string }> {
    const res = await this.sendFsRpc(
      { type: "fs_mkdir_req", parentPath, name },
      "fs_mkdir_res",
      "新建远端文件夹超时",
    );
    return {
      ok: Boolean(res.ok),
      createdPath: typeof res.createdPath === "string" ? res.createdPath : undefined,
      error: typeof res.error === "string" ? res.error : undefined,
    };
  }

  async deleteRemoteFs(
    targetPath: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const res = await this.sendFsRpc(
      { type: "fs_delete_req", targetPath },
      "fs_delete_res",
      "删除远端文件超时",
    );
    return {
      ok: Boolean(res.ok),
      error: typeof res.error === "string" ? res.error : undefined,
    };
  }

  downloadRemoteFile(filePath: string): Promise<RemoteFsDownloadResult> {
    if (this.activeFileDownload) {
      return Promise.reject(new Error("已有远端文件正在下载，请等待完成或取消后再试"));
    }
    const fileDc = this.fileDataChannel;
    if (!fileDc || fileDc.readyState !== "open") {
      return Promise.reject(
        new Error("WebRTC P2P 文件通道未就绪（请确保处于 WebRTC 模式）"),
      );
    }

    const reqId = this.createFsReqId();
    const fallbackName =
      filePath.split(/[/\\]/).filter(Boolean).pop() || "download.bin";

    return new Promise<RemoteFsDownloadResult>((resolve, reject) => {
      const download: ActiveRemoteDownload = {
        reqId,
        filePath,
        fileName: fallbackName,
        mimeType: "application/octet-stream",
        totalBytes: 0,
        receivedBytes: 0,
        started: false,
        chunks: [],
        lastProgressEmitAt: Date.now(),
        idleTimer: null,
        resolve,
        reject,
      };
      this.activeFileDownload = download;
      this.fileDownloadBinaryChain = Promise.resolve();
      this.resetRemoteDownloadIdleTimer(download);

      this.setState({
        fileDownload: {
          active: true,
          reqId,
          fileName: fallbackName,
          receivedBytes: 0,
          totalBytes: 0,
          error: null,
        },
      });

      try {
        fileDc.send(
          JSON.stringify({
            type: "fs_download_req",
            reqId,
            filePath,
          }),
        );
      } catch {
        this.failActiveRemoteDownload("发送远端文件下载请求失败");
      }
    });
  }

  cancelRemoteFileDownload(): void {
    const active = this.activeFileDownload;
    if (!active) return;

    if (active.idleTimer !== null) {
      clearTimeout(active.idleTimer);
      active.idleTimer = null;
    }
    this.activeFileDownload = null;
    active.chunks = [];

    if (this.fileDataChannel?.readyState === "open") {
      try {
        this.fileDataChannel.send(
          JSON.stringify({
            type: "fs_download_cancel",
            reqId: active.reqId,
          }),
        );
      } catch {
        // Ignore send errors while cancelling
      }
    }

    this.setState({
      fileDownload: {
        active: false,
        reqId: null,
        fileName: active.fileName,
        receivedBytes: active.receivedBytes,
        totalBytes: active.totalBytes,
        error: "已取消下载",
      },
    });
    active.reject(new Error("已取消下载"));
  }

  clearRemoteFileDownload(): void {
    if (this.activeFileDownload) return;
    const curr = this.state.fileDownload;
    if (curr.active || curr.fileName || curr.error || curr.receivedBytes > 0) {
      this.setState({ fileDownload: { ...EMPTY_FILE_DOWNLOAD_STATE } });
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
      this.ws = null;

      if (this.intentionalDisconnect) {
        this.teardownPeerConnection();
        return;
      }

      if (this.state.socketStatus === "error") {
        this.teardownPeerConnection();
        return;
      }

      if (event.code === 4001) {
        const readable = mapServerErrorMessage(
          "UNAUTHORIZED",
          event.reason || "",
          request.kind,
        );
        this.intentionalDisconnect = true;
        this.clearReconnectTimer();
        this.detachBrowserListeners();
        this.abortPendingWolAcks(readable);
        this.abortActiveFileTransferSilent();
        this.abortAllRemoteFsSilent(readable);
        this.teardownPeerConnection();
        this.setState({
          socketStatus: "error",
          errorCode: "UNAUTHORIZED",
          errorMessage: readable,
          pendingApprovalMessage: null,
          sessionPermissions: null,
        });
        return;
      }

      if (event.code === 4003) {
        const readable = event.reason
          ? `连接被设备拒绝（来源不受信任）：${event.reason}`
          : "连接被设备拒绝：当前网页来源不在允许范围内 (FORBIDDEN_ORIGIN)";
        this.intentionalDisconnect = true;
        this.clearReconnectTimer();
        this.detachBrowserListeners();
        this.abortPendingWolAcks(readable);
        this.abortActiveFileTransferSilent();
        this.abortAllRemoteFsSilent(readable);
        this.teardownPeerConnection();
        this.setState({
          socketStatus: "error",
          errorCode: "UNAUTHORIZED",
          errorMessage: readable,
          pendingApprovalMessage: null,
          sessionPermissions: null,
        });
        return;
      }

      if (event.code === 4029) {
        const readable = mapServerErrorMessage(
          "RATE_LIMITED",
          event.reason || "",
          request.kind,
        );
        this.intentionalDisconnect = true;
        this.clearReconnectTimer();
        this.detachBrowserListeners();
        this.abortPendingWolAcks(readable);
        this.abortActiveFileTransferSilent();
        this.abortAllRemoteFsSilent(readable);
        this.teardownPeerConnection();
        this.setState({
          socketStatus: "error",
          errorCode: "RATE_LIMITED",
          errorMessage: readable,
          pendingApprovalMessage: null,
          sessionPermissions: null,
        });
        return;
      }

      this.abortPendingWolAcks("连接已断开");
      this.teardownPeerConnection();
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
      terminalReady: false,
      pendingApprovalMessage: null,
      sessionPermissions: null,
      mediaStream: null,
      hasRemoteAudio: false,
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
          this.evaluateWsJpegAutoQuality(rtt);
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
              sessionId: null,
              sessionStatus: "error",
              pendingApprovalMessage: null,
              sessionPermissions: null,
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
            hasRemoteAudio: false,
            dataChannelOpen: false,
            fileChannelOpen: false,
            terminalReady: false,
            pendingApprovalMessage: null,
            sessionPermissions: null,
            remoteCursorShape: "default",
            remoteCursorVisible: true,
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
          hasRemoteAudio: false,
          dataChannelOpen: false,
          fileChannelOpen: false,
          terminalReady: false,
          pendingApprovalMessage: null,
          sessionPermissions: null,
          remoteCursorShape: "default",
          remoteCursorVisible: true,
          fps: 0,
          errorMessage: formatSessionEndMessage(parsed.reason),
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

      case "cursor.update": {
        this.handleCursorUpdate(parsed);
        break;
      }

      case "chat.msg": {
        this.handleChatMessage(parsed);
        break;
      }

      case "session.pending": {
        this.handleSessionPending(parsed);
        break;
      }

      case "session.permissions": {
        this.handleSessionPermissions(parsed);
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
          this.detachBrowserListeners();
          this.abortPendingWolAcks(readable);
          this.abortActiveFileTransferSilent();
          this.abortAllRemoteFsSilent(readable);
          this.teardownPeerConnection();
          this.setState({
            socketStatus: "error",
            errorCode: parsed.code,
            errorMessage: readable,
            pendingApprovalMessage: null,
            sessionPermissions: null,
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
              hasRemoteAudio: false,
              dataChannelOpen: false,
              fileChannelOpen: false,
              terminalReady: false,
              pendingApprovalMessage: null,
              sessionPermissions: null,
              remoteCursorShape: "default",
              remoteCursorVisible: true,
              fps: 0,
              errorCode: parsed.code,
              errorMessage: readable,
            });
          } else {
            this.setState({
              sessionStatus: "error",
              pendingApprovalMessage: null,
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
            hasRemoteAudio: false,
            dataChannelOpen: false,
            fileChannelOpen: false,
            terminalReady: false,
            pendingApprovalMessage: null,
            sessionPermissions: null,
            remoteCursorShape: "default",
            remoteCursorVisible: true,
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
    let handledByWolAck = false;
    if (typeof msg.seq === "number") {
      const pendingWol = this.pendingWolAcks.get(msg.seq);
      if (pendingWol && pendingWol.relayDeviceId === msg.deviceId) {
        handledByWolAck = true;
        pendingWol.finish({ ok: msg.ok, message: msg.message });
      }
    }
    for (const listener of this.ackListeners) {
      listener(msg);
    }
    if (!handledByWolAck && !msg.ok && msg.message) {
      this.pushNotice("warn", msg.message);
    }
  }

  private handleClipboardSync(msg: ClipboardSyncMessage): void {
    this.setState({
      remoteClipboard: msg.text,
      lastClipboardAt: Date.now(),
    });
    for (const listener of this.clipboardListeners) {
      listener(msg);
    }
    const target = this.state.devices.find(
      (d) => d.deviceId === this.state.activeDeviceId,
    );
    if (target?.deviceType !== "desktop") {
      this.pushNotice("info", "已同步远端剪贴板内容");
    }
  }

  private handleCursorUpdate(msg: CursorUpdateMessage): void {
    if (!this.state.sessionId || msg.sessionId !== this.state.sessionId) {
      return;
    }
    if (!VALID_CURSOR_SHAPES.has(msg.shape)) {
      return;
    }
    const nextVisible = msg.visible !== false;
    if (
      this.state.remoteCursorShape === msg.shape &&
      this.state.remoteCursorVisible === nextVisible
    ) {
      return;
    }
    this.setState({
      remoteCursorShape: msg.shape,
      remoteCursorVisible: nextVisible,
    });
  }

  private handleChatMessage(msg: ChatMessage): void {
    if (!this.state.sessionId || msg.sessionId !== this.state.sessionId) {
      return;
    }
    if (this.state.chatMessages.some((item) => item.id === msg.id)) {
      return;
    }
    const nextMessages = [...this.state.chatMessages, msg].slice(-MAX_CHAT_MESSAGES);
    const nextUnread =
      msg.sender === "host"
        ? this.state.unreadChatCount + 1
        : this.state.unreadChatCount;
    this.setState({
      chatMessages: nextMessages,
      unreadChatCount: nextUnread,
    });
  }

  private handleSessionPending(msg: SessionPendingMessage): void {
    if (!this.state.sessionId || msg.sessionId !== this.state.sessionId) {
      return;
    }
    // Pause any active WebRTC negotiation fallback timer while waiting for human approval
    this.clearWebRtcFallbackTimer();
    this.setState({
      pendingApprovalMessage:
        msg.message?.trim() || "等待被控电脑确认接入...",
      errorCode: null,
      errorMessage: null,
    });
  }

  private handleSessionPermissions(msg: SessionPermissionsMessage): void {
    if (!this.state.sessionId || msg.sessionId !== this.state.sessionId) {
      return;
    }
    this.setState({
      sessionPermissions: msg.permissions ? { ...msg.permissions } : null,
    });
  }

  private handleTerminalChannelMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const msg = parsed as Record<string, unknown>;
    const type = typeof msg.type === "string" ? msg.type : "";
    const termId = typeof msg.termId === "string" ? msg.termId : "";

    let ev: TerminalEvent | null = null;
    if (type === "term_ready") {
      ev = {
        type: "term_ready",
        termId,
        shell: typeof msg.shell === "string" ? msg.shell : "",
        cwd: typeof msg.cwd === "string" ? msg.cwd : "",
      };
    } else if (type === "term_data") {
      if (typeof msg.data !== "string") return;
      ev = {
        type: "term_data",
        termId,
        data: msg.data,
      };
    } else if (type === "term_exit") {
      ev = {
        type: "term_exit",
        termId,
        exitCode:
          typeof msg.exitCode === "number" && Number.isFinite(msg.exitCode)
            ? Math.round(msg.exitCode)
            : -1,
      };
    } else if (type === "term_error") {
      ev = {
        type: "term_error",
        termId,
        error:
          typeof msg.error === "string" && msg.error.trim().length > 0
            ? msg.error.trim()
            : "远程终端发生异常",
      };
    }

    if (!ev) return;
    for (const listener of this.terminalListeners) {
      listener(ev);
    }
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
    } else if (parsed.type === "cursor.update") {
      this.handleCursorUpdate(parsed);
    } else if (parsed.type === "chat.msg") {
      this.handleChatMessage(parsed);
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
      pendingApprovalMessage: null,
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
    this.resetWsJpegAutoQuality();
    this.setState({
      ...basePatch,
      activeTransport: "ws-jpeg",
      webrtcRoute: null,
      webrtcTelemetry: null,
      sessionStatus: "streaming",
      mediaStream: null,
      hasRemoteAudio: false,
      dataChannelOpen: false,
      fileChannelOpen: false,
      terminalReady: false,
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

    const targetDevice = this.state.devices.find((d) => d.deviceId === deviceId);
    const isDesktopTarget = targetDevice?.deviceType === "desktop";
    const preferredCodec: VideoCodecPreference = isDesktopTarget
      ? (this.customDesktopQuality?.codec ?? this.state.desktopQuality?.codec ?? "auto")
      : "auto";

    const videoTransceiver = pc.addTransceiver("video", { direction: "recvonly" });
    if (isDesktopTarget) {
      try {
        pc.addTransceiver("audio", { direction: "recvonly" });
      } catch {
        // Ignore if environment does not support audio recvonly transceiver
      }
    }
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
        // Prioritize user-selected desktop codec (or H.264 Constrained High/Baseline in auto mode),
        // then remaining H.264, then VP8, then remaining codecs.
        const ordered = sortPreferredVideoCodecs(capabilities.codecs, preferredCodec);
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
      pointerDc.onmessage = (event) => {
        if (this.pc !== pc) return;
        if (typeof event.data === "string") {
          this.handleDataChannelMessage(event.data);
        }
      };
    } catch {
      this.pointerDataChannel = null;
    }

    if (isDesktopTarget) {
      try {
        const termDc = pc.createDataChannel("terminal", { ordered: true });
        this.terminalDataChannel = termDc;
        termDc.onopen = () => {
          if (this.pc !== pc) return;
          this.setState({ terminalReady: true });
        };
        termDc.onclose = () => {
          if (this.pc !== pc) return;
          this.setState({ terminalReady: false });
        };
        termDc.onmessage = (event) => {
          if (this.pc !== pc) return;
          if (typeof event.data === "string") {
            this.handleTerminalChannelMessage(event.data);
          }
        };
      } catch {
        this.terminalDataChannel = null;
      }
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
        this.failAllPendingFsRequests("WebRTC 文件通道已断开");
        this.failActiveRemoteDownload("WebRTC 文件通道已断开");
      };
      fileDc.onmessage = (event) => {
        if (this.pc !== pc) return;
        const payload = event.data;
        if (typeof payload === "string") {
          this.handleFileChannelMessage(payload);
        } else if (payload instanceof ArrayBuffer) {
          this.handleFileChannelBinary(new Uint8Array(payload));
        } else if (ArrayBuffer.isView(payload)) {
          this.handleFileChannelBinary(
            new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
          );
        } else if (typeof Blob !== "undefined" && payload instanceof Blob) {
          this.fileDownloadBinaryChain = this.fileDownloadBinaryChain
            .then(async () => {
              const buf = await payload.arrayBuffer();
              if (this.pc === pc) {
                this.handleFileChannelBinary(new Uint8Array(buf));
              }
            })
            .catch(() => undefined);
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

      const existingStream = event.streams?.[0];
      let stream: MediaStream;
      if (existingStream) {
        stream = existingStream;
        const prev = this.state.mediaStream;
        if (
          prev &&
          prev !== existingStream &&
          typeof prev.getTracks === "function" &&
          typeof existingStream.getTracks === "function" &&
          typeof existingStream.addTrack === "function"
        ) {
          const existingIds = new Set(existingStream.getTracks().map((t) => t.id));
          for (const prevTrack of prev.getTracks()) {
            if (!existingIds.has(prevTrack.id)) {
              existingStream.addTrack(prevTrack);
            }
          }
        }
      } else if (
        this.state.mediaStream &&
        typeof this.state.mediaStream.addTrack === "function" &&
        event.track
      ) {
        stream = this.state.mediaStream;
        const existingIds =
          typeof stream.getTracks === "function"
            ? new Set(stream.getTracks().map((t) => t.id))
            : new Set<string>();
        if (!existingIds.has(event.track.id)) {
          stream.addTrack(event.track);
        }
      } else {
        stream = new MediaStream(event.track ? [event.track] : []);
      }

      const audioTracksCount =
        typeof stream.getAudioTracks === "function"
          ? stream.getAudioTracks().length
          : event.track?.kind === "audio"
            ? 1
            : 0;

      // P0-2: Only attach mediaStream here; keep sessionStatus = "negotiating" until ICE connects
      this.setState({
        mediaStream: stream,
        hasRemoteAudio: audioTracksCount > 0,
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
    this.resetWsJpegAutoQuality();

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
    const fallbackDevice = this.state.devices.find((d) => d.deviceId === deviceId);
    const fallbackQuality: StreamQuality =
      fallbackDevice?.deviceType === "desktop"
        ? (this.customDesktopQuality
            ? { ...this.customDesktopQuality }
            : { ...DESKTOP_QUALITY_PRESETS[this.state.qualityPreset] })
        : QUALITY_PRESETS[this.state.qualityPreset];
    this.setState({
      sessionId: nextSessionId,
      sessionStatus: "fallback",
      activeTransport: "ws-jpeg",
      webrtcRoute: null,
      webrtcTelemetry: null,
      mediaStream: null,
      hasRemoteAudio: false,
      dataChannelOpen: false,
      fileChannelOpen: false,
      terminalReady: false,
      pendingApprovalMessage: null,
      sessionPermissions: null,
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
        quality: fallbackQuality,
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
    this.failAllPendingFsRequests("WebRTC 连接已断开");
    this.failActiveRemoteDownload("WebRTC 连接已断开");

    if (this.terminalDataChannel) {
      try {
        this.terminalDataChannel.onopen = null;
        this.terminalDataChannel.onclose = null;
        this.terminalDataChannel.onmessage = null;
        this.terminalDataChannel.close();
      } catch {
        // Ignore
      }
      this.terminalDataChannel = null;
    }

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
    if (this.state.terminalReady) {
      teardownPatch.terminalReady = false;
    }
    if (this.state.hasRemoteAudio) {
      teardownPatch.hasRemoteAudio = false;
    }
    if (Object.keys(teardownPatch).length > 0) {
      this.setState(teardownPatch);
    }
  }

  private resetRemoteDownloadIdleTimer(download: ActiveRemoteDownload): void {
    if (download.idleTimer !== null) {
      clearTimeout(download.idleTimer);
    }
    download.idleTimer = setTimeout(() => {
      if (this.activeFileDownload === download) {
        this.failActiveRemoteDownload("远端文件下载超时");
      }
    }, FS_DOWNLOAD_IDLE_TIMEOUT_MS);
  }

  private handleFileChannelBinary(chunk: Uint8Array): void {
    const active = this.activeFileDownload;
    if (!active) return;

    if (chunk.byteLength === 0) return;

    if (active.receivedBytes + chunk.byteLength > FS_DOWNLOAD_MAX_BYTES) {
      this.failActiveRemoteDownload("下载文件超过 256 MB 大小限制");
      return;
    }

    const copy = new Uint8Array(chunk.byteLength);
    copy.set(chunk);
    active.chunks.push(copy);
    active.receivedBytes += copy.byteLength;
    this.resetRemoteDownloadIdleTimer(active);

    const now = Date.now();
    if (
      now - active.lastProgressEmitAt >= FILE_PROGRESS_THROTTLE_MS ||
      (active.totalBytes > 0 && active.receivedBytes >= active.totalBytes)
    ) {
      active.lastProgressEmitAt = now;
      this.setState({
        fileDownload: {
          active: true,
          reqId: active.reqId,
          fileName: active.fileName,
          receivedBytes: active.receivedBytes,
          totalBytes: active.totalBytes,
          error: null,
        },
      });
    }
  }

  private async finalizeRemoteDownload(
    active: ActiveRemoteDownload,
    expectedSha256: string,
    expectedSize: number | null,
  ): Promise<void> {
    try {
      await this.fileDownloadBinaryChain;
    } catch {
      // Ignore prior chain errors
    }

    const totalLen = active.receivedBytes;
    if (expectedSize !== null && expectedSize >= 0 && totalLen !== expectedSize) {
      const msg = `下载字节数不匹配（预期 ${expectedSize}，实际 ${totalLen}）`;
      this.setState({
        fileDownload: {
          active: false,
          reqId: null,
          fileName: active.fileName,
          receivedBytes: totalLen,
          totalBytes: expectedSize,
          error: msg,
        },
      });
      active.reject(new Error(msg));
      return;
    }

    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of active.chunks) {
      merged.set(part, offset);
      offset += part.byteLength;
    }
    active.chunks = [];

    const actualSha = await computeSha256Hex(merged);
    const normalizedExpected = expectedSha256.trim().toLowerCase();
    if (
      normalizedExpected.length === 64 &&
      actualSha !== normalizedExpected
    ) {
      const msg = "远端文件下载校验失败（SHA-256 不匹配）";
      this.setState({
        fileDownload: {
          active: false,
          reqId: null,
          fileName: active.fileName,
          receivedBytes: totalLen,
          totalBytes: active.totalBytes || totalLen,
          error: msg,
        },
      });
      active.reject(new Error(msg));
      return;
    }

    const blob = new Blob([merged as BlobPart], {
      type: active.mimeType || "application/octet-stream",
    });
    this.setState({
      fileDownload: {
        active: false,
        reqId: null,
        fileName: active.fileName,
        receivedBytes: totalLen,
        totalBytes: totalLen,
        error: null,
      },
    });
    active.resolve({
      blob,
      fileName: active.fileName,
      sha256: actualSha,
    });
  }

  private failAllPendingFsRequests(reason: string): void {
    if (this.pendingFsRequests.size === 0) return;
    const entries = Array.from(this.pendingFsRequests.values());
    this.pendingFsRequests.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
  }

  private failActiveRemoteDownload(reason: string): void {
    const active = this.activeFileDownload;
    if (!active) return;
    if (active.idleTimer !== null) {
      clearTimeout(active.idleTimer);
      active.idleTimer = null;
    }
    this.activeFileDownload = null;
    active.chunks = [];
    this.setState({
      fileDownload: {
        active: false,
        reqId: null,
        fileName: active.fileName,
        receivedBytes: active.receivedBytes,
        totalBytes: active.totalBytes,
        error: reason,
      },
    });
    active.reject(new Error(reason));
  }

  private abortAllRemoteFsSilent(reason: string): void {
    this.failAllPendingFsRequests(reason);
    const active = this.activeFileDownload;
    if (active) {
      if (active.idleTimer !== null) {
        clearTimeout(active.idleTimer);
        active.idleTimer = null;
      }
      this.activeFileDownload = null;
      active.chunks = [];
      active.reject(new Error(reason));
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

    // 1. Handle Remote File Manager RPC responses (fs_roots_res / fs_list_res / fs_mkdir_res / fs_delete_res / fs_error)
    if (
      type === "fs_roots_res" ||
      type === "fs_list_res" ||
      type === "fs_mkdir_res" ||
      type === "fs_delete_res"
    ) {
      const reqId = typeof msg.reqId === "string" ? msg.reqId : "";
      const pending = reqId ? this.pendingFsRequests.get(reqId) : undefined;
      if (pending && pending.expectedType === type) {
        clearTimeout(pending.timer);
        this.pendingFsRequests.delete(reqId);
        pending.resolve(msg);
      }
      return;
    }
    if (type === "fs_error") {
      const reqId = typeof msg.reqId === "string" ? msg.reqId : "";
      const pending = reqId ? this.pendingFsRequests.get(reqId) : undefined;
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingFsRequests.delete(reqId);
        const errMsg =
          typeof msg.error === "string" && msg.error.trim().length > 0
            ? msg.error.trim()
            : "远程文件操作失败";
        pending.reject(new Error(errMsg));
      }
      return;
    }

    // 2. Handle Remote File Download control frames (fs_download_start / fs_download_end / fs_download_error)
    if (type === "fs_download_start") {
      const active = this.activeFileDownload;
      const reqId = typeof msg.reqId === "string" ? msg.reqId : "";
      if (!active || reqId !== active.reqId) return;
      active.started = true;
      if (typeof msg.fileName === "string" && msg.fileName.trim()) {
        active.fileName = msg.fileName.trim();
      }
      if (typeof msg.size === "number" && Number.isFinite(msg.size) && msg.size >= 0) {
        active.totalBytes = Math.floor(msg.size);
      }
      if (typeof msg.mimeType === "string" && msg.mimeType.trim()) {
        active.mimeType = msg.mimeType.trim();
      }
      this.resetRemoteDownloadIdleTimer(active);
      this.setState({
        fileDownload: {
          active: true,
          reqId: active.reqId,
          fileName: active.fileName,
          receivedBytes: active.receivedBytes,
          totalBytes: active.totalBytes,
          error: null,
        },
      });
      return;
    }

    if (type === "fs_download_end") {
      const active = this.activeFileDownload;
      const reqId = typeof msg.reqId === "string" ? msg.reqId : "";
      if (!active || reqId !== active.reqId) return;
      if (active.idleTimer !== null) {
        clearTimeout(active.idleTimer);
        active.idleTimer = null;
      }
      this.activeFileDownload = null;
      const expectedSha = typeof msg.sha256 === "string" ? msg.sha256 : "";
      const expectedSize =
        typeof msg.size === "number" && Number.isFinite(msg.size)
          ? Math.floor(msg.size)
          : null;
      void this.finalizeRemoteDownload(active, expectedSha, expectedSize);
      return;
    }

    if (type === "fs_download_error") {
      const active = this.activeFileDownload;
      const reqId = typeof msg.reqId === "string" ? msg.reqId : "";
      if (!active || (reqId && reqId !== active.reqId)) return;
      const errText =
        typeof msg.error === "string" && msg.error.trim().length > 0
          ? msg.error.trim()
          : "远端文件下载失败";
      this.failActiveRemoteDownload(errText);
      return;
    }

    // 3. Handle P2P upload control frames (file.accept / file.progress / file.done / file.error)
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

  private resetWsJpegAutoQuality(): void {
    this.wsJpegAutoTier = "balanced";
    this.wsJpegAutoCongestedCount = 0;
    this.wsJpegAutoHealthyCount = 0;
    this.wsJpegAutoLastAdjustAt = 0;
  }

  /**
   * Receiver-side fallback auto-step-down for ws-jpeg mode (or legacy Android agents):
   * uses hysteresis (220ms step-down / 100ms step-up), consecutive streak thresholds,
   * and a 10s cooldown to avoid thrashing. WebRTC Android v1.0.7 handles full
   * on-device AdaptiveQoSController at 1s granularity and never enters this path.
   */
  private evaluateWsJpegAutoQuality(rttMs: number): void {
    if (
      this.state.qualityPreset !== "auto" ||
      this.state.activeTransport !== "ws-jpeg" ||
      this.state.sessionStatus !== "streaming" ||
      !this.state.activeDeviceId ||
      !this.state.sessionId
    ) {
      return;
    }

    const now = Date.now();
    const cooldownElapsed =
      this.wsJpegAutoLastAdjustAt === 0 ||
      now - this.wsJpegAutoLastAdjustAt >= WS_JPEG_AUTO_COOLDOWN_MS;

    if (rttMs >= WS_JPEG_AUTO_STEP_DOWN_RTT_MS) {
      this.wsJpegAutoCongestedCount += 1;
      this.wsJpegAutoHealthyCount = 0;
      if (
        this.wsJpegAutoTier !== "eco" &&
        this.wsJpegAutoCongestedCount >= WS_JPEG_AUTO_CONGESTED_STREAK &&
        cooldownElapsed
      ) {
        this.wsJpegAutoTier = "eco";
        this.wsJpegAutoCongestedCount = 0;
        this.wsJpegAutoLastAdjustAt = now;
        this.sendCommand({
          action: "quality",
          quality: { ...QUALITY_PRESETS.eco, auto: true },
        });
      }
    } else if (rttMs <= WS_JPEG_AUTO_STEP_UP_RTT_MS) {
      this.wsJpegAutoHealthyCount += 1;
      this.wsJpegAutoCongestedCount = 0;
      if (
        this.wsJpegAutoTier === "eco" &&
        this.wsJpegAutoHealthyCount >= WS_JPEG_AUTO_HEALTHY_STREAK &&
        cooldownElapsed
      ) {
        this.wsJpegAutoTier = "balanced";
        this.wsJpegAutoHealthyCount = 0;
        this.wsJpegAutoLastAdjustAt = now;
        this.sendCommand({
          action: "quality",
          quality: QUALITY_PRESETS.auto,
        });
      }
    } else {
      this.wsJpegAutoCongestedCount = 0;
      this.wsJpegAutoHealthyCount = 0;
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
