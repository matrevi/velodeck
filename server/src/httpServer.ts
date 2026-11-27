import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { WebSocketServer } from "ws";
import type { UserProfile } from "@velodeck/protocol";
import { AuditLogger } from "./audit.js";
import {
  loadOrCreateJwtSecret,
  signJwt,
  timingSafeEqualString,
  verifyJwt,
} from "./auth.js";
import type { ServerConfig } from "./config.js";
import { extractClientIp, isLoopbackIp, VeloDeckHub } from "./hub.js";
import { isValidDeviceId, VeloDeckStore, StoreError } from "./store.js";

const SERVER_VERSION = "1.0.9";
const VERSIONED_APK_DOWNLOAD_RE = /^\/api\/download\/velodeck-agent-v[0-9A-Za-z._-]+\.apk$/;
const MAX_JSON_BODY_BYTES = 32 * 1024;
const MAX_WS_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2 MB

const BASE_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const HTML_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "font-src 'self' data:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const BUILTIN_ALLOWED_ORIGINS = new Set([
  "capacitor://localhost",
  "app://velodeck",
  "app://velodeck-host",
  "https://localhost",
  "http://localhost",
]);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

const COMPRESSIBLE_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".webmanifest",
  ".svg",
  ".txt",
]);

const ASSET_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".webmanifest",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".ico",
  ".wasm",
  ".map",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
]);

class BodyParseError extends Error {
  public readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "BodyParseError";
    this.statusCode = statusCode;
  }
}

interface ApkHashCache {
  mtimeMs: number;
  size: number;
  sha256: string;
}

export interface VeloDeckServer {
  httpServer: http.Server;
  wss: WebSocketServer;
  hub: VeloDeckHub;
  store: VeloDeckStore;
  listen: () => Promise<{ host: string; port: number }>;
  close: () => Promise<void>;
}

function normalizeOrigin(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      // URL.origin normalizes default :80 (http) and :443 (https) ports and lowercases scheme/host.
      return parsed.origin.toLowerCase();
    }
  } catch {
    // Non-HTTP scheme or malformed origin; fall back to lowercased string.
  }
  return trimmed.toLowerCase();
}

function normalizeHostForProtocol(host: string, protocol: string): string {
  const lower = host.trim().toLowerCase();
  if (protocol === "http:" && lower.endsWith(":80")) {
    return lower.slice(0, -3);
  }
  if (protocol === "https:" && lower.endsWith(":443")) {
    return lower.slice(0, -4);
  }
  return lower;
}

function isAllowedOrigin(
  originHeader: string,
  req: IncomingMessage,
  allowedOriginSet: ReadonlySet<string>,
): boolean {
  const normalized = normalizeOrigin(originHeader);
  if (normalized.length === 0) {
    return false;
  }
  if (BUILTIN_ALLOWED_ORIGINS.has(normalized) || allowedOriginSet.has(normalized)) {
    return true;
  }

  const reqHost = typeof req.headers.host === "string" ? req.headers.host.trim().toLowerCase() : "";
  if (!reqHost) {
    return false;
  }

  try {
    const parsed = new URL(originHeader.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return parsed.host.toLowerCase() === normalizeHostForProtocol(reqHost, parsed.protocol);
  } catch {
    return false;
  }
}

function buildApiCorsHeaders(
  req: IncomingMessage,
  allowedOriginSet: ReadonlySet<string>,
): { headers: Record<string, string>; originAllowed: boolean; hasOrigin: boolean } {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.trim().length === 0) {
    return {
      headers: { Vary: "Origin" },
      originAllowed: true,
      hasOrigin: false,
    };
  }
  if (isAllowedOrigin(origin, req, allowedOriginSet)) {
    return {
      headers: {
        "Access-Control-Allow-Origin": origin.trim(),
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Token",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Expose-Headers": "X-APK-SHA256, Content-Length, Content-Range, ETag",
        Vary: "Origin",
      },
      originAllowed: true,
      hasOrigin: true,
    };
  }
  return {
    headers: { Vary: "Origin" },
    originAllowed: false,
    hasOrigin: true,
  };
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  headOnly: boolean,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    ...BASE_SECURITY_HEADERS,
    ...(extraHeaders ?? {}),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  if (headOnly) {
    res.end();
  } else {
    res.end(payload);
  }
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const contentLengthHeader = req.headers["content-length"];
    if (contentLengthHeader) {
      const declared = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
        req.pause();
        reject(new BodyParseError(413, "请求体过大"));
        return;
      }
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    req.on("data", (chunk: Buffer | string) => {
      if (settled) {
        return;
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      totalBytes += buf.byteLength;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        settled = true;
        req.pause();
        reject(new BodyParseError(413, "请求体过大"));
        return;
      }
      chunks.push(buf);
    });

    req.on("error", () => {
      if (!settled) {
        settled = true;
        reject(new BodyParseError(400, "读取请求失败"));
      }
    });

    req.on("close", () => {
      if (!settled && !req.complete) {
        settled = true;
        reject(new BodyParseError(400, "请求连接已提前关闭"));
      }
    });

    req.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          reject(new BodyParseError(400, "请求体必须为 JSON 对象"));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new BodyParseError(400, "无效的 JSON 请求体"));
      }
    });
  });
}

