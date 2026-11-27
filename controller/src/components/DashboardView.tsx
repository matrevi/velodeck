import { useEffect, useState } from "react";
import {
  BatteryCharging,
  Check,
  ChevronRight,
  Copy,
  Download,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  MonitorSmartphone,
  Plus,
  RefreshCw,
  Server,
  Share,
  ShieldCheck,
  Smartphone,
  Sun,
  Trash2,
  Unlock,
  Wifi,
  X,
  Zap,
} from "lucide-react";
import { formatControlCode, type DeviceSummary } from "@velodeck/protocol";
import {
  dismissIosPwaBanner,
  getAndroidApkDownloadUrl,
  shouldShowIosPwaBanner,
  type SavedAccountSession,
  type ServerInfo,
} from "../state/auth";
import { isAllowedDirectUrl } from "../state/profiles";
import type { RemoteClientState } from "../transport/RemoteClient";
import { SecuritySettingsModal } from "./SecuritySettingsModal";

interface DashboardViewProps {
  clientState: RemoteClientState;
  savedAccount: SavedAccountSession | null;
  apiBase: string;
  serverInfo: ServerInfo;
  profileCount: number;
  onOpenConnections: (editProfileId?: string) => void;
  onOpenControlCode: () => void;
  onLogoutAccount: () => void;
  onReloginAccount: () => void;
  onChangePassword: (input: {
    currentPassword: string;
    newPassword: string;
  }) => Promise<void>;
  onLogoutAllSessions: () => Promise<void>;
  onControlDevice: (device: DeviceSummary) => void;
  onWakeDevice: (device: DeviceSummary) => void;
  onUnbindDevice: (device: DeviceSummary) => Promise<void>;
  onReconnect: () => void;
  onSwitchToDirectUrl?: (device: DeviceSummary) => void;
}

function formatLastSeen(ts: number): string {
  if (!ts) return "离线";
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return "刚刚在线";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  return `${Math.floor(diffSec / 86400)} 天前`;
}

function renderShellStatus(state: RemoteClientState) {
  switch (state.socketStatus) {
    case "connected":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          已连接
          {state.rttMs !== null && (
            <span className="font-mono text-zinc-300">{state.rttMs}ms</span>
          )}
        </span>
      );
    case "connecting":
    case "authenticating":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-2 py-0.5 text-[11px] font-medium text-blue-300">
          <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
          连接中
        </span>
      );
    case "reconnecting":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-200">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          重连 #{state.reconnectAttempt}
        </span>
      );
    case "error":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-md bg-rose-500/20 px-2 py-0.5 text-[11px] font-medium text-rose-200">
          <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
          连接异常
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-2 py-0.5 text-[11px] font-medium text-zinc-400">
          <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" />
          未连接
        </span>
      );
  }
}

