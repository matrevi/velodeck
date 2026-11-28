import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_REMOTE_DOWNLOAD_BYTES = 256 * 1024 * 1024;
export const REMOTE_DOWNLOAD_CHUNK_SIZE = 64 * 1024;
export const MAX_DIRECTORY_ENTRIES = 1000;
export const MAX_ENTRY_NAME_LENGTH = 120;
export const MAX_PATH_LENGTH = 4096;

export type FsRootKind = "home" | "desktop" | "downloads" | "documents" | "drive";

export interface FsRootEntry {
  name: string;
  path: string;
  kind: FsRootKind;
}

export interface FsDirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface FsListResult {
  path: string;
  parentPath: string | null;
  entries: FsDirEntry[];
}

export interface FsCreateDirResult {
  ok: boolean;
  createdPath?: string;
  error?: string;
}

export interface FsDeleteResult {
  ok: boolean;
  error?: string;
}

export interface RemoteDownloadMeta {
  fileName: string;
  size: number;
  mimeType: string;
  filePath: string;
}

export interface RemoteDownloadChunkResult {
  done: boolean;
  chunk?: Uint8Array;
  sha256?: string;
  size?: number;
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/typescript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".apk": "application/vnd.android.package-archive",
  ".dmg": "application/x-apple-diskimage",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function getMimeTypeForFileName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function hasControlOrNullChars(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Strictly validates a single directory/file entry name (e.g., for `fs_mkdir_req`).
 * Rejects empty strings, `.`, `..`, NUL bytes, path separators (`/` and `\`),
 * ASCII control characters, and names longer than 120 characters.
 */
export function sanitizeEntryName(name: string): string | null {
  if (typeof name !== "string") {
    return null;
  }
  if (
    hasControlOrNullChars(name) ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    return null;
  }
  const trimmed = name.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_ENTRY_NAME_LENGTH ||
    trimmed === "." ||
    trimmed === ".."
  ) {
    return null;
  }
  return trimmed;
}

/**
 * Validates and resolves a filesystem path string, rejecting null bytes,
 * control characters, empty strings, and excessively long paths.
 */
export function normalizeFsPath(rawPath: unknown): string | null {
  if (typeof rawPath !== "string") {
    return null;
  }
  if (
    rawPath.length === 0 ||
    rawPath.length > MAX_PATH_LENGTH ||
    hasControlOrNullChars(rawPath)
  ) {
    return null;
  }
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return null;
  }
  return path.resolve(trimmed);
}

/**
 * Validates an optional `targetDir` provided on `file.offer` / `file_offer`.
 * Returns the resolved directory path only if it exists, is a directory, and is writable.
 */
export function resolveValidUploadTargetDir(rawTargetDir: unknown): string | null {
  const resolved = normalizeFsPath(rawTargetDir);
  if (!resolved) {
    return null;
  }
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return null;
    }
    fs.accessSync(resolved, fs.constants.W_OK);
    return resolved;
  } catch {
    return null;
  }
}

function isExistingDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Enumerates default browsing roots (Home, Desktop, Downloads, Documents that exist),
 * plus mounted `/Volumes/*` on macOS, `C:\..Z:\` drives on Windows, and `/` on Linux.
 */
export function getDefaultRoots(
  platform: string = process.platform,
  homeDir: string = os.homedir(),
): FsRootEntry[] {
  const roots: FsRootEntry[] = [];
  const seen = new Set<string>();

  const pushIfDir = (name: string, target: string, kind: FsRootKind): void => {
    const resolved = path.resolve(target);
    const key = platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return;
    if (!isExistingDirectory(resolved)) return;
    seen.add(key);
    roots.push({ name, path: resolved, kind });
  };

  if (homeDir && !hasControlOrNullChars(homeDir)) {
    pushIfDir("主目录", homeDir, "home");
    pushIfDir("桌面", path.join(homeDir, "Desktop"), "desktop");
    pushIfDir("下载", path.join(homeDir, "Downloads"), "downloads");
    pushIfDir("文档", path.join(homeDir, "Documents"), "documents");
  }

  if (platform === "darwin") {
    try {
      const volEntries = fs.readdirSync("/Volumes", { withFileTypes: true });
      for (const entry of volEntries) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join("/Volumes", entry.name);
        pushIfDir(entry.name, full, "drive");
      }
    } catch {
      // /Volumes unavailable in restricted sandbox
    }
  } else if (platform === "win32") {
    for (let code = 67; code <= 90; code += 1) {
      const letter = String.fromCharCode(code);
      const driveRoot = `${letter}:\\`;
      try {
        if (fs.existsSync(driveRoot) && isExistingDirectory(driveRoot)) {
          const key = driveRoot.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            roots.push({ name: `${letter}:`, path: driveRoot, kind: "drive" });
          }
        }
      } catch {
        // Skip inaccessible drive
      }
    }
  } else {
    pushIfDir("根目录 /", "/", "drive");
  }

  return roots;
}

/**
 * Lists directory contents sorted with directories first, then alphabetically,
 * gracefully skipping unreadable entries and capping output at 1000 entries.
 */
export function listDirectory(dirPath: string): FsListResult {
  const resolved = normalizeFsPath(dirPath);
  if (!resolved) {
    throw new Error("无效的目录路径");
  }

  let dirStat: fs.Stats;
  try {
    dirStat = fs.statSync(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error("目录不存在");
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new Error("没有权限访问该目录");
    }
    throw new Error("无法读取目录信息");
  }

  if (!dirStat.isDirectory()) {
    throw new Error("目标路径不是文件夹");
  }

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(resolved, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error("没有权限读取该目录内容");
    }
    throw new Error("读取目录内容失败");
  }

