import type { IncomingMessage } from "node:http";
import { WebSocket, type RawData } from "ws";
import {
  isWireMessage,
  normalizeControlCode,
  peekMediaFrameSessionId,
  type AgentRegisterMessage,
  type AgentRegisteredMessage,
  type AgentTelemetryMessage,
  type ClipboardSyncMessage,
  type ControlAckMessage,
  type ControlCmdMessage,
  type ControllerAuthMessage,
  type ControllerAuthedMessage,
  type DeviceCapabilities,
  type DeviceStatusMessage,
  type DeviceSummary,
  type ErrorMessage,
  type PongMessage,
  type RtcAnswerMessage,
  type RtcIceMessage,
  type RtcOfferMessage,
  type SessionEndMessage,
  type SessionReadyMessage,
  type SessionRequestMessage,
  type StreamQuality,
  type TransportMode,
  type UserProfile,
  type WireMessage,
} from "@velodeck/protocol";
import { AuditLogger } from "./audit.js";
import {
  hashPassword,
  loadOrCreateJwtSecret,
  sha256Hex,
  timingSafeEqualHex,
  verifyJwt,
  verifyPassword,
} from "./auth.js";
import type { ServerConfig } from "./config.js";
import {
  cloneDeviceSummary,
  isValidDeviceId,
  MAX_PASSWORD_LENGTH,
  MIN_CONTROL_PASSWORD_LENGTH,
  VeloDeckStore,
  type StoredDevice,
} from "./store.js";
import { buildIceServers } from "./turn.js";

// Keep per-controller binary frame queue tight (64 KB) so ws-jpeg fallback stays low-latency without dropping 900p fallback frames
const MAX_CONTROLLER_BUFFERED_BYTES = 64 * 1024;
const MAX_OUTBOUND_BUFFERED_BYTES = 2 * 1024 * 1024; // 2 MB guard against stalled peers OOMing container
const PENDING_SESSION_TIMEOUT_MS = 30_000;
const REPLACE_TERMINATE_GRACE_MS = 2_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const HOUR_WINDOW_MS = 3_600_000;
const MAX_NEW_DEVICES_PER_IP_PER_HOUR = 5;
const MAX_REGISTERS_PER_IP_PER_HOUR = 5;
const MAX_TRACKED_MAP_ENTRIES = 10_000;
const MAX_PRE_AUTH_TEXT_BYTES = 8 * 1024;
const MAX_POST_AUTH_TEXT_BYTES = 64 * 1024;
const MAX_CLIPBOARD_TEXT_BYTES = 64 * 1024;
const MAX_SESSIONS_PER_DEVICE = 2;
const MAX_SESSIONS_PER_CONTROLLER = 5;
const MAX_OUT_OF_BAND_PER_CONTROLLER = 10;
const MAX_PENDING_TEXT_MSGS = 100;

const LOCKOUT_TIER1_FAILURES = 5;
const LOCKOUT_TIER1_MS = 60_000;
const LOCKOUT_TIER2_FAILURES = 10;
const LOCKOUT_TIER2_MS = 15 * 60_000;
const LOCKOUT_QUIET_RESET_MS = 30 * 60_000;

const SESSION_ID_REGEX = /^[a-zA-Z0-9_-]{8,64}$/;
const CONTROL_CODE_REGEX = /^\d{9}$/;
const IPV4_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export interface HubStats {
  devicesOnline: number;
  devicesTotal: number;
  controllersConnected: number;
  activeSessions: number;
}

type ControllerAuthType = "account" | "code" | "token";

interface LockoutEntry {
  failures: number;
  lockedUntilMs: number;
  lastFailureMs: number;
}

interface ClientConn {
  ws: WebSocket;
  ip: string;
  connSeq: number;
  ipCounted: boolean;
  role: "unauthenticated" | "agent" | "controller";
  deviceId?: string;
  agentAuthUserId?: string;
  agentAuthTokenVersion?: number;
  controllerId?: string;
  clientName?: string;
  authType?: ControllerAuthType;
  userId?: string;
  tokenVersion?: number;
  authorizedDeviceId?: string;
  controlPassHashSnapshot?: string;
  accessTokenHashHex?: string;
  lastActivityMs: number;
  replaced: boolean;
  authTimer?: NodeJS.Timeout;
  replaceTimer?: NodeJS.Timeout;
  msgChain: Promise<void>;
  pendingTextMsgs: number;
}

interface LiveAgentState {
  conn: ClientConn;
  summary: DeviceSummary;
}

interface SessionRecord {
  sessionId: string;
  deviceId: string;
  controllerId: string;
  controllerConn: ClientConn;
  createdAt: number;
  ready: boolean;
}

interface OutOfBandEntry {
  controllerConn: ClientConn;
  deviceId: string;
  createdAt: number;
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, maxSize = MAX_TRACKED_MAP_ENTRIES): void {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= maxSize) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }
  map.set(key, value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_REGEX.test(value);
}

function isValidRotation(value: unknown): value is 0 | 1 | 2 | 3 {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

function isValidTransportMode(value: unknown): value is TransportMode {
  return value === "webrtc" || value === "ws-jpeg";
}

function isValidStreamQuality(value: unknown): value is StreamQuality {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const q = value as Record<string, unknown>;
  return (
    typeof q.maxWidth === "number" &&
    Number.isFinite(q.maxWidth) &&
    q.maxWidth > 0 &&
    typeof q.fps === "number" &&
    Number.isFinite(q.fps) &&
    q.fps > 0 &&
    typeof q.bitrateKbps === "number" &&
    Number.isFinite(q.bitrateKbps) &&
    q.bitrateKbps > 0 &&
    typeof q.jpegQuality === "number" &&
    Number.isFinite(q.jpegQuality) &&
    q.jpegQuality > 0
  );
}

function sanitizeLabel(value: unknown, fallback: string, maxLen = 64): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const clean = value.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, maxLen);
  return clean.length > 0 ? clean : fallback;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const match = IPV4_REGEX.exec(ip);
  if (!match) {
    return null;
  }
  const a = Number.parseInt(match[1] ?? "", 10);
  const b = Number.parseInt(match[2] ?? "", 10);
  const c = Number.parseInt(match[3] ?? "", 10);
  const d = Number.parseInt(match[4] ?? "", 10);
  if (a > 255 || b > 255 || c > 255 || d > 255) {
    return null;
  }
  return [a, b, c, d];
}

function isRfc1918OrCgnatIpv4(ip: string): boolean {
  const octets = parseIpv4Octets(ip);
  if (!octets) {
    return false;
  }
  const [a, b] = octets;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT / Tailscale)
  return false;
}

export function validateDirectUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return undefined;
    }
    if (parsed.username !== "" || parsed.password !== "") {
      return undefined;
    }
    if (!isRfc1918OrCgnatIpv4(parsed.hostname)) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function normalizeIp(raw: string | undefined): string {
  if (!raw) {
    return "";
  }
  let trimmed = raw.trim();
  if (trimmed.toLowerCase().startsWith("::ffff:")) {
    const v4 = trimmed.slice(7);
    if (parseIpv4Octets(v4)) {
      trimmed = v4;
    }
  }
  return trimmed;
}

export function isLoopbackIp(raw: string | undefined): boolean {
  const ip = normalizeIp(raw);
  if (!ip) {
    return false;
  }
  if (ip === "::1" || ip === "127.0.0.1") {
    return true;
  }
  const octets = parseIpv4Octets(ip);
  return octets !== null && octets[0] === 127;
}