export function DashboardView({
  clientState,
  savedAccount,
  apiBase,
  serverInfo,
  profileCount,
  onOpenConnections,
  onOpenControlCode,
  onLogoutAccount,
  onReloginAccount,
  onChangePassword,
  onLogoutAllSessions,
  onControlDevice,
  onWakeDevice,
  onUnbindDevice,
  onReconnect,
  onSwitchToDirectUrl,
}: DashboardViewProps) {
  const [showIosBanner, setShowIosBanner] = useState(false);
  const [wakingDeviceId, setWakingDeviceId] = useState<string | null>(null);
  const [copiedCodeDeviceId, setCopiedCodeDeviceId] = useState<string | null>(null);
  const [confirmUnbindId, setConfirmUnbindId] = useState<string | null>(null);
  const [unbindingDeviceId, setUnbindingDeviceId] = useState<string | null>(null);
  const [securityModalOpen, setSecurityModalOpen] = useState(false);

  useEffect(() => {
    setShowIosBanner(shouldShowIosPwaBanner());
  }, []);

  function handleDismissIosBanner() {
    setShowIosBanner(false);
    dismissIosPwaBanner();
  }

  function handleWakeClick(device: DeviceSummary) {
    setWakingDeviceId(device.deviceId);
    onWakeDevice(device);
    window.setTimeout(() => {
      setWakingDeviceId((curr) => (curr === device.deviceId ? null : curr));
    }, 900);
  }

  async function handleCopyControlCode(device: DeviceSummary) {
    if (!device.controlCode) return;
    try {
      await navigator.clipboard.writeText(formatControlCode(device.controlCode));
      setCopiedCodeDeviceId(device.deviceId);
      window.setTimeout(() => {
        setCopiedCodeDeviceId((curr) => (curr === device.deviceId ? null : curr));
      }, 1500);
    } catch {
      // Ignore clipboard denial
    }
  }

  async function handleConfirmUnbind(device: DeviceSummary) {
    setUnbindingDeviceId(device.deviceId);
    try {
      await onUnbindDevice(device);
      setConfirmUnbindId(null);
    } finally {
      setUnbindingDeviceId(null);
    }
  }

  const activeProfile = clientState.profile;
  const isAccountMode =
    clientState.authType === "account" ||
    (!activeProfile && savedAccount !== null);
  const activeUser = clientState.user ?? savedAccount?.user ?? null;
  const accountLabel = activeUser
    ? activeUser.displayName || activeUser.username
    : "";
  const activeMode = clientState.serverMode ?? activeProfile?.mode ?? "relay";
  const hasActiveConnection = isAccountMode || Boolean(activeProfile);
  const apkUrl = getAndroidApkDownloadUrl(apiBase);
  const hasAndroidApk = serverInfo.hasAndroidApk;
  const apkSha256 = serverInfo.apkSha256;
  const onlineCount = clientState.devices.filter((d) => d.online).length;

  return (
    <div className="flex min-h-[100dvh] flex-col bg-[#F4F5F7] text-[#111318]">
      {/* Committed Deep-Ink Hardware Shell Header */}
      <header className="safe-top sticky top-0 z-30 border-b border-[#232732] bg-[#111318] text-white">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-2.5 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <img
              src="./icon.svg"
              alt="VeloDeck 极控"
              className="h-7 w-7 shrink-0 rounded-lg bg-[#1C212C] ring-1 ring-white/20"
            />
            <span className="text-[15px] font-semibold tracking-tight text-white">
              VeloDeck 极控
            </span>
            {renderShellStatus(clientState)}
          </div>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            {isAccountMode ? (
              <>
                <button
                  type="button"
                  onClick={onOpenControlCode}
                  className="btn-shell inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium"
                >
                  <KeyRound className="h-3.5 w-3.5 text-blue-400" />
                  <span>控制码</span>
                </button>
                {savedAccount && (
                  <button
                    type="button"
                    onClick={() => setSecurityModalOpen(true)}
                    className="btn-shell inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium"
                    title="账号安全设置"
                  >
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                    <span className="hidden sm:inline">安全设置</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={onLogoutAccount}
                  className="btn-shell inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium hover:text-rose-300"
                  title="退出账号"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">退出</span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onOpenControlCode}
                  className="btn-shell inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium"
                >
                  <KeyRound className="h-3.5 w-3.5 text-blue-400" />
                  <span className="hidden sm:inline">控制码 / 账号</span>
                </button>
                <button
                  type="button"
                  onClick={() => onOpenConnections()}
                  className="btn-shell inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium"
                >
                  <Plus className="h-3.5 w-3.5 text-blue-400" />
                  <span>{profileCount > 0 ? "切换连接" : "添加连接"}</span>
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="safe-bottom mx-auto flex w-full max-w-5xl flex-1 flex-col space-y-5 px-4 py-6 sm:px-6 lg:py-8">
        {/* iOS Add to Home Screen Strip */}
        {showIosBanner && (
          <div className="flex items-center gap-3 rounded-lg border border-[#D8E2F8] bg-[#EFF4FF] px-3.5 py-2.5 text-xs text-[#1E3A8A]">
            <Share className="h-4 w-4 shrink-0 text-[#2563EB]" />
            <p className="min-w-0 flex-1 leading-snug">
              在 Safari 中轻点「分享」→「添加到主屏幕」，即可全屏无地址栏控机。
            </p>
            <button
              type="button"
              onClick={handleDismissIosBanner}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#1E3A8A]/70 hover:bg-[#DBEAFE]"
              aria-label="关闭提示"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Workspace Page Header Row (Flat on ground, clear operational controls) */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[#111318]">
              {isAccountMode ? "我的设备" : activeProfile?.label || "设备列表"}
            </h1>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-[#6B7280]">
              {isAccountMode && accountLabel && (
                <span>账号：{accountLabel}</span>
              )}
              <span>
                在线{" "}
                <strong className="font-mono font-semibold text-[#111318]">
                  {onlineCount}
                </strong>{" "}
                / <span className="font-mono">{clientState.devices.length}</span> 台
              </span>
              <span className="text-[#CBD5E1]">|</span>
              <span>
                通道：
                {clientState.desiredTransport === "webrtc" ? "WebRTC" : "WS 帧流"}
              </span>
            </p>
          </div>

          <div className="flex items-center gap-2">
            {hasActiveConnection && (
              <button
                type="button"
                onClick={onReconnect}
                className="btn-outline inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-medium"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 text-[#4B5563] ${
                    clientState.socketStatus === "connecting" ||
                    clientState.socketStatus === "authenticating"
                      ? "animate-spin text-[#2563EB]"
                      : ""
                  }`}
                />
                刷新状态
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpenConnections()}
              className="btn-outline inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-[#4B5563]"
            >
              <Server className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">局域网 / 自建</span>
            </button>
          </div>
        </div>

        {/* Error Banner */}
        {clientState.errorMessage && clientState.socketStatus !== "connected" && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-4 py-3 text-xs text-[#991B1B]">
            <span className="leading-relaxed">{clientState.errorMessage}</span>
            {isAccountMode && clientState.errorCode === "UNAUTHORIZED" ? (
              <button
                type="button"
                onClick={onReloginAccount}
                className="shrink-0 rounded-md bg-[#DC2626] px-3 py-1.5 font-medium text-white hover:bg-[#B91C1C]"
              >
                重新登录
              </button>
            ) : activeProfile ? (
              <button
                type="button"
                onClick={() => onOpenConnections(activeProfile.id)}
                className="shrink-0 rounded-md border border-[#FCA5A5] bg-white px-3 py-1.5 font-medium text-[#991B1B] hover:bg-[#FEF2F2]"
              >
                修改配置
              </button>
            ) : null}
          </div>
        )}

        {/* Unified White Fleet Sheet (Zero nested cards!) */}
        {!hasActiveConnection ? (
          <section className="panel rounded-xl px-6 py-12 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-[#F4F5F7] text-[#374151]">
              <MonitorSmartphone className="h-6 w-6" />
            </div>
            <h2 className="text-base font-semibold text-[#111318]">
              开始连接你的 Android 手机
            </h2>
            <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-[#6B7280]">
              输入 9 位远程控制码或登录同一账号即可随时控机，也支持局域网直连。
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
              <button
                type="button"
                onClick={onOpenControlCode}
                className="btn-primary inline-flex h-10 items-center gap-2 rounded-lg px-4 text-xs font-medium"
              >
                <KeyRound className="h-4 w-4" />
                控制码 / 账号登录
              </button>
              <button
                type="button"
                onClick={() => onOpenConnections()}
                className="btn-outline inline-flex h-10 items-center gap-1.5 rounded-lg px-4 text-xs font-medium"
              >
                <Plus className="h-4 w-4" />
                添加直连配置
              </button>
            </div>
          </section>
        ) : clientState.devices.length === 0 ? (
          <section className="panel rounded-xl px-6 py-12 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-[#F4F5F7] text-[#4B5563]">
              <Smartphone className="h-6 w-6" />
            </div>
            <h2 className="text-base font-semibold text-[#111318]">
              {clientState.socketStatus === "connected"
                ? isAccountMode
                  ? "账号下还没有已绑定的手机"
                  : "暂未发现受控设备"
                : "正在连接云端服务..."}
            </h2>
            <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-[#6B7280]">
              {clientState.socketStatus === "connected"
                ? isAccountMode
                  ? `在被控 Android 手机上安装并打开 VeloDeck Agent，登录同一账号「${accountLabel || activeUser?.username || ""}」，设备会自动上线显示在此列表中。`
                  : "请确认 Android 手机上的 VeloDeck Agent 已启动并配置了相同的服务地址与密钥。"
                : "正在进行握手认证，请稍候片刻或点击重新检测。"}
            </p>

            <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
              {isAccountMode && hasAndroidApk && (
                <a
                  href={apkUrl}
                  download="velodeck-agent.apk"
                  className="btn-primary inline-flex h-10 items-center gap-1.5 rounded-lg px-4 text-xs font-medium"
                >
                  <Download className="h-4 w-4" />
                  下载 Android 被控端 APK
                </a>
              )}
              <button
                type="button"
                onClick={onReconnect}
                className="btn-outline inline-flex h-10 items-center gap-1.5 rounded-lg px-4 text-xs font-medium"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                重新检测
              </button>
              {isAccountMode && (
                <button
                  type="button"
                  onClick={onOpenControlCode}
                  className="btn-outline inline-flex h-10 items-center gap-1.5 rounded-lg px-4 text-xs font-medium text-[#2563EB]"
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  输入 9 位控制码连接
                </button>
              )}
            </div>

            {isAccountMode && hasAndroidApk && apkSha256 && (
              <p
                className="mt-3 font-mono text-[11px] text-[#9CA3AF]"
                title={apkSha256}
              >
                SHA-256: {apkSha256.slice(0, 16)}...
              </p>
            )}
          </section>
        ) : (
          <section className="panel overflow-hidden rounded-xl">
            {/* Desktop Column Header Row (Tailscale Fleet Table Grammar) */}
            <div className="hidden grid-cols-12 items-center gap-4 border-b border-[#E2E6EC] bg-[#F8F9FB] px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-[#6B7280] md:grid">
              <div className="col-span-4">设备</div>
              <div className="col-span-2">控制码</div>
              <div className="col-span-3">状态与电源</div>
              <div className="col-span-3 text-right">操作</div>
            </div>

            <ul className="divide-y divide-[#ECEFF4]">
              {clientState.devices.map((device) => {
                const isLowBattery = device.battery <= 20 && !device.charging;
                const batteryPct = Math.max(0, Math.min(100, device.battery));
                const isWaking = wakingDeviceId === device.deviceId;
                const isCopied = copiedCodeDeviceId === device.deviceId;
                const isConfirmingUnbind = confirmUnbindId === device.deviceId;
                const isUnbinding = unbindingDeviceId === device.deviceId;
                const capabilities = device.capabilities;
                const formattedCode = device.controlCode
                  ? formatControlCode(device.controlCode)
                  : "";
                const canUseDirectUrl =
                  Boolean(device.directUrl) &&
                  isAllowedDirectUrl(device.directUrl ?? "");

                return (
                  <li
                    key={device.deviceId}
                    className="grid grid-cols-1 items-center gap-4 px-4 py-4 transition-colors hover:bg-[#FAFBFD] sm:px-5 md:grid-cols-12"
                  >
                    {/* Col 1: Device Identity & Hardware Specs */}
                    <div className="flex min-w-0 items-start gap-3 md:col-span-4">
                      <span
                        className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${
                          device.online ? "bg-[#16A34A]" : "bg-[#CBD5E1]"
                        }`}
                        title={device.online ? "在线" : "离线"}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="truncate text-sm font-semibold text-[#111318]">
                            {device.name || device.model}
                          </h3>
                          <span
                            className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${
                              device.online
                                ? "bg-[#ECFDF3] text-[#15803D]"
                                : "bg-[#F3F4F6] text-[#6B7280]"
                            }`}
                          >
                            {device.online ? "在线" : formatLastSeen(device.lastSeen)}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-[#6B7280]">
                          {device.model} · Android {device.androidVersion} ·{" "}
                          <span className="font-mono">
                            {device.screenWidth}×{device.screenHeight}
                          </span>
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                          <CapabilityTag
                            label="无障碍"
                            enabled={capabilities.accessibility}
                            warnWhenOff
                          />
                          <CapabilityTag
                            label="免确认录屏"
                            enabled={capabilities.mediaProjection}
                            warnWhenOff
                          />
                          <CapabilityTag
                            label={capabilities.webrtc ? "WebRTC" : "WS 帧流"}
                            enabled={capabilities.webrtc || capabilities.wsJpeg}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Col 2: Permanent 9-Digit Control Code */}
                    <div className="flex items-center justify-between md:col-span-2 md:block">
                      <span className="text-xs text-[#6B7280] md:hidden">控制码</span>
                      {formattedCode ? (
                        <button
                          type="button"
                          onClick={() => void handleCopyControlCode(device)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-[#E2E6EC] bg-[#F8F9FB] px-2 py-1 font-mono text-xs font-semibold tracking-wider text-[#111318] transition hover:border-[#CBD5E1] hover:bg-white"
                          title="点击复制 9 位控制码"
                        >
                          <span>{formattedCode}</span>
                          {isCopied ? (
                            <Check className="h-3 w-3 text-[#15803D]" />
                          ) : (
                            <Copy className="h-3 w-3 text-[#6B7280]" />
                          )}
                        </button>
                      ) : (
                        <span className="font-mono text-xs text-[#9CA3AF]">—</span>
                      )}
                    </div>

                    {/* Col 3: Power & Lock Telemetry */}
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#4B5563] md:col-span-3 md:flex-col md:items-start md:gap-1.5">
                      <div className="flex items-center gap-2">
                        {device.charging && (
                          <BatteryCharging className="h-3.5 w-3.5 text-[#16A34A]" />
                        )}
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[#E5E7EB]">
                          <div
                            className={`h-full rounded-full ${
                              device.charging
                                ? "bg-[#16A34A]"
                                : isLowBattery
                                  ? "bg-[#DC2626]"
                                  : "bg-[#374151]"
                            }`}
                            style={{ width: `${batteryPct}%` }}
                          />
                        </div>
                        <span className="font-mono text-xs font-medium text-[#111318]">
                          {device.battery}%
                        </span>
                      </div>

                      <div className="flex items-center gap-3 text-xs text-[#6B7280]">
                        <span className="inline-flex items-center gap-1">
                          {device.locked ? (
                            <Lock className="h-3 w-3 text-[#B45309]" />
                          ) : (
                            <Unlock className="h-3 w-3 text-[#15803D]" />
                          )}
                          {device.locked ? "已锁屏" : "已解锁"}
                        </span>
                        {device.screenOn !== undefined && (
                          <span className="inline-flex items-center gap-1">
                            <Sun className="h-3 w-3 text-[#6B7280]" />
                            {device.screenOn ? "亮屏" : "息屏"}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Col 4: Actions */}
                    <div className="flex flex-col items-stretch gap-2 md:col-span-3 md:items-end">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={!device.online}
                          onClick={() => onControlDevice(device)}
                          className="btn-primary inline-flex h-9 flex-1 items-center justify-center gap-1 rounded-lg px-3.5 text-xs font-medium disabled:cursor-not-allowed md:flex-none"
                        >
                          <span>连接控制</span>
                          <ChevronRight className="h-3.5 w-3.5" />
                        </button>

                        <button
                          type="button"
                          disabled={!device.online}
                          onClick={() => handleWakeClick(device)}
                          className="btn-outline inline-flex h-9 items-center justify-center gap-1 rounded-lg px-3 text-xs font-medium disabled:cursor-not-allowed"
                        >
                          <Zap className="h-3.5 w-3.5 text-[#D97706]" />
                          <span>{isWaking ? "已发送" : "唤醒"}</span>
                        </button>
                      </div>

                      <div className="flex items-center justify-end gap-2">
                        {canUseDirectUrl &&
                          activeMode === "relay" &&
                          !isAccountMode &&
                          onSwitchToDirectUrl && (
                            <button
                              type="button"
                              onClick={() => onSwitchToDirectUrl(device)}
                              className="inline-flex items-center gap-1 text-[11px] font-medium text-[#15803D] hover:underline"
                            >
                              <Wifi className="h-3 w-3" />
                              切换局域网直连
                            </button>
                          )}

                        {isAccountMode &&
                          (isConfirmingUnbind ? (
                            <div className="flex items-center gap-1.5 text-[11px]">
                              <span className="text-[#DC2626]">确认解绑？</span>
                              <button
                                type="button"
                                disabled={isUnbinding}
                                onClick={() => void handleConfirmUnbind(device)}
                                className="inline-flex h-6 items-center gap-1 rounded bg-[#DC2626] px-2 font-medium text-white hover:bg-[#B91C1C] disabled:opacity-50"
                              >
                                {isUnbinding && (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                )}
                                确认
                              </button>
                              <button
                                type="button"
                                disabled={isUnbinding}
                                onClick={() => setConfirmUnbindId(null)}
                                className="h-6 rounded px-1.5 text-[#6B7280] hover:text-[#111318]"
                              >
                                取消
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmUnbindId(device.deviceId)}
                              className="inline-flex items-center gap-1 text-[11px] text-[#9CA3AF] transition hover:text-[#DC2626]"
                            >
                              <Trash2 className="h-3 w-3" />
                              解绑
                            </button>
                          ))}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* Quiet Utility Footer */}
        <div className="mt-auto pt-4">
          <footer className="flex flex-wrap items-center justify-between gap-2.5 border-t border-[#E2E6EC] pt-4 text-xs text-[#6B7280]">
            {hasAndroidApk && clientState.devices.length > 0 ? (
              <div className="flex flex-wrap items-center gap-3">
                <a
                  href={apkUrl}
                  download="velodeck-agent.apk"
                  className="inline-flex items-center gap-1.5 font-medium text-[#2563EB] hover:underline"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>下载 Android 被控端 Release APK</span>
                </a>
                <span className="text-[11px] text-[#9CA3AF]">
                  如浏览器提示不安全下载，请点「保留 / 仍要下载」
                </span>
                {apkSha256 && (
                  <span className="font-mono text-[11px] text-[#9CA3AF]" title={apkSha256}>
                    SHA-256: {apkSha256.slice(0, 12)}...
                  </span>
                )}
              </div>
            ) : (
              <span>VeloDeck 极控 · 设备控制台</span>
            )}
          </footer>
        </div>
      </main>

      <SecuritySettingsModal
        open={securityModalOpen}
        savedAccount={savedAccount}
        onClose={() => setSecurityModalOpen(false)}
        onChangePassword={onChangePassword}
        onLogoutAllSessions={onLogoutAllSessions}
      />
    </div>
  );
}

function CapabilityTag({
  label,
  enabled,
  warnWhenOff = false,
}: {
  label: string;
  enabled: boolean;
  warnWhenOff?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 ${
        enabled
          ? "text-[#4B5563]"
          : warnWhenOff
            ? "font-medium text-[#B45309]"
            : "text-[#9CA3AF]"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          enabled
            ? "bg-[#16A34A]"
            : warnWhenOff
              ? "bg-[#D97706]"
              : "bg-[#D1D5DB]"
        }`}
      />
      {label}
    </span>
  );
}
