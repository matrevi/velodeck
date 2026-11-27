import path from "node:path";

export const APP_SCHEME = "app";
export const APP_HOST = "velodeck";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".wasm": "application/wasm",
};

function hasUnsafePathToken(rawPath: string): boolean {
  if (rawPath.includes("\0") || rawPath.includes("\\")) {
    return true;
  }
  if (/%00|%5c/i.test(rawPath)) {
    return true;
  }
  const segments = rawPath.split("/");
  for (const segment of segments) {
    if (segment === "..") {
      return true;
    }
    if (/%2e/i.test(segment)) {
      try {
        const decodedSegment = decodeURIComponent(segment);
        if (
          decodedSegment === ".." ||
          decodedSegment.includes("/") ||
          decodedSegment.includes("\\") ||
          decodedSegment.includes("\0")
        ) {
          return true;
        }
      } catch {
        return true;
      }
    }
  }
  return false;
}

/**
 * Resolves an `app://velodeck/<path>` request into a safe absolute file path
 * strictly contained inside `rootDir`. Returns `null` for wrong hosts,
 * malformed URLs, traversal attempts, backslash tricks, or null bytes.
 */
export function resolveStaticAssetPath(
  rootDir: string,
  requestUrl: string,
): string | null {
  if (!rootDir || !requestUrl) {
    return null;
  }
  if (requestUrl.includes("\0") || /[\u0000-\u001f\u007f]/.test(requestUrl)) {
    return null;
  }

  // Inspect the raw path before WHATWG URL dot-segment normalization collapses `..`.
  const schemePrefix = `${APP_SCHEME}://`;
  if (!requestUrl.toLowerCase().startsWith(schemePrefix)) {
    return null;
  }
  const afterScheme = requestUrl.slice(schemePrefix.length);
  const pathStartIdx = afterScheme.search(/[/?#]/);
  const rawAfterAuthority =
    pathStartIdx === -1 ? "" : afterScheme.slice(pathStartIdx);
  const rawPathname = rawAfterAuthority.split(/[?#]/, 1)[0] ?? "";
  if (hasUnsafePathToken(rawPathname)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== `${APP_SCHEME}:` ||
    parsed.hostname.toLowerCase() !== APP_HOST ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return null;
  }

  if (hasUnsafePathToken(parsed.pathname)) {
    return null;
  }

  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }

  if (hasUnsafePathToken(decodedPathname)) {
    return null;
  }

  const stripped = decodedPathname.replace(/^\/+/, "");
  const isSpaRoute =
    stripped.length === 0 ||
    stripped.endsWith("/") ||
    path.posix.extname(stripped) === "";
  const relativeTarget = isSpaRoute ? "index.html" : stripped;

  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(resolvedRoot, relativeTarget);
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(resolvedRoot + path.sep)
  ) {
    return null;
  }

  return resolvedTarget;
}

export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Checks whether a frame or navigation URL belongs to the trusted renderer origin
 * (`app://velodeck` in production, or a local Vite dev origin like `http://localhost:5173`).
 * Note: Node/WHATWG `URL.origin` returns `"null"` for non-special schemes like `app:`,
 * so this helper computes custom-scheme origins explicitly.
 */
export function isAllowedRendererUrl(
  targetUrl: string,
  allowedOrigin: string,
): boolean {
  if (!targetUrl || !allowedOrigin) {
    return false;
  }
  try {
    const parsed = new URL(targetUrl);
    let actualOrigin = "";
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      actualOrigin = parsed.origin;
    } else if (parsed.protocol === `${APP_SCHEME}:` && parsed.host) {
      actualOrigin = `${parsed.protocol}//${parsed.host.toLowerCase()}`;
    } else {
      return false;
    }
    return actualOrigin === allowedOrigin;
  } catch {
    return false;
  }
}

/**
 * Allows only `http:` and `https:` external URLs. Blocks `file:`, `javascript:`,
 * `smb:`, `data:`, custom schemes, and control characters.
 */
export function isSafeExternalUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== "string") {
    return false;
  }
  const trimmed = rawUrl.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 2048 ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}