function isPrivateOrNonRoutableIp(raw: string): boolean {
  const ip = normalizeIp(raw).toLowerCase();
  if (!ip) {
    return true;
  }
  if (ip === "::1" || ip === "::") {
    return true;
  }
  if (
    ip.startsWith("fc") ||
    ip.startsWith("fd") ||
    ip.startsWith("fe8") ||
    ip.startsWith("fe9") ||
    ip.startsWith("fea") ||
    ip.startsWith("feb")
  ) {
    return true;
  }
  const octets = parseIpv4Octets(ip);
  if (octets) {
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

export function extractClientIp(req?: IncomingMessage, trustProxy = false): string {
  if (!req) {
    return "unknown";
  }
  const socketIp = normalizeIp(req.socket?.remoteAddress) || "unknown";
  if (!trustProxy) {
    return socketIp;
  }

  const xRealIp = req.headers["x-real-ip"];
  if (typeof xRealIp === "string" && xRealIp.trim().length > 0) {
    return normalizeIp(xRealIp) || socketIp;
  }

  const forwarded = req.headers["x-forwarded-for"];
  const rawList =
    typeof forwarded === "string"
      ? forwarded
      : Array.isArray(forwarded)
        ? forwarded.join(",")
        : "";
  if (rawList.trim().length > 0) {
    const hops = rawList
      .split(",")
      .map((entry) => normalizeIp(entry))
      .filter((entry) => entry.length > 0);
    if (hops.length > 0) {
      for (let i = hops.length - 1; i >= 0; i -= 1) {
        const hop = hops[i];
        if (hop && !isPrivateOrNonRoutableIp(hop)) {
          return hop;
        }
      }
      const rightmost = hops[hops.length - 1];
      if (rightmost) {
        return rightmost;
      }
    }
  }

  return socketIp;
}

function cloneCapabilities(cap: DeviceCapabilities): DeviceCapabilities {
  const copy: DeviceCapabilities = {
    webrtc: Boolean(cap.webrtc),
    wsJpeg: Boolean(cap.wsJpeg),
    wsH264: Boolean(cap.wsH264),
    wake: Boolean(cap.wake),
    unlock: Boolean(cap.unlock),
    accessibility: Boolean(cap.accessibility),
    mediaProjection: Boolean(cap.mediaProjection),
  };
  if (cap.rootOrShizuku !== undefined) {
    copy.rootOrShizuku = Boolean(cap.rootOrShizuku);
  }
  if (cap.p2pFileTransfer !== undefined) {
    copy.p2pFileTransfer = Boolean(cap.p2pFileTransfer);
  }
  return copy;
}

function defaultCapabilities(): DeviceCapabilities {
  return {
    webrtc: false,
    wsJpeg: true,
    wsH264: false,
    wake: false,
    unlock: false,
    accessibility: false,
    mediaProjection: false,
  };
}

function mergeCapabilities(
  base: DeviceCapabilities | undefined,
  patch: Partial<DeviceCapabilities> | undefined,
): DeviceCapabilities {
  const merged = cloneCapabilities(base ?? defaultCapabilities());
  if (!patch) {
    return merged;
  }
  if (typeof patch.webrtc === "boolean") merged.webrtc = patch.webrtc;
  if (typeof patch.wsJpeg === "boolean") merged.wsJpeg = patch.wsJpeg;
  if (typeof patch.wsH264 === "boolean") merged.wsH264 = patch.wsH264;
  if (typeof patch.wake === "boolean") merged.wake = patch.wake;
  if (typeof patch.unlock === "boolean") merged.unlock = patch.unlock;
  if (typeof patch.accessibility === "boolean") merged.accessibility = patch.accessibility;
  if (typeof patch.mediaProjection === "boolean") merged.mediaProjection = patch.mediaProjection;
  if (typeof patch.rootOrShizuku === "boolean") merged.rootOrShizuku = patch.rootOrShizuku;
  if (typeof patch.p2pFileTransfer === "boolean") merged.p2pFileTransfer = patch.p2pFileTransfer;
  return merged;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

export class VeloDeckHub {
  private readonly config: ServerConfig;
  public readonly store: VeloDeckStore;
  public readonly jwtSecret: string;
  public readonly audit: AuditLogger;
  private readonly connections = new Set<ClientConn>();
  private readonly wsCountByIp = new Map<string, number>();
  private readonly liveAgents = new Map<string, LiveAgentState>();
  private readonly controllers = new Set<ClientConn>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly outOfBandCmds = new Map<string, OutOfBandEntry[]>();
  private readonly latestAgentSeqByDevice = new Map<string, number>();
  private readonly latestControllerSeqByKey = new Map<string, number>();
  private readonly failedAuthByIp = new Map<string, number[]>();
  private readonly registerRateByIp = new Map<string, number[]>();
  private readonly newDeviceByIp = new Map<string, number[]>();
  private readonly lockoutByTarget = new Map<string, LockoutEntry>();
  private nextConnSeq = 1;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    config: ServerConfig,
    store?: VeloDeckStore,
    jwtSecret?: string,
    audit?: AuditLogger,
  ) {
    this.config = config;
    this.store =
      store ??
      new VeloDeckStore(config.dataDir, {
        maxUsers: config.maxUsers,
        maxDevices: config.maxDevices,
      });
    this.jwtSecret = jwtSecret ?? loadOrCreateJwtSecret(config.dataDir, config.jwtSecret);
    this.audit = audit ?? new AuditLogger(config.dataDir);
    this.startHeartbeat();
  }

  public handleConnection(ws: WebSocket, req?: IncomingMessage): void {
    if (this.closed) {
      ws.close(1001, "Server shutting down");
      return;
    }

    const ip = extractClientIp(req, this.config.trustProxy);

    if (this.connections.size >= this.config.maxWsConnections) {
      this.audit.log({
        event: "ws.limit_hit",
        ip,
        ok: false,
        detail: "max_ws_connections",
      });
      this.sendError(ws, "RATE_LIMITED", "Server WebSocket connection limit reached");
      ws.close(4029, "RATE_LIMITED");
      return;
    }

    const currentForIp = this.wsCountByIp.get(ip) ?? 0;
    if (currentForIp >= this.config.maxWsPerIp) {
      this.audit.log({
        event: "ws.limit_hit",
        ip,
        ok: false,
        detail: "max_ws_per_ip",
      });
      this.sendError(ws, "RATE_LIMITED", "Too many concurrent WebSocket connections from this IP");
      ws.close(4029, "RATE_LIMITED");
      return;
    }

    const conn: ClientConn = {
      ws,
      ip,
      connSeq: this.nextConnSeq++,
      ipCounted: true,
      role: "unauthenticated",
      lastActivityMs: Date.now(),
      replaced: false,
      msgChain: Promise.resolve(),
      pendingTextMsgs: 0,
    };

    this.connections.add(conn);
    this.wsCountByIp.set(ip, currentForIp + 1);

    conn.authTimer = setTimeout(() => {
      conn.authTimer = undefined;
      if (this.closed || conn.role !== "unauthenticated") {
        return;
      }
      this.audit.log({
        event: "ws.auth_timeout",
        ip: conn.ip,
        ok: false,
        detail: "auth_deadline_exceeded",
      });
      this.sendError(conn.ws, "UNAUTHORIZED", "Authentication deadline exceeded");
      try {
        conn.ws.close(4008, "AUTH_TIMEOUT");
      } catch {
        conn.ws.terminate();
      }
    }, this.config.authTimeoutMs);
    conn.authTimer.unref?.();

    ws.on("pong", () => {
      conn.lastActivityMs = Date.now();
    });

    ws.on("message", (data: RawData, isBinary: boolean) => {
      conn.lastActivityMs = Date.now();
      if (isBinary) {
        try {
          this.handleBinaryMessage(conn, data);
        } catch (err) {
          this.handleSocketInternalError(conn, err);
        }
        return;
      }

      // Synchronous fast path for already-authenticated sockets with an empty async queue
      // (avoids per-message Promise allocation on high-frequency 50Hz touch_move / control.ack).
      if (conn.role !== "unauthenticated" && conn.pendingTextMsgs === 0) {
        if (this.closed || conn.ws.readyState !== WebSocket.OPEN) {
          return;
        }
        try {
          this.handlePostAuthTextMessage(conn, data);
        } catch (err) {
          this.handleSocketInternalError(conn, err);
        }
        return;
      }

      if (conn.pendingTextMsgs >= MAX_PENDING_TEXT_MSGS) {
        this.sendError(conn.ws, "RATE_LIMITED", "Too many queued messages");
        try {
          conn.ws.close(1008, "MESSAGE_QUEUE_OVERFLOW");
        } catch {
          conn.ws.terminate();
        }
        return;
      }

      conn.pendingTextMsgs += 1;
      conn.msgChain = conn.msgChain
        .then(async () => {
          if (this.closed || conn.ws.readyState !== WebSocket.OPEN) {
            return;
          }
          await this.handleTextMessage(conn, data);
        })
        .catch((err: unknown) => {
          this.handleSocketInternalError(conn, err);
        })
        .finally(() => {
          conn.pendingTextMsgs = Math.max(0, conn.pendingTextMsgs - 1);
        });
    });

    ws.on("close", () => {
      this.handleDisconnect(conn);
    });

    ws.on("error", () => {
      // Socket errors are followed by close; prevent unhandled EventEmitter crash.
    });
  }

  private clearAuthTimer(conn: ClientConn): void {
    if (conn.authTimer) {
      clearTimeout(conn.authTimer);
      conn.authTimer = undefined;
    }
  }

  private clearReplaceTimer(conn: ClientConn): void {
    if (conn.replaceTimer) {
      clearTimeout(conn.replaceTimer);
      conn.replaceTimer = undefined;
    }
  }

  private releaseIpSlot(conn: ClientConn): void {
    if (!conn.ipCounted) {
      return;
    }
    conn.ipCounted = false;
    const currentCount = this.wsCountByIp.get(conn.ip) ?? 0;
    if (currentCount <= 1) {
      this.wsCountByIp.delete(conn.ip);
    } else {
      this.wsCountByIp.set(conn.ip, currentCount - 1);
    }
  }

  private closeReplacedConnection(conn: ClientConn, code: number, reason: string): void {
    conn.replaced = true;
    this.clearAuthTimer(conn);
    this.releaseIpSlot(conn);
    try {
      conn.ws.close(code, reason);
    } catch {
      conn.ws.terminate();
      return;
    }
    if (!conn.replaceTimer && conn.ws.readyState !== WebSocket.CLOSED) {
      conn.replaceTimer = setTimeout(() => {
        conn.replaceTimer = undefined;
        if (conn.ws.readyState !== WebSocket.CLOSED) {
          try {
            conn.ws.terminate();
          } catch {
            // Ignore terminate errors on already-closing socket.
          }
        }
      }, REPLACE_TERMINATE_GRACE_MS);
      conn.replaceTimer.unref?.();
    }
  }

  private handleSocketInternalError(conn: ClientConn, err: unknown): void {
    const errName = err instanceof Error ? err.name : "Error";
    this.audit.log({
      event: "ws.error",
      ip: conn.ip,
      ok: false,
      userId: conn.userId,
      deviceId: conn.deviceId,
      detail: `unhandled_${errName}`,
    });
    this.sendError(conn.ws, "INTERNAL_ERROR", "Internal server error");
    try {
      conn.ws.close(1011, "INTERNAL_ERROR");
    } catch {
      conn.ws.terminate();
    }
  }

  public getStats(): HubStats {
    let devicesOnline = 0;
    for (const live of this.liveAgents.values()) {
      if (live.summary.online && live.conn.ws.readyState === WebSocket.OPEN) {
        devicesOnline += 1;
      }
    }
    return {
      devicesOnline,
      devicesTotal: this.store.getDeviceCount(),
      controllersConnected: this.controllers.size,
      activeSessions: this.sessions.size,
    };
  }

  public listDevicesForOwner(userId: string): DeviceSummary[] {
    const stored = this.store.listDevicesByOwner(userId);
    return stored.map((summary) => {
      const live = this.liveAgents.get(summary.deviceId);
      if (live && live.conn.ws.readyState === WebSocket.OPEN) {
        return cloneDeviceSummary(live.summary);
      }
      return summary;
    });
  }

  public listDevicesForLegacyToken(tokenHashHex: string): DeviceSummary[] {
    const stored = this.store.listDevicesByLegacyTokenHash(tokenHashHex);
    return stored.map((summary) => {
      const live = this.liveAgents.get(summary.deviceId);
      if (live && live.conn.ws.readyState === WebSocket.OPEN) {
        return cloneDeviceSummary(live.summary);
      }
      return summary;
    });
  }

  public revokeUserSessions(userId: string, reason = "CREDENTIALS_CHANGED"): void {
    // 1. Disconnect all account-authenticated controllers belonging to userId
    for (const ctrl of Array.from(this.controllers)) {
      if (ctrl.authType === "account" && ctrl.userId === userId) {
        this.controllers.delete(ctrl);
        this.endSessionsForController(ctrl, reason);
        this.removeOutOfBandForController(ctrl);
        this.closeReplacedConnection(ctrl, 4001, "CREDENTIALS_CHANGED");
      }
    }

    // 2. Disconnect all live agents authenticated via an invalidated JWT of userId
    for (const [deviceId, live] of Array.from(this.liveAgents.entries())) {
      if (live.conn.agentAuthUserId === userId) {
        this.liveAgents.delete(deviceId);
        live.summary.online = false;
        live.summary.lastSeen = Date.now();
        this.store.updateDeviceSummaryInMemory(deviceId, live.summary);
        this.removeOutOfBandForDevice(deviceId);

        for (const [sessionId, session] of Array.from(this.sessions.entries())) {
          if (session.deviceId === deviceId) {
            this.sessions.delete(sessionId);
            this.sendJson(session.controllerConn.ws, {
              type: "session.end",
              sessionId,
              deviceId,
              reason,
            });
          }
        }

        const stored = this.store.getDevice(deviceId);
        if (stored) {
          this.broadcastDeviceStatus(stored, live.summary);
        }

        this.closeReplacedConnection(live.conn, 4001, "CREDENTIALS_CHANGED");
      }
    }
  }

  public unbindDevice(userId: string, deviceId: string, ip = "unknown"): boolean {
    if (!isValidDeviceId(deviceId)) {
      return false;
    }
    const existing = this.store.getDevice(deviceId);
    if (!existing || existing.ownerUserId !== userId) {
      return false;
    }

    const removed = this.store.unbindDevice(userId, deviceId);
    if (!removed) {
      return false;
    }

    const live = this.liveAgents.get(deviceId);
    if (live) {
      delete live.summary.ownerUsername;
      this.store.updateDeviceSummaryInMemory(deviceId, live.summary);
    }

    // Terminate any active sessions owned by this user on the unbound device
    for (const [sessionId, session] of this.sessions.entries()) {
      if (
        session.deviceId === deviceId &&
        session.controllerConn.authType === "account" &&
        session.controllerConn.userId === userId
      ) {
        this.sessions.delete(sessionId);
        const endMsg: SessionEndMessage = {
          type: "session.end",
          sessionId,
          deviceId,
          reason: "device_unbound",
        };
        this.sendJson(session.controllerConn.ws, endMsg);
        if (live && live.conn.ws.readyState === WebSocket.OPEN) {
          this.sendJson(live.conn.ws, endMsg);
        }
        this.audit.log({
          event: "session.end",
          ip,
          ok: true,
          userId,
          deviceId,
          sessionId,
          detail: "device_unbound",
        });
      }
    }

    // Notify the former owner's connected controllers that this device is no longer bound/online to them
    const now = Date.now();
    const offlineSnapshot = cloneDeviceSummary(live?.summary ?? existing.summary);
    offlineSnapshot.online = false;
    offlineSnapshot.lastSeen = now;
    delete offlineSnapshot.ownerUsername;
    this.broadcastToOwnerControllers(userId, offlineSnapshot);

    this.audit.log({
      event: "device.unbind",
      ip,
      ok: true,
      userId,
      deviceId,
      detail: "rest_unbind",
    });

    return true;
  }

  public isRateLimited(ip: string): boolean {
    const timestamps = this.failedAuthByIp.get(ip);
    if (!timestamps || timestamps.length === 0) {
      return false;
    }
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
    const recent = timestamps.filter((ts) => ts >= cutoff);
    if (recent.length === 0) {
      this.failedAuthByIp.delete(ip);
      return false;
    }
    setBounded(this.failedAuthByIp, ip, recent);
    return recent.length >= this.config.maxFailedAuthPerMin;
  }

  public recordFailedAuth(ip: string): void {
    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    const existing = this.failedAuthByIp.get(ip) ?? [];
    const recent = existing.filter((ts) => ts >= cutoff);
    recent.push(now);
    setBounded(this.failedAuthByIp, ip, recent);
  }

  public isRegisterRateLimited(ip: string): boolean {
    const timestamps = this.registerRateByIp.get(ip);
    if (!timestamps || timestamps.length === 0) {
      return false;
    }
    const cutoff = Date.now() - HOUR_WINDOW_MS;
    const recent = timestamps.filter((ts) => ts >= cutoff);
    if (recent.length === 0) {
      this.registerRateByIp.delete(ip);
      return false;
    }
    setBounded(this.registerRateByIp, ip, recent);
    return recent.length >= MAX_REGISTERS_PER_IP_PER_HOUR;
  }

  public recordRegisterAttempt(ip: string): void {
    const now = Date.now();
    const cutoff = now - HOUR_WINDOW_MS;
    const existing = this.registerRateByIp.get(ip) ?? [];
    const recent = existing.filter((ts) => ts >= cutoff);
    recent.push(now);
    setBounded(this.registerRateByIp, ip, recent);
  }

  private isNewDeviceRateLimited(ip: string): boolean {
    const timestamps = this.newDeviceByIp.get(ip);
    if (!timestamps || timestamps.length === 0) {
      return false;
    }
    const cutoff = Date.now() - HOUR_WINDOW_MS;
    const recent = timestamps.filter((ts) => ts >= cutoff);
    if (recent.length === 0) {
      this.newDeviceByIp.delete(ip);
      return false;
    }
    setBounded(this.newDeviceByIp, ip, recent);
    return recent.length >= MAX_NEW_DEVICES_PER_IP_PER_HOUR;
  }

  private recordNewDeviceRegistration(ip: string): void {
    const now = Date.now();
    const cutoff = now - HOUR_WINDOW_MS;
    const existing = this.newDeviceByIp.get(ip) ?? [];
    const recent = existing.filter((ts) => ts >= cutoff);
    recent.push(now);
    setBounded(this.newDeviceByIp, ip, recent);
  }

  public isTargetLockedOut(targetKey: string): boolean {
    const entry = this.lockoutByTarget.get(targetKey);
    if (!entry) {
      return false;
    }
    const now = Date.now();
    if (entry.lockedUntilMs > now) {
      return true;
    }
    if (now - entry.lastFailureMs > LOCKOUT_QUIET_RESET_MS) {
      this.lockoutByTarget.delete(targetKey);
    }
    return false;
  }

  public recordTargetFailure(targetKey: string, ip: string): boolean {
    const now = Date.now();
    const prev = this.lockoutByTarget.get(targetKey);
    let failures = 1;
    let lockedUntilMs = 0;

    if (prev) {
      if (now >= prev.lockedUntilMs && now - prev.lastFailureMs > LOCKOUT_QUIET_RESET_MS) {
        failures = 1;
      } else {
        failures = prev.failures + 1;
        lockedUntilMs = prev.lockedUntilMs;
      }
    }

    if (failures >= LOCKOUT_TIER2_FAILURES) {
      lockedUntilMs = Math.max(lockedUntilMs, now + LOCKOUT_TIER2_MS);
    } else if (failures >= LOCKOUT_TIER1_FAILURES) {
      lockedUntilMs = Math.max(lockedUntilMs, now + LOCKOUT_TIER1_MS);
    }

    setBounded(this.lockoutByTarget, targetKey, {
      failures,
      lockedUntilMs,
      lastFailureMs: now,
    });

    if (lockedUntilMs > now) {
      this.audit.log({
        event: "lockout.hit",
        ip,
        ok: false,
        detail: `${targetKey.split(":")[0]}_lockout_failures_${failures}`,
      });
      return true;
    }
    return false;
  }

  public clearTargetLockout(targetKey: string): void {
    this.lockoutByTarget.delete(targetKey);
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const conn of this.connections) {
      this.clearAuthTimer(conn);
      this.clearReplaceTimer(conn);
      conn.replaced = true;
      conn.ipCounted = false;
      try {
        if (
          conn.ws.readyState === WebSocket.OPEN ||
          conn.ws.readyState === WebSocket.CONNECTING
        ) {
          conn.ws.close(1001, "Server shutting down");
        }
      } catch {
        conn.ws.terminate();
      }
    }

    this.connections.clear();
    this.wsCountByIp.clear();
    this.liveAgents.clear();
    this.controllers.clear();
    this.sessions.clear();
    this.outOfBandCmds.clear();
    this.latestAgentSeqByDevice.clear();
    this.latestControllerSeqByKey.clear();
    this.failedAuthByIp.clear();
    this.registerRateByIp.clear();
    this.newDeviceByIp.clear();
    this.lockoutByTarget.clear();
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();

      for (const conn of this.connections) {
        if (now - conn.lastActivityMs > this.config.heartbeatTimeoutMs) {
          conn.ws.terminate();
          continue;
        }
        if (conn.ws.readyState === WebSocket.OPEN) {
          try {
            conn.ws.ping();
          } catch {
            conn.ws.terminate();
          }
        }
      }

      // Prune unacknowledged session.request entries older than 30s so dead handshakes cannot exhaust session quotas.
      const pendingSessionCutoff = now - PENDING_SESSION_TIMEOUT_MS;
      for (const [sessionId, session] of Array.from(this.sessions.entries())) {
        if (!session.ready && session.createdAt < pendingSessionCutoff) {
          this.sessions.delete(sessionId);
          const endMsg: SessionEndMessage = {
            type: "session.end",
            sessionId,
            deviceId: session.deviceId,
            reason: "session_timeout",
          };
          this.sendJson(session.controllerConn.ws, endMsg);
          const agentConn = this.getAgentForSession(session);
          if (agentConn) {
            this.sendJson(agentConn.ws, endMsg);
          }
          this.audit.log({
            event: "session.end",
            ip: session.controllerConn.ip,
            ok: true,
            userId: session.controllerConn.userId,
            deviceId: session.deviceId,
            sessionId,
            detail: "session_timeout",
          });
        }
      }

      // Prune expired rate-limit entries, lockouts, and stale out-of-band command trackers
      const minCutoff = now - RATE_LIMIT_WINDOW_MS;
      const hourCutoff = now - HOUR_WINDOW_MS;

      for (const [key, entries] of Array.from(this.outOfBandCmds.entries())) {
        const recent = entries.filter((entry) => entry.createdAt >= minCutoff);
        if (recent.length === 0) {
          this.outOfBandCmds.delete(key);
        } else if (recent.length !== entries.length) {
          this.outOfBandCmds.set(key, recent);
        }
      }
      for (const [ip, timestamps] of this.failedAuthByIp.entries()) {
        const recent = timestamps.filter((ts) => ts >= minCutoff);
        if (recent.length === 0) {
          this.failedAuthByIp.delete(ip);
        } else {
          this.failedAuthByIp.set(ip, recent);
        }
      }
      for (const [ip, timestamps] of this.registerRateByIp.entries()) {
        const recent = timestamps.filter((ts) => ts >= hourCutoff);
        if (recent.length === 0) {
          this.registerRateByIp.delete(ip);
        } else {
          this.registerRateByIp.set(ip, recent);
        }
      }
      for (const [ip, timestamps] of this.newDeviceByIp.entries()) {
        const recent = timestamps.filter((ts) => ts >= hourCutoff);
        if (recent.length === 0) {
          this.newDeviceByIp.delete(ip);
        } else {
          this.newDeviceByIp.set(ip, recent);
        }
      }
      for (const [key, entry] of this.lockoutByTarget.entries()) {
        if (now >= entry.lockedUntilMs && now - entry.lastFailureMs > LOCKOUT_QUIET_RESET_MS) {
          this.lockoutByTarget.delete(key);
        }
      }
    }, this.config.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private sendRawPayload(ws: WebSocket, payload: string): boolean {
    if (ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    if (ws.bufferedAmount > MAX_OUTBOUND_BUFFERED_BYTES) {
      try {
        ws.terminate();
      } catch {
        // Ignore terminate errors on stalled sockets.
      }
      return false;
    }
    try {
      ws.send(payload);
      return true;
    } catch {
      return false;
    }
  }

  private sendJson(ws: WebSocket, msg: WireMessage): boolean {
    if (ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    return this.sendRawPayload(ws, JSON.stringify(msg));
  }

  private sendError(
    ws: WebSocket,
    code: ErrorMessage["code"],
    message: string,
    extra?: { sessionId?: string; deviceId?: string },
  ): void {
    const err: ErrorMessage = {
      type: "error",
      code,
      message,
    };
    if (extra?.sessionId !== undefined) {
      err.sessionId = extra.sessionId;
    }
    if (extra?.deviceId !== undefined) {
      err.deviceId = extra.deviceId;
    }
    this.sendJson(ws, err);
  }

  private canControllerAccessStoredDevice(conn: ClientConn, device: StoredDevice): boolean {
    if (conn.role !== "controller") {
      return false;
    }
    if (conn.authType === "account") {
      if (!conn.userId || !device.ownerUserId || device.ownerUserId !== conn.userId) {
        return false;
      }
      const currentTv = this.store.getUserTokenVersion(conn.userId);
      return currentTv !== null && conn.tokenVersion === currentTv;
    }
    if (conn.authType === "code") {
      return Boolean(
        conn.authorizedDeviceId &&
          conn.authorizedDeviceId === device.deviceId &&
          conn.controlPassHashSnapshot &&
          device.controlPassHash &&
          conn.controlPassHashSnapshot === device.controlPassHash,
      );
    }
    if (conn.authType === "token") {
      return Boolean(
        this.config.enableLegacyTokenAuth &&
          conn.accessTokenHashHex &&
          device.legacyAccessTokenHash &&
          timingSafeEqualHex(conn.accessTokenHashHex, device.legacyAccessTokenHash),
      );
    }
    return false;
  }

  private canControllerAccessDevice(conn: ClientConn, deviceId: string): boolean {
    if (conn.role !== "controller" || !isValidDeviceId(deviceId)) {
      return false;
    }
    const device = this.store.getDevice(deviceId);
    if (!device) {
      return false;
    }
    return this.canControllerAccessStoredDevice(conn, device);
  }

  private broadcastDeviceStatus(device: StoredDevice, summaryOverride?: DeviceSummary): void {
    const msg: DeviceStatusMessage = {
      type: "device.status",
      device: cloneDeviceSummary(summaryOverride ?? device.summary),
    };
    const payload = JSON.stringify(msg);

    for (const ctrl of this.controllers) {
      if (
        ctrl.ws.readyState === WebSocket.OPEN &&
        this.canControllerAccessStoredDevice(ctrl, device)
      ) {
        this.sendRawPayload(ctrl.ws, payload);
      }
    }
  }

  private broadcastToOwnerControllers(userId: string, summary: DeviceSummary): void {
    const msg: DeviceStatusMessage = {
      type: "device.status",
      device: cloneDeviceSummary(summary),
    };
    const payload = JSON.stringify(msg);

    for (const ctrl of this.controllers) {
      if (
        ctrl.ws.readyState === WebSocket.OPEN &&
        ctrl.authType === "account" &&
        ctrl.userId === userId
      ) {
        this.sendRawPayload(ctrl.ws, payload);
      }
    }
  }

  private broadcastToLegacyTokenControllers(tokenHashHex: string, summary: DeviceSummary): void {
    const msg: DeviceStatusMessage = {
      type: "device.status",
      device: cloneDeviceSummary(summary),
    };
    const payload = JSON.stringify(msg);

    for (const ctrl of this.controllers) {
      if (
        ctrl.ws.readyState === WebSocket.OPEN &&
        ctrl.authType === "token" &&
        ctrl.accessTokenHashHex &&
        timingSafeEqualHex(ctrl.accessTokenHashHex, tokenHashHex)
      ) {
        this.sendRawPayload(ctrl.ws, payload);
      }
    }
  }

  private parseTextWireMessage(conn: ClientConn, data: RawData): WireMessage | null {
    const buf = rawDataToBuffer(data);
    const maxBytes =
      conn.role === "unauthenticated" ? MAX_PRE_AUTH_TEXT_BYTES : MAX_POST_AUTH_TEXT_BYTES;
    if (buf.byteLength > maxBytes) {
      this.sendError(conn.ws, "INVALID_MESSAGE", "Message payload exceeds allowed size");
      try {
        conn.ws.close(1009, "MESSAGE_TOO_LARGE");
      } catch {
        conn.ws.terminate();
      }
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString("utf8"));
    } catch {
      this.sendError(conn.ws, "INVALID_MESSAGE", "Malformed JSON message");
      return null;
    }

    if (!isWireMessage(parsed)) {
      this.sendError(conn.ws, "INVALID_MESSAGE", "Missing or invalid message type");
      return null;
    }
    return parsed;
  }

  private dispatchPostAuthMessage(conn: ClientConn, parsed: WireMessage): void {
    switch (parsed.type) {
      case "ping": {
        const pong: PongMessage = {
          type: "pong",
          ts: typeof parsed.ts === "number" ? parsed.ts : Date.now(),
        };
        this.sendJson(conn.ws, pong);
        return;
      }
      case "pong":
        return;
      case "agent.telemetry":
        this.handleAgentTelemetry(conn, parsed);
        return;
      case "session.request":
        this.handleSessionRequest(conn, parsed);
        return;
      case "session.ready":
        this.handleSessionReady(conn, parsed);
        return;
      case "rtc.offer":
      case "rtc.answer":
      case "rtc.ice":
      case "clipboard.sync":
        this.handleBidirectionalSessionMessage(conn, parsed);
        return;
      case "control.cmd":
        this.handleControlCmd(conn, parsed);
        return;
      case "control.ack":
        this.handleControlAck(conn, parsed);
        return;
      case "session.end":
        this.handleSessionEnd(conn, parsed);
        return;
      case "error":
        this.handleAgentError(conn, parsed);
        return;
      default:
        this.sendError(
          conn.ws,
          "INVALID_MESSAGE",
          `Unsupported client message type: ${parsed.type}`,
        );
    }
  }

  private handlePostAuthTextMessage(conn: ClientConn, data: RawData): void {
    const parsed = this.parseTextWireMessage(conn, data);
    if (!parsed) {
      return;
    }
    if (parsed.type === "agent.register" || parsed.type === "controller.auth") {
      this.sendError(conn.ws, "INVALID_MESSAGE", "Connection is already authenticated");
      return;
    }
    this.dispatchPostAuthMessage(conn, parsed);
  }

  private async handleTextMessage(conn: ClientConn, data: RawData): Promise<void> {
    const parsed = this.parseTextWireMessage(conn, data);
    if (!parsed) {
      return;
    }

    // Reject all non-auth messages (including ping!) prior to authentication
    if (
      conn.role === "unauthenticated" &&
      parsed.type !== "agent.register" &&
      parsed.type !== "controller.auth"
    ) {
      this.sendError(conn.ws, "UNAUTHORIZED", "Authentication required");
      return;
    }

    // Reject repeat authentication on already-authenticated sockets
    if (
      conn.role !== "unauthenticated" &&
      (parsed.type === "agent.register" || parsed.type === "controller.auth")
    ) {
      this.sendError(conn.ws, "INVALID_MESSAGE", "Connection is already authenticated");
      return;
    }

    if (parsed.type === "agent.register") {
      await this.handleAgentRegister(conn, parsed);
      return;
    }
    if (parsed.type === "controller.auth") {
      await this.handleControllerAuth(conn, parsed);
      return;
    }
    this.dispatchPostAuthMessage(conn, parsed);
  }

  private async handleAgentRegister(conn: ClientConn, msg: AgentRegisterMessage): Promise<void> {
    if (this.isRateLimited(conn.ip)) {
      this.audit.log({
        event: "rate_limit.hit",
        ip: conn.ip,
        ok: false,
        detail: "agent_register_ip_rate_limit",
      });
      this.sendError(conn.ws, "RATE_LIMITED", "Too many failed authentication attempts");
      conn.ws.close(4029, "RATE_LIMITED");
      return;
    }

    const rawDeviceId = typeof msg.deviceId === "string" ? msg.deviceId.trim() : "";
    if (!isValidDeviceId(rawDeviceId)) {
      this.recordFailedAuth(conn.ip);
      this.audit.log({
        event: "agent.register",
        ip: conn.ip,
        ok: false,
        detail: "invalid_device_id",
      });
      this.sendError(
        conn.ws,
        "INVALID_MESSAGE",
        "deviceId must be 8-64 alphanumeric, underscore, or hyphen characters",
      );
      conn.ws.close(4001, "UNAUTHORIZED");
      return;
    }

    if (!isNonEmptyString(msg.deviceSecret) || msg.deviceSecret.length > 256) {
      this.recordFailedAuth(conn.ip);
      this.audit.log({
        event: "agent.register",
        ip: conn.ip,
        ok: false,
        deviceId: rawDeviceId,
        detail: "invalid_device_secret",
      });
      this.sendError(
        conn.ws,
        "UNAUTHORIZED",
        "deviceId and deviceSecret must be non-empty strings",
        { deviceId: rawDeviceId },
      );
      conn.ws.close(4001, "UNAUTHORIZED");
      return;
    }

    const deviceId = rawDeviceId;
    const incomingSecretHashHex = sha256Hex(msg.deviceSecret);
    const existingStored = this.store.getDevice(deviceId);

    if (existingStored) {
      if (!timingSafeEqualHex(existingStored.deviceSecretHash, incomingSecretHashHex)) {
        this.recordFailedAuth(conn.ip);
        this.audit.log({
          event: "agent.register",
          ip: conn.ip,
          ok: false,
          deviceId,
          detail: "device_secret_mismatch",
        });
        this.sendError(
          conn.ws,
          "DEVICE_SECRET_MISMATCH",
          "Device secret does not match existing registration",
          { deviceId },
        );
        conn.ws.close(4003, "DEVICE_SECRET_MISMATCH");
        return;
      }
    } else {
      if (this.isNewDeviceRateLimited(conn.ip)) {
        this.audit.log({
          event: "rate_limit.hit",
          ip: conn.ip,
          ok: false,
          deviceId,
          detail: "new_device_per_hour_limit",
        });
        this.sendError(conn.ws, "RATE_LIMITED", "Too many new devices registered from this IP", {
          deviceId,
        });
        conn.ws.close(4029, "RATE_LIMITED");
        return;
      }
      if (this.store.getDeviceCount() >= this.config.maxDevices) {
        this.audit.log({
          event: "agent.register",
          ip: conn.ip,
          ok: false,
          deviceId,
          detail: "max_devices_quota_exceeded",
        });
        this.sendError(conn.ws, "RATE_LIMITED", "Maximum registered devices quota reached", {
          deviceId,
        });
        conn.ws.close(4029, "RATE_LIMITED");
        return;
      }
    }

    const unbindOwner = msg.unbindOwner === true;
    const hasAuthToken = !unbindOwner && isNonEmptyString(msg.authToken);
    const hasControlPassword = isNonEmptyString(msg.controlPassword);
    const hasAccessToken = this.config.enableLegacyTokenAuth && isNonEmptyString(msg.accessToken);

    if (
      !hasAuthToken &&
      !hasControlPassword &&
      !hasAccessToken &&
      !(unbindOwner && existingStored)
    ) {
      this.recordFailedAuth(conn.ip);
      this.audit.log({
        event: "agent.register",
        ip: conn.ip,
        ok: false,
        deviceId,
        detail: "missing_credentials",
      });
      this.sendError(
        conn.ws,
        "UNAUTHORIZED",
        this.config.enableLegacyTokenAuth
          ? "At least one of authToken, controlPassword, or accessToken must be provided"
          : "At least one of authToken or controlPassword must be provided",
        { deviceId },
      );
      conn.ws.close(4001, "UNAUTHORIZED");
      return;
    }

    let boundUser: UserProfile | null = null;
    let boundTokenVersion: number | undefined;
    if (hasAuthToken) {
      const claims = verifyJwt(msg.authToken!.trim(), this.jwtSecret);
      const userWithTv = claims ? this.store.getUserWithTokenVersion(claims.sub) : null;
      if (!claims || !userWithTv || userWithTv.tokenVersion !== claims.tv) {
        this.recordFailedAuth(conn.ip);
        this.audit.log({
          event: "agent.register",
          ip: conn.ip,
          ok: false,
          deviceId,
          detail: "invalid_jwt",
        });
        this.sendError(
          conn.ws,
          "UNAUTHORIZED",
          "登录状态已失效，请重新登录账号",
          { deviceId },
        );
        conn.ws.close(4001, "UNAUTHORIZED");
        return;
      }
      boundUser = userWithTv.user;
      boundTokenVersion = userWithTv.tokenVersion;
    }

    let controlPassHash = existingStored?.controlPassHash;
    let controlPasswordChanged = false;
    if (hasControlPassword) {
      const incomingPass = msg.controlPassword!;
      if (controlPassHash && (await verifyPassword(incomingPass, controlPassHash))) {
        // Password unchanged; keep existing salted hash (allows upgrading existing devices smoothly)
      } else {
        if (
          incomingPass.length < MIN_CONTROL_PASSWORD_LENGTH ||
          incomingPass.length > MAX_PASSWORD_LENGTH
        ) {
          this.recordFailedAuth(conn.ip);
          this.audit.log({
            event: "agent.register",
            ip: conn.ip,
            ok: false,
            deviceId,
            detail: "weak_control_password",
          });
          this.sendError(
            conn.ws,
            "INVALID_MESSAGE",
            `无人值守密码长度需为 ${MIN_CONTROL_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} 位`,
            { deviceId },
          );
          conn.ws.close(4001, "UNAUTHORIZED");
          return;
        }
        if (controlPassHash) {
          controlPasswordChanged = true;
        }
        controlPassHash = await hashPassword(incomingPass);
      }
    }

    // Socket may have closed or been superseded while async scrypt was running.
    if (this.closed || conn.replaced || conn.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // Prevent stale async scrypt completions from overwriting a newer socket for the same deviceId.
    const existingLive = this.liveAgents.get(deviceId);
    const latestAgentSeq = this.latestAgentSeqByDevice.get(deviceId) ?? 0;
    if (
      (existingLive && existingLive.conn !== conn && existingLive.conn.connSeq > conn.connSeq) ||
      latestAgentSeq > conn.connSeq
    ) {
      this.closeReplacedConnection(conn, 4000, "Replaced by newer agent connection");
      return;
    }

    // Re-read existing device in case of concurrent registration during async scrypt
    const latestStored = this.store.getDevice(deviceId);
    if (latestStored && !timingSafeEqualHex(latestStored.deviceSecretHash, incomingSecretHashHex)) {
      this.recordFailedAuth(conn.ip);
      this.sendError(
        conn.ws,
        "DEVICE_SECRET_MISMATCH",
        "Device secret does not match existing registration",
        { deviceId },
      );
      conn.ws.close(4003, "DEVICE_SECRET_MISMATCH");
      return;
    }
    if (!latestStored && this.store.getDeviceCount() >= this.config.maxDevices) {
      this.sendError(conn.ws, "RATE_LIMITED", "Maximum registered devices quota reached", {
        deviceId,
      });
      conn.ws.close(4029, "RATE_LIMITED");
      return;
    }

    const now = Date.now();
    const controlCode = latestStored?.controlCode ?? this.store.generateUniqueControlCode();
    const previousOwnerUserId = latestStored?.ownerUserId;
    const previousLegacyTokenHash = latestStored?.legacyAccessTokenHash;

    const ownerUserId = unbindOwner
      ? undefined
      : boundUser
        ? boundUser.userId
        : latestStored?.ownerUserId;
    const ownerUsername = unbindOwner
      ? undefined
      : boundUser
        ? boundUser.username
        : ownerUserId
          ? this.store.getUserById(ownerUserId)?.username
          : undefined;

    const legacyAccessTokenHash = hasAccessToken
      ? sha256Hex(msg.accessToken!)
      : latestStored?.legacyAccessTokenHash;

    const summary = this.buildDeviceSummary(
      deviceId,
      msg,
      now,
      existingLive?.summary ?? latestStored?.summary,
      controlCode,
      ownerUsername,
    );

    const updatedRecord: StoredDevice = {
      deviceId,
      deviceSecretHash: latestStored?.deviceSecretHash ?? incomingSecretHashHex,
      controlCode,
      summary,
    };
    if (controlPassHash !== undefined) {
      updatedRecord.controlPassHash = controlPassHash;
    }
    if (ownerUserId !== undefined) {
      updatedRecord.ownerUserId = ownerUserId;
    }
    if (legacyAccessTokenHash !== undefined) {
      updatedRecord.legacyAccessTokenHash = legacyAccessTokenHash;
    }

    setBounded(this.latestAgentSeqByDevice, deviceId, conn.connSeq);

    // Replace existing live socket cleanly before activating the new connection
    const isReplacingLiveAgent = Boolean(existingLive && existingLive.conn !== conn);
    if (existingLive && existingLive.conn !== conn) {
      this.closeReplacedConnection(existingLive.conn, 4000, "Replaced by new agent connection");
    }

    const legacyTokenChanged = Boolean(
      previousLegacyTokenHash &&
        (!legacyAccessTokenHash ||
          !timingSafeEqualHex(previousLegacyTokenHash, legacyAccessTokenHash)),
    );
    const ownerChanged = Boolean(previousOwnerUserId && previousOwnerUserId !== ownerUserId);

    // Save record first so subsequent access checks see the new hashes/owner immediately
    this.store.saveDevice(updatedRecord);
    if (!latestStored) {
      this.recordNewDeviceRegistration(conn.ip);
    }

    // Revoke any active sessions whose controller is no longer authorized after credential changes,
    // and terminate all remaining stale sessions when an agent reconnects on a new socket so zombie
    // sessions never accumulate and exhaust MAX_SESSIONS_PER_DEVICE.
    const endReason = unbindOwner && ownerChanged ? "device_unbound" : "device_access_changed";
    if (isReplacingLiveAgent) {
      this.removeOutOfBandForDevice(deviceId);
    }
    for (const [sessionId, session] of Array.from(this.sessions.entries())) {
      if (session.deviceId !== deviceId) {
        continue;
      }
      const revokedCodeSession =
        controlPasswordChanged && session.controllerConn.authType === "code";
      const accessRevoked =
        revokedCodeSession ||
        !this.canControllerAccessStoredDevice(session.controllerConn, updatedRecord);
      if (accessRevoked || isReplacingLiveAgent) {
        const reason = accessRevoked ? endReason : "agent_reconnected";
        this.sessions.delete(sessionId);
        this.sendJson(session.controllerConn.ws, {
          type: "session.end",
          sessionId,
          deviceId,
          reason,
        });
        this.audit.log({
          event: "session.end",
          ip: conn.ip,
          ok: true,
          userId: session.controllerConn.userId,
          deviceId,
          sessionId,
          detail: reason,
        });
      }
    }

    // Notify and immediately disconnect all controllers affected by credential/ownership rotation
    if (latestStored) {
      const offlineSnapshot = cloneDeviceSummary(existingLive?.summary ?? latestStored.summary);
      offlineSnapshot.online = false;
      offlineSnapshot.lastSeen = now;
      delete offlineSnapshot.ownerUsername;

      if (legacyTokenChanged && previousLegacyTokenHash) {
        this.broadcastToLegacyTokenControllers(previousLegacyTokenHash, offlineSnapshot);
      }
      if (ownerChanged && previousOwnerUserId) {
        this.broadcastToOwnerControllers(previousOwnerUserId, offlineSnapshot);
      }
    }

    const rotatedDetails: string[] = [];
    if (controlPasswordChanged) {
      rotatedDetails.push("control_password");
      for (const ctrl of Array.from(this.controllers)) {
        if (ctrl.authType === "code" && ctrl.authorizedDeviceId === deviceId) {
          this.controllers.delete(ctrl);
          this.endSessionsForController(ctrl, "device_access_changed");
          this.removeOutOfBandForController(ctrl);
          this.closeReplacedConnection(ctrl, 4001, "CREDENTIALS_CHANGED");
        }
      }
    }

    if (legacyTokenChanged && previousLegacyTokenHash) {
      rotatedDetails.push("legacy_token");
      for (const ctrl of Array.from(this.controllers)) {
        if (
          ctrl.authType === "token" &&
          ctrl.accessTokenHashHex &&
          timingSafeEqualHex(ctrl.accessTokenHashHex, previousLegacyTokenHash)
        ) {
          this.controllers.delete(ctrl);
          this.endSessionsForController(ctrl, "device_access_changed");
          this.removeOutOfBandForController(ctrl);
          this.closeReplacedConnection(ctrl, 4001, "CREDENTIALS_CHANGED");
        }
      }
    }

    if (ownerChanged && previousOwnerUserId) {
      rotatedDetails.push(unbindOwner ? "owner_unbound" : "owner_changed");
      for (const ctrl of Array.from(this.controllers)) {
        if (ctrl.authType === "account" && ctrl.userId === previousOwnerUserId) {
          this.controllers.delete(ctrl);
          this.endSessionsForController(ctrl, endReason);
          this.removeOutOfBandForController(ctrl);
          this.closeReplacedConnection(ctrl, 4001, "CREDENTIALS_CHANGED");
        }
      }
      if (unbindOwner) {
        this.audit.log({
          event: "device.unbind",
          ip: conn.ip,
          ok: true,
          userId: previousOwnerUserId,
          deviceId,
          detail: "agent_unbind_owner",
        });
      }
    }

    if (rotatedDetails.length > 0) {
      this.audit.log({
        event: "agent.credentials_rotated",
        ip: conn.ip,
        ok: true,
        userId: ownerUserId,
        deviceId,
        detail: rotatedDetails.join(","),
      });
    }

    this.liveAgents.set(deviceId, { conn, summary });

    this.clearAuthTimer(conn);
    conn.role = "agent";
    conn.deviceId = deviceId;
    if (boundUser && boundTokenVersion !== undefined) {
      conn.agentAuthUserId = boundUser.userId;
      conn.agentAuthTokenVersion = boundTokenVersion;
    } else {
      delete conn.agentAuthUserId;
      delete conn.agentAuthTokenVersion;
    }
    conn.replaced = false;

    this.audit.log({
      event: "agent.register",
      ip: conn.ip,
      ok: true,
      userId: ownerUserId,
      deviceId,
      detail: latestStored ? "reconnected" : "new_device",
    });

    const reply: AgentRegisteredMessage = {
      type: "agent.registered",
      deviceId,
      controlCode,
      serverTime: now,
      iceServers: buildIceServers(this.config, `agent-${deviceId}`, now),
    };
    if (ownerUsername !== undefined) {
      reply.ownerUsername = ownerUsername;
    }
    this.sendJson(conn.ws, reply);
    this.broadcastDeviceStatus(updatedRecord, summary);
  }

  private buildDeviceSummary(
    deviceId: string,
    msg: AgentRegisterMessage,
    now: number,
    prev: DeviceSummary | undefined,
    controlCode: string,
    ownerUsername: string | undefined,
  ): DeviceSummary {
    const summary: DeviceSummary = {
      deviceId,
      controlCode,
      name: sanitizeLabel(msg.name, prev?.name ?? deviceId, 64),
      model: sanitizeLabel(msg.model, prev?.model ?? "Unknown", 64),
      androidVersion: sanitizeLabel(msg.androidVersion, prev?.androidVersion ?? "Unknown", 64),
      online: true,
      lastSeen: now,
      screenWidth: clampNumber(msg.screenWidth, prev?.screenWidth ?? 0, 0, 16_384),
      screenHeight: clampNumber(msg.screenHeight, prev?.screenHeight ?? 0, 0, 16_384),
      rotation: isValidRotation(msg.rotation) ? msg.rotation : (prev?.rotation ?? 0),
      battery: clampNumber(msg.battery, prev?.battery ?? 0, 0, 100),
      charging: typeof msg.charging === "boolean" ? msg.charging : (prev?.charging ?? false),
      locked: typeof msg.locked === "boolean" ? msg.locked : (prev?.locked ?? false),
      capabilities: mergeCapabilities(prev?.capabilities, msg.capabilities),
    };
    if (ownerUsername !== undefined) {
      summary.ownerUsername = ownerUsername;
    }
    const screenOn =
      typeof msg.screenOn === "boolean" ? msg.screenOn : prev?.screenOn;
    if (screenOn !== undefined) {
      summary.screenOn = screenOn;
    }
    const blackScreenActive =
      typeof msg.blackScreenActive === "boolean"
        ? msg.blackScreenActive
        : prev?.blackScreenActive;
    if (blackScreenActive !== undefined) {
      summary.blackScreenActive = blackScreenActive;
    }
    // Validate directUrl strictly (ws:// or wss:// with RFC1918/CGNAT private IPv4 only)
    const validatedIncomingUrl =
      msg.directUrl !== undefined ? validateDirectUrl(msg.directUrl) : undefined;
    const validatedPrevUrl = validateDirectUrl(prev?.directUrl);
    const directUrl =
      msg.directUrl !== undefined ? validatedIncomingUrl : validatedPrevUrl;
    if (directUrl !== undefined) {
      summary.directUrl = directUrl;
    }
    return summary;
  }

  private handleAgentTelemetry(conn: ClientConn, msg: AgentTelemetryMessage): void {
    if (conn.role !== "agent" || !conn.deviceId) {
      this.sendError(conn.ws, "UNAUTHORIZED", "Agent authentication required");
      return;
    }
    if (msg.deviceId && msg.deviceId !== conn.deviceId) {
      this.sendError(conn.ws, "UNAUTHORIZED", "Cannot update telemetry for another device", {
        deviceId: msg.deviceId,
      });
      return;
    }

    const live = this.liveAgents.get(conn.deviceId);
    const stored = this.store.getDevice(conn.deviceId);
    if (!live || live.conn !== conn || !stored) {
      this.sendError(conn.ws, "UNAUTHORIZED", "Agent session is no longer active");
      return;
    }

    const s = live.summary;
    if (typeof msg.screenWidth === "number") {
      s.screenWidth = clampNumber(msg.screenWidth, s.screenWidth, 0, 16_384);
    }
    if (typeof msg.screenHeight === "number") {
      s.screenHeight = clampNumber(msg.screenHeight, s.screenHeight, 0, 16_384);
    }
    if (isValidRotation(msg.rotation)) s.rotation = msg.rotation;
    if (typeof msg.battery === "number") {
      s.battery = clampNumber(msg.battery, s.battery, 0, 100);
    }
    if (typeof msg.charging === "boolean") s.charging = msg.charging;
    if (typeof msg.locked === "boolean") s.locked = msg.locked;
    if (typeof msg.screenOn === "boolean") s.screenOn = msg.screenOn;
    if (typeof msg.blackScreenActive === "boolean") {
      s.blackScreenActive = msg.blackScreenActive;
    }
    if (msg.capabilities) {
      s.capabilities = mergeCapabilities(s.capabilities, msg.capabilities);
    }
    s.lastSeen = Date.now();

    this.store.updateDeviceSummaryInMemory(conn.deviceId, s);
    this.broadcastDeviceStatus(stored, s);
  }

  private isStaleControllerAuth(
    conn: ClientConn,
    authKey: string,
    clientId: string,
    matcher: (existing: ClientConn) => boolean,
  ): boolean {
    if ((this.latestControllerSeqByKey.get(authKey) ?? 0) > conn.connSeq) {
      return true;
    }
    for (const existingCtrl of this.controllers) {
      if (
        existingCtrl !== conn &&
        existingCtrl.controllerId === clientId &&
        matcher(existingCtrl) &&
        existingCtrl.connSeq > conn.connSeq
      ) {
        return true;
      }
    }
    return false;
  }

  private replaceDuplicateController(
    conn: ClientConn,
    clientId: string,
    matcher: (existing: ClientConn) => boolean,
  ): void {
    for (const existingCtrl of Array.from(this.controllers)) {
      if (
        existingCtrl !== conn &&
        existingCtrl.controllerId === clientId &&
        matcher(existingCtrl)
      ) {
        this.controllers.delete(existingCtrl);
        this.endSessionsForController(existingCtrl, "controller_replaced");
        this.removeOutOfBandForController(existingCtrl);
        this.closeReplacedConnection(existingCtrl, 4000, "Replaced by new controller connection");
      }
    }
  }

  private async handleControllerAuth(
    conn: ClientConn,
    msg: ControllerAuthMessage,
  ): Promise<void> {
    if (this.isRateLimited(conn.ip)) {
      this.audit.log({
        event: "rate_limit.hit",
        ip: conn.ip,
        ok: false,
        detail: "controller_auth_ip_rate_limit",
      });
      this.sendError(conn.ws, "RATE_LIMITED", "Too many failed authentication attempts");
      conn.ws.close(4029, "RATE_LIMITED");
      return;
    }

    if (!isNonEmptyString(msg.clientId) || msg.clientId.trim().length > 64) {
      this.recordFailedAuth(conn.ip);
      this.audit.log({
        event: "ws.auth_failed",
        ip: conn.ip,
        ok: false,
        detail: "invalid_client_id",
      });
      this.sendError(conn.ws, "UNAUTHORIZED", "clientId must be a non-empty string (<= 64 chars)");
      conn.ws.close(4001, "UNAUTHORIZED");
      return;
    }

    const clientId = sanitizeLabel(msg.clientId, "", 64);
    if (!clientId) {
      this.recordFailedAuth(conn.ip);
      this.sendError(conn.ws, "UNAUTHORIZED", "clientId must be a non-empty string");
      conn.ws.close(4001, "UNAUTHORIZED");
      return;
    }

    const now = Date.now();

    // 1. Account mode (JWT)
    if (isNonEmptyString(msg.authToken)) {
      const claims = verifyJwt(msg.authToken.trim(), this.jwtSecret);
      const userWithTv = claims ? this.store.getUserWithTokenVersion(claims.sub) : null;
      if (!claims || !userWithTv || userWithTv.tokenVersion !== claims.tv) {
        this.recordFailedAuth(conn.ip);
        this.audit.log({
          event: "ws.auth_failed",
          ip: conn.ip,
          ok: false,
          detail: "invalid_account_jwt",
        });
        this.sendError(conn.ws, "UNAUTHORIZED", "登录状态已失效，请重新登录");
        conn.ws.close(4001, "UNAUTHORIZED");
        return;
      }

      const { user, tokenVersion } = userWithTv;
      const authKey = `account:${user.userId}:${clientId}`;
      const accountMatcher = (existing: ClientConn) =>
        existing.authType === "account" && existing.userId === user.userId;

      if (this.isStaleControllerAuth(conn, authKey, clientId, accountMatcher)) {
        this.closeReplacedConnection(conn, 4000, "Replaced by newer controller connection");
        return;
      }
      setBounded(this.latestControllerSeqByKey, authKey, conn.connSeq);

      this.replaceDuplicateController(conn, clientId, accountMatcher);

      this.clearAuthTimer(conn);
      conn.role = "controller";
      conn.controllerId = clientId;
      conn.authType = "account";
      conn.userId = user.userId;
      conn.tokenVersion = tokenVersion;
      delete conn.authorizedDeviceId;
      delete conn.controlPassHashSnapshot;
      delete conn.accessTokenHashHex;
      if (isNonEmptyString(msg.clientName)) {
        conn.clientName = sanitizeLabel(msg.clientName, clientId, 64);
      }
      conn.replaced = false;
      this.controllers.add(conn);

      this.audit.log({
        event: "ws.auth",
        ip: conn.ip,
        ok: true,
        userId: user.userId,
        username: user.username,
        detail: "account",
      });

      const reply: ControllerAuthedMessage = {
        type: "controller.authed",
        clientId,
        serverTime: now,
        mode: "relay",
        authType: "account",
        user,
        devices: this.listDevicesForOwner(user.userId),
        iceServers: buildIceServers(this.config, `ctrl-${clientId}`, now),
      };
      this.sendJson(conn.ws, reply);
      return;
    }

    // 2. 9-Digit Control Code + Unattended Password mode
    if (isNonEmptyString(msg.controlCode)) {
      const normalizedCode = normalizeControlCode(msg.controlCode);
      const isNineDigits = CONTROL_CODE_REGEX.test(normalizedCode);
      const lockoutKey = isNineDigits ? `code:${normalizedCode}` : null;

      if (lockoutKey && this.isTargetLockedOut(lockoutKey)) {
        this.audit.log({
          event: "lockout.hit",
          ip: conn.ip,
          ok: false,
          detail: "control_code_locked",
        });
        this.sendError(conn.ws, "RATE_LIMITED", "控制码尝试失败次数过多，已临时锁定，请稍后再试");
        conn.ws.close(4029, "RATE_LIMITED");
        return;
      }

      const incomingPassword =
        typeof msg.controlPassword === "string" ? msg.controlPassword : "";
      const device = await this.store.verifyDeviceControlPassword(
        normalizedCode,
        incomingPassword,
      );

      if (this.closed || conn.replaced || conn.ws.readyState !== WebSocket.OPEN) {
        return;
      }

      if (!device || !device.controlPassHash) {
        this.recordFailedAuth(conn.ip);
        if (lockoutKey) {
          this.recordTargetFailure(lockoutKey, conn.ip);
        }
        this.audit.log({
          event: "ws.auth_failed",
          ip: conn.ip,
          ok: false,
          detail: "invalid_control_code_or_password",
        });
        this.sendError(conn.ws, "UNAUTHORIZED", "控制码或无人值守密码错误");
        conn.ws.close(4001, "UNAUTHORIZED");
        return;
      }

      if (lockoutKey) {
        this.clearTargetLockout(lockoutKey);
      }

      const authKey = `code:${device.deviceId}:${clientId}`;
      const codeMatcher = (existing: ClientConn) =>
        existing.authType === "code" && existing.authorizedDeviceId === device.deviceId;
      if (this.isStaleControllerAuth(conn, authKey, clientId, codeMatcher)) {
        this.closeReplacedConnection(conn, 4000, "Replaced by newer controller connection");
        return;
      }
      setBounded(this.latestControllerSeqByKey, authKey, conn.connSeq);

      this.replaceDuplicateController(conn, clientId, codeMatcher);

      this.clearAuthTimer(conn);
      conn.role = "controller";
      conn.controllerId = clientId;
      conn.authType = "code";
      conn.authorizedDeviceId = device.deviceId;
      conn.controlPassHashSnapshot = device.controlPassHash;
      delete conn.userId;
      delete conn.tokenVersion;
      delete conn.accessTokenHashHex;
      if (isNonEmptyString(msg.clientName)) {
        conn.clientName = sanitizeLabel(msg.clientName, clientId, 64);
      }
      conn.replaced = false;
      this.controllers.add(conn);

      this.audit.log({
        event: "ws.auth",
        ip: conn.ip,
        ok: true,
        deviceId: device.deviceId,
        detail: "code",
      });

      const live = this.liveAgents.get(device.deviceId);
      const summary =
        live && live.conn.ws.readyState === WebSocket.OPEN
          ? cloneDeviceSummary(live.summary)
          : cloneDeviceSummary(device.summary);

      const reply: ControllerAuthedMessage = {
        type: "controller.authed",
        clientId,
        serverTime: now,
        mode: "relay",
        authType: "code",
        devices: [summary],
        iceServers: buildIceServers(this.config, `ctrl-${clientId}`, now),
      };
      this.sendJson(conn.ws, reply);
      return;
    }

    // 3. Legacy Shared Access Token mode (disabled by default; must match at least 1 device)
    if (isNonEmptyString(msg.accessToken)) {
      if (!this.config.enableLegacyTokenAuth) {
        this.recordFailedAuth(conn.ip);
        this.audit.log({
          event: "ws.auth_failed",
          ip: conn.ip,
          ok: false,
          detail: "legacy_token_auth_disabled",
        });
        this.sendError(conn.ws, "UNAUTHORIZED", "Legacy accessToken authentication is disabled");
        conn.ws.close(4001, "UNAUTHORIZED");
        return;
      }

      const accessTokenHashHex = sha256Hex(msg.accessToken);
      const matchingDevices = this.listDevicesForLegacyToken(accessTokenHashHex);
      if (matchingDevices.length === 0) {
        this.recordFailedAuth(conn.ip);
        this.audit.log({
          event: "ws.auth_failed",
          ip: conn.ip,
          ok: false,
          detail: "legacy_token_no_matching_device",
        });
        this.sendError(conn.ws, "UNAUTHORIZED", "Invalid accessToken");
        conn.ws.close(4001, "UNAUTHORIZED");
        return;
      }

      const authKey = `token:${accessTokenHashHex}:${clientId}`;
      const tokenMatcher = (existing: ClientConn) =>
        existing.authType === "token" &&
        Boolean(existing.accessTokenHashHex) &&
        timingSafeEqualHex(existing.accessTokenHashHex!, accessTokenHashHex);
      if (this.isStaleControllerAuth(conn, authKey, clientId, tokenMatcher)) {
        this.closeReplacedConnection(conn, 4000, "Replaced by newer controller connection");
        return;
      }
      setBounded(this.latestControllerSeqByKey, authKey, conn.connSeq);

      this.replaceDuplicateController(conn, clientId, tokenMatcher);

      this.clearAuthTimer(conn);
      conn.role = "controller";
      conn.controllerId = clientId;
      conn.authType = "token";
      conn.accessTokenHashHex = accessTokenHashHex;
      delete conn.userId;
      delete conn.tokenVersion;
      delete conn.authorizedDeviceId;
      delete conn.controlPassHashSnapshot;
      if (isNonEmptyString(msg.clientName)) {
        conn.clientName = sanitizeLabel(msg.clientName, clientId, 64);
      }
      conn.replaced = false;
      this.controllers.add(conn);

      this.audit.log({
        event: "ws.auth",
        ip: conn.ip,
        ok: true,
        detail: "token",
      });

      const reply: ControllerAuthedMessage = {
        type: "controller.authed",
        clientId,
        serverTime: now,
        mode: "relay",
        authType: "token",
        devices: matchingDevices,
        iceServers: buildIceServers(this.config, `ctrl-${clientId}`, now),
      };
      this.sendJson(conn.ws, reply);
      return;
    }

    this.recordFailedAuth(conn.ip);
    this.audit.log({
      event: "ws.auth_failed",
      ip: conn.ip,
      ok: false,
      detail: "missing_credentials",
    });
    this.sendError(
      conn.ws,
      "UNAUTHORIZED",
      this.config.enableLegacyTokenAuth
        ? "Authentication credentials required (authToken, controlCode + controlPassword, or accessToken)"
        : "Authentication credentials required (authToken or controlCode + controlPassword)",
    );
    conn.ws.close(4001, "UNAUTHORIZED");
  }

  private handleSessionRequest(conn: ClientConn, msg: SessionRequestMessage): void {
    if (conn.role !== "controller" || !conn.controllerId) {
      this.sendError(conn.ws, "UNAUTHORIZED", "Controller authentication required", {
        sessionId: typeof msg.sessionId === "string" ? msg.sessionId : undefined,
        deviceId: typeof msg.deviceId === "string" ? msg.deviceId : undefined,
      });
      return;
    }

    if (!isValidSessionId(msg.sessionId) || !isValidDeviceId(msg.deviceId)) {
      this.sendError(
        conn.ws,
        "INVALID_MESSAGE",
        "sessionId and deviceId must match /^[a-zA-Z0-9_-]{8,64}$/",
      );
      return;
    }

    if (!isValidTransportMode(msg.preferredTransport) || !isValidStreamQuality(msg.quality)) {
      this.sendError(
        conn.ws,
        "INVALID_MESSAGE",
        "preferredTransport must be 'webrtc' or 'ws-jpeg' and quality must contain positive finite numbers",
        {
          sessionId: msg.sessionId,
          deviceId: msg.deviceId,
        },
      );
      return;
    }

    if (!this.canControllerAccessDevice(conn, msg.deviceId)) {
      this.sendError(conn.ws, "UNAUTHORIZED", "Access denied for target device", {
        sessionId: msg.sessionId,
        deviceId: msg.deviceId,
      });
      return;
    }

    const live = this.liveAgents.get(msg.deviceId);
    if (!live || !live.summary.online || live.conn.ws.readyState !== WebSocket.OPEN) {
      this.sendError(conn.ws, "DEVICE_OFFLINE", "Target device is offline", {
        sessionId: msg.sessionId,
        deviceId: msg.deviceId,
      });
      return;
    }

    const existingSession = this.sessions.get(msg.sessionId);
    if (
      existingSession &&
      (existingSession.controllerConn !== conn || existingSession.deviceId !== msg.deviceId)
    ) {
      this.sendError(conn.ws, "UNAUTHORIZED", "Session ID already belongs to another peer", {
        sessionId: msg.sessionId,
        deviceId: msg.deviceId,
      });
      return;
    }

    if (!existingSession) {
      let deviceSessions = 0;
      let controllerSessions = 0;
      for (const s of this.sessions.values()) {
        if (s.deviceId === msg.deviceId) deviceSessions += 1;
        if (s.controllerConn === conn) controllerSessions += 1;
      }
      if (deviceSessions >= MAX_SESSIONS_PER_DEVICE) {
        this.sendError(conn.ws, "RATE_LIMITED", "Maximum active sessions per device reached", {
          sessionId: msg.sessionId,
          deviceId: msg.deviceId,
        });
        return;
      }
      if (controllerSessions >= MAX_SESSIONS_PER_CONTROLLER) {
        this.sendError(conn.ws, "RATE_LIMITED", "Maximum active sessions per controller reached", {
          sessionId: msg.sessionId,
          deviceId: msg.deviceId,
        });
        return;
      }
    }

    const now = Date.now();
    const session: SessionRecord = {
      sessionId: msg.sessionId,
      deviceId: msg.deviceId,
      controllerId: conn.controllerId,
      controllerConn: conn,
      createdAt: now,
      ready: false,
    };
    this.sessions.set(msg.sessionId, session);

    this.audit.log({
      event: "session.start",
      ip: conn.ip,
      ok: true,
      userId: conn.userId,
      deviceId: msg.deviceId,
      sessionId: msg.sessionId,
      detail: msg.preferredTransport,
    });

    const forwarded: SessionRequestMessage = {
      type: "session.request",
      sessionId: msg.sessionId,
      deviceId: msg.deviceId,
      preferredTransport: msg.preferredTransport,
      quality: {
        maxWidth: msg.quality.maxWidth,
        fps: msg.quality.fps,
        bitrateKbps: msg.quality.bitrateKbps,
        jpegQuality: msg.quality.jpegQuality,
      },
      iceServers: buildIceServers(this.config, `agent-${msg.deviceId}`, now),
    };
    this.sendJson(live.conn.ws, forwarded);
  }

  private getAgentForSession(session: SessionRecord): ClientConn | null {
    const live = this.liveAgents.get(session.deviceId);
    if (!live || !live.summary.online) {
      return null;
    }
    if (live.conn.ws.readyState !== WebSocket.OPEN) {
      return null;
    }
    return live.conn;
  }

  private isSessionAgent(conn: ClientConn, session: SessionRecord): boolean {
    if (conn.role !== "agent" || conn.deviceId !== session.deviceId) {
      return false;
    }
    const live = this.liveAgents.get(session.deviceId);
    return live?.conn === conn;
  }

  private handleSessionReady(conn: ClientConn, msg: SessionReadyMessage): void {
    const session = this.sessions.get(msg.sessionId);
    if (!session) {
      this.sendError(conn.ws, "SESSION_NOT_FOUND", "Active session not found", {
        sessionId: msg.sessionId,
        deviceId: msg.deviceId,
      });
      return;
    }
    if (!this.isSessionAgent(conn, session)) {
      this.sendError(conn.ws, "UNAUTHORIZED", "Only the target agent may send session.ready", {
        sessionId: msg.sessionId,
        deviceId: msg.deviceId,
      });
      return;
    }
    if (msg.deviceId !== session.deviceId) {
      this.sendError(conn.ws, "INVALID_MESSAGE", "deviceId does not match session", {
        sessionId: msg.sessionId,
        deviceId: msg.deviceId,
      });
      return;
    }
    session.ready = true;
    const forwarded: SessionReadyMessage = {
      ...msg,
      iceServers: buildIceServers(this.config, `ctrl-${session.controllerId}`),
    };
    this.sendJson(session.controllerConn.ws, forwarded);
  }

  private countOutOfBandForController(conn: ClientConn): number {
    let count = 0;
    for (const entries of this.outOfBandCmds.values()) {
      for (const entry of entries) {
        if (entry.controllerConn === conn) {
          count += 1;
        }
      }
    }
    return count;
  }

  private removeOutOfBandForController(conn: ClientConn): void {
    for (const [key, entries] of Array.from(this.outOfBandCmds.entries())) {
      const remaining = entries.filter((entry) => entry.controllerConn !== conn);
      if (remaining.length === 0) {
        this.outOfBandCmds.delete(key);
      } else if (remaining.length !== entries.length) {
        this.outOfBandCmds.set(key, remaining);
      }
    }
  }

  private removeOutOfBandForDevice(deviceId: string): void {
    for (const [key, entries] of Array.from(this.outOfBandCmds.entries())) {
      const remaining = entries.filter((entry) => entry.deviceId !== deviceId);
      if (remaining.length === 0) {
        this.outOfBandCmds.delete(key);
      } else if (remaining.length !== entries.length) {
        this.outOfBandCmds.set(key, remaining);
      }
    }
  }

  private handleControlCmd(conn: ClientConn, msg: ControlCmdMessage): void {
    // Validate text / clipboard payload sizes before forwarding
    const cmd = msg.command;
    if (!cmd || typeof cmd !== "object" || typeof cmd.action !== "string") {
      this.sendError(conn.ws, "INVALID_MESSAGE", "Invalid control command");
      return;
    }
    if (cmd.action === "text" || cmd.action === "clipboard_set") {
      if (
        typeof cmd.text !== "string" ||
        Buffer.byteLength(cmd.text, "utf8") > MAX_CLIPBOARD_TEXT_BYTES
      ) {
        this.sendError(conn.ws, "INVALID_MESSAGE", "Text payload exceeds maximum 64KB limit", {
          sessionId: msg.sessionId,
          deviceId: msg.deviceId,
        });
        return;
      }
    }

    // Allow sessionless wake / unlock commands from an authorized controller (e.g. Dashboard "唤醒" button)
    if (!isNonEmptyString(msg.sessionId)) {
      if (conn.role !== "controller") {
        this.sendError(conn.ws, "UNAUTHORIZED", "Controller authentication required", {
          deviceId: msg.deviceId,
        });
        return;
      }
      const action = cmd.action;
      if (action !== "wake" && action !== "unlock" && action !== "black_screen") {
        this.sendError(
          conn.ws,
          "SESSION_NOT_FOUND",
          "Active session required for this control command",
          { sessionId: msg.sessionId, deviceId: msg.deviceId },
        );
        return;
      }
      if (!isValidDeviceId(msg.deviceId) || !this.canControllerAccessDevice(conn, msg.deviceId)) {
        this.sendError(conn.ws, "UNAUTHORIZED", "Access denied for target device", {
          deviceId: msg.deviceId,
        });
        return;
      }
      const live = this.liveAgents.get(msg.deviceId);
      if (!live || !live.summary.online || live.conn.ws.readyState !== WebSocket.OPEN) {
        this.sendError(conn.ws, "DEVICE_OFFLINE", "Target device is offline", {
          deviceId: msg.deviceId,
        });
        return;
      }
      if (typeof msg.seq === "number" && Number.isFinite(msg.seq)) {
        const key = `${msg.deviceId}:${msg.seq}`;
        const existingQueue = this.outOfBandCmds.get(key) ?? [];
        const existingForCtrl = existingQueue.find((entry) => entry.controllerConn === conn);
        if (
          !existingForCtrl &&
          this.countOutOfBandForController(conn) >= MAX_OUT_OF_BAND_PER_CONTROLLER
        ) {
          this.sendError(conn.ws, "RATE_LIMITED", "Too many pending out-of-band control commands", {
            deviceId: msg.deviceId,
          });
          return;
        }
        if (existingForCtrl) {
          existingForCtrl.createdAt = Date.now();
        } else {
          existingQueue.push({
            controllerConn: conn,
            deviceId: msg.deviceId,
            createdAt: Date.now(),
          });
          this.outOfBandCmds.set(key, existingQueue);
        }
      }

      // Audit wake / unlock (strictly NEVER log PIN!)
      this.audit.log({
        event: action === "wake" ? "control.wake" : "control.unlock",
        ip: conn.ip,
        ok: true,
        userId: conn.userId,
        deviceId: msg.deviceId,
        detail: "sessionless",
      });

      this.sendJson(live.conn.ws, msg);
      return;
    }

    const session = this.sessions.get(msg.sessionId);
    if (!session) {
      this.sendError(conn.ws, "SESSION_NOT_FOUND", "Active session not found", {
        sessionId: msg.sessionId,
        deviceId: msg.deviceId,
      });
      return;
    }
    if (session.controllerConn !== conn) {
      this.sendError(conn.ws, "UNAUTHORIZED", "Only the owning controller may send control.cmd", {
        sessionId: msg.sessionId,
        deviceId: msg.deviceId,
      });
      return;
    }
    if (msg.deviceId !== session.deviceId) {
      this.sendError(conn.ws, "INVALID_MESSAGE", "deviceId does not match session", {
        sessionId: msg.sessionId,
        deviceId: msg.deviceId,
      });
      return;
    }
    const agentConn = this.getAgentForSession(session);
    if (!agentConn) {
      this.sendError(conn.ws, "DEVICE_OFFLINE", "Target device is offline", {
        sessionId: msg.sessionId,
        deviceId: session.deviceId,
      });
      return;
    }

    if (cmd.action === "wake" || cmd.action === "unlock") {
      this.audit.log({
        event: cmd.action === "wake" ? "control.wake" : "control.unlock",
        ip: conn.ip,
        ok: true,
        userId: conn.userId,
        deviceId: session.deviceId,
        sessionId: session.sessionId,
      });
    }

    this.sendJson(agentConn.ws, msg);
  }

  private handleControlAck(conn: ClientConn, msg: ControlAckMessage): void {
    if (!isNonEmptyString(msg.sessionId)) {
      if (conn.role !== "agent" || !conn.deviceId) {
        return;
      }
      const live = this.liveAgents.get(conn.deviceId);
      if (!live || live.conn !== conn) {
        return;
      }
      if (isNonEmptyString(msg.deviceId) && msg.deviceId !== conn.deviceId) {
        return;
      }
      if (typeof msg.seq === "number" && Number.isFinite(msg.seq)) {
        const key = `${conn.deviceId}:${msg.seq}`;
        const queue = this.outOfBandCmds.get(key);
        if (queue && queue.length > 0) {
          const pending = queue.shift();
          if (queue.length === 0) {
            this.outOfBandCmds.delete(key);
          }
          if (pending) {
            this.sendJson(pending.controllerConn.ws, msg);
          }
        }
      }
      return;
    }

    const session = this.sessions.get(msg.sessionId);
    if (!session) {
      this.sendError(conn.ws, "SESSION_NOT_FOUND", "Active session not found", {
        sessionId: msg.sessionId,
        deviceId: msg.deviceId,
      });
      return;
    }
    if (!this.isSessionAgent(conn, session)) {
      this.sendError(conn.ws, "UNAUTHORIZED", "Only the target agent may send control.ack", {
        sessionId: msg.sessionId,
        deviceId: msg.deviceId,
      });
      return;
    }
    if (msg.deviceId !== session.deviceId) {
      this.sendError(conn.ws, "INVALID_MESSAGE", "deviceId does not match session", {
        sessionId: msg.sessionId,
        deviceId: msg.deviceId,
      });
      return;
    }
    this.sendJson(session.controllerConn.ws, msg);
  }

  private handleBidirectionalSessionMessage(
    conn: ClientConn,
    msg: RtcOfferMessage | RtcAnswerMessage | RtcIceMessage | ClipboardSyncMessage,
  ): void {
    if (msg.type === "clipboard.sync") {
      if (
        typeof msg.text !== "string" ||
        Buffer.byteLength(msg.text, "utf8") > MAX_CLIPBOARD_TEXT_BYTES
      ) {
        this.sendError(conn.ws, "INVALID_MESSAGE", "Clipboard text exceeds 64KB limit", {
          sessionId: msg.sessionId,
          deviceId: msg.deviceId,
        });
        return;
      }
    }

    const session = this.sessions.get(msg.sessionId);
    if (!session) {
      this.sendError(conn.ws, "SESSION_NOT_FOUND", "Active session not found", {
        sessionId: msg.sessionId,
        deviceId: msg.deviceId,
      });
      return;
    }

    if (msg.deviceId !== session.deviceId) {
      this.sendError(conn.ws, "INVALID_MESSAGE", "deviceId does not match session", {
        sessionId: msg.sessionId,
        deviceId: msg.deviceId,
      });
      return;
    }

    if (session.controllerConn === conn) {
      const agentConn = this.getAgentForSession(session);
      if (!agentConn) {
        this.sendError(conn.ws, "DEVICE_OFFLINE", "Target device is offline", {
          sessionId: msg.sessionId,
          deviceId: session.deviceId,
        });
        return;
      }
      this.sendJson(agentConn.ws, msg);
      return;
    }

    if (this.isSessionAgent(conn, session)) {
      this.sendJson(session.controllerConn.ws, msg);
      return;
    }

    this.sendError(conn.ws, "UNAUTHORIZED", "Not authorized for this session", {
      sessionId: msg.sessionId,
      deviceId: msg.deviceId,
    });
  }

  private handleSessionEnd(conn: ClientConn, msg: SessionEndMessage): void {
    const session = this.sessions.get(msg.sessionId);
    if (!session) {
      this.sendError(conn.ws, "SESSION_NOT_FOUND", "Active session not found", {
        sessionId: msg.sessionId,
        deviceId: msg.deviceId,
      });
      return;
    }

    const fromController = session.controllerConn === conn;
    const fromAgent = this.isSessionAgent(conn, session);
    if (!fromController && !fromAgent) {
      this.sendError(conn.ws, "UNAUTHORIZED", "Not authorized to end this session", {
        sessionId: msg.sessionId,
        deviceId: msg.deviceId,
      });
      return;
    }

    if (msg.deviceId !== session.deviceId) {
      this.sendError(conn.ws, "INVALID_MESSAGE", "deviceId does not match session", {
        sessionId: msg.sessionId,
        deviceId: msg.deviceId,
      });
      return;
    }

    this.sessions.delete(session.sessionId);

    this.audit.log({
      event: "session.end",
      ip: conn.ip,
      ok: true,
      userId: session.controllerConn.userId,
      deviceId: session.deviceId,
      sessionId: session.sessionId,
      detail: typeof msg.reason === "string" ? msg.reason : "ended",
    });

    if (fromController) {
      const agentConn = this.getAgentForSession(session);
      if (agentConn) {
        this.sendJson(agentConn.ws, msg);
      }
    } else {
      this.sendJson(session.controllerConn.ws, msg);
    }
  }

  private static readonly AGENT_FORWARDABLE_ERROR_CODES = new Set<ErrorMessage["code"]>([
    "INTERNAL_ERROR",
    "SESSION_NOT_FOUND",
    "INVALID_MESSAGE",
    "DEVICE_OFFLINE",
  ]);

  private static readonly TERMINAL_AGENT_ERROR_CODES = new Set<ErrorMessage["code"]>([
    "INTERNAL_ERROR",
    "SESSION_NOT_FOUND",
    "DEVICE_OFFLINE",
  ]);

  private handleAgentError(conn: ClientConn, msg: ErrorMessage): void {
    if (conn.role !== "agent" || !conn.deviceId) {
      this.sendError(conn.ws, "INVALID_MESSAGE", "Unsupported client message type: error");
      return;
    }

    const live = this.liveAgents.get(conn.deviceId);
    if (!live || live.conn !== conn) {
      return;
    }

    // Never allow an agent to emit errors targeting another deviceId
    if (isNonEmptyString(msg.deviceId) && msg.deviceId !== conn.deviceId) {
      return;
    }

    const code: ErrorMessage["code"] =
      typeof msg.code === "string" &&
      VeloDeckHub.AGENT_FORWARDABLE_ERROR_CODES.has(msg.code as ErrorMessage["code"])
        ? (msg.code as ErrorMessage["code"])
        : "INTERNAL_ERROR";
    const message =
      typeof msg.message === "string" && msg.message.trim().length > 0
        ? msg.message.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 512)
        : "Agent reported an error";
    const isTerminal = VeloDeckHub.TERMINAL_AGENT_ERROR_CODES.has(code);

    if (isNonEmptyString(msg.sessionId)) {
      const session = this.sessions.get(msg.sessionId);
      if (!session || !this.isSessionAgent(conn, session)) {
        return;
      }
      if (isTerminal) {
        this.sessions.delete(session.sessionId);
        this.audit.log({
          event: "session.end",
          ip: conn.ip,
          ok: true,
          userId: session.controllerConn.userId,
          deviceId: session.deviceId,
          sessionId: session.sessionId,
          detail: `agent_error:${code}`,
        });
      }
      const forwarded: ErrorMessage = {
        type: "error",
        code,
        message,
        sessionId: session.sessionId,
        deviceId: session.deviceId,
      };
      this.sendJson(session.controllerConn.ws, forwarded);
      return;
    }

    // Fallback: no sessionId supplied; forward to active session(s) owned by this agent
    for (const [sessionId, session] of Array.from(this.sessions.entries())) {
      if (!this.isSessionAgent(conn, session)) {
        continue;
      }
      if (isTerminal) {
        this.sessions.delete(sessionId);
        this.audit.log({
          event: "session.end",
          ip: conn.ip,
          ok: true,
          userId: session.controllerConn.userId,
          deviceId: session.deviceId,
          sessionId,
          detail: `agent_error:${code}`,
        });
      }
      const forwarded: ErrorMessage = {
        type: "error",
        code,
        message,
        sessionId,
        deviceId: session.deviceId,
      };
      this.sendJson(session.controllerConn.ws, forwarded);
    }
  }

  private handleBinaryMessage(conn: ClientConn, data: RawData): void {
    if (conn.role === "unauthenticated") {
      this.sendError(conn.ws, "UNAUTHORIZED", "Authentication required");
      try {
        conn.ws.close(4001, "UNAUTHORIZED");
      } catch {
        conn.ws.terminate();
      }
      return;
    }
    if (conn.role !== "agent" || !conn.deviceId) {
      return;
    }

    const buf = rawDataToBuffer(data);
    const sessionId = peekMediaFrameSessionId(buf);
    if (!sessionId) {
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session || !this.isSessionAgent(conn, session)) {
      return;
    }

    const ctrlWs = session.controllerConn.ws;
    if (ctrlWs.readyState !== WebSocket.OPEN) {
      return;
    }
    if (ctrlWs.bufferedAmount > MAX_CONTROLLER_BUFFERED_BYTES) {
      // Drop frame to prevent unbounded memory growth under slow controller networks.
      return;
    }

    try {
      ctrlWs.send(buf, { binary: true });
    } catch {
      // Ignore transient send errors on closing controller socket.
    }
  }

  private endSessionsForController(ctrlConn: ClientConn, reason: string): void {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.controllerConn === ctrlConn) {
        this.sessions.delete(sessionId);
        const agentConn = this.getAgentForSession(session);
        if (agentConn) {
          this.sendJson(agentConn.ws, {
            type: "session.end",
            sessionId,
            deviceId: session.deviceId,
            reason,
          });
        }
        this.audit.log({
          event: "session.end",
          ip: ctrlConn.ip,
          ok: true,
          userId: ctrlConn.userId,
          deviceId: session.deviceId,
          sessionId,
          detail: reason,
        });
      }
    }
  }

  private handleDisconnect(conn: ClientConn): void {
    this.clearAuthTimer(conn);
    this.clearReplaceTimer(conn);
    this.connections.delete(conn);
    this.releaseIpSlot(conn);

    if (conn.replaced) {
      return;
    }

    if (conn.role === "agent" && conn.deviceId) {
      const live = this.liveAgents.get(conn.deviceId);
      if (live && live.conn === conn) {
        this.liveAgents.delete(conn.deviceId);
        live.summary.online = false;
        live.summary.lastSeen = Date.now();
        // Avoid immediate disk persistence on transient disconnect lastSeen updates;
        // startup loadFromDisk() resets online=false for all persisted devices anyway.
        this.store.updateDeviceSummaryInMemory(conn.deviceId, live.summary);
        this.removeOutOfBandForDevice(conn.deviceId);

        for (const [sessionId, session] of Array.from(this.sessions.entries())) {
          if (session.deviceId === conn.deviceId) {
            this.sessions.delete(sessionId);
            this.sendJson(session.controllerConn.ws, {
              type: "session.end",
              sessionId,
              deviceId: session.deviceId,
              reason: "device_disconnected",
            });
            this.audit.log({
              event: "session.end",
              ip: conn.ip,
              ok: true,
              userId: session.controllerConn.userId,
              deviceId: session.deviceId,
              sessionId,
              detail: "device_disconnected",
            });
          }
        }

        const stored = this.store.getDevice(conn.deviceId);
        if (stored) {
          this.broadcastDeviceStatus(stored, live.summary);
        }
      }
      return;
    }

    if (conn.role === "controller") {
      this.controllers.delete(conn);
      this.removeOutOfBandForController(conn);
      this.endSessionsForController(conn, "controller_disconnected");
    }
  }
}
