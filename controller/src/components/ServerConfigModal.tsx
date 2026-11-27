import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Loader2,
  PlugZap,
  Server,
  Trash2,
  X,
} from "lucide-react";
import {
  deriveRelayWsUrlFromApiBase,
  formatServerHostLabel,
  normalizeServerBaseUrl,
} from "../desktop/bridge";
import { fetchServerInfo } from "../state/auth";

export interface ServerConfigModalProps {
  open: boolean;
  currentServerUrl: string;
  recentServers: string[];
  onClose: () => void;
  onSaveServer: (normalizedServerUrl: string) => Promise<void> | void;
  onRemoveRecentServer?: (serverUrl: string) => Promise<void> | void;
}

type ConnectionTestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; message: string; latencyMs: number }
  | { status: "error"; message: string };

export function ServerConfigModal({
  open,
  currentServerUrl,
  recentServers,
  onClose,
  onSaveServer,
  onRemoveRecentServer,
}: ServerConfigModalProps) {
  const [inputUrl, setInputUrl] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<ConnectionTestState>({
    status: "idle",
  });

  const inputRef = useRef<HTMLInputElement | null>(null);
  const testAbortRef = useRef<AbortController | null>(null);
  const testSeqRef = useRef(0);

  useEffect(() => {
    if (!open) {
      testAbortRef.current?.abort();
      testAbortRef.current = null;
      return;
    }
    setInputUrl(currentServerUrl);
    setFormError(null);
    setSaving(false);
    setTestState({ status: "idle" });
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 20);
    return () => {
      window.clearTimeout(timer);
      testAbortRef.current?.abort();
      testAbortRef.current = null;
    };
  }, [open, currentServerUrl]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  const normalizedUrl = useMemo(
    () => normalizeServerBaseUrl(inputUrl),
    [inputUrl],
  );
  const derivedWsUrl = useMemo(
    () => (normalizedUrl ? deriveRelayWsUrlFromApiBase(normalizedUrl) : ""),
    [normalizedUrl],
  );
  const normalizedCurrent = useMemo(
    () => normalizeServerBaseUrl(currentServerUrl),
    [currentServerUrl],
  );

  const normalizedRecent = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const raw of recentServers) {
      const clean = normalizeServerBaseUrl(raw);
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      list.push(clean);
    }
    return list;
  }, [recentServers]);

  if (!open) return null;

  async function handleTestConnection() {
    if (!normalizedUrl) {
      setFormError("请输入有效的服务器域名或 IP 地址后再测试连接");
      return;
    }

    testAbortRef.current?.abort();
    const controller = new AbortController();
    testAbortRef.current = controller;
    const seq = ++testSeqRef.current;

    setFormError(null);
    setTestState({ status: "testing" });

    let httpStatus: number | null = null;
    let isJsonResponse = true;
    let networkError: string | null = null;
    const startedAt = performance.now();
    const timeoutId = window.setTimeout(() => controller.abort(), 6000);

    try {
      const info = await fetchServerInfo(normalizedUrl, async (url, init) => {
        try {
          const res = await fetch(url, { ...init, signal: controller.signal });
          httpStatus = res.status;
          const contentType = res.headers.get("content-type") ?? "";
          if (res.ok && contentType && !contentType.toLowerCase().includes("json")) {
            isJsonResponse = false;
          }
          return res;
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            networkError = "连接超时（6 秒未响应），请检查地址、端口或防火墙";
          } else {
            networkError =
              "无法连接到该服务器，请检查地址、端口、HTTPS 证书或网络连通性";
          }
          throw err;
        }
      });

      if (seq !== testSeqRef.current) return;
      const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));

      if (networkError) {
        setTestState({ status: "error", message: networkError });
      } else if (httpStatus === null || httpStatus < 200 || httpStatus >= 300) {
        setTestState({
          status: "error",
          message:
            httpStatus !== null
              ? `服务器返回 HTTP ${httpStatus}，请确认该地址运行的是 VeloDeck 服务端`
              : "服务器未返回有效响应",
        });
      } else if (!isJsonResponse) {
        setTestState({
          status: "error",
          message: "目标地址返回的不是 VeloDeck 接口响应，请检查 URL 路径",
        });
      } else {
        const versionSuffix = info.version
          ? `服务端 v${info.version}`
          : "VeloDeck 服务端";
        setTestState({
          status: "ok",
          message: `连接成功 · ${versionSuffix}`,
          latencyMs,
        });
      }
    } finally {
      window.clearTimeout(timeoutId);
      if (testAbortRef.current === controller) {
        testAbortRef.current = null;
      }
    }
  }

  async function commitServerUrl(targetUrl: string) {
    const clean = normalizeServerBaseUrl(targetUrl);
    if (!clean) {
      setFormError(
        "请输入有效的服务器地址（例如 https://remote.example.com 或 http://203.0.113.10）",
      );
      return;
    }

    setSaving(true);
    setFormError(null);
    try {
      await onSaveServer(clean);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "保存服务器配置失败";
      setFormError(msg);
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    void commitServerUrl(inputUrl);
  }

  const hasRawInput = inputUrl.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-[65] flex items-end justify-center bg-black/45 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="自托管服务器设置"
        className="modal-panel animate-sheet-up safe-bottom max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl text-[#111318] sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#E2E6EC] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#EFF4FF] text-[#2563EB]">
              <Server className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-[#111318]">
                自托管服务器设置
              </h2>
              <p className="mt-0.5 text-xs text-[#6B7280]">
                配置你的 VeloDeck 中继服务端地址，用于控制码与账号登录
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[#6B7280] hover:bg-[#F3F4F6] hover:text-[#111318]"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 p-5">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="desktop-server-url-input"
                className="mb-1.5 block text-xs font-medium text-[#374151]"
              >
                服务器地址（HTTP / HTTPS）
              </label>
              <input
                ref={inputRef}
                id="desktop-server-url-input"
                type="text"
                value={inputUrl}
                onChange={(e) => {
                  setInputUrl(e.target.value);
                  setFormError(null);
                  if (testState.status !== "idle") {
                    setTestState({ status: "idle" });
                  }
                }}
                placeholder="https://your-server.example.com 或 http://203.0.113.10"
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                className="field h-11 w-full rounded-lg px-3.5 font-mono text-sm placeholder:font-sans placeholder:text-[#9CA3AF]"
              />
              <p className="mt-1.5 text-[11px] text-[#6B7280]">
                示例：
                <span className="font-mono text-[#374151]">
                  https://remote.example.com
                </span>
                、
                <span className="font-mono text-[#374151]">
                  http://203.0.113.10
                </span>
                {" "}或{" "}
                <span className="font-mono text-[#374151]">
                  192.168.1.50:8080
                </span>
              </p>
            </div>

            {/* Auto-Normalization & WebSocket Preview */}
            {hasRawInput && (
              normalizedUrl ? (
                <div className="space-y-1.5 rounded-lg border border-[#E2E6EC] bg-[#F8F9FB] px-3.5 py-2.5 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <span className="shrink-0 text-[11px] font-medium text-[#6B7280]">
                      API 地址
                    </span>
                    <span className="truncate font-mono text-[11px] font-medium text-[#111318]">
                      {normalizedUrl}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="shrink-0 text-[11px] font-medium text-[#6B7280]">
                      WebSocket
                    </span>
                    <span className="truncate font-mono text-[11px] text-[#2563EB]">
                      {derivedWsUrl}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg border border-[#FDE68A] bg-[#FFFBEB] px-3 py-2 text-xs text-[#92400E]">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#D97706]" />
                  <span>
                    地址格式无效，请输入域名或 IP（仅支持 http:// 与 https:// 协议）
                  </span>
                </div>
              )
            )}

            {/* Live Connection Test Result */}
            {testState.status === "ok" && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-[#BBF7D0] bg-[#ECFDF3] px-3.5 py-2.5 text-xs text-[#15803D]">
                <span className="inline-flex items-center gap-2 font-medium">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>{testState.message}</span>
                </span>
                <span className="shrink-0 font-mono text-[11px]">
                  {testState.latencyMs}ms
                </span>
              </div>
            )}

            {testState.status === "error" && (
              <div className="flex items-start gap-2 rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-xs text-[#991B1B]">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#DC2626]" />
                <span>{testState.message}</span>
              </div>
            )}

            {formError && (
              <div className="flex items-start gap-2 rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-xs text-[#991B1B]">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#DC2626]" />
                <span>{formError}</span>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex items-center gap-2.5 pt-1">
              <button
                type="button"
                disabled={!normalizedUrl || testState.status === "testing" || saving}
                onClick={() => void handleTestConnection()}
                className="btn-outline inline-flex h-10 items-center justify-center gap-1.5 rounded-lg px-4 text-xs font-medium disabled:cursor-not-allowed"
              >
                {testState.status === "testing" ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-[#2563EB]" />
                    <span>测试中...</span>
                  </>
                ) : (
                  <>
                    <PlugZap className="h-3.5 w-3.5 text-[#2563EB]" />
                    <span>测试连接</span>
                  </>
                )}
              </button>

              <button
                type="submit"
                disabled={!normalizedUrl || saving}
                className="btn-primary flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg text-sm font-medium disabled:cursor-not-allowed"
              >
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>正在切换...</span>
                  </>
                ) : (
                  <span>保存并切换</span>
                )}
              </button>
            </div>
          </form>

          {/* Recent Servers Sheet */}
          {normalizedRecent.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-[#374151]">
                  最近使用的服务器
                </h3>
                <span className="font-mono text-[11px] text-[#6B7280]">
                  {normalizedRecent.length} 个
                </span>
              </div>

              <div className="overflow-hidden rounded-lg border border-[#E2E6EC]">
                <ul className="divide-y divide-[#ECEFF4]">
                  {normalizedRecent.map((serverUrl) => {
                    const isCurrent = serverUrl === normalizedCurrent;
                    const hostLabel =
                      formatServerHostLabel(serverUrl) || serverUrl;
                    return (
                      <li
                        key={serverUrl}
                        className={`flex items-center gap-2 px-3.5 py-2.5 transition-colors ${
                          isCurrent
                            ? "bg-[#EFF4FF]"
                            : "bg-white hover:bg-[#F8F9FB]"
                        }`}
                      >
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void commitServerUrl(serverUrl)}
                          className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left disabled:opacity-50"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-mono text-xs font-semibold text-[#111318]">
                                {hostLabel}
                              </span>
                              {isCurrent && (
                                <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-[#DBEAFE] px-1.5 py-0.5 text-[10px] font-medium text-[#1D4ED8]">
                                  <Check className="h-2.5 w-2.5" />
                                  当前
                                </span>
                              )}
                            </div>
                            <p className="mt-0.5 truncate font-mono text-[11px] text-[#6B7280]">
                              {serverUrl}
                            </p>
                          </div>
                          {!isCurrent && (
                            <span className="shrink-0 text-xs font-medium text-[#2563EB]">
                              切换
                            </span>
                          )}
                        </button>

                        {onRemoveRecentServer && (
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => void onRemoveRecentServer(serverUrl)}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#9CA3AF] hover:bg-[#FEF2F2] hover:text-[#DC2626] disabled:opacity-50"
                            aria-label={`移除 ${hostLabel}`}
                            title="从最近列表移除"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
