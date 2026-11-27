import type { TransportMode } from "@velodeck/protocol";

export type ConnectionMode = "relay" | "direct";
export type QualityPreset = "auto" | "eco" | "balanced" | "hd";

export interface ConnectionProfile {
  id: string;
  label: string;
  mode: ConnectionMode;
  wsUrl: string;
  accessToken: string;
  preferredTransport: TransportMode;
  qualityPreset: QualityPreset;
  updatedAt?: number;
}

export interface QuickConnectParams {
  wsUrl: string;
  accessToken: string;
  mode: ConnectionMode;
  label: string;
  preferredTransport: TransportMode;
  qualityPreset: QualityPreset;
  deviceId?: string;
}

export interface QuickConnectSecurityAssessment {
  requiresConfirmation: boolean;
  isExternalHost: boolean;
  isInsecurePublicWs: boolean;
  protocol: string;
  host: string;
}

export const PROFILES_STORAGE_KEY = "velodeck.controller.profiles.v1";
export const ACTIVE_PROFILE_STORAGE_KEY = "velodeck.controller.activeProfileId.v1";
export const CLIENT_ID_STORAGE_KEY = "velodeck.controller.clientId.v1";
const envApiBase =
  typeof import.meta !== "undefined" &&
  typeof (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_DEFAULT_API_BASE === "string"
    ? (import.meta as { env?: Record<string, string | undefined> }).env!.VITE_DEFAULT_API_BASE!.trim()
    : "";
const envWsUrl =
  typeof import.meta !== "undefined" &&
  typeof (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_DEFAULT_WS_URL === "string"
    ? (import.meta as { env?: Record<string, string | undefined> }).env!.VITE_DEFAULT_WS_URL!.trim()
    : "";
export const DEFAULT_CLOUD_API_BASE = envApiBase || "http://localhost:8080";
export const DEFAULT_CLOUD_WS_URL = envWsUrl || "ws://localhost:8080/ws";

const QUICK_CONNECT_QUERY_KEYS = [
  "url",
  "wsUrl",
  "token",
  "accessToken",
  "mode",
  "label",
  "transport",
  "quality",
  "deviceId",
] as const;

function getSafeStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    return null;
  }
  return null;
}

function getSafeSessionStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      return window.sessionStorage;
    }
  } catch {
    return null;
  }
  return null;
}

let inMemoryClientId: string | null = null;

export function generateId(prefix = "prof"): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID().slice(0, 12)}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function detectDefaultWsUrl(
  loc?: Pick<Location, "protocol" | "host"> | null,
): string {
  const target =
    loc !== undefined ? loc : typeof window !== "undefined" ? window.location : null;
  if (!target || !target.host) {
    return "";
  }
  if (target.protocol === "https:") {
    return `wss://${target.host}/ws`;
  }
  if (target.protocol === "http:") {
    return `ws://${target.host}/ws`;
  }
  return "";
}

/**
 * Returns "" (same-origin) when running in a browser over HTTP/HTTPS,
 * or the default public relay server base URL when running in Capacitor / file://.
 */
export function detectDefaultApiBase(
  loc?: Pick<Location, "protocol" | "host"> | null,
): string {
  const target =
    loc !== undefined ? loc : typeof window !== "undefined" ? window.location : null;
  if (
    target &&
    (target.protocol === "http:" || target.protocol === "https:") &&
    Boolean(target.host)
  ) {
    return "";
  }
  return DEFAULT_CLOUD_API_BASE;
}

/**
 * Smart default video transport:
 * - Prefer WebRTC (hardware H.264/VP8 + UDP P2P / coturn relay) on both https:// and http://
 *   browser origins (receive-only video + DataChannel works over pure-IP HTTP without HTTPS).
 * - Automatically falls back to low-latency ws-jpeg within 4.5s if ICE/UDP is blocked.
 */
export function detectDefaultTransport(
  loc?: Pick<Location, "protocol"> | null,
): TransportMode {
  const target =
    loc !== undefined ? loc : typeof window !== "undefined" ? window.location : null;
  if (target?.protocol === "https:" || target?.protocol === "http:") {
    return "webrtc";
  }
  if (typeof RTCPeerConnection !== "undefined") {
    return "webrtc";
  }
  return "ws-jpeg";
}

/**
 * Resolves the default relay WebSocket URL for Account & Control-Code modes.
 * Uses same-origin ws(s)://<host>/ws in browser, falling back to DEFAULT_CLOUD_WS_URL in Capacitor.
 */
