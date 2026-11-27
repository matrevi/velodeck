import fs from "node:fs";
import path from "node:path";

export type WindowPreset = "phone" | "compact" | "dashboard";

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopSettings {
  serverUrl: string;
  recentServers: string[];
  alwaysOnTop: boolean;
  lastPreset: WindowPreset;
  windowBounds?: WindowBounds;
}

export const PRESET_SIZES: Readonly<
  Record<WindowPreset, Readonly<{ width: number; height: number }>>
> = {
  phone: { width: 430, height: 880 },
  compact: { width: 360, height: 740 },
  dashboard: { width: 1100, height: 760 },
};

export const MIN_WINDOW_WIDTH = 340;
export const MIN_WINDOW_HEIGHT = 560;
export const MAX_SERVER_URL_LENGTH = 512;
export const MAX_RECENT_SERVERS = 8;

const WORK_AREA_MARGIN = 24;
const IPV4_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isValidPreset(value: unknown): value is WindowPreset {
  return value === "phone" || value === "compact" || value === "dashboard";
}

function isIpv4Address(host: string): boolean {
  const match = IPV4_REGEX.exec(host);
  if (!match) {
    return false;
  }
  for (let i = 1; i <= 4; i += 1) {
    const octet = Number(match[i]);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return false;
    }
  }
  return true;
}

function isLocalOrIpHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".lan") ||
    lower.endsWith(".internal") ||
    lower.startsWith("[") ||
    isIpv4Address(lower)
  ) {
    return true;
  }
  return false;
}

/**
 * Normalizes a VeloDeck server base URL (`http:` or `https:`).
 * - Auto-prefixes `http://` for IP addresses, `localhost`, and `.local` hosts
 *   and `https://` for public domain names when scheme is omitted.
 * - Strips trailing slashes, `/ws`, `/api/info`, query strings, and fragments.
 * - Rejects malformed inputs, embedded credentials, non-http(s) schemes, or
 *   URLs longer than 512 characters by returning `""`.
 */
