import path from "node:path";
import { fileURLToPath } from "node:url";
import { isWeakTurnSecret } from "./turn.js";

export type RegistrationMode =
  | "first-user-then-invite"
  | "invite"
  | "open"
  | "closed";

export interface ServerConfig {
  port: number;
  host: string;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  authTimeoutMs: number;
  stunUrls: string[];
  turnUrls: string[];
  turnSecret?: string;
  turnUsername?: string;
  turnPassword?: string;
  turnTtlSeconds: number;
  staticDir: string;
  dataDir: string;
  jwtSecret?: string;
  apkPath: string;
  maxFailedAuthPerMin: number;
  trustProxy: boolean;
  registrationMode: RegistrationMode;
  registrationInviteCode?: string;
  enableLegacyTokenAuth: boolean;
  allowedOrigins: string[];
  adminToken?: string;
  maxUsers: number;
  maxDevices: number;
  maxWsConnections: number;
  maxWsPerIp: number;
  requireAuthForApk: boolean;
}

export const DEFAULT_STUN_URLS = [
  "stun:stun.miwifi.com:3478",
  "stun:stun.chat.bilibili.com:3478",
];

const VALID_REGISTRATION_MODES = new Set<RegistrationMode>([
  "first-user-then-invite",
  "invite",
  "open",
  "closed",
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, "..");
const DEFAULT_STATIC_DIR = path.resolve(SERVER_ROOT, "../controller/dist");
const DEFAULT_DATA_DIR = path.resolve(SERVER_ROOT, "data");
const DEFAULT_APK_PATH = path.resolve(SERVER_ROOT, "downloads", "velodeck-agent.apk");

function parseIntEnv(
  raw: string | undefined,
  fallback: number,
  minValue: number,
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < minValue) {
    return fallback;
  }
  return parsed;
}

function parseBoolEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  return raw.trim().toLowerCase() === "true";
}

function parseListEnv(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined) {
    return [...fallback];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseOptionalString(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseRegistrationMode(raw: string | undefined): RegistrationMode {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed) {
    return "first-user-then-invite";
  }
  if (VALID_REGISTRATION_MODES.has(trimmed as RegistrationMode)) {
    return trimmed as RegistrationMode;
  }
  console.warn(
    `[velodeck-server] Unknown REGISTRATION_MODE "${trimmed}"; defaulting to "closed" for safety.`,
  );
  return "closed";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const staticDirEnv = parseOptionalString(env.STATIC_DIR);
  const staticDir = staticDirEnv
    ? path.resolve(staticDirEnv)
    : DEFAULT_STATIC_DIR;

  const dataDirEnv = parseOptionalString(env.DATA_DIR);
  const dataDir =
    dataDirEnv === ":memory:"
      ? ":memory:"
      : dataDirEnv
        ? path.resolve(dataDirEnv)
        : DEFAULT_DATA_DIR;

  const apkPathEnv = parseOptionalString(env.APK_PATH);
  const apkPath = apkPathEnv ? path.resolve(apkPathEnv) : DEFAULT_APK_PATH;

  const jwtSecret = parseOptionalString(env.JWT_SECRET);
  const publicIp = parseOptionalString(env.PUBLIC_IP);
  const turnSecret = parseOptionalString(env.TURN_SECRET);
  const turnUsername = parseOptionalString(env.TURN_USERNAME);
  const turnPassword = parseOptionalString(env.TURN_PASSWORD);
  const registrationInviteCode = parseOptionalString(env.REGISTRATION_INVITE_CODE);
  const adminToken = parseOptionalString(env.ADMIN_TOKEN);

  if (turnSecret !== undefined) {
    if (isWeakTurnSecret(turnSecret)) {
      throw new Error(
        "Refusing to start with weak placeholder TURN_SECRET. Generate a strong secret with `openssl rand -hex 32`.",
      );
    }
    if (turnSecret.length < 16) {
      console.warn(
        "[velodeck-server] TURN_SECRET is shorter than 16 characters; generate a strong secret with `openssl rand -hex 32`.",
      );
    }
  }

  const heartbeatIntervalMs = parseIntEnv(env.HEARTBEAT_INTERVAL_MS, 15_000, 100);
  let heartbeatTimeoutMs = parseIntEnv(env.HEARTBEAT_TIMEOUT_MS, 35_000, 200);
  if (heartbeatTimeoutMs <= heartbeatIntervalMs) {
    const clamped = Math.max(heartbeatTimeoutMs, heartbeatIntervalMs * 2);
    console.warn(
      `[velodeck-server] HEARTBEAT_TIMEOUT_MS (${heartbeatTimeoutMs}) must exceed HEARTBEAT_INTERVAL_MS (${heartbeatIntervalMs}); clamping to ${clamped}ms.`,
    );
    heartbeatTimeoutMs = clamped;
  }

  let turnUrls = parseListEnv(env.TURN_URLS, []);
  if (turnUrls.length === 0 && publicIp !== undefined && turnSecret !== undefined) {
    const formattedHost =
      publicIp.includes(":") && !publicIp.startsWith("[") ? `[${publicIp}]` : publicIp;
    turnUrls = [
      `turn:${formattedHost}:3478?transport=udp`,
      `turn:${formattedHost}:3478?transport=tcp`,
    ];
  }

  const config: ServerConfig = {
    port: parseIntEnv(env.PORT, 8080, 0),
    host: parseOptionalString(env.HOST) ?? "0.0.0.0",
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    authTimeoutMs: parseIntEnv(env.WS_AUTH_TIMEOUT_MS, 10_000, 50),
    stunUrls: parseListEnv(env.STUN_URLS, DEFAULT_STUN_URLS),
    turnUrls,
    turnTtlSeconds: parseIntEnv(env.TURN_TTL_SECONDS, 1_800, 60),
    staticDir,
    dataDir,
    apkPath,
    maxFailedAuthPerMin: parseIntEnv(env.MAX_FAILED_AUTH_PER_MIN, 30, 1),
    trustProxy: parseBoolEnv(env.TRUST_PROXY, false),
    registrationMode: parseRegistrationMode(env.REGISTRATION_MODE),
    enableLegacyTokenAuth: parseBoolEnv(env.ENABLE_LEGACY_TOKEN_AUTH, false),
    allowedOrigins: parseListEnv(env.ALLOWED_ORIGINS, []),
    maxUsers: parseIntEnv(env.MAX_USERS, 100, 1),
    maxDevices: parseIntEnv(env.MAX_DEVICES, 100, 1),
    maxWsConnections: parseIntEnv(env.MAX_WS_CONNECTIONS, 500, 1),
    maxWsPerIp: parseIntEnv(env.MAX_WS_PER_IP, 15, 1),
    requireAuthForApk: parseBoolEnv(env.REQUIRE_AUTH_FOR_APK, false),
  };

  if (jwtSecret !== undefined) {
    config.jwtSecret = jwtSecret;
  }
  if (turnSecret !== undefined) {
    config.turnSecret = turnSecret;
  }
  if (turnUsername !== undefined) {
    config.turnUsername = turnUsername;
  }
  if (turnPassword !== undefined) {
    config.turnPassword = turnPassword;
  }
  if (registrationInviteCode !== undefined) {
    config.registrationInviteCode = registrationInviteCode;
  }
  if (adminToken !== undefined) {
    config.adminToken = adminToken;
  }

  return config;
}