export function detectDefaultRelayWsUrl(
  loc?: Pick<Location, "protocol" | "host"> | null,
): string {
  const sameOrigin = detectDefaultWsUrl(loc);
  if (sameOrigin) {
    return sameOrigin;
  }
  return DEFAULT_CLOUD_WS_URL;
}

/**
 * Strictly matches private LAN / Tailscale IPv4 addresses:
 * 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10.
 * Excludes loopback (127.x) and all public IPs/hostnames.
 */
export function isPrivateLanIp(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase();
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
  if (!ipv4) return false;

  const a = Number(ipv4[1]);
  const b = Number(ipv4[2]);
  const c = Number(ipv4[3]);
  const d = Number(ipv4[4]);
  if (a > 255 || b > 255 || c > 255 || d > 255) return false;

  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  // Carrier-grade NAT / Tailscale 100.64.0.0/10
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * Matches localhost/loopback, private LAN IPs, Tailscale CGNAT/MagicDNS, and mDNS `.local`.
 */
export function isPrivateHost(hostname: string): boolean {
  const clean = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (
    clean === "localhost" ||
    clean === "::1" ||
    clean.endsWith(".local") ||
    clean.endsWith(".ts.net")
  ) {
    return true;
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(clean);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    const c = Number(ipv4[3]);
    const d = Number(ipv4[4]);
    if (a > 255 || b > 255 || c > 255 || d > 255) return false;
    if (a === 127) return true;
  }

  return isPrivateLanIp(clean);
}

/**
 * Validates that a device-advertised directUrl uses ws(s):// and points strictly
 * to a private LAN / Tailscale IP so credentials are never forwarded to public hosts.
 */
export function isAllowedDirectUrl(wsUrl: string): boolean {
  const trimmed = wsUrl.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return false;
    }
    return isPrivateLanIp(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Checks whether a WebSocket URL targets the exact same host (including port) as the page origin.
 */
export function isSameOriginWsUrl(
  wsUrl: string,
  loc?: Pick<Location, "protocol" | "host"> | null,
): boolean {
  const target =
    loc !== undefined ? loc : typeof window !== "undefined" ? window.location : null;
  if (
    !target ||
    !target.host ||
    (target.protocol !== "http:" && target.protocol !== "https:")
  ) {
    return false;
  }

  try {
    const parsedWs = new URL(wsUrl);
    if (parsedWs.protocol !== "ws:" && parsedWs.protocol !== "wss:") {
      return false;
    }
    const parsedOrigin = new URL(`${target.protocol}//${target.host}`);
    return parsedWs.host.toLowerCase() === parsedOrigin.host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Evaluates whether a URL-imported quick-connect target must prompt for explicit
 * user security confirmation (different/external host OR cleartext ws:// on a public host).
 */
export function assessQuickConnectSecurity(
  wsUrl: string,
  loc?: Pick<Location, "protocol" | "host"> | null,
): QuickConnectSecurityAssessment {
  try {
    const parsed = new URL(wsUrl);
    const isExternalHost = !isSameOriginWsUrl(wsUrl, loc);
    const isInsecurePublicWs =
      parsed.protocol === "ws:" && !isPrivateHost(parsed.hostname);
    return {
      requiresConfirmation: isExternalHost || isInsecurePublicWs,
      isExternalHost,
      isInsecurePublicWs,
      protocol: parsed.protocol,
      host: parsed.host,
    };
  } catch {
    return {
      requiresConfirmation: true,
      isExternalHost: true,
      isInsecurePublicWs: true,
      protocol: "",
      host: wsUrl,
    };
  }
}

export function inferModeFromWsUrl(wsUrl: string): ConnectionMode {
  try {
    const parsed = new URL(wsUrl);
    if (parsed.protocol === "ws:" || isPrivateHost(parsed.hostname)) {
      return "direct";
    }
    return "relay";
  } catch {
    return wsUrl.startsWith("ws://") ? "direct" : "relay";
  }
}

export function normalizeWsUrl(raw: string, fallbackMode?: ConnectionMode): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  let candidate = trimmed;
  if (/^https:\/\//i.test(candidate)) {
    candidate = `wss://${candidate.slice("https://".length)}`;
  } else if (/^http:\/\//i.test(candidate)) {
    candidate = `ws://${candidate.slice("http://".length)}`;
  } else if (!/^wss?:\/\//i.test(candidate)) {
    const firstSegment = candidate.split("/")[0] ?? "";
    const hostOnly = firstSegment.split(":")[0] ?? "";
    const usePlainWs = fallbackMode === "direct" || isPrivateHost(hostOnly);
    candidate = `${usePlainWs ? "ws" : "wss"}://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    if (!parsed.pathname || parsed.pathname === "/") {
      parsed.pathname = "/ws";
    }
    return parsed.toString();
  } catch {
    return candidate;
  }
}

function parseHashAsSearchParams(hash: string): URLSearchParams {
  if (!hash) return new URLSearchParams();
  let body = hash.startsWith("#") ? hash.slice(1) : hash;
  if (body.startsWith("?")) {
    body = body.slice(1);
  }
  return new URLSearchParams(body);
}

export function parseQuickConnectParams(
  search: string,
  hashOrLoc?: string | Pick<Location, "protocol" | "host"> | null,
  loc?: Pick<Location, "protocol" | "host"> | null,
): QuickConnectParams | null {
  const hash = typeof hashOrLoc === "string" ? hashOrLoc : "";
  const resolvedLoc = typeof hashOrLoc === "string" ? loc : hashOrLoc;

  if (!search && !hash) return null;

  const searchParams = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const hashParams = parseHashAsSearchParams(hash);

  // Prefer #fragment parameters (never sent in HTTP requests/server logs), fall back to ?query
  const getParam = (key: string): string | null =>
    hashParams.get(key) ?? searchParams.get(key);

  const rawUrl = (getParam("url") ?? getParam("wsUrl") ?? "").trim();
  const rawToken = (getParam("token") ?? getParam("accessToken") ?? "").trim();
  const rawMode = getParam("mode")?.trim().toLowerCase();
  const rawLabel = getParam("label")?.trim() ?? "";
  const rawTransport = getParam("transport")?.trim().toLowerCase();
  const rawQuality = getParam("quality")?.trim().toLowerCase();
  const rawDeviceId = getParam("deviceId")?.trim() ?? "";

  if (!rawUrl && !rawToken) {
    return null;
  }

  const explicitMode: ConnectionMode | undefined =
    rawMode === "direct" || rawMode === "relay" ? rawMode : undefined;

  const resolvedUrl = rawUrl
    ? normalizeWsUrl(rawUrl, explicitMode)
    : detectDefaultWsUrl(resolvedLoc);

  if (!resolvedUrl) {
    return null;
  }

  // Ensure resolved URL is strictly ws:// or wss:// with a valid hostname
  let parsedResolved: URL;
  try {
    parsedResolved = new URL(resolvedUrl);
    if (
      (parsedResolved.protocol !== "ws:" && parsedResolved.protocol !== "wss:") ||
      !parsedResolved.hostname
    ) {
      return null;
    }
  } catch {
    return null;
  }

  const mode: ConnectionMode = explicitMode ?? inferModeFromWsUrl(resolvedUrl);
  const preferredTransport: TransportMode =
    rawTransport === "ws-jpeg" ? "ws-jpeg" : "webrtc";
  const qualityPreset: QualityPreset =
    rawQuality === "auto" ||
    rawQuality === "eco" ||
    rawQuality === "balanced" ||
    rawQuality === "hd"
      ? rawQuality
      : "auto";

  const host = parsedResolved.hostname;
  const fallbackLabel = host
    ? mode === "direct"
      ? `直连 ${host}`
      : host
    : mode === "direct"
      ? "直连设备"
      : "中继服务器";

  const result: QuickConnectParams = {
    wsUrl: resolvedUrl,
    accessToken: rawToken,
    mode,
    label: rawLabel || fallbackLabel,
    preferredTransport,
    qualityPreset,
  };

  if (rawDeviceId) {
    result.deviceId = rawDeviceId;
  }

  return result;
}

export function stripQuickConnectParamsFromUrl(
  win?: Pick<Window, "location" | "history"> | null,
): boolean {
  const target = win ?? (typeof window !== "undefined" ? window : null);
  if (!target || !target.location || !target.history) {
    return false;
  }

  try {
    const url = new URL(target.location.href);
    let changed = false;

    for (const key of QUICK_CONNECT_QUERY_KEYS) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    }

    let nextHash = url.hash;
    if (url.hash) {
      const hashParams = parseHashAsSearchParams(url.hash);
      let hashChanged = false;
      for (const key of QUICK_CONNECT_QUERY_KEYS) {
        if (hashParams.has(key)) {
          hashParams.delete(key);
          hashChanged = true;
        }
      }
      if (hashChanged) {
        changed = true;
        const cleanHash = hashParams.toString();
        nextHash = cleanHash ? `#${cleanHash}` : "";
      }
    }

    if (!changed) return false;

    const cleanSearch = url.searchParams.toString();
    const nextUrl = `${url.pathname}${cleanSearch ? `?${cleanSearch}` : ""}${nextHash}`;
    target.history.replaceState(null, "", nextUrl);
    return true;
  } catch {
    return false;
  }
}

function isValidProfile(value: unknown): value is ConnectionProfile {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.label === "string" &&
    (candidate.mode === "relay" || candidate.mode === "direct") &&
    typeof candidate.wsUrl === "string" &&
    typeof candidate.accessToken === "string" &&
    (candidate.preferredTransport === "webrtc" || candidate.preferredTransport === "ws-jpeg") &&
    (candidate.qualityPreset === "auto" ||
      candidate.qualityPreset === "eco" ||
      candidate.qualityPreset === "balanced" ||
      candidate.qualityPreset === "hd")
  );
}

export function loadProfiles(storage?: Storage): ConnectionProfile[] {
  const store = getSafeStorage(storage);
  if (!store) return [];
  try {
    const raw = store.getItem(PROFILES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidProfile);
  } catch {
    return [];
  }
}

export function saveProfiles(profiles: ConnectionProfile[], storage?: Storage): void {
  const store = getSafeStorage(storage);
  if (!store) return;
  try {
    store.setItem(PROFILES_STORAGE_KEY, JSON.stringify(profiles));
  } catch {
    // Ignore storage quota errors
  }
}

export function loadActiveProfileId(storage?: Storage): string | null {
  const store = getSafeStorage(storage);
  if (!store) return null;
  try {
    return store.getItem(ACTIVE_PROFILE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveActiveProfileId(id: string | null, storage?: Storage): void {
  const store = getSafeStorage(storage);
  if (!store) return;
  try {
    if (id) {
      store.setItem(ACTIVE_PROFILE_STORAGE_KEY, id);
    } else {
      store.removeItem(ACTIVE_PROFILE_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

export function upsertProfile(
  profiles: ConnectionProfile[],
  input: Omit<ConnectionProfile, "id"> & { id?: string },
): { profiles: ConnectionProfile[]; saved: ConnectionProfile } {
  const normalizedUrl = normalizeWsUrl(input.wsUrl, input.mode);
  const saved: ConnectionProfile = {
    id: input.id || generateId("conn"),
    label: input.label.trim() || (input.mode === "direct" ? "直连设备" : "中继服务器"),
    mode: input.mode,
    wsUrl: normalizedUrl,
    accessToken: input.accessToken.trim(),
    preferredTransport: input.preferredTransport,
    qualityPreset: input.qualityPreset,
    updatedAt: Date.now(),
  };

  const existingIndex = profiles.findIndex((p) => p.id === saved.id);
  if (existingIndex >= 0) {
    const next = [...profiles];
    next[existingIndex] = saved;
    return { profiles: next, saved };
  }

  return { profiles: [saved, ...profiles], saved };
}

export function deleteProfile(profiles: ConnectionProfile[], id: string): ConnectionProfile[] {
  return profiles.filter((p) => p.id !== id);
}

export function importQuickConnectProfile(
  profiles: ConnectionProfile[],
  quick: QuickConnectParams,
): { profiles: ConnectionProfile[]; profile: ConnectionProfile } {
  const normalizedUrl = normalizeWsUrl(quick.wsUrl, quick.mode);
  const existing = profiles.find(
    (p) => p.wsUrl === normalizedUrl && p.mode === quick.mode,
  );

  if (existing) {
    const updated: ConnectionProfile = {
      ...existing,
      label: quick.label || existing.label,
      accessToken: quick.accessToken || existing.accessToken,
      preferredTransport: quick.preferredTransport,
      qualityPreset: quick.qualityPreset,
      updatedAt: Date.now(),
    };
    return {
      profiles: profiles.map((p) => (p.id === existing.id ? updated : p)),
      profile: updated,
    };
  }

  const { profiles: next, saved } = upsertProfile(profiles, {
    label: quick.label,
    mode: quick.mode,
    wsUrl: normalizedUrl,
    accessToken: quick.accessToken,
    preferredTransport: quick.preferredTransport,
    qualityPreset: quick.qualityPreset,
  });

  return { profiles: next, profile: saved };
}

export function getOrCreateClientId(storage?: Storage): string {
  const store = getSafeSessionStorage(storage);
  if (store) {
    try {
      const existing = store.getItem(CLIENT_ID_STORAGE_KEY);
      if (existing) return existing;
    } catch {
      // Ignore
    }
  } else if (inMemoryClientId) {
    return inMemoryClientId;
  }

  const created = generateId("ctrl");
  if (store) {
    try {
      store.setItem(CLIENT_ID_STORAGE_KEY, created);
      return created;
    } catch {
      // Fall back to per-tab in-memory ID if sessionStorage write fails
    }
  }
  if (!storage) {
    if (inMemoryClientId) return inMemoryClientId;
    inMemoryClientId = created;
  }
  return created;
}