export function normalizeServerUrl(raw: string): string {
  if (typeof raw !== "string") {
    return "";
  }
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_SERVER_URL_LENGTH ||
    /[\s\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    return "";
  }

  let candidate = trimmed;
  const hasExplicitHttp = /^https?:\/\//i.test(candidate);

  if (!hasExplicitHttp) {
    // Reject any other explicit scheme (e.g. ftp://, ws://, file:, javascript:, data:).
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
      return "";
    }
    if (
      /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate) &&
      !/^[a-zA-Z0-9.-]+:\d{1,5}(\/|$)/.test(candidate)
    ) {
      return "";
    }

    // Extract authority host before first `/` to choose http:// vs https://.
    const authority = candidate.split("/", 1)[0] ?? "";
    let bareHost = authority;
    if (authority.startsWith("[")) {
      const endBracket = authority.indexOf("]");
      if (endBracket === -1) {
        return "";
      }
      bareHost = authority.slice(0, endBracket + 1);
    } else {
      const colonIdx = authority.indexOf(":");
      bareHost = colonIdx === -1 ? authority : authority.slice(0, colonIdx);
    }

    if (!bareHost) {
      return "";
    }

    // Require schemeless input to be localhost, IPv4, IPv6, or a dotted domain.
    if (
      !isLocalOrIpHost(bareHost) &&
      !bareHost.includes(".")
    ) {
      return "";
    }

    // Reject malformed all-numeric dotted strings like `999.999.999.999`.
    if (/^\d+(\.\d+)+$/.test(bareHost) && !isIpv4Address(bareHost)) {
      return "";
    }

    const prefix = isLocalOrIpHost(bareHost) ? "http://" : "https://";
    candidate = `${prefix}${candidate}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return "";
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return "";
  }

  // Reject invalid numeric IPv4 lookalikes when passed with explicit scheme.
  if (
    /^\d+(\.\d+)+$/.test(parsed.hostname) &&
    !isIpv4Address(parsed.hostname)
  ) {
    return "";
  }

  let cleanPath = parsed.pathname.replace(/\/+$/, "");
  // Strip known API/WS suffixes if pasted directly from a controller or API link.
  cleanPath = cleanPath.replace(/\/api(?:\/.*)?$/i, "");
  cleanPath = cleanPath.replace(/\/ws\/?$/i, "");
  cleanPath = cleanPath.replace(/\/+$/, "");

  const normalized = `${parsed.origin}${cleanPath}`;
  if (normalized.length > MAX_SERVER_URL_LENGTH) {
    return "";
  }
  return normalized;
}

export function upsertRecentServer(
  current: readonly string[],
  url: string,
  max = MAX_RECENT_SERVERS,
): string[] {
  const limit = Math.max(0, Math.floor(max));
  if (limit === 0) {
    return [];
  }

  const result: string[] = [];
  const seen = new Set<string>();

  const normalizedPrimary = normalizeServerUrl(url);
  if (normalizedPrimary) {
    result.push(normalizedPrimary);
    seen.add(normalizedPrimary);
  }

  for (const item of current) {
    if (result.length >= limit) {
      break;
    }
    const normalized = normalizeServerUrl(item);
    if (normalized && !seen.has(normalized)) {
      result.push(normalized);
      seen.add(normalized);
    }
  }

  return result;
}

function intersectionArea(a: WindowBounds, b: WorkArea): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) {
    return 0;
  }
  return (right - left) * (bottom - top);
}

/**
 * Ensures a restored window rectangle fits inside at least one connected display
 * workArea (preventing off-screen windows after unplugging an external monitor).
 */
export function clampWindowBounds(
  bounds: WindowBounds,
  workAreas: readonly WorkArea[],
  minWidth = MIN_WINDOW_WIDTH,
  minHeight = MIN_WINDOW_HEIGHT,
): WindowBounds {
  const safeWidth = Number.isFinite(bounds.width)
    ? Math.max(Math.round(bounds.width), minWidth)
    : PRESET_SIZES.dashboard.width;
  const safeHeight = Number.isFinite(bounds.height)
    ? Math.max(Math.round(bounds.height), minHeight)
    : PRESET_SIZES.dashboard.height;
  const safeX = Number.isFinite(bounds.x) ? Math.round(bounds.x) : 0;
  const safeY = Number.isFinite(bounds.y) ? Math.round(bounds.y) : 0;

  if (workAreas.length === 0) {
    return { x: safeX, y: safeY, width: safeWidth, height: safeHeight };
  }

  const normalizedBounds: WindowBounds = {
    x: safeX,
    y: safeY,
    width: safeWidth,
    height: safeHeight,
  };

  let bestArea = workAreas[0];
  let bestOverlap = intersectionArea(normalizedBounds, bestArea);

  for (let i = 1; i < workAreas.length; i += 1) {
    const candidate = workAreas[i];
    const overlap = intersectionArea(normalizedBounds, candidate);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestArea = candidate;
    }
  }

  const clampedWidth = Math.min(
    Math.max(safeWidth, Math.min(minWidth, bestArea.width)),
    bestArea.width,
  );
  const clampedHeight = Math.min(
    Math.max(safeHeight, Math.min(minHeight, bestArea.height)),
    bestArea.height,
  );

  // If the saved window is completely off-screen, center it cleanly on the primary display.
  if (bestOverlap === 0) {
    return {
      x: Math.round(bestArea.x + (bestArea.width - clampedWidth) / 2),
      y: Math.round(bestArea.y + (bestArea.height - clampedHeight) / 2),
      width: clampedWidth,
      height: clampedHeight,
    };
  }

  const minX = bestArea.x;
  const maxX = bestArea.x + bestArea.width - clampedWidth;
  const minY = bestArea.y;
  const maxY = bestArea.y + bestArea.height - clampedHeight;

  return {
    x: Math.min(Math.max(safeX, minX), maxX),
    y: Math.min(Math.max(safeY, minY), maxY),
    width: clampedWidth,
    height: clampedHeight,
  };
}

/**
 * Computes window bounds for a named preset cleanly anchored within `workArea`.
 * On shorter laptop screens (e.g., 13" MacBook Air where height < 880), phone
 * and compact presets shrink height to `workArea.height - 24` while preserving
 * the crisp vertical phone aspect ratio.
 */
export function computePresetBounds(
  preset: WindowPreset,
  currentBounds: WindowBounds | null | undefined,
  workArea: WorkArea,
): WindowBounds {
  const target = PRESET_SIZES[preset];
  const maxFitWidth =
    workArea.width > WORK_AREA_MARGIN * 2
      ? workArea.width - WORK_AREA_MARGIN
      : workArea.width;
  const maxFitHeight =
    workArea.height > WORK_AREA_MARGIN * 2
      ? workArea.height - WORK_AREA_MARGIN
      : workArea.height;

  let width = target.width;
  let height = target.height;

  if (preset === "phone" || preset === "compact") {
    if (height > maxFitHeight) {
      height = Math.max(Math.min(MIN_WINDOW_HEIGHT, workArea.height), maxFitHeight);
      const scale = height / target.height;
      width = Math.max(
        Math.min(MIN_WINDOW_WIDTH, workArea.width),
        Math.round(target.width * scale),
      );
    }
    if (width > maxFitWidth) {
      width = Math.max(Math.min(MIN_WINDOW_WIDTH, workArea.width), maxFitWidth);
    }
  } else {
    width = Math.min(width, maxFitWidth);
    height = Math.min(height, maxFitHeight);
  }

  width = Math.min(Math.max(width, Math.min(MIN_WINDOW_WIDTH, workArea.width)), workArea.width);
  height = Math.min(
    Math.max(height, Math.min(MIN_WINDOW_HEIGHT, workArea.height)),
    workArea.height,
  );

  let x: number;
  let y: number;
  if (
    currentBounds &&
    Number.isFinite(currentBounds.x) &&
    Number.isFinite(currentBounds.y) &&
    Number.isFinite(currentBounds.width) &&
    Number.isFinite(currentBounds.height)
  ) {
    const centerX = currentBounds.x + currentBounds.width / 2;
    const centerY = currentBounds.y + currentBounds.height / 2;
    x = Math.round(centerX - width / 2);
    y = Math.round(centerY - height / 2);
  } else {
    x = Math.round(workArea.x + (workArea.width - width) / 2);
    y = Math.round(workArea.y + (workArea.height - height) / 2);
  }

  const clampedX = Math.min(
    Math.max(x, workArea.x),
    workArea.x + workArea.width - width,
  );
  const clampedY = Math.min(
    Math.max(y, workArea.y),
    workArea.y + workArea.height - height,
  );

  return {
    x: clampedX,
    y: clampedY,
    width,
    height,
  };
}

function createDefaultSettings(): DesktopSettings {
  return {
    serverUrl: "",
    recentServers: [],
    alwaysOnTop: false,
    lastPreset: "dashboard",
  };
}

function sanitizeBounds(raw: unknown): WindowBounds | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const { x, y, width, height } = obj;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 100 ||
    height < 100
  ) {
    return undefined;
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function sanitizeSettings(raw: unknown): DesktopSettings {
  if (!raw || typeof raw !== "object") {
    return createDefaultSettings();
  }
  const obj = raw as Record<string, unknown>;
  const serverUrl =
    typeof obj.serverUrl === "string" ? normalizeServerUrl(obj.serverUrl) : "";
  const rawRecents = Array.isArray(obj.recentServers)
    ? obj.recentServers.filter((item): item is string => typeof item === "string")
    : [];
  const recentServers = upsertRecentServer(rawRecents, "", MAX_RECENT_SERVERS);
  const alwaysOnTop = Boolean(obj.alwaysOnTop);
  const lastPreset: WindowPreset = isValidPreset(obj.lastPreset)
    ? obj.lastPreset
    : "dashboard";
  const windowBounds = sanitizeBounds(obj.windowBounds);

  const sanitized: DesktopSettings = {
    serverUrl,
    recentServers,
    alwaysOnTop,
    lastPreset,
  };
  if (windowBounds) {
    sanitized.windowBounds = windowBounds;
  }
  return sanitized;
}

export function loadSettings(filePath: string): DesktopSettings {
  try {
    const rawText = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(rawText);
    return sanitizeSettings(parsed);
  } catch {
    return createDefaultSettings();
  }
}

export function saveSettingsAtomic(
  filePath: string,
  settings: DesktopSettings,
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const sanitized = sanitizeSettings(settings);
  const payload = `${JSON.stringify(sanitized, null, 2)}\n`;
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`;

  try {
    fs.writeFileSync(tmpPath, payload, { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(tmpPath, 0o600);
    } catch {
      // Ignore chmod failures on filesystems that do not support POSIX modes.
    }
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Best-effort cleanup of temp file.
    }
    throw error;
  }
}
