import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  CheckCircle2,
  Download,
  File as FileIcon,
  FileText,
  FileUp,
  Folder,
  FolderPlus,
  HardDrive,
  Home,
  Loader2,
  Monitor,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
  Zap,
} from "lucide-react";
import type { DeviceSummary } from "@velodeck/protocol";
import type {
  RemoteClient,
  RemoteClientState,
  RemoteFsEntry,
  RemoteFsRoot,
} from "../transport/RemoteClient";

export interface RemoteFileBrowserProps {
  client: RemoteClient;
  clientState: RemoteClientState;
  device: DeviceSummary | null;
  currentDir: string;
  onCurrentDirChange: (dirPath: string) => void;
  onShowToast?: (level: "info" | "warn" | "error", text: string) => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${Math.round(bytes)} B`;
}

function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "--";
  if (bytesPerSec >= 1024 * 1024) {
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  if (bytesPerSec >= 1024) {
    return `${Math.round(bytesPerSec / 1024)} KB/s`;
  }
  return `${Math.round(bytesPerSec)} B/s`;
}

function formatMtime(mtimeMs: number): string {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return "--";
  try {
    const d = new Date(mtimeMs);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return "--";
  }
}

function renderRootIcon(kind: RemoteFsRoot["kind"]) {
  switch (kind) {
    case "home":
      return <Home className="h-3.5 w-3.5" />;
    case "desktop":
      return <Monitor className="h-3.5 w-3.5" />;
    case "downloads":
      return <Download className="h-3.5 w-3.5" />;
    case "documents":
      return <FileText className="h-3.5 w-3.5" />;
    default:
      return <HardDrive className="h-3.5 w-3.5" />;
  }
}

interface BreadcrumbSegment {
  label: string;
  path: string;
}

function splitPathBreadcrumbs(dirPath: string): BreadcrumbSegment[] {
  const trimmed = dirPath.trim();
  if (!trimmed) return [];

  // Windows path e.g. C:\Users\Alice\Desktop
  const winDriveMatch = /^([a-zA-Z]:)([\\/].*)?$/.exec(trimmed);
  if (winDriveMatch) {
    const drive = `${winDriveMatch[1]}\\`;
    const rest = (winDriveMatch[2] ?? "").replace(/^[\\/]+/, "");
    const parts = rest ? rest.split(/[\\/]+/).filter(Boolean) : [];
    const segments: BreadcrumbSegment[] = [{ label: winDriveMatch[1]!, path: drive }];
    let acc = drive;
    for (const part of parts) {
      acc = acc.endsWith("\\") ? `${acc}${part}` : `${acc}\\${part}`;
      segments.push({ label: part, path: acc });
    }
    return segments;
  }

  // POSIX path e.g. /Users/alice/Desktop
  const isAbs = trimmed.startsWith("/");
  const parts = trimmed.split("/").filter(Boolean);
  const segments: BreadcrumbSegment[] = isAbs ? [{ label: "/", path: "/" }] : [];
  let acc = isAbs ? "" : "";
  for (const part of parts) {
    acc = isAbs ? `${acc}/${part}` : acc ? `${acc}/${part}` : part;
    segments.push({ label: part, path: acc });
  }
  return segments;
}

function triggerBlobDownload(blob: Blob, fileName: string): void {
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName || "download.bin";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    window.setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Ignore revoke failure
      }
    }, 4000);
  }
}

export function RemoteFileBrowser({
  client,
  clientState,
  device,
  currentDir,
  onCurrentDirChange,
  onShowToast,
}: RemoteFileBrowserProps) {
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const newFolderInputRef = useRef<HTMLInputElement | null>(null);
  const lastUploadDoneIdRef = useRef<string | null>(null);

  const [roots, setRoots] = useState<RemoteFsRoot[]>([]);
  const [rootsLoading, setRootsLoading] = useState(false);
  const [entries, setEntries] = useState<RemoteFsEntry[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderNameDraft, setFolderNameDraft] = useState("");
  const [mkdirBusy, setMkdirBusy] = useState(false);

  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(null);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);

  const isFileReady =
    clientState.fileChannelOpen && device?.capabilities.p2pFileTransfer !== false;
  const supportsFileManager = device?.capabilities.fileManager !== false;
  const ft = clientState.fileTransfer;
  const dl = clientState.fileDownload;

  const isUploadActive =
    ft !== null &&
    (ft.status === "preparing" ||
      ft.status === "sending" ||
      ft.status === "verifying");
  const isDownloadActive = dl.active;

  const loadDirectory = useCallback(
    async (targetPath: string) => {
      if (!targetPath) return;
      setListLoading(true);
      setErrorMsg(null);
      setConfirmDeletePath(null);
      try {
        const res = await client.listRemoteFsDir(targetPath);
        setEntries(res.entries);
        setParentPath(res.parentPath);
        onCurrentDirChange(res.path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "读取远端目录失败";
        setErrorMsg(msg);
      } finally {
        setListLoading(false);
      }
    },
    [client, onCurrentDirChange],
  );

  // Load roots once WebRTC file channel opens
  useEffect(() => {
    if (!isFileReady || !supportsFileManager) return;
    let cancelled = false;
    setRootsLoading(true);
    setErrorMsg(null);

    void client
      .listRemoteFsRoots()
      .then((loadedRoots) => {
        if (cancelled) return;
        setRoots(loadedRoots);
        const initialPath =
          currentDir ||
          loadedRoots.find((r) => r.kind === "desktop")?.path ||
          loadedRoots.find((r) => r.kind === "downloads")?.path ||
          loadedRoots[0]?.path ||
          "";
        if (initialPath) {
          void loadDirectory(initialPath);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "获取远端目录列表失败";
        setErrorMsg(msg);
      })
      .finally(() => {
        if (!cancelled) setRootsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, isFileReady, supportsFileManager]);

  // Auto-refresh listing when a P2P upload finishes into this directory
  useEffect(() => {
    if (
      ft?.status === "done" &&
      ft.transferId &&
      ft.transferId !== lastUploadDoneIdRef.current
    ) {
      lastUploadDoneIdRef.current = ft.transferId;
      if (currentDir && isFileReady && supportsFileManager) {
        void loadDirectory(currentDir);
      }
    }
  }, [ft?.status, ft?.transferId, currentDir, isFileReady, supportsFileManager, loadDirectory]);

  useEffect(() => {
    if (creatingFolder) {
      window.setTimeout(() => newFolderInputRef.current?.focus(), 20);
    }
  }, [creatingFolder]);

  const breadcrumbs = useMemo(
    () => splitPathBreadcrumbs(currentDir),
    [currentDir],
  );

  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((entry) => entry.name.toLowerCase().includes(q));
  }, [entries, searchQuery]);

  async function handleCreateFolder() {
    const trimmed = folderNameDraft.trim();
    if (!trimmed || !currentDir || mkdirBusy) return;
    setMkdirBusy(true);
    setErrorMsg(null);
    try {
      const res = await client.mkdirRemoteFs(currentDir, trimmed);
      if (!res.ok) {
        setErrorMsg(res.error || "新建文件夹失败");
        return;
      }
      setFolderNameDraft("");
      setCreatingFolder(false);
      onShowToast?.("info", `已创建文件夹「${trimmed}」`);
      await loadDirectory(currentDir);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "新建文件夹失败");
    } finally {
      setMkdirBusy(false);
    }
  }

  async function handleUploadToCurrentDir(file: File) {
    try {
      await client.sendFileOverWebRtc(file, {
        fileName: file.name,
        mimeType: file.type || undefined,
        purpose: "file",
        targetDir: currentDir || undefined,
      });
    } catch {
      // RemoteClient already sets fileTransfer error state & notice
    }
  }

  async function handleDownloadEntry(entry: RemoteFsEntry) {
    if (entry.isDir || isDownloadActive) return;
    setDownloadingPath(entry.path);
    setErrorMsg(null);
    try {
      const res = await client.downloadRemoteFile(entry.path);
      triggerBlobDownload(res.blob, res.fileName);
      onShowToast?.("info", `已下载「${res.fileName}」（SHA-256 校验通过）`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "下载远端文件失败";
      if (msg !== "已取消下载") {
        setErrorMsg(msg);
      }
    } finally {
      setDownloadingPath((curr) => (curr === entry.path ? null : curr));
    }
  }

  async function handleConfirmDelete(entry: RemoteFsEntry) {
    if (deletingPath) return;
    setDeletingPath(entry.path);
    setErrorMsg(null);
    try {
      const res = await client.deleteRemoteFs(entry.path);
      if (!res.ok) {
        setErrorMsg(res.error || "移入废纸篓失败");
        return;
      }
      setConfirmDeletePath(null);
      onShowToast?.("info", `已将「${entry.name}」移入远端废纸篓`);
      if (currentDir) {
        await loadDirectory(currentDir);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "移入废纸篓失败");
    } finally {
      setDeletingPath(null);
    }
  }

  const uploadPct =
    ft && ft.totalBytes > 0
      ? ft.status === "done"
        ? 100
        : Math.min(100, Math.round((ft.sentBytes / ft.totalBytes) * 100))
      : 0;

  const downloadPct =
    dl.totalBytes > 0
      ? Math.min(100, Math.round((dl.receivedBytes / dl.totalBytes) * 100))
      : dl.active
        ? 15
        : 0;

  return (
    <div className="space-y-3">
      {/* P2P File Channel Status Strip */}
      {isFileReady ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          <span className="inline-flex items-center gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
            <span>WebRTC 双向文件管理通道已就绪（P2P 直传 · SHA-256 校验）</span>
          </span>
          <span className="font-mono text-[10px] text-emerald-300/80">
            支持拖拽上传到此目录
          </span>
        </div>
      ) : (
        <div className="space-y-2 rounded-lg border border-amber-500/35 bg-amber-500/10 p-3 text-xs text-amber-200">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <p className="leading-relaxed">
              {clientState.activeTransport !== "webrtc"
                ? "当前处于 WS 帧流通道，双向文件管理需切换至 WebRTC 模式。"
                : "WebRTC P2P 文件通道尚未就绪，请等待通道连通。"}
            </p>
          </div>
          {clientState.activeTransport !== "webrtc" && (
            <button
              type="button"
              onClick={() => client.setTransport("webrtc")}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-amber-400/40 bg-amber-400/15 px-3 text-xs font-medium text-amber-100 hover:bg-amber-400/25"
            >
              <Zap className="h-3.5 w-3.5" />
              切换至 WebRTC
            </button>
          )}
        </div>
      )}

      {/* Quick Root Pills */}
      {isFileReady && supportsFileManager && (
        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
          {rootsLoading && roots.length === 0 ? (
            <span className="inline-flex h-8 items-center gap-1.5 px-2 text-xs text-zinc-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[#60A5FA]" />
              正在加载远端快捷目录...
            </span>
          ) : (
            roots.map((root) => {
              const isSelected = currentDir === root.path;
              return (
                <button
                  key={root.path}
                  type="button"
                  onClick={() => void loadDirectory(root.path)}
                  title={root.path}
                  className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition ${
                    isSelected
                      ? "border-[#2563EB] bg-[#2563EB] text-white"
                      : "border-[#262A34] bg-[#191D26] text-zinc-200 hover:border-[#3A4152] hover:bg-[#232836]"
                  }`}
                >
                  {renderRootIcon(root.kind)}
                  <span>{root.name}</span>
                </button>
              );
            })
          )}
        </div>
      )}

      {/* Path Breadcrumb + Action Toolbar */}
      <div className="rounded-lg border border-[#262A34] bg-[#0A0C10]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1F2430] px-2.5 py-2">
          {/* Scrollable Breadcrumb */}
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto font-mono text-[11px] text-zinc-300">
            {breadcrumbs.length > 0 ? (
              breadcrumbs.map((seg, idx) => {
                const isLast = idx === breadcrumbs.length - 1;
                return (
                  <span key={seg.path} className="inline-flex shrink-0 items-center gap-1">
                    {idx > 0 && <span className="text-zinc-600">/</span>}
                    <button
                      type="button"
                      disabled={listLoading || isLast}
                      onClick={() => void loadDirectory(seg.path)}
                      className={`rounded px-1 py-0.5 transition ${
                        isLast
                          ? "font-semibold text-white"
                          : "text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
                      }`}
                    >
                      {seg.label}
                    </button>
                  </span>
                );
              })
            ) : (
              <span className="text-zinc-500">
                {supportsFileManager
                  ? "选择一个快捷目录开始浏览远端文件"
                  : "远端主机未开放目录浏览，仍可直接上传文件"}
              </span>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex shrink-0 items-center gap-1">
            {supportsFileManager && (
              <>
                <button
                  type="button"
                  disabled={!isFileReady || !parentPath || listLoading}
                  onClick={() => parentPath && void loadDirectory(parentPath)}
                  title="上级目录"
                  className="inline-flex h-8 items-center gap-1 rounded-md border border-[#262A34] bg-[#14171F] px-2 text-[11px] font-medium text-zinc-200 transition hover:bg-[#1E2330] disabled:opacity-40"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">上级</span>
                </button>
                <button
                  type="button"
                  disabled={!isFileReady || !currentDir || listLoading}
                  onClick={() => currentDir && void loadDirectory(currentDir)}
                  title="刷新目录"
                  className="inline-flex h-8 items-center gap-1 rounded-md border border-[#262A34] bg-[#14171F] px-2 text-[11px] font-medium text-zinc-200 transition hover:bg-[#1E2330] disabled:opacity-40"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${listLoading ? "animate-spin text-[#60A5FA]" : ""}`}
                  />
                  <span className="hidden sm:inline">刷新</span>
                </button>
                <button
                  type="button"
                  disabled={!isFileReady || !currentDir}
                  onClick={() => {
                    setCreatingFolder((prev) => !prev);
                    setFolderNameDraft("");
                  }}
                  title="新建文件夹"
                  className={`inline-flex h-8 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition disabled:opacity-40 ${
                    creatingFolder
                      ? "border-[#2563EB] bg-[#2563EB] text-white"
                      : "border-[#262A34] bg-[#14171F] text-zinc-200 hover:bg-[#1E2330]"
                  }`}
                >
                  <FolderPlus className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">新建</span>
                </button>
              </>
            )}

            <input
              ref={uploadInputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) {
                  void handleUploadToCurrentDir(file);
                }
              }}
            />
            <button
              type="button"
              disabled={!isFileReady || isUploadActive}
              onClick={() => uploadInputRef.current?.click()}
              className="btn-primary inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Upload className="h-3.5 w-3.5" />
              <span>上传到此目录</span>
            </button>
          </div>
        </div>

        {/* Inline New Folder Input Row */}
        {creatingFolder && (
          <div className="flex items-center gap-2 border-b border-[#1F2430] bg-[#111520] px-3 py-2">
            <Folder className="h-4 w-4 shrink-0 text-[#60A5FA]" />
            <input
              ref={newFolderInputRef}
              type="text"
              value={folderNameDraft}
              onChange={(e) => setFolderNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleCreateFolder();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setCreatingFolder(false);
                }
              }}
              placeholder="输入新文件夹名称..."
              maxLength={120}
              className="h-8 min-w-0 flex-1 rounded-md border border-[#2C313D] bg-[#0A0C10] px-2.5 text-xs text-white placeholder:text-zinc-500 focus:border-[#2563EB] focus:outline-none"
            />
            <button
              type="button"
              disabled={mkdirBusy || !folderNameDraft.trim()}
              onClick={() => void handleCreateFolder()}
              className="btn-primary inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-xs font-medium disabled:opacity-45"
            >
              {mkdirBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              创建
            </button>
            <button
              type="button"
              onClick={() => setCreatingFolder(false)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#262A34] bg-[#14171F] text-zinc-400 hover:text-white"
              aria-label="取消新建文件夹"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Quick Filter Bar for Large Directories */}
        {entries.length > 8 && (
          <div className="flex items-center gap-2 border-b border-[#1F2430] px-3 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={`筛选当前目录 (${entries.length} 项)...`}
              className="h-7 min-w-0 flex-1 bg-transparent text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="text-zinc-500 hover:text-zinc-200"
                aria-label="清除筛选"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}

        {/* Error Strip */}
        {errorMsg && (
          <div className="flex items-center justify-between gap-2 border-b border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            <span className="min-w-0 flex-1">{errorMsg}</span>
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              className="shrink-0 text-rose-300/80 hover:text-rose-100"
              aria-label="关闭错误提示"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Tabular File Listing */}
        {supportsFileManager && (
          <div className="max-h-[38vh] min-h-[160px] overflow-y-auto divide-y divide-[#1A1E28]">
            {listLoading && entries.length === 0 ? (
              <div className="flex h-40 items-center justify-center gap-2 text-xs text-zinc-400">
                <Loader2 className="h-4 w-4 animate-spin text-[#60A5FA]" />
                <span>正在读取远端目录...</span>
              </div>
            ) : !isFileReady ? (
              <div className="flex h-36 flex-col items-center justify-center gap-1.5 px-4 text-center text-xs text-zinc-500">
                <FileUp className="h-5 w-5 text-zinc-600" />
                <span>建立 WebRTC 连接后即可浏览、上传与下载远端电脑文件</span>
              </div>
            ) : filteredEntries.length === 0 ? (
              <div className="flex h-32 items-center justify-center text-xs text-zinc-500">
                {searchQuery ? "没有匹配的文件或文件夹" : "此目录为空"}
              </div>
            ) : (
              filteredEntries.map((entry) => {
                const isConfirmingDel = confirmDeletePath === entry.path;
                const isDeletingThis = deletingPath === entry.path;
                const isDownloadingThis = downloadingPath === entry.path;
                return (
                  <div
                    key={entry.path}
                    className="flex items-center justify-between gap-2 px-3 py-2 text-xs transition hover:bg-[#141822]"
                  >
                    <button
                      type="button"
                      disabled={!entry.isDir}
                      onClick={() => entry.isDir && void loadDirectory(entry.path)}
                      className={`flex min-w-0 flex-1 items-center gap-2.5 text-left ${
                        entry.isDir ? "cursor-pointer" : "cursor-default"
                      }`}
                    >
                      {entry.isDir ? (
                        <Folder className="h-4 w-4 shrink-0 text-[#60A5FA]" />
                      ) : (
                        <FileIcon className="h-4 w-4 shrink-0 text-zinc-400" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-zinc-100">
                          {entry.name}
                        </p>
                        <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-zinc-500">
                          <span>{entry.isDir ? "文件夹" : formatBytes(entry.size)}</span>
                          <span>·</span>
                          <span>{formatMtime(entry.mtimeMs)}</span>
                        </div>
                      </div>
                    </button>

                    <div className="flex shrink-0 items-center gap-1">
                      {isConfirmingDel ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            disabled={isDeletingThis}
                            onClick={() => void handleConfirmDelete(entry)}
                            className="inline-flex h-7 items-center gap-1 rounded border border-rose-500/50 bg-rose-600 px-2 text-[11px] font-medium text-white hover:bg-rose-500 disabled:opacity-50"
                          >
                            {isDeletingThis && (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            )}
                            确认删除
                          </button>
                          <button
                            type="button"
                            disabled={isDeletingThis}
                            onClick={() => setConfirmDeletePath(null)}
                            className="inline-flex h-7 items-center rounded border border-[#262A34] bg-[#191D26] px-2 text-[11px] text-zinc-300 hover:bg-[#232836]"
                          >
                            取消
                          </button>
                        </div>
                      ) : (
                        <>
                          {!entry.isDir && (
                            <button
                              type="button"
                              disabled={!isFileReady || isDownloadActive}
                              onClick={() => void handleDownloadEntry(entry)}
                              title="下载到本地"
                              className="inline-flex h-7 items-center gap-1 rounded-md border border-[#262A34] bg-[#191D26] px-2 text-[11px] font-medium text-zinc-200 transition hover:border-[#3B82F6]/60 hover:bg-[#1E293B] hover:text-white disabled:opacity-40"
                            >
                              {isDownloadingThis ? (
                                <Loader2 className="h-3 w-3 animate-spin text-[#60A5FA]" />
                              ) : (
                                <Download className="h-3 w-3 text-[#60A5FA]" />
                              )}
                              <span>下载</span>
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={!isFileReady || Boolean(deletingPath)}
                            onClick={() => setConfirmDeletePath(entry.path)}
                            title="移入远端废纸篓"
                            aria-label={`将 ${entry.name} 移入废纸篓`}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[#262A34] bg-[#191D26] text-zinc-400 transition hover:border-rose-500/40 hover:bg-rose-500/15 hover:text-rose-300 disabled:opacity-40"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Active Download Progress Strip */}
      {(dl.active || dl.error) && (
        <div className="rounded-lg border border-[#262A34] bg-[#0A0C10] p-3">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="truncate font-medium text-white">
              下载：{dl.fileName || "远端文件"}
            </span>
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${
                dl.error
                  ? "bg-rose-500/20 text-rose-300"
                  : "bg-blue-500/20 text-blue-300"
              }`}
            >
              {dl.error ? "已中止" : `${downloadPct}%`}
            </span>
          </div>
          {dl.active && (
            <>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-[#3B82F6] transition-all duration-150"
                  style={{ width: `${downloadPct}%` }}
                />
              </div>
              <div className="mt-1.5 flex items-center justify-between font-mono text-[11px] text-zinc-400">
                <span>
                  {formatBytes(dl.receivedBytes)}
                  {dl.totalBytes > 0 ? ` / ${formatBytes(dl.totalBytes)}` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => client.cancelRemoteFileDownload()}
                  className="font-sans text-xs font-medium text-rose-300 hover:text-rose-200"
                >
                  取消下载
                </button>
              </div>
            </>
          )}
          {dl.error && !dl.active && (
            <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-rose-300">
              <span>{dl.error}</span>
              <button
                type="button"
                onClick={() => client.clearRemoteFileDownload()}
                className="text-zinc-400 hover:text-white"
              >
                清除
              </button>
            </div>
          )}
        </div>
      )}

      {/* Active / Recent Upload Progress Strip */}
      {ft && (
        <div className="rounded-lg border border-[#262A34] bg-[#0A0C10] p-3">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="truncate font-medium text-white">
              上传：{ft.fileName}
            </span>
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                ft.status === "done"
                  ? "bg-emerald-500/20 text-emerald-300"
                  : ft.status === "error"
                    ? "bg-rose-500/20 text-rose-300"
                    : ft.status === "cancelled"
                      ? "bg-zinc-500/20 text-zinc-300"
                      : "bg-blue-500/20 text-blue-300"
              }`}
            >
              {ft.status === "done"
                ? "已上传"
                : ft.status === "verifying"
                  ? "校验中"
                  : ft.status === "error"
                    ? "失败"
                    : ft.status === "cancelled"
                      ? "已取消"
                      : `${uploadPct}%`}
            </span>
          </div>

          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className={`h-full rounded-full transition-all duration-150 ${
                ft.status === "error"
                  ? "bg-rose-500"
                  : ft.status === "done"
                    ? "bg-emerald-400"
                    : ft.status === "cancelled"
                      ? "bg-zinc-500"
                      : "bg-[#3B82F6]"
              }`}
              style={{
                width: `${ft.status === "preparing" && ft.totalBytes === 0 ? 12 : uploadPct}%`,
              }}
            />
          </div>

          <div className="mt-1.5 flex items-center justify-between font-mono text-[11px] text-zinc-400">
            <span>
              {formatBytes(ft.sentBytes)} / {formatBytes(ft.totalBytes)}
            </span>
            <span>
              {ft.status === "sending" ? formatSpeed(ft.speedBytesPerSec) : ""}
            </span>
          </div>

          {ft.message && (
            <p className="mt-1.5 truncate text-[11px] text-zinc-300">{ft.message}</p>
          )}

          <div className="mt-2 flex justify-end">
            {isUploadActive ? (
              <button
                type="button"
                onClick={() => client.cancelFileTransfer()}
                className="inline-flex h-7 items-center gap-1 rounded border border-rose-500/35 bg-rose-500/15 px-2.5 text-[11px] font-medium text-rose-200 hover:bg-rose-500/25"
              >
                <X className="h-3 w-3" />
                取消上传
              </button>
            ) : (
              <button
                type="button"
                onClick={() => client.clearFileTransfer()}
                className="inline-flex h-7 items-center gap-1 rounded border border-[#262A34] bg-[#191D26] px-2 text-[11px] text-zinc-300 hover:bg-[#232836]"
              >
                清除记录
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