  const entries: FsDirEntry[] = [];
  for (const dirent of dirents) {
    const fullPath = path.join(resolved, dirent.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      try {
        stat = fs.lstatSync(fullPath);
      } catch {
        continue;
      }
    }
    const isDir = stat.isDirectory();
    entries.push({
      name: dirent.name,
      path: fullPath,
      isDir,
      size: isDir ? 0 : Math.max(0, Math.floor(stat.size)),
      mtimeMs: Number.isFinite(stat.mtimeMs) ? Math.round(stat.mtimeMs) : 0,
    });
  }

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) {
      return a.isDir ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, {
      sensitivity: "base",
      numeric: true,
    });
  });

  const parent = path.dirname(resolved);
  const parentPath = parent !== resolved ? parent : null;

  return {
    path: resolved,
    parentPath,
    entries: entries.slice(0, MAX_DIRECTORY_ENTRIES),
  };
}

/**
 * Safely creates a subdirectory inside `parentPath` after validating `name`.
 */
export function createDirectory(
  parentPath: string,
  name: string,
): FsCreateDirResult {
  const resolvedParent = normalizeFsPath(parentPath);
  if (!resolvedParent || !isExistingDirectory(resolvedParent)) {
    return { ok: false, error: "父目录不存在或不可访问" };
  }

  const safeName = sanitizeEntryName(name);
  if (!safeName) {
    return { ok: false, error: "文件夹名称包含非法字符或长度超限" };
  }

  const createdPath = path.join(resolvedParent, safeName);
  if (path.dirname(createdPath) !== resolvedParent) {
    return { ok: false, error: "非法的目标文件夹路径" };
  }

  try {
    if (fs.existsSync(createdPath)) {
      return { ok: false, error: "同名文件或文件夹已存在" };
    }
    fs.mkdirSync(createdPath);
    return { ok: true, createdPath };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "创建文件夹失败",
    };
  }
}

/**
 * Returns true if `targetPath` is a protected system/root/home directory that must never be deleted.
 */
export function isProtectedDeletePath(
  targetPath: string,
  homeDir: string = os.homedir(),
  platform: string = process.platform,
): boolean {
  const trimmed = targetPath.trim();
  if (!trimmed) return true;

  // Explicitly catch Windows drive roots (e.g. "C:\", "D:/") even when tested on POSIX
  if (/^[a-zA-Z]:[\\/]*$/.test(trimmed)) {
    return true;
  }

  const resolved = path.resolve(trimmed);
  // Filesystem root: dirname(p) === p (covers "/" on POSIX and "C:\" on Windows)
  if (path.dirname(resolved) === resolved) {
    return true;
  }

  const norm = (p: string): string =>
    platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);

  const normalizedTarget = norm(resolved);
  if (homeDir && normalizedTarget === norm(homeDir)) {
    return true;
  }

  const protectedSystemDirs =
    platform === "win32"
      ? ["c:\\windows", "c:\\users", "c:\\program files", "c:\\program files (x86)"]
      : ["/users", "/home", "/volumes", "/system", "/applications", "/library", "/etc", "/usr", "/var", "/bin", "/sbin"];

  if (protectedSystemDirs.includes(normalizedTarget.toLowerCase())) {
    return true;
  }

  return false;
}

/**
 * Safely moves a file or folder to the OS Trash / Recycle Bin using `trashFn` (`shell.trashItem`),
 * refusing filesystem roots and the user's home directory.
 */
export async function trashPath(
  targetPath: string,
  trashFn: (filePath: string) => Promise<void>,
  homeDir: string = os.homedir(),
  platform: string = process.platform,
): Promise<FsDeleteResult> {
  if (typeof targetPath !== "string" || targetPath.trim().length === 0 || hasControlOrNullChars(targetPath)) {
    return { ok: false, error: "无效的目标路径" };
  }

  if (isProtectedDeletePath(targetPath, homeDir, platform)) {
    return { ok: false, error: "禁止删除系统根目录或用户主目录" };
  }

  const resolved = normalizeFsPath(targetPath);
  if (!resolved) {
    return { ok: false, error: "无效的目标路径" };
  }

  try {
    fs.lstatSync(resolved);
  } catch {
    return { ok: false, error: "目标文件或文件夹不存在" };
  }

  try {
    await trashFn(resolved);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "移至回收站失败",
    };
  }
}

