export type TransportMode = "webrtc" | "ws-jpeg";

export type DeviceType = "android" | "desktop";
export type DevicePlatform = "android" | "darwin" | "win32" | "linux";
export type MouseButton = "left" | "right" | "middle";
export type VideoCodecPreference = "auto" | "h264" | "hevc" | "av1" | "vp9";
export type DesktopPowerOperation = "lock" | "sleep" | "restart" | "shutdown";

export interface DisplayInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  primary?: boolean;
}

export interface KeyModifiers {
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

export type RemoteKey =
  | "back"
  | "home"
  | "recents"
  | "notifications"
  | "quick_settings"
  | "power_dialog"
  | "lock"
  | "screenshot"
  | "volume_up"
  | "volume_down"
  | "enter"
  | "backspace";

export interface UserProfile {
  userId: string;
  username: string;
  displayName: string;
}

export interface DeviceCapabilities {
  webrtc: boolean;
  wsJpeg: boolean;
  wsH264: boolean;
  wake: boolean;
  unlock: boolean;
  accessibility: boolean;
  mediaProjection: boolean;
  rootOrShizuku?: boolean;
  p2pFileTransfer?: boolean;
  desktopAudio?: boolean;
  privacyScreen?: boolean;
  fileManager?: boolean;
  powerControl?: boolean;
  highRefresh?: boolean;
}

export interface DeviceSummary {
  deviceId: string;
  controlCode?: string;
  ownerUsername?: string;
  name: string;
  model: string;
  androidVersion: string;
  online: boolean;
  lastSeen: number;
  screenWidth: number;
  screenHeight: number;
  rotation: 0 | 1 | 2 | 3;
  battery: number;
  charging: boolean;
  locked: boolean;
  screenOn?: boolean;
  blackScreenActive?: boolean;
  forcePortraitActive?: boolean;
  privacyScreenActive?: boolean;
  audioEnabled?: boolean;
  directUrl?: string;
  deviceType?: DeviceType;
  osPlatform?: DevicePlatform;
  displays?: DisplayInfo[];
  activeDisplayId?: string;
  capabilities: DeviceCapabilities;
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface StreamQuality {
  maxWidth: number;
  fps: number;
  bitrateKbps: number;
  jpegQuality: number;
  /** When true, agent dynamically adapts bitrate, FPS, and resolution tier to live link speed/RTT. */
  auto?: boolean;
  codec?: VideoCodecPreference;
  audioEnabled?: boolean;
}

export const QUALITY_PRESETS: Record<"auto" | "eco" | "balanced" | "hd", StreamQuality> = {
  auto: { maxWidth: 900, fps: 60, bitrateKbps: 4500, jpegQuality: 54, auto: true },
  eco: { maxWidth: 540, fps: 30, bitrateKbps: 1600, jpegQuality: 45 },
  balanced: { maxWidth: 900, fps: 60, bitrateKbps: 4500, jpegQuality: 54 },
  hd: { maxWidth: 1080, fps: 60, bitrateKbps: 7500, jpegQuality: 64 },
};

export const DESKTOP_QUALITY_PRESETS: Record<
  "auto" | "eco" | "balanced" | "hd" | "ultra",
  StreamQuality
> = {
  auto: { maxWidth: 1920, fps: 60, bitrateKbps: 8000, jpegQuality: 58, auto: true, codec: "auto" },
  eco: { maxWidth: 1280, fps: 60, bitrateKbps: 3000, jpegQuality: 50, codec: "auto" },
  balanced: { maxWidth: 1920, fps: 60, bitrateKbps: 8000, jpegQuality: 60, codec: "auto" },
  hd: { maxWidth: 2560, fps: 90, bitrateKbps: 16000, jpegQuality: 68, codec: "auto" },
  ultra: { maxWidth: 3840, fps: 120, bitrateKbps: 30000, jpegQuality: 74, codec: "auto" },
};

export interface RtcIceCandidateInit {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

export type ControlCommand =
  | { action: "tap"; x: number; y: number }
  | { action: "long_press"; x: number; y: number; durationMs?: number }
  | { action: "swipe"; x1: number; y1: number; x2: number; y2: number; durationMs?: number }
  | { action: "touch_down"; pointerId: number; x: number; y: number }
  | { action: "touch_move"; pointerId: number; x: number; y: number }
  | { action: "touch_up"; pointerId: number; x: number; y: number }
  | {
      action: "pinch";
      cx: number;
      cy: number;
      startDist: number;
      endDist: number;
      durationMs?: number;
    }
  | { action: "key"; key: RemoteKey }
  | { action: "text"; text: string; submit?: boolean }
  | { action: "clipboard_set"; text: string }
  | { action: "wake" }
  | { action: "unlock"; pin?: string }
  | { action: "black_screen"; enabled: boolean }
  | { action: "force_portrait"; enabled: boolean }
  | { action: "quality"; quality: StreamQuality }
  | { action: "request_keyframe" }
  | { action: "mouse_move"; x: number; y: number }
  | { action: "mouse_down"; x: number; y: number; button: MouseButton; clickCount?: number }
  | { action: "mouse_up"; x: number; y: number; button: MouseButton }
  | { action: "mouse_wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { action: "key_event"; phase: "down" | "up" | "press"; code: string; key: string; modifiers?: KeyModifiers }
  | { action: "select_display"; displayId: string }
  | { action: "privacy_screen"; enabled: boolean }
  | { action: "audio_toggle"; enabled: boolean }
  | { action: "power"; operation: DesktopPowerOperation };

export interface AgentRegisterMessage {
  type: "agent.register";
  deviceId: string;
  deviceSecret: string;
  /** Optional legacy/direct shared access token */
  accessToken?: string;
  /** Optional logged-in user JWT to bind this device to an account */
  authToken?: string;
  /** Explicitly unbind this device from its current owner account (authenticated by deviceSecret) */
  unbindOwner?: boolean;
  /** Optional unattended control password for 9-digit control code access */
  controlPassword?: string;
  name: string;
  model: string;
  androidVersion: string;
  screenWidth: number;
  screenHeight: number;
  rotation: 0 | 1 | 2 | 3;
  battery: number;
  charging: boolean;
  locked: boolean;
  screenOn?: boolean;
  blackScreenActive?: boolean;
  forcePortraitActive?: boolean;
  privacyScreenActive?: boolean;
  audioEnabled?: boolean;
  directUrl?: string;
  deviceType?: DeviceType;
  osPlatform?: DevicePlatform;
  displays?: DisplayInfo[];
  activeDisplayId?: string;
  capabilities: DeviceCapabilities;
}

export interface AgentRegisteredMessage {
  type: "agent.registered";
  deviceId: string;
  controlCode?: string;
  ownerUsername?: string;
  serverTime: number;
  iceServers: IceServerConfig[];
}

export interface AgentTelemetryMessage {
  type: "agent.telemetry";
  deviceId: string;
  screenWidth?: number;
  screenHeight?: number;
  rotation?: 0 | 1 | 2 | 3;
  battery?: number;
  charging?: boolean;
  locked?: boolean;
  screenOn?: boolean;
  blackScreenActive?: boolean;
  forcePortraitActive?: boolean;
  privacyScreenActive?: boolean;
  audioEnabled?: boolean;
  deviceType?: DeviceType;
  osPlatform?: DevicePlatform;
  displays?: DisplayInfo[];
  activeDisplayId?: string;
  capabilities?: Partial<DeviceCapabilities>;
}

export interface ControllerAuthMessage {
  type: "controller.auth";
  /** Account mode: JWT returned by /api/auth/login or /api/auth/register */
  authToken?: string;
  /** Control-code mode: 9-digit remote device code */
  controlCode?: string;
  /** Control-code mode: unattended password configured on target phone */
  controlPassword?: string;
  /** Legacy / Direct LAN mode shared token */
  accessToken?: string;
  clientId: string;
  clientName?: string;
}

export interface ControllerAuthedMessage {
  type: "controller.authed";
  clientId: string;
  serverTime: number;
  mode: "relay" | "direct";
  authType?: "account" | "code" | "token";
  user?: UserProfile;
  devices: DeviceSummary[];
  iceServers: IceServerConfig[];
}

export interface DeviceStatusMessage {
  type: "device.status";
  device: DeviceSummary;
}

export interface SessionRequestMessage {
  type: "session.request";
  sessionId: string;
  deviceId: string;
  preferredTransport: TransportMode;
  quality: StreamQuality;
  /** Optional fresh per-session ICE/TURN servers injected by Relay so 7x24 agents never use expired TURN credentials */
  iceServers?: IceServerConfig[];
}

export interface SessionReadyMessage {
  type: "session.ready";
  sessionId: string;
  deviceId: string;
  transport: TransportMode;
  screenWidth: number;
  screenHeight: number;
  rotation: 0 | 1 | 2 | 3;
  /** Optional fresh per-session ICE/TURN servers injected by Relay so long-lived controllers never use expired TURN credentials */
  iceServers?: IceServerConfig[];
}

export interface SessionEndMessage {
  type: "session.end";
  sessionId: string;
  deviceId: string;
  reason?: string;
}

export interface RtcOfferMessage {
  type: "rtc.offer";
  sessionId: string;
  deviceId: string;
  sdp: string;
}

export interface RtcAnswerMessage {
  type: "rtc.answer";
  sessionId: string;
  deviceId: string;
  sdp: string;
}

export interface RtcIceMessage {
  type: "rtc.ice";
  sessionId: string;
  deviceId: string;
  candidate: RtcIceCandidateInit;
}

export interface ControlCmdMessage {
  type: "control.cmd";
  sessionId: string;
  deviceId: string;
  seq?: number;
  command: ControlCommand;
}

export interface ControlAckMessage {
  type: "control.ack";
  sessionId: string;
  deviceId: string;
  seq?: number;
  ok: boolean;
  message?: string;
}

export interface ClipboardSyncMessage {
  type: "clipboard.sync";
  sessionId: string;
  deviceId: string;
  text: string;
}

export interface PingMessage {
  type: "ping";
  ts: number;
}

export interface PongMessage {
  type: "pong";
  ts: number;
}

export interface ErrorMessage {
  type: "error";
  code:
    | "UNAUTHORIZED"
    | "DEVICE_OFFLINE"
    | "DEVICE_SECRET_MISMATCH"
    | "INVALID_MESSAGE"
    | "SESSION_NOT_FOUND"
    | "RATE_LIMITED"
    | "INTERNAL_ERROR";
  message: string;
  sessionId?: string;
  deviceId?: string;
}

export type WireMessage =
  | AgentRegisterMessage
  | AgentRegisteredMessage
  | AgentTelemetryMessage
  | ControllerAuthMessage
  | ControllerAuthedMessage
  | DeviceStatusMessage
  | SessionRequestMessage
  | SessionReadyMessage
  | SessionEndMessage
  | RtcOfferMessage
  | RtcAnswerMessage
  | RtcIceMessage
  | ControlCmdMessage
  | ControlAckMessage
  | ClipboardSyncMessage
  | PingMessage
  | PongMessage
  | ErrorMessage;

export function isWireMessage(value: unknown): value is WireMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  );
}

/** Strips spaces/dashes and validates a 9-digit remote control code. */
export function normalizeControlCode(raw: string): string {
  return raw.replace(/[\s-]+/g, "").trim();
}

/** Formats a 9-digit control code as "683 291 405". */
export function formatControlCode(raw: string): string {
  const clean = normalizeControlCode(raw);
  if (clean.length !== 9) return clean;
  return `${clean.slice(0, 3)} ${clean.slice(3, 6)} ${clean.slice(6, 9)}`;
}
