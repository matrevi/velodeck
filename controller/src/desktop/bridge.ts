import { isPrivateHost } from "../state/profiles";

export type DesktopPlatform = "darwin" | "win32" | "linux";
export type DesktopWindowPreset = "phone" | "compact" | "dashboard";
export type DesktopMenuCommand =
  | "toggle-black-screen"
  | "toggle-force-portrait"
  | "copy-screenshot"
  | "save-screenshot"
  | "open-server-settings"
  | "reconnect";

export interface DesktopWindowState {
  alwaysOnTop: boolean;
  preset: DesktopWindowPreset;
  isFullScreen: boolean;
}

export interface DesktopServerConfig {
  serverUrl: string;
  recentServers: string[];
}

export interface VeloDeckDesktopBridge {
  readonly platform: DesktopPlatform;
  readonly appVersion: string;
  readonly defaultServerUrl: string;
  getWindowState(): Promise<DesktopWindowState>;
  onWindowStateChange(cb: (state: DesktopWindowState) => void): () => void;
  setAlwaysOnTop(enabled: boolean): Promise<DesktopWindowState>;
  setWindowPreset(preset: DesktopWindowPreset): Promise<DesktopWindowState>;
  openNewWindow(): Promise<void>;
  copyScreenshotPng(dataUrl: string): Promise<{ ok: boolean; error?: string }>;
  saveScreenshotPng(
    dataUrl: string,
    suggestedName: string,
  ): Promise<{
    ok: boolean;
    savedPath?: string;
    cancelled?: boolean;
    error?: string;
  }>;
  getServerConfig(): Promise<DesktopServerConfig>;
  setServerConfig(serverUrl: string): Promise<DesktopServerConfig>;
  removeRecentServer(serverUrl: string): Promise<DesktopServerConfig>;
  onCommand(cb: (command: DesktopMenuCommand) => void): () => void;
}

declare global {
  interface Window {
    velodeckDesktop?: VeloDeckDesktopBridge;
  }
}

export const DESKTOP_SERVER_URL_STORAGE_KEY = "velodeck.desktop.serverUrl.v1";
export const DESKTOP_RECENT_SERVERS_STORAGE_KEY =
  "velodeck.desktop.recentServers.v1";

const MAX_CACHED_RECENT_SERVERS = 10;

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

function isIpv4Address(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  return (
    Number(match[1]) <= 255 &&
    Number(match[2]) <= 255 &&
    Number(match[3]) <= 255 &&
    Number(match[4]) <= 255
  );
}

function shouldDefaultToHttp(hostSegment: string): boolean {
  const lower = hostSegment.trim().toLowerCase();
  if (!lower) return false;

  // Strip IPv6 brackets or :port suffix to inspect bare hostname
  let hostname = lower;
  if (hostname.startsWith("[")) {
    const closeIdx = hostname.indexOf("]");
    if (closeIdx > 0) {
      hostname = hostname.slice(1, closeIdx);
    }
  } else {
    const colonIdx = hostname.indexOf(":");
    if (colonIdx >= 0) {
      hostname = hostname.slice(0, colonIdx);
    }
  }

  if (!hostname) return false;
  if (isIpv4Address(hostname)) return true;
  if (isPrivateHost(hostname)) return true;
  if (
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".internal")
  ) {
    return true;
  }
  return false;
}

export function getDesktopBridge(): VeloDeckDesktopBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as { velodeckDesktop?: unknown }).velodeckDesktop;
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  return candidate as VeloDeckDesktopBridge;
}

export function isDesktopApp(): boolean {
  return getDesktopBridge() !== null;
}

export function isMacDesktop(): boolean {
  return getDesktopBridge()?.platform === "darwin";
}

/**
 * Normalizes a user-provided VeloDeck server base URL:
 * - Trims whitespace & rejects embedded spaces or non-http(s) protocols (e.g. javascript:, file:, ftp:)
 * - Auto-prepends `http://` for bare IPv4 / localhost / private hosts and `https://` for bare domain names
 * - Strips trailing `/api/...`, `/ws`, and trailing slashes
 * - Returns `""` for invalid inputs
 */