/**
 * Pull-based & async-iterable chunked file reader that computes streaming SHA-256
 * while enforcing regular-file checks and the 256 MB download size limit.
 */
export class RemoteDownloadStream implements AsyncIterable<Uint8Array> {
  public readonly meta: RemoteDownloadMeta;

  private fd: number | null;
  private readonly chunkSize: number;
  private readonly hash: crypto.Hash;
  private bytesRead = 0;
  private finalized = false;
  private sha256Hex: string | null = null;

  constructor(
    fd: number,
    meta: RemoteDownloadMeta,
    chunkSize = REMOTE_DOWNLOAD_CHUNK_SIZE,
  ) {
    this.fd = fd;
    this.meta = meta;
    this.chunkSize = Math.max(4096, Math.min(256 * 1024, Math.floor(chunkSize)));
    this.hash = crypto.createHash("sha256");
  }

  public get totalBytesRead(): number {
    return this.bytesRead;
  }

  public get sha256(): string | null {
    return this.sha256Hex;
  }

  public readNextChunk(): RemoteDownloadChunkResult {
    if (this.finalized || this.fd === null) {
      return {
        done: true,
        sha256: this.sha256Hex ?? "",
        size: this.bytesRead,
      };
    }

    const buf = Buffer.allocUnsafe(this.chunkSize);
    let n = 0;
    try {
      n = fs.readSync(this.fd, buf, 0, this.chunkSize, null);
    } catch (error) {
      this.close();
      throw error;
    }

    if (n <= 0) {
      this.finish();
      return {
        done: true,
        sha256: this.sha256Hex ?? "",
        size: this.bytesRead,
      };
    }

    if (this.bytesRead + n > MAX_REMOTE_DOWNLOAD_BYTES) {
      this.close();
      throw new Error("文件大小超出 256 MB 限制");
    }

    const slice = buf.subarray(0, n);
    this.hash.update(slice);
    this.bytesRead += n;

    // Copy to a clean tightly-sized Uint8Array so `.buffer` matches `.byteLength`
    const out = new Uint8Array(n);
    out.set(slice);
    return { done: false, chunk: out };
  }

  private finish(): void {
    if (!this.finalized) {
      this.finalized = true;
      this.sha256Hex = this.hash.digest("hex");
    }
    this.closeFdOnly();
  }

  private closeFdOnly(): void {
    if (this.fd !== null) {
      const fdToClose = this.fd;
      this.fd = null;
      try {
        fs.closeSync(fdToClose);
      } catch {
        // Ignore close errors
      }
    }
  }

  public close(): void {
    this.finalized = true;
    this.closeFdOnly();
  }

  public async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array, void, void> {
    try {
      while (true) {
        const res = this.readNextChunk();
        if (res.done) {
          break;
        }
        if (res.chunk && res.chunk.byteLength > 0) {
          yield res.chunk;
        }
      }
    } finally {
      this.close();
    }
  }
}

/**
 * Validates that `filePath` points to an existing regular file <= 256 MB (rejecting
 * directories, FIFOs, sockets, device nodes, and null-byte paths) and opens a streaming reader.
 */
export function openDownloadStream(
  filePath: string,
  chunkSize = REMOTE_DOWNLOAD_CHUNK_SIZE,
): RemoteDownloadStream {
  const resolved = normalizeFsPath(filePath);
  if (!resolved) {
    throw new Error("无效的文件路径");
  }

  let preStat: fs.Stats;
  try {
    preStat = fs.statSync(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error("文件不存在");
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new Error("没有权限读取该文件");
    }
    throw new Error("无法读取文件信息");
  }

  if (!preStat.isFile()) {
    throw new Error("仅支持下载普通文件（不支持文件夹或特殊设备文件）");
  }
  if (preStat.size > MAX_REMOTE_DOWNLOAD_BYTES) {
    throw new Error("文件大小超过 256 MB 限制");
  }

  const fd = fs.openSync(resolved, "r");
  try {
    const fstat = fs.fstatSync(fd);
    if (!fstat.isFile()) {
      throw new Error("仅支持下载普通文件（不支持文件夹或特殊设备文件）");
    }
    if (fstat.size > MAX_REMOTE_DOWNLOAD_BYTES) {
      throw new Error("文件大小超过 256 MB 限制");
    }

    const rawBase = path.basename(resolved);
    const safeName =
      sanitizeEntryName(rawBase) ??
      rawBase.replace(/[\u0000-\u001f\u007f/\\]+/g, "_").slice(0, MAX_ENTRY_NAME_LENGTH) ??
      "download";

    return new RemoteDownloadStream(
      fd,
      {
        fileName: safeName || "download",
        size: Math.max(0, Math.floor(fstat.size)),
        mimeType: getMimeTypeForFileName(safeName || "download"),
        filePath: resolved,
      },
      chunkSize,
    );
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // Ignore
    }
    throw error;
  }
}