function handleBodyError(
  req: IncomingMessage,
  res: ServerResponse,
  err: unknown,
  corsHeaders: Record<string, string>,
): void {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  const status = err instanceof BodyParseError ? err.statusCode : 400;
  const message = err instanceof Error ? err.message : "无效请求体";
  const extraHeaders =
    status === 413 ? { ...corsHeaders, Connection: "close" } : corsHeaders;
  sendJson(res, status, { ok: false, error: message }, false, extraHeaders);
  if (status === 413) {
    res.once("finish", () => {
      req.socket.destroy();
    });
  }
}

function getCacheControl(relPosixPath: string): string {
  const baseName = path.posix.basename(relPosixPath);
  if (baseName === "index.html" || baseName === "sw.js") {
    return "no-cache, no-store, must-revalidate";
  }
  if (baseName === "manifest.webmanifest") {
    return "no-cache";
  }
  if (relPosixPath.startsWith("assets/")) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

function isBenignStreamAbortError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ERR_STREAM_DESTROYED" ||
    code === "ABORT_ERR"
  );
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    const st = await fsp.stat(dirPath);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    const st = await fsp.stat(filePath);
    return st.isFile();
  } catch {
    return false;
  }
}

type ParsedByteRange =
  | { kind: "ignore" }
  | { kind: "unsatisfiable" }
  | { kind: "range"; start: number; end: number };

function parseSingleByteRange(rangeHeader: string, totalSize: number): ParsedByteRange {
  const trimmed = rangeHeader.trim();
  if (!/^bytes=/i.test(trimmed)) {
    return { kind: "ignore" };
  }
  const spec = trimmed.slice(6).trim();
  // Multi-part ranges (comma-separated) fall back cleanly to 200 OK per RFC 9110 §14.2
  if (spec.includes(",")) {
    return { kind: "ignore" };
  }
  if (totalSize <= 0) {
    return { kind: "unsatisfiable" };
  }
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) {
    return { kind: "unsatisfiable" };
  }
  const startStr = match[1] ?? "";
  const endStr = match[2] ?? "";
  if (startStr.length === 0 && endStr.length === 0) {
    return { kind: "unsatisfiable" };
  }
  if (startStr.length === 0) {
    // Suffix byte range: bytes=-N (last N bytes)
    const suffixLen = Number(endStr);
    if (!Number.isSafeInteger(suffixLen) || suffixLen <= 0) {
      return { kind: "unsatisfiable" };
    }
    const start = Math.max(0, totalSize - suffixLen);
    return { kind: "range", start, end: totalSize - 1 };
  }
  const start = Number(startStr);
  if (!Number.isSafeInteger(start) || start < 0 || start >= totalSize) {
    return { kind: "unsatisfiable" };
  }
  if (endStr.length === 0) {
    return { kind: "range", start, end: totalSize - 1 };
  }
  const rawEnd = Number(endStr);
  if (!Number.isSafeInteger(rawEnd) || rawEnd < start) {
    return { kind: "unsatisfiable" };
  }
  return { kind: "range", start, end: Math.min(rawEnd, totalSize - 1) };
}