export function normalizeServerBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return "";
  }

  let candidate = trimmed;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    // Explicit scheme:// — validated below to strictly allow http: / https:
  } else if (candidate.startsWith("//") || candidate.startsWith("://")) {
    return "";
  } else {
    // Distinguish explicit non-hierarchical schemes (e.g. javascript:alert(1), data:..., mailto:...)
    // from bare host:port (e.g. localhost:8080, 192.168.1.2:8080/ws, [::1]:8080).
    const firstSlashIdx = candidate.indexOf("/");
    const authority =
      firstSlashIdx >= 0 ? candidate.slice(0, firstSlashIdx) : candidate;

    if (!authority) {
      return "";
    }

    if (!authority.startsWith("[")) {
      const colonIdx = authority.indexOf(":");
      if (colonIdx >= 0) {
        const afterColon = authority.slice(colonIdx + 1);
        if (!/^\d{1,5}$/.test(afterColon)) {
          return "";
        }
      }
    }

    const scheme = shouldDefaultToHttp(authority) ? "http" : "https";
    candidate = `${scheme}://${candidate}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return "";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "";
  }

  if (parsed.username || parsed.password) {
    return "";
  }

  const hostname = parsed.hostname;
  if (
    !hostname ||
    hostname.startsWith(".") ||
    hostname.endsWith(".") ||
    hostname.includes("..")
  ) {
    return "";
  }

  let pathname = parsed.pathname || "";
  pathname = pathname.replace(/\/api(?:\/.*)?$/i, "");
  pathname = pathname.replace(/\/ws\/?$/i, "");
  pathname = pathname.replace(/\/+$/, "");

  return `${parsed.origin}${pathname}`;
}

/**
 * Derives the relay WebSocket endpoint (`wss://<host>/ws` or `ws://<host>/ws`)
 * from a normalized HTTP(S) API base URL.
 */
export function deriveRelayWsUrlFromApiBase(apiBase: string): string {
  const normalized = normalizeServerBaseUrl(apiBase);
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    const wsProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    const basePath = parsed.pathname.replace(/\/+$/, "");
    return `${wsProtocol}//${parsed.host}${basePath}/ws`;
  } catch {
    return "";
  }
}

/**
 * Formats a concise host (plus optional port/subpath) label for shell badges and toasts.
 */
export function formatServerHostLabel(apiBase: string): string {
  const normalized = normalizeServerBaseUrl(apiBase);
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    const basePath = parsed.pathname.replace(/\/+$/, "");
    return basePath ? `${parsed.host}${basePath}` : parsed.host;
  } catch {
    return normalized;
  }
}

export function loadCachedDesktopServerUrl(storage?: Storage): string {
  const store = getSafeStorage(storage);
  if (!store) return "";
  try {
    const raw = store.getItem(DESKTOP_SERVER_URL_STORAGE_KEY);
    if (!raw) return "";
    return normalizeServerBaseUrl(raw);
  } catch {
    return "";
  }
}

export function saveCachedDesktopServerUrl(
  url: string,
  storage?: Storage,
): void {
  const store = getSafeStorage(storage);
  if (!store) return;
  try {
    const normalized = normalizeServerBaseUrl(url);
    if (normalized) {
      store.setItem(DESKTOP_SERVER_URL_STORAGE_KEY, normalized);
    } else {
      store.removeItem(DESKTOP_SERVER_URL_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota errors
  }
}

export function loadCachedRecentDesktopServers(storage?: Storage): string[] {
  const store = getSafeStorage(storage);
  if (!store) return [];
  try {
    const raw = store.getItem(DESKTOP_RECENT_SERVERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const normalized = normalizeServerBaseUrl(item);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(normalized);
      if (result.length >= MAX_CACHED_RECENT_SERVERS) break;
    }
    return result;
  } catch {
    return [];
  }
}

export function saveCachedRecentDesktopServers(
  servers: string[],
  storage?: Storage,
): void {
  const store = getSafeStorage(storage);
  if (!store) return;
  try {
    const seen = new Set<string>();
    const clean: string[] = [];
    for (const item of servers) {
      const normalized = normalizeServerBaseUrl(item);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      clean.push(normalized);
      if (clean.length >= MAX_CACHED_RECENT_SERVERS) break;
    }
    if (clean.length === 0) {
      store.removeItem(DESKTOP_RECENT_SERVERS_STORAGE_KEY);
    } else {
      store.setItem(DESKTOP_RECENT_SERVERS_STORAGE_KEY, JSON.stringify(clean));
    }
  } catch {
    // Ignore storage quota errors
  }
}