function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function createVeloDeckServer(config: ServerConfig): VeloDeckServer {
  const startedAt = Date.now();
  const audit = new AuditLogger(config.dataDir);
  const store = new VeloDeckStore(config.dataDir, {
    maxUsers: config.maxUsers,
    maxDevices: config.maxDevices,
  });
  const jwtSecret = loadOrCreateJwtSecret(config.dataDir, config.jwtSecret);
  const hub = new VeloDeckHub(config, store, jwtSecret, audit);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });

  const allowedOriginSet = new Set(
    config.allowedOrigins.map((origin) => normalizeOrigin(origin)).filter(Boolean),
  );

  let apkHashCache: ApkHashCache | null = null;
  let apkHashInFlight: { mtimeMs: number; size: number; promise: Promise<string> } | null = null;

  const getApkMetadata = async (): Promise<{
    hasAndroidApk: boolean;
    apkSha256: string | null;
    size: number | null;
  }> => {
    try {
      const stat = await fsp.stat(config.apkPath);
      if (!stat.isFile()) {
        apkHashCache = null;
        return { hasAndroidApk: false, apkSha256: null, size: null };
      }
      if (
        apkHashCache &&
        apkHashCache.mtimeMs === stat.mtimeMs &&
        apkHashCache.size === stat.size
      ) {
        return { hasAndroidApk: true, apkSha256: apkHashCache.sha256, size: stat.size };
      }

      let hashPromise: Promise<string>;
      if (
        apkHashInFlight &&
        apkHashInFlight.mtimeMs === stat.mtimeMs &&
        apkHashInFlight.size === stat.size
      ) {
        hashPromise = apkHashInFlight.promise;
      } else {
        const p = computeFileSha256(config.apkPath);
        apkHashInFlight = { mtimeMs: stat.mtimeMs, size: stat.size, promise: p };
        p.finally(() => {
          if (apkHashInFlight?.promise === p) {
            apkHashInFlight = null;
          }
        }).catch(() => {});
        hashPromise = p;
      }

      const sha256 = await hashPromise;
      apkHashCache = { mtimeMs: stat.mtimeMs, size: stat.size, sha256 };
      return { hasAndroidApk: true, apkSha256: sha256, size: stat.size };
    } catch {
      apkHashCache = null;
      return { hasAndroidApk: false, apkSha256: null, size: null };
    }
  };

  wss.on("connection", (ws, req) => {
    hub.handleConnection(ws, req);
  });

  const staticRoot = path.resolve(config.staticDir);
  const staticRootPrefix = staticRoot.endsWith(path.sep)
    ? staticRoot
    : `${staticRoot}${path.sep}`;

  const authenticateBearer = (req: IncomingMessage): UserProfile | null => {
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== "string") {
      return null;
    }
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
    if (!match?.[1]) {
      return null;
    }
    const claims = verifyJwt(match[1], jwtSecret);
    if (!claims) {
      return null;
    }
    const userWithTv = store.getUserWithTokenVersion(claims.sub);
    if (!userWithTv || userWithTv.tokenVersion !== claims.tv) {
      return null;
    }
    return userWithTv.user;
  };

  const isAdminAuthorized = (req: IncomingMessage): boolean => {
    const adminHeader = req.headers["x-admin-token"];
    if (
      config.adminToken &&
      typeof adminHeader === "string" &&
      timingSafeEqualString(adminHeader.trim(), config.adminToken)
    ) {
      return true;
    }
    const socketIsLoopback = isLoopbackIp(req.socket?.remoteAddress);
    const clientIpIsLoopback = isLoopbackIp(extractClientIp(req, config.trustProxy));
    return socketIsLoopback && clientIpIsLoopback;
  };

  const getRegistrationStatus = () => {
    const userCount = store.getUserCount();
    const underQuota = userCount < config.maxUsers;
    const hasInviteConfigured = Boolean(config.registrationInviteCode);
    switch (config.registrationMode) {
      case "open":
        return {
          registrationMode: config.registrationMode,
          registrationOpen: underQuota,
          requiresInviteCode: false,
        };
      case "closed":
        return {
          registrationMode: config.registrationMode,
          registrationOpen: false,
          requiresInviteCode: false,
        };
      case "invite":
        return {
          registrationMode: config.registrationMode,
          registrationOpen: hasInviteConfigured && underQuota,
          requiresInviteCode: true,
        };
      case "first-user-then-invite": {
        const isFirstUser = userCount === 0;
        return {
          registrationMode: config.registrationMode,
          registrationOpen: (isFirstUser || hasInviteConfigured) && underQuota,
          requiresInviteCode: !isFirstUser,
        };
      }
    }
  };

  const handleApiRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    method: string,
    headOnly: boolean,
  ): Promise<void> => {
    const cors = buildApiCorsHeaders(req, allowedOriginSet);

    if (method === "OPTIONS") {
      if (cors.hasOrigin && !cors.originAllowed) {
        sendJson(res, 403, { ok: false, error: "Origin Not Allowed" }, false, cors.headers);
        return;
      }
      res.writeHead(204, {
        ...BASE_SECURITY_HEADERS,
        ...cors.headers,
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    if (pathname === "/api/info") {
      if (method !== "GET" && method !== "HEAD") {
        sendJson(res, 405, { ok: false, error: "Method Not Allowed" }, headOnly, {
          ...cors.headers,
          Allow: "GET, HEAD, OPTIONS",
        });
        return;
      }
      const apkMeta = await getApkMetadata();
      const regStatus = getRegistrationStatus();
      sendJson(
        res,
        200,
        {
          ok: true,
          version: SERVER_VERSION,
          hasAndroidApk: apkMeta.hasAndroidApk,
          apkSha256: apkMeta.apkSha256,
          registrationMode: regStatus.registrationMode,
          registrationOpen: regStatus.registrationOpen,
          requiresInviteCode: regStatus.requiresInviteCode,
        },
        headOnly,
        cors.headers,
      );
      return;
    }

    if (pathname === "/api/admin/stats") {
      if (method !== "GET" && method !== "HEAD") {
        sendJson(res, 405, { ok: false, error: "Method Not Allowed" }, headOnly, {
          ...cors.headers,
          Allow: "GET, HEAD, OPTIONS",
        });
        return;
      }
      if (!isAdminAuthorized(req)) {
        sendJson(res, 403, { ok: false, error: "Forbidden" }, headOnly, cors.headers);
        return;
      }
      sendJson(
        res,
        200,
        {
          ok: true,
          version: SERVER_VERSION,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          ...hub.getStats(),
        },
        headOnly,
        cors.headers,
      );
      return;
    }

    if (pathname === "/api/auth/register") {
      if (method !== "POST") {
        sendJson(res, 405, { ok: false, error: "Method Not Allowed" }, headOnly, {
          ...cors.headers,
          Allow: "POST, OPTIONS",
        });
        return;
      }
      const ip = extractClientIp(req, config.trustProxy);
      if (hub.isRateLimited(ip) || hub.isRegisterRateLimited(ip)) {
        audit.log({
          event: "rate_limit.hit",
          ip,
          ok: false,
          detail: "http_register_rate_limit",
        });
        sendJson(
          res,
          429,
          { ok: false, error: "请求过于频繁，请稍后再试" },
          false,
          cors.headers,
        );
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        handleBodyError(req, res, err, cors.headers);
        return;
      }

      const inviteCode = typeof body.inviteCode === "string" ? body.inviteCode.trim() : "";

      if (config.registrationMode === "closed") {
        audit.log({
          event: "auth.register",
          ip,
          ok: false,
          detail: "registration_closed",
        });
        sendJson(
          res,
          403,
          { ok: false, error: "当前服务器已关闭新用户注册" },
          false,
          cors.headers,
        );
        return;
      }

      if (config.registrationMode === "invite") {
        if (!config.registrationInviteCode) {
          audit.log({
            event: "auth.register",
            ip,
            ok: false,
            detail: "invite_code_unconfigured",
          });
          sendJson(
            res,
            403,
            { ok: false, error: "公网注册已自动锁定，请联系管理员配置邀请码" },
            false,
            cors.headers,
          );
          return;
        }
        if (!timingSafeEqualString(inviteCode, config.registrationInviteCode)) {
          hub.recordFailedAuth(ip);
          hub.recordRegisterAttempt(ip);
          audit.log({
            event: "auth.register",
            ip,
            ok: false,
            detail: "invalid_invite_code",
          });
          sendJson(res, 403, { ok: false, error: "邀请码无效" }, false, cors.headers);
          return;
        }
      }

      let requireFirstUser = false;
      if (config.registrationMode === "first-user-then-invite") {
        const hasValidInvite =
          Boolean(config.registrationInviteCode) &&
          timingSafeEqualString(inviteCode, config.registrationInviteCode!);

        if (store.getUserCount() > 0) {
          if (!config.registrationInviteCode) {
            audit.log({
              event: "auth.register",
              ip,
              ok: false,
              detail: "first_user_locked_no_invite",
            });
            sendJson(
              res,
              403,
              { ok: false, error: "公网注册已自动锁定，请联系管理员配置邀请码" },
              false,
              cors.headers,
            );
            return;
          }
          if (!hasValidInvite) {
            hub.recordFailedAuth(ip);
            hub.recordRegisterAttempt(ip);
            audit.log({
              event: "auth.register",
              ip,
              ok: false,
              detail: "invalid_invite_code",
            });
            sendJson(res, 403, { ok: false, error: "邀请码无效" }, false, cors.headers);
            return;
          }
        } else if (!hasValidInvite) {
          // Enforce first-user check again inside store.createUser() after async scrypt to close TOCTOU window.
          requireFirstUser = true;
        }
      }

      hub.recordRegisterAttempt(ip);

      const username = typeof body.username === "string" ? body.username : "";
      const password = typeof body.password === "string" ? body.password : "";
      const displayName =
        typeof body.displayName === "string" ? body.displayName : undefined;

      try {
        const user = await store.createUser(username, password, displayName, {
          requireFirstUser,
        });
        const tv = store.getUserTokenVersion(user.userId) ?? 1;
        const token = signJwt({ sub: user.userId, username: user.username, tv }, jwtSecret);
        audit.log({
          event: "auth.register",
          ip,
          ok: true,
          userId: user.userId,
          username: user.username,
        });
        sendJson(res, 201, { ok: true, token, user }, false, cors.headers);
      } catch (err) {
        if (err instanceof StoreError) {
          audit.log({
            event: "auth.register",
            ip,
            ok: false,
            detail: err.code,
          });
          sendJson(
            res,
            err.statusCode,
            { ok: false, error: err.message },
            false,
            cors.headers,
          );
          return;
        }
        throw err;
      }
      return;
    }

    if (pathname === "/api/auth/login") {
      if (method !== "POST") {
        sendJson(res, 405, { ok: false, error: "Method Not Allowed" }, headOnly, {
          ...cors.headers,
          Allow: "POST, OPTIONS",
        });
        return;
      }
      const ip = extractClientIp(req, config.trustProxy);
      if (hub.isRateLimited(ip)) {
        audit.log({
          event: "rate_limit.hit",
          ip,
          ok: false,
          detail: "http_login_ip_rate_limit",
        });
        sendJson(
          res,
          429,
          { ok: false, error: "登录尝试过于频繁，请稍后再试" },
          false,
          cors.headers,
        );
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        handleBodyError(req, res, err, cors.headers);
        return;
      }

      const username = typeof body.username === "string" ? body.username : "";
      const password = typeof body.password === "string" ? body.password : "";
      const normalizedUsername = username.trim().toLowerCase();
      const lockoutKey = normalizedUsername.length > 0 ? `user:${normalizedUsername}` : null;

      if (lockoutKey && hub.isTargetLockedOut(lockoutKey)) {
        audit.log({
          event: "lockout.hit",
          ip,
          ok: false,
          username: normalizedUsername,
          detail: "login_account_locked",
        });
        sendJson(
          res,
          429,
          { ok: false, error: "该账号登录失败次数过多，已临时锁定，请稍后再试" },
          false,
          cors.headers,
        );
        return;
      }

      const user = await store.authenticateUser(username, password);
      if (!user) {
        hub.recordFailedAuth(ip);
        if (lockoutKey) {
          hub.recordTargetFailure(lockoutKey, ip);
        }
        audit.log({
          event: "auth.login",
          ip,
          ok: false,
          username: normalizedUsername || undefined,
          detail: "invalid_credentials",
        });
        sendJson(
          res,
          401,
          { ok: false, error: "用户名或密码错误" },
          false,
          cors.headers,
        );
        return;
      }

      if (lockoutKey) {
        hub.clearTargetLockout(lockoutKey);
      }
      const tv = store.getUserTokenVersion(user.userId) ?? 1;
      const token = signJwt({ sub: user.userId, username: user.username, tv }, jwtSecret);
      audit.log({
        event: "auth.login",
        ip,
        ok: true,
        userId: user.userId,
        username: user.username,
      });
      sendJson(res, 200, { ok: true, token, user }, false, cors.headers);
      return;
    }

    if (pathname === "/api/auth/logout-all") {
      if (method !== "POST") {
        sendJson(res, 405, { ok: false, error: "Method Not Allowed" }, headOnly, {
          ...cors.headers,
          Allow: "POST, OPTIONS",
        });
        return;
      }
      const user = authenticateBearer(req);
      if (!user) {
        sendJson(
          res,
          401,
          { ok: false, error: "未登录或登录状态已失效" },
          false,
          cors.headers,
        );
        return;
      }
      const ip = extractClientIp(req, config.trustProxy);
      store.bumpTokenVersion(user.userId);
      hub.revokeUserSessions(user.userId, "CREDENTIALS_CHANGED");
      audit.log({
        event: "auth.logout_all",
        ip,
        ok: true,
        userId: user.userId,
        username: user.username,
      });
      sendJson(res, 200, { ok: true }, false, cors.headers);
      return;
    }

    if (pathname === "/api/auth/change-password") {
      if (method !== "POST") {
        sendJson(res, 405, { ok: false, error: "Method Not Allowed" }, headOnly, {
          ...cors.headers,
          Allow: "POST, OPTIONS",
        });
        return;
      }
      const ip = extractClientIp(req, config.trustProxy);
      if (hub.isRateLimited(ip)) {
        audit.log({
          event: "rate_limit.hit",
          ip,
          ok: false,
          detail: "http_change_password_rate_limit",
        });
        sendJson(
          res,
          429,
          { ok: false, error: "请求过于频繁，请稍后再试" },
          false,
          cors.headers,
        );
        return;
      }

      const user = authenticateBearer(req);
      if (!user) {
        sendJson(
          res,
          401,
          { ok: false, error: "未登录或登录状态已失效" },
          false,
          cors.headers,
        );
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        handleBodyError(req, res, err, cors.headers);
        return;
      }

      const currentPassword =
        typeof body.currentPassword === "string" ? body.currentPassword : "";
      const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

      try {
        const { user: updatedUser, tokenVersion } = await store.changeUserPassword(
          user.userId,
          currentPassword,
          newPassword,
        );
        hub.revokeUserSessions(user.userId, "CREDENTIALS_CHANGED");
        const token = signJwt(
          { sub: updatedUser.userId, username: updatedUser.username, tv: tokenVersion },
          jwtSecret,
        );
        audit.log({
          event: "auth.change_password",
          ip,
          ok: true,
          userId: updatedUser.userId,
          username: updatedUser.username,
        });
        sendJson(res, 200, { ok: true, token, user: updatedUser }, false, cors.headers);
      } catch (err) {
        if (err instanceof StoreError) {
          if (err.code === "INVALID_CREDENTIALS") {
            hub.recordFailedAuth(ip);
          }
          audit.log({
            event: "auth.change_password",
            ip,
            ok: false,
            userId: user.userId,
            username: user.username,
            detail: err.code,
          });
          sendJson(
            res,
            err.statusCode,
            { ok: false, error: err.message },
            false,
            cors.headers,
          );
          return;
        }
        throw err;
      }
      return;
    }

    if (pathname === "/api/auth/me") {
      if (method !== "GET" && method !== "HEAD") {
        sendJson(res, 405, { ok: false, error: "Method Not Allowed" }, headOnly, {
          ...cors.headers,
          Allow: "GET, HEAD, OPTIONS",
        });
        return;
      }
      const user = authenticateBearer(req);
      if (!user) {
        sendJson(
          res,
          401,
          { ok: false, error: "未登录或登录状态已失效" },
          headOnly,
          cors.headers,
        );
        return;
      }
      const devices = hub.listDevicesForOwner(user.userId);
      sendJson(res, 200, { ok: true, user, devices }, headOnly, cors.headers);
      return;
    }

    if (pathname === "/api/devices/unbind") {
      if (method !== "POST") {
        sendJson(res, 405, { ok: false, error: "Method Not Allowed" }, headOnly, {
          ...cors.headers,
          Allow: "POST, OPTIONS",
        });
        return;
      }
      const user = authenticateBearer(req);
      if (!user) {
        sendJson(
          res,
          401,
          { ok: false, error: "未登录或登录状态已失效" },
          false,
          cors.headers,
        );
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        handleBodyError(req, res, err, cors.headers);
        return;
      }

      const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
      if (!isValidDeviceId(deviceId)) {
        sendJson(res, 400, { ok: false, error: "无效的 deviceId" }, false, cors.headers);
        return;
      }

      const ip = extractClientIp(req, config.trustProxy);
      const unbound = hub.unbindDevice(user.userId, deviceId, ip);
      if (!unbound) {
        sendJson(
          res,
          404,
          { ok: false, error: "设备不存在或未绑定到当前账号" },
          false,
          cors.headers,
        );
        return;
      }
      sendJson(res, 200, { ok: true }, false, cors.headers);
      return;
    }

    if (
      pathname === "/api/download/velodeck-agent.apk" ||
      pathname === "/api/download/android" ||
      VERSIONED_APK_DOWNLOAD_RE.test(pathname)
    ) {
      if (method !== "GET" && method !== "HEAD") {
        sendJson(res, 405, { ok: false, error: "Method Not Allowed" }, headOnly, {
          ...cors.headers,
          Allow: "GET, HEAD, OPTIONS",
        });
        return;
      }

      if (config.requireAuthForApk) {
        const user = authenticateBearer(req);
        if (!user) {
          sendJson(
            res,
            401,
            { ok: false, error: "需要登录后才能下载 Android 安装包" },
            headOnly,
            cors.headers,
          );
          return;
        }
      }

      const apkMeta = await getApkMetadata();
      if (!apkMeta.hasAndroidApk || apkMeta.size === null) {
        sendJson(
          res,
          404,
          { error: "Android APK 尚未上传" },
          headOnly,
          cors.headers,
        );
        return;
      }

      // Disable socket/request/response idle timeouts so slow mobile links never drop mid-APK transfer
      req.setTimeout(0);
      res.setTimeout(0);
      req.socket?.setTimeout(0);

      const totalSize = apkMeta.size;
      const etag = apkMeta.apkSha256 ? `"${apkMeta.apkSha256}"` : null;

      const baseDlHeaders: Record<string, string | number> = {
        ...BASE_SECURITY_HEADERS,
        ...cors.headers,
        "Content-Type": "application/vnd.android.package-archive",
        "Content-Disposition": `attachment; filename="velodeck-agent-v${SERVER_VERSION}.apk"`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
      };
      if (apkMeta.apkSha256) {
        baseDlHeaders["X-APK-SHA256"] = apkMeta.apkSha256;
      }
      if (etag) {
        baseDlHeaders.ETag = etag;
      }

      const rangeHeader = typeof req.headers.range === "string" ? req.headers.range : null;
      const ifNoneMatch =
        typeof req.headers["if-none-match"] === "string" ? req.headers["if-none-match"].trim() : null;
      if (etag && !rangeHeader && ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === `W/${etag}`)) {
        res.writeHead(304, {
          ...BASE_SECURITY_HEADERS,
          ...cors.headers,
          ETag: etag,
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
        });
        res.end();
        return;
      }

      // Respect If-Range per RFC 9110 §13.1.5 so stale partial downloads restart cleanly after APK upgrades
      const ifRange =
        typeof req.headers["if-range"] === "string" ? req.headers["if-range"].trim() : null;
      const ifRangeAllowsRange = !ifRange || (etag !== null && ifRange === etag);

      let statusCode = 200;
      let start = 0;
      let end = totalSize - 1;
      const dlHeaders: Record<string, string | number> = { ...baseDlHeaders };

      if (rangeHeader && ifRangeAllowsRange) {
        const parsedRange = parseSingleByteRange(rangeHeader, totalSize);
        if (parsedRange.kind === "unsatisfiable") {
          res.writeHead(416, {
            ...BASE_SECURITY_HEADERS,
            ...cors.headers,
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes */${totalSize}`,
            "Content-Length": 0,
            ...(etag ? { ETag: etag } : {}),
          });
          res.end();
          return;
        }
        if (parsedRange.kind === "range") {
          statusCode = 206;
          start = parsedRange.start;
          end = parsedRange.end;
          dlHeaders["Content-Range"] = `bytes ${start}-${end}/${totalSize}`;
          dlHeaders["Content-Length"] = end - start + 1;
        } else {
          dlHeaders["Content-Length"] = totalSize;
        }
      } else {
        dlHeaders["Content-Length"] = totalSize;
      }

      res.writeHead(statusCode, dlHeaders);
      if (headOnly || totalSize === 0) {
        res.end();
        return;
      }

      try {
        const streamOpts = statusCode === 206 ? { start, end } : undefined;
        await pipeline(fs.createReadStream(config.apkPath, streamOpts), res);
      } catch (err) {
        if (!isBenignStreamAbortError(err)) {
          console.error("[velodeck-server] APK download stream error:", err);
        }
        if (!res.writableEnded) {
          res.destroy();
        }
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: "API Not Found" }, headOnly, cors.headers);
  };

  const handleRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const method = req.method ?? "GET";
    const headOnly = method === "HEAD";

    const rawUrl = req.url ?? "/";
    const rawPathPart = rawUrl.split("?")[0] ?? "/";
    let rawDecodedPath: string;
    try {
      rawDecodedPath = decodeURIComponent(rawPathPart);
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid URL encoding" }, headOnly);
      return;
    }

    if (rawDecodedPath.includes("\0")) {
      sendJson(res, 400, { ok: false, error: "Invalid path" }, headOnly);
      return;
    }

    // Reject explicit path-traversal segments before URL normalization collapses them.
    if (
      rawDecodedPath
        .split(/[\\/]/)
        .some((segment) => segment === "..")
    ) {
      sendJson(res, 403, { ok: false, error: "Forbidden" }, headOnly);
      return;
    }

    let pathname: string;
    try {
      const url = new URL(rawUrl, "http://localhost");
      pathname = url.pathname;
    } catch {
      sendJson(res, 400, { ok: false, error: "Bad Request" }, headOnly);
      return;
    }

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      await handleApiRequest(req, res, pathname, method, headOnly);
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      sendJson(res, 405, { ok: false, error: "Method Not Allowed" }, false, {
        Allow: "GET, HEAD",
      });
      return;
    }

    // Minimal unauthenticated health probe (no operational telemetry leaked publicly)
    if (pathname === "/health") {
      sendJson(res, 200, { ok: true }, headOnly);
      return;
    }

    if (!(await isDirectory(staticRoot))) {
      if (pathname === "/" || pathname === "/index.html") {
        sendJson(
          res,
          200,
          {
            ok: true,
            service: "velodeck-server",
            version: SERVER_VERSION,
            wsEndpoint: "/ws",
            healthEndpoint: "/health",
            apiEndpoint: "/api/info",
          },
          headOnly,
        );
        return;
      }
      sendJson(res, 404, { ok: false, error: "Not Found" }, headOnly);
      return;
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid URL encoding" }, headOnly);
      return;
    }

    if (decodedPath.includes("\0")) {
      sendJson(res, 400, { ok: false, error: "Invalid path" }, headOnly);
      return;
    }

    const relativePath = decodedPath.replace(/^\/+/, "");
    let targetPath = relativePath
      ? path.resolve(staticRoot, relativePath)
      : path.join(staticRoot, "index.html");

    if (targetPath !== staticRoot && !targetPath.startsWith(staticRootPrefix)) {
      sendJson(res, 403, { ok: false, error: "Forbidden" }, headOnly);
      return;
    }

    if (await isDirectory(targetPath)) {
      targetPath = path.join(targetPath, "index.html");
    }

    if (!(await isFile(targetPath))) {
      const ext = path.extname(decodedPath).toLowerCase();
      const isAssetRoute =
        decodedPath.startsWith("/assets/") || ASSET_EXTENSIONS.has(ext);
      if (isAssetRoute) {
        sendJson(res, 404, { ok: false, error: "Asset Not Found" }, headOnly);
        return;
      }

      const fallbackIndex = path.join(staticRoot, "index.html");
      if (await isFile(fallbackIndex)) {
        targetPath = fallbackIndex;
      } else {
        sendJson(res, 404, { ok: false, error: "Not Found" }, headOnly);
        return;
      }
    }

    // Re-verify real path after symlink resolution to prevent symlink escapes.
    let realRoot: string;
    let realTarget: string;
    try {
      realRoot = await fsp.realpath(staticRoot);
      realTarget = await fsp.realpath(targetPath);
    } catch {
      sendJson(res, 404, { ok: false, error: "Not Found" }, headOnly);
      return;
    }
    const realRootPrefix = realRoot.endsWith(path.sep)
      ? realRoot
      : `${realRoot}${path.sep}`;
    if (!realTarget.startsWith(realRootPrefix)) {
      sendJson(res, 403, { ok: false, error: "Forbidden" }, headOnly);
      return;
    }

    const stat = await fsp.stat(realTarget);
    const ext = path.extname(realTarget).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    const relPosix = path
      .relative(realRoot, realTarget)
      .split(path.sep)
      .join(path.posix.sep);

    const acceptEncoding =
      typeof req.headers["accept-encoding"] === "string"
        ? req.headers["accept-encoding"]
        : "";
    const shouldGzip =
      !headOnly &&
      stat.size >= 1024 &&
      COMPRESSIBLE_EXTENSIONS.has(ext) &&
      /\bgzip\b/i.test(acceptEncoding);

    const staticHeaders: Record<string, string | number> = {
      ...BASE_SECURITY_HEADERS,
      "Content-Type": contentType,
      "Cache-Control": getCacheControl(relPosix),
      Vary: "Accept-Encoding",
    };
    if (shouldGzip) {
      staticHeaders["Content-Encoding"] = "gzip";
    } else {
      staticHeaders["Content-Length"] = stat.size;
    }
    if (ext === ".html") {
      staticHeaders["Content-Security-Policy"] = HTML_CONTENT_SECURITY_POLICY;
    }

    res.writeHead(200, staticHeaders);

    if (headOnly) {
      res.end();
      return;
    }

    try {
      if (shouldGzip) {
        await pipeline(fs.createReadStream(realTarget), zlib.createGzip({ level: 6 }), res);
      } else {
        await pipeline(fs.createReadStream(realTarget), res);
      }
    } catch (err) {
      if (!isBenignStreamAbortError(err)) {
        console.error("[velodeck-server] Static file stream error:", err);
      }
      if (!res.writableEnded) {
        res.destroy();
      }
    }
  };

  const httpServer = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      console.error("[velodeck-server] Unhandled HTTP request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, {
          ...BASE_SECURITY_HEADERS,
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ ok: false, error: "Internal Server Error" }));
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 15_000;
  httpServer.keepAliveTimeout = 15_000;

  httpServer.on("upgrade", (req, socket, head) => {
    const onSocketErr = () => {};
    socket.on("error", onSocketErr);

    let pathname = "";
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      pathname = url.pathname;
    } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    if (pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    // Validate browser Origin header on WS upgrades (allow absent Origin for native OkHttp/CLI clients)
    const originHeader = req.headers.origin;
    if (originHeader !== undefined && !isAllowedOrigin(originHeader, req, allowedOriginSet)) {
      audit.log({
        event: "ws.origin_rejected",
        ip: extractClientIp(req, config.trustProxy),
        ok: false,
        detail: "mismatched_origin",
      });
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    if ("setNoDelay" in socket && typeof socket.setNoDelay === "function") {
      socket.setNoDelay(true);
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      socket.off("error", onSocketErr);
      wss.emit("connection", ws, req);
    });
  });

  const listen = (): Promise<{ host: string; port: number }> => {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        httpServer.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        const addr = httpServer.address() as AddressInfo | null;
        resolve({
          host: addr?.address ?? config.host,
          port: addr?.port ?? config.port,
        });
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(config.port, config.host);
    });
  };

  const close = async (): Promise<void> => {
    hub.close();
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    if (httpServer.listening) {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
        httpServer.closeAllConnections?.();
      });
    }
    await Promise.all([store.flush(), audit.flush()]);
  };

  return {
    httpServer,
    wss,
    hub,
    store,
    listen,
    close,
  };
}
