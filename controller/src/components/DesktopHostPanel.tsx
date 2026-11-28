import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Clipboard,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  FileCheck2,
  Link2,
  Loader2,
  Lock,
  MessageSquare,
  Monitor,
  Moon,
  Network,
  Pencil,
  Power,
  PowerOff,
  RefreshCw,
  RotateCcw,
  Send,
  Server,
  ShieldAlert,
  ShieldCheck,
  Unlink,
  Unlock,
  Volume2,
  X,
} from "lucide-react";
import {
  formatControlCode,
  type AccessApprovalMode,
  type SessionPermissions,
} from "@velodeck/protocol";
import type {
  DesktopHostConfigPatch,
  DesktopHostState,
} from "../desktop/bridge";
import { MIN_PASSWORD_LENGTH, type SavedAccountSession } from "../state/auth";

export interface DesktopHostHandlers {
  onStartHost: () => Promise<void>;
  onStopHost: () => Promise<void>;
  onUpdateConfig: (patch: DesktopHostConfigPatch) => Promise<void>;
  onRegeneratePassword: () => Promise<void>;
  onBindAccount: () => Promise<void>;
  onUnbindAccount: () => Promise<void>;
  onSelectDisplay: (displayId: string) => Promise<void>;
  onDisconnectSession: () => Promise<void>;
  onRefreshPermissions: () => Promise<void>;
  onOpenPermissionSettings: (kind: "accessibility" | "screen") => Promise<void>;
  onSetPrivacyScreen?: (enabled: boolean) => Promise<void>;
  onSetBlockInput?: (enabled: boolean) => Promise<void>;
  onApproveSession?: (
    sessionId: string,
    permissions: SessionPermissions,
  ) => Promise<void>;
  onRejectSession?: (sessionId: string) => Promise<void>;
  onSendChatMessage?: (text: string) => Promise<void>;
}

export interface DesktopHostPanelProps {
  hostState: DesktopHostState;
  serverUrl: string;
  savedAccount: SavedAccountSession | null;
  handlers: DesktopHostHandlers;
  onOpenServerSettings?: () => void;
  /** Omit outer card chrome when rendered inside another `.panel` sheet (e.g. LaunchView tab). */
  embedded?: boolean;
  /** Allow collapsing into a compact operational strip (e.g. DashboardView when stopped). */
  collapsible?: boolean;
}

function getHostStatusBadge(hostState: DesktopHostState): {
  label: string;
  pillClass: string;
  dotClass: string;
} {
  switch (hostState.status) {
    case "connecting":
      return {
        label: "连接中...",
        pillClass: "bg-[#EFF6FF] text-[#1D4ED8] border-[#BFDBFE]",
        dotClass: "bg-[#2563EB]",
      };
    case "online":
      return {
        label: "在线等待连接",
        pillClass: "bg-[#ECFDF3] text-[#15803D] border-[#BBF7D0]",
        dotClass: "bg-[#16A34A]",
      };
    case "controlling":
      return {
        label:
          hostState.activeTransport === "ws-jpeg"
            ? "正在被远控 · WS 帧流"
            : "正在被远控 · WebRTC",
        pillClass: "bg-[#EFF6FF] text-[#1D4ED8] border-[#93C5FD]",
        dotClass: "bg-[#2563EB]",
      };
    case "error":
      return {
        label: "连接异常",
        pillClass: "bg-[#FEF2F2] text-[#B91C1C] border-[#FECACA]",
        dotClass: "bg-[#DC2626]",
      };
    default:
      return {
        label: "已停止",
        pillClass: "bg-[#F3F4F6] text-[#4B5563] border-[#E2E6EC]",
        dotClass: "bg-[#9CA3AF]",
      };
  }
}

function formatReceivedTime(ts: number): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

export function DesktopHostPanel({
  hostState,
  serverUrl,
  savedAccount,
  handlers,
  onOpenServerSettings,
  embedded = false,
  collapsible = false,
}: DesktopHostPanelProps) {
  const [expanded, setExpanded] = useState<boolean>(
    () => !collapsible || hostState.enabled || hostState.status !== "stopped",
  );
  const [toggling, setToggling] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [regeneratingPwd, setRegeneratingPwd] = useState(false);
  const [bindingBusy, setBindingBusy] = useState(false);
  const [refreshingPerms, setRefreshingPerms] = useState(false);
  const [selectingDisplayId, setSelectingDisplayId] = useState<string | null>(null);

  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedPassword, setCopiedPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const [editingPassword, setEditingPassword] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState(hostState.controlPassword);
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(hostState.deviceName);
  const [savingName, setSavingName] = useState(false);
  const [busySettingKey, setBusySettingKey] = useState<string | null>(null);

  const [approvalPerms, setApprovalPerms] = useState({
    input: true,
    clipboard: true,
    fileTransfer: true,
    audio: true,
    terminal: true,
  });
  const [approvalBusy, setApprovalBusy] = useState<"approve" | "reject" | null>(null);
  const [unblockingInput, setUnblockingInput] = useState(false);
  const [chatExpanded, setChatExpanded] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [sendingChat, setSendingChat] = useState(false);
  const prevChatCountRef = useRef<number>(hostState.chatMessages?.length ?? 0);

  // Auto-expand collapsible dashboard card when host becomes active, receives an incoming session, pending approval, or block-input lock
  useEffect(() => {
    if (!collapsible) return;
    if (
      hostState.enabled ||
      hostState.activeSessionId ||
      hostState.pendingApproval ||
      hostState.blockInputActive ||
      hostState.status === "error"
    ) {
      setExpanded(true);
    }
  }, [
    collapsible,
    hostState.enabled,
    hostState.activeSessionId,
    hostState.pendingApproval,
    hostState.blockInputActive,
    hostState.status,
  ]);

  // Reset permission checkboxes to all-checked whenever a new approval request arrives
  useEffect(() => {
    if (hostState.pendingApproval?.sessionId) {
      setApprovalPerms({
        input: true,
        clipboard: true,
        fileTransfer: true,
        audio: true,
        terminal: true,
      });
      setApprovalBusy(null);
    }
  }, [hostState.pendingApproval?.sessionId]);

  // Auto-expand host session chat strip when a new message arrives from controller
  useEffect(() => {
    const msgs = hostState.chatMessages ?? [];
    if (msgs.length > prevChatCountRef.current) {
      const latest = msgs[msgs.length - 1];
      if (latest?.sender === "controller") {
        setChatExpanded(true);
      }
    }
    prevChatCountRef.current = msgs.length;
  }, [hostState.chatMessages]);

  // Keep draft inputs aligned with external IPC updates while not editing
  useEffect(() => {
    if (!editingPassword) {
      setPasswordDraft(hostState.controlPassword);
      setPasswordError(null);
    }
  }, [editingPassword, hostState.controlPassword]);

  useEffect(() => {
    if (!editingName) {
      setNameDraft(hostState.deviceName);
    }
  }, [editingName, hostState.deviceName]);

  const statusMeta = getHostStatusBadge(hostState);
  const formattedCode = hostState.controlCode
    ? formatControlCode(hostState.controlCode)
    : "--- --- ---";
  const isHostEnabled =
    hostState.enabled ||
    hostState.status === "connecting" ||
    hostState.status === "online" ||
    hostState.status === "controlling";
  const hasServerUrl = Boolean(serverUrl.trim());
  const isMacHost = hostState.permissions.platform === "darwin";
  const needsMacPermission =
    isMacHost &&
    (!hostState.permissions.screenCapture || !hostState.permissions.accessibility);

  async function handleToggleHost() {
    if (toggling) return;
    if (!isHostEnabled && !hasServerUrl) {
      onOpenServerSettings?.();
      return;
    }
    setToggling(true);
    try {
      if (isHostEnabled) {
        await handlers.onStopHost();
      } else {
        await handlers.onStartHost();
      }
    } finally {
      setToggling(false);
    }
  }

  async function handleCopyCode() {
    if (!hostState.controlCode) return;
    try {
      await navigator.clipboard.writeText(formatControlCode(hostState.controlCode));
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1500);
    } catch {
      // Ignore clipboard denial
    }
  }

  async function handleCopyPassword() {
    if (!hostState.controlPassword) return;
    try {
      await navigator.clipboard.writeText(hostState.controlPassword);
      setCopiedPassword(true);
      window.setTimeout(() => setCopiedPassword(false), 1500);
    } catch {
      // Ignore clipboard denial
    }
  }

  async function handleSavePassword() {
    const trimmed = passwordDraft.trim();
    if (trimmed.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(`无人值守控制密码至少需要 ${MIN_PASSWORD_LENGTH} 位`);
      return;
    }
    setPasswordError(null);
    setSavingPassword(true);
    try {
      await handlers.onUpdateConfig({ controlPassword: trimmed });
      setEditingPassword(false);
    } finally {
      setSavingPassword(false);
    }
  }

  async function handleRegeneratePasswordClick() {
    if (regeneratingPwd) return;
    setRegeneratingPwd(true);
    try {
      await handlers.onRegeneratePassword();
      setEditingPassword(false);
      setPasswordError(null);
    } finally {
      setRegeneratingPwd(false);
    }
  }

  async function handleSaveDeviceName() {
    const trimmed = nameDraft.trim();
    if (!trimmed) return;
    if (trimmed === hostState.deviceName) {
      setEditingName(false);
      return;
    }
    setSavingName(true);
    try {
      await handlers.onUpdateConfig({ deviceName: trimmed });
      setEditingName(false);
    } finally {
      setSavingName(false);
    }
  }

  async function handleBindToggle(action: "bind" | "unbind") {
    if (bindingBusy) return;
    setBindingBusy(true);
    try {
      if (action === "bind") {
        await handlers.onBindAccount();
      } else {
        await handlers.onUnbindAccount();
      }
    } finally {
      setBindingBusy(false);
    }
  }

  async function handleSelectDisplayClick(displayId: string) {
    if (selectingDisplayId || displayId === hostState.activeDisplayId) return;
    setSelectingDisplayId(displayId);
    try {
      await handlers.onSelectDisplay(displayId);
    } finally {
      setSelectingDisplayId(null);
    }
  }

  async function handleDisconnectClick() {
    if (disconnecting) return;
    setDisconnecting(true);
    try {
      await handlers.onDisconnectSession();
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleRefreshPermsClick() {
    if (refreshingPerms) return;
    setRefreshingPerms(true);
    try {
      await handlers.onRefreshPermissions();
    } finally {
      setRefreshingPerms(false);
    }
  }

  async function handleToggleProConfig(
    key: "autoLaunch" | "preventSleep" | "audioCaptureEnabled" | "clipboardAutoSync",
    nextValue: boolean,
  ) {
    if (busySettingKey) return;
    setBusySettingKey(key);
    try {
      await handlers.onUpdateConfig({ [key]: nextValue });
    } finally {
      setBusySettingKey(null);
    }
  }

  async function handleTogglePrivacyScreen() {
    if (busySettingKey || !handlers.onSetPrivacyScreen) return;
    setBusySettingKey("privacyScreenActive");
    try {
      await handlers.onSetPrivacyScreen(!hostState.privacyScreenActive);
    } finally {
      setBusySettingKey(null);
    }
  }

  async function handleChangeAccessMode(nextMode: AccessApprovalMode) {
    if (busySettingKey || (hostState.accessMode ?? "auto") === nextMode) return;
    setBusySettingKey("accessMode");
    try {
      await handlers.onUpdateConfig({ accessMode: nextMode });
    } finally {
      setBusySettingKey(null);
    }
  }

  async function handleApprovePending() {
    if (
      approvalBusy ||
      !hostState.pendingApproval ||
      !handlers.onApproveSession
    ) {
      return;
    }
    setApprovalBusy("approve");
    try {
      await handlers.onApproveSession(hostState.pendingApproval.sessionId, {
        mouse: approvalPerms.input,
        keyboard: approvalPerms.input,
        clipboard: approvalPerms.clipboard,
        fileTransfer: approvalPerms.fileTransfer,
        audio: approvalPerms.audio,
        terminal: approvalPerms.terminal,
      });
    } finally {
      setApprovalBusy(null);
    }
  }

  async function handleRejectPending() {
    if (
      approvalBusy ||
      !hostState.pendingApproval ||
      !handlers.onRejectSession
    ) {
      return;
    }
    setApprovalBusy("reject");
    try {
      await handlers.onRejectSession(hostState.pendingApproval.sessionId);
    } finally {
      setApprovalBusy(null);
    }
  }

  async function handleUnblockLocalInput() {
    if (unblockingInput || !handlers.onSetBlockInput) return;
    setUnblockingInput(true);
    try {
      await handlers.onSetBlockInput(false);
    } finally {
      setUnblockingInput(false);
    }
  }

  async function handleSendHostChat(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = chatDraft.trim();
    if (!trimmed || sendingChat || !handlers.onSendChatMessage) return;
    setSendingChat(true);
    try {
      await handlers.onSendChatMessage(trimmed);
      setChatDraft("");
    } finally {
      setSendingChat(false);
    }
  }

  const showBody = !collapsible || expanded;

  const content = (
    <>
      {/* Header Row */}
      <div
        className={`flex flex-wrap items-center justify-between gap-3 ${
          embedded
            ? "pb-4 border-b border-[#ECEFF4]"
            : `px-4 py-3.5 sm:px-5 ${showBody ? "border-b border-[#E2E6EC] bg-[#F8F9FB]" : "bg-white"}`
        }`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${
              hostState.status === "controlling"
                ? "border-[#93C5FD] bg-[#EFF6FF] text-[#2563EB]"
                : hostState.status === "online"
                  ? "border-[#BBF7D0] bg-[#ECFDF3] text-[#15803D]"
                  : "border-[#E2E6EC] bg-[#F4F5F7] text-[#374151]"
            }`}
          >
            <Monitor className="h-4.5 w-4.5" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold tracking-tight text-[#111318]">
                本机被控
              </h2>
              <span
                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium ${statusMeta.pillClass}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${statusMeta.dotClass}`} />
                <span>{statusMeta.label}</span>
              </span>
              {collapsible && !expanded && hostState.controlCode && (
                <span className="hidden rounded border border-[#E2E6EC] bg-[#F8F9FB] px-1.5 py-0.5 font-mono text-[11px] font-semibold text-[#374151] sm:inline">
                  {formattedCode}
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-xs text-[#6B7280]">
              允许其他手机或电脑远程控制这台电脑（支持高刷 WebRTC、系统音频与键鼠直通）
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          {/* Primary Hardware Toggle Switch */}
          <button
            type="button"
            role="switch"
            aria-checked={isHostEnabled}
            aria-label={isHostEnabled ? "关闭本机被控" : "开启本机被控"}
            disabled={toggling}
            onClick={() => void handleToggleHost()}
            className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] disabled:opacity-60 ${
              isHostEnabled
                ? "border-[#2563EB] bg-[#2563EB] text-white hover:bg-[#1D4ED8]"
                : "border-[#CBD2DC] bg-white text-[#111318] hover:bg-[#F8F9FB]"
            }`}
          >
            <span
              className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
                isHostEnabled ? "bg-white/30" : "bg-[#D1D5DB]"
              }`}
            >
              <span
                className={`inline-block h-3 w-3 transform rounded-full bg-white shadow-xs transition-transform ${
                  isHostEnabled ? "translate-x-3.5" : "translate-x-0.5"
                }`}
              />
            </span>
            {toggling ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <span>{isHostEnabled ? "已开启" : "开启被控"}</span>
            )}
          </button>

          {collapsible && (
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              aria-expanded={expanded}
              aria-label={expanded ? "收起本机被控面板" : "展开本机被控面板"}
              className="btn-outline inline-flex h-9 w-9 items-center justify-center rounded-lg text-[#4B5563]"
            >
              {expanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Expandable Structured Console Body */}
      {showBody && (
        <div className={embedded ? "pt-4 space-y-4" : "p-4 sm:p-5 space-y-4"}>
          {/* Missing Server Configuration Banner */}
          {!hasServerUrl && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#FDE68A] bg-[#FFFBEB] px-3.5 py-2.5 text-xs text-[#92400E]">
              <div className="flex min-w-0 items-start gap-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#D97706]" />
                <span className="leading-relaxed">
                  开启本机被控前，请先配置你的自托管 VeloDeck 服务器地址。
                </span>
              </div>
              {onOpenServerSettings && (
                <button
                  type="button"
                  onClick={onOpenServerSettings}
                  className="btn-outline inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border-[#F59E0B]/50 bg-white px-2.5 text-xs font-medium text-[#92400E] hover:bg-[#FEF3C7]"
                >
                  <Server className="h-3.5 w-3.5" />
                  先配置自托管服务器
                </button>
              )}
            </div>
          )}

          {/* Active Block-Input Warning Banner */}
          {hostState.blockInputActive && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#F59E0B] bg-[#FFFBEB] px-3.5 py-3 text-xs text-[#92400E]">
              <div className="flex min-w-0 items-start gap-2.5">
                <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[#D97706]" />
                <div className="min-w-0">
                  <p className="font-semibold text-[#78350F]">
                    本机物理键鼠输入已被远控端锁定
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-[#92400E]">
                    为防止操作冲突，本地实体键盘与鼠标暂时被禁用；你可随时点击右侧按钮立即解除。
                  </p>
                </div>
              </div>
              {handlers.onSetBlockInput && (
                <button
                  type="button"
                  disabled={unblockingInput}
                  onClick={() => void handleUnblockLocalInput()}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[#D97706] bg-[#D97706] px-3 text-xs font-medium text-white transition hover:bg-[#B45309] disabled:opacity-50"
                >
                  {unblockingInput ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Unlock className="h-3.5 w-3.5" />
                  )}
                  解除本地键鼠锁定
                </button>
              )}
            </div>
          )}

          {/* Incoming Connection Approval Request Card */}
          {hostState.pendingApproval && (
            <div className="space-y-3 rounded-lg border-2 border-[#2563EB] bg-[#EFF6FF] p-4 text-xs text-[#1E3A8A]">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex items-start gap-2.5">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#F59E0B]/40 bg-[#FFFBEB] text-[#D97706]">
                    <ShieldAlert className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-[#111318]">
                        收到远程接入请求
                      </p>
                      <span className="rounded border border-[#FDE68A] bg-[#FFFBEB] px-1.5 py-0.5 text-[10px] font-semibold text-[#B45309]">
                        等待本机审批
                      </span>
                    </div>
                    <p className="mt-0.5 font-mono text-[11px] text-[#3B82F6]">
                      会话 {hostState.pendingApproval.sessionId.slice(0, 12)}
                      {hostState.pendingApproval.requestedAt > 0
                        ? ` · ${formatReceivedTime(hostState.pendingApproval.requestedAt)}`
                        : ""}
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-md border border-[#BFDBFE] bg-white px-3 py-2.5">
                <p className="mb-2 text-[11px] font-semibold text-[#374151]">
                  本次会话授予权限：
                </p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {(
                    [
                      { key: "input", label: "鼠标与键盘" },
                      { key: "clipboard", label: "剪贴板" },
                      { key: "fileTransfer", label: "文件管理" },
                      { key: "audio", label: "系统声音" },
                      { key: "terminal", label: "远程终端" },
                    ] as const
                  ).map((item) => (
                    <label
                      key={item.key}
                      className="inline-flex cursor-pointer items-center gap-1.5 select-none text-xs text-[#111318]"
                    >
                      <input
                        type="checkbox"
                        checked={approvalPerms[item.key]}
                        onChange={(e) =>
                          setApprovalPerms((prev) => ({
                            ...prev,
                            [item.key]: e.target.checked,
                          }))
                        }
                        className="h-4 w-4 rounded border-[#CBD2DC] accent-[#2563EB]"
                      />
                      <span>{item.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={Boolean(approvalBusy) || !handlers.onRejectSession}
                  onClick={() => void handleRejectPending()}
                  className="btn-outline inline-flex h-9 items-center gap-1.5 rounded-md border-[#FCA5A5] bg-white px-3.5 text-xs font-medium text-[#DC2626] hover:bg-[#FEF2F2] disabled:opacity-50"
                >
                  {approvalBusy === "reject" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <X className="h-3.5 w-3.5" />
                  )}
                  拒绝
                </button>
                <button
                  type="button"
                  disabled={Boolean(approvalBusy) || !handlers.onApproveSession}
                  onClick={() => void handleApprovePending()}
                  className="btn-primary inline-flex h-9 items-center gap-1.5 rounded-md px-4 text-xs font-semibold disabled:opacity-50"
                >
                  {approvalBusy === "approve" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  允许接入
                </button>
              </div>
            </div>
          )}

          {/* Active Incoming Remote Control Alert */}
          {hostState.activeSessionId && (
            <div className="overflow-hidden rounded-lg border border-[#93C5FD] bg-[#EFF6FF] text-xs text-[#1E3A8A]">
              <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#2563EB]" />
                  <div className="min-w-0">
                    <p className="font-semibold text-[#111318]">
                      当前正被远程控制（
                      {hostState.activeTransport === "webrtc"
                        ? "WebRTC 60fps"
                        : "WS 帧流"}
                      ）
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] text-[#3B82F6]">
                      会话 ID: {hostState.activeSessionId.slice(0, 12)}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {handlers.onSendChatMessage && (
                    <button
                      type="button"
                      onClick={() => setChatExpanded((prev) => !prev)}
                      className="btn-outline inline-flex h-8 items-center gap-1.5 rounded-md border-[#93C5FD] bg-white px-2.5 text-xs font-medium text-[#1D4ED8] hover:bg-[#DBEAFE]/50"
                    >
                      <MessageSquare className="h-3.5 w-3.5" />
                      <span>会话消息</span>
                      {(hostState.chatMessages?.length ?? 0) > 0 && (
                        <span className="rounded bg-[#2563EB] px-1.5 py-0.2 font-mono text-[10px] font-semibold text-white">
                          {hostState.chatMessages?.length}
                        </span>
                      )}
                      {chatExpanded ? (
                        <ChevronUp className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={disconnecting}
                    onClick={() => void handleDisconnectClick()}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[#DC2626] bg-[#DC2626] px-3 text-xs font-medium text-white transition hover:bg-[#B91C1C] disabled:opacity-50"
                  >
                    {disconnecting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <PowerOff className="h-3.5 w-3.5" />
                    )}
                    断开远控
                  </button>
                </div>
              </div>

              {/* Collapsible Host Session Chat Strip */}
              {chatExpanded && handlers.onSendChatMessage && (
                <div className="border-t border-[#BFDBFE] bg-white px-3.5 py-3">
                  <div className="max-h-40 space-y-2 overflow-y-auto rounded-md border border-[#E2E6EC] bg-[#F8F9FB] p-2.5">
                    {(hostState.chatMessages?.length ?? 0) === 0 ? (
                      <p className="py-2 text-center text-[11px] text-[#6B7280]">
                        暂无消息，可向正在操作本机的控制端发送快捷回复
                      </p>
                    ) : (
                      (hostState.chatMessages ?? []).map((msg) => {
                        const isHost = msg.sender === "host";
                        return (
                          <div
                            key={msg.id}
                            className={`flex flex-col ${isHost ? "items-end" : "items-start"}`}
                          >
                            <span className="mb-0.5 text-[10px] text-[#6B7280]">
                              {isHost ? "本机" : msg.senderName || "控制端"} ·{" "}
                              <span className="font-mono">
                                {formatReceivedTime(msg.ts)}
                              </span>
                            </span>
                            <div
                              className={`max-w-[85%] break-words rounded-lg border px-2.5 py-1.5 text-xs ${
                                isHost
                                  ? "border-[#2563EB] bg-[#2563EB] text-white"
                                  : "border-[#E2E6EC] bg-white text-[#111318]"
                              }`}
                            >
                              {msg.text}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                  <form
                    onSubmit={(e) => void handleSendHostChat(e)}
                    className="mt-2 flex items-center gap-1.5"
                  >
                    <input
                      type="text"
                      value={chatDraft}
                      onChange={(e) => setChatDraft(e.target.value)}
                      placeholder="回复控制端消息..."
                      maxLength={2000}
                      className="field h-8 min-w-0 flex-1 rounded-md px-2.5 text-xs"
                    />
                    <button
                      type="submit"
                      disabled={sendingChat || !chatDraft.trim()}
                      className="btn-primary inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-3 text-xs font-medium disabled:opacity-45"
                    >
                      {sendingChat ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Send className="h-3.5 w-3.5" />
                      )}
                      发送
                    </button>
                  </form>
                </div>
              )}
            </div>
          )}

          {/* Error Notice */}
          {hostState.lastError && (
            <div className="flex items-start gap-2 rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-xs text-[#991B1B]">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#DC2626]" />
              <span className="min-w-0 flex-1 leading-relaxed">
                {hostState.lastError}
              </span>
            </div>
          )}

          {/* 9-Digit Control Code + Unattended Password Grid */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/* Control Code Cell */}
            <div className="rounded-lg border border-[#E2E6EC] bg-[#F8F9FB] p-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[#6B7280]">
                  本机 9 位控制码
                </span>
                <button
                  type="button"
                  disabled={!hostState.controlCode}
                  onClick={() => void handleCopyCode()}
                  className="btn-outline inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium disabled:opacity-45"
                >
                  {copiedCode ? (
                    <>
                      <Check className="h-3 w-3 text-[#15803D]" />
                      <span className="text-[#15803D]">已复制</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3 text-[#4B5563]" />
                      <span>复制</span>
                    </>
                  )}
                </button>
              </div>
              <p className="mt-2 font-mono text-2xl font-bold tracking-[0.14em] text-[#111318]">
                {formattedCode}
              </p>
              <p className="mt-1 text-[11px] text-[#6B7280]">
                在手机浏览器或另一台电脑输入此控制码即可连接本机
              </p>
            </div>

            {/* Unattended Password Cell */}
            <div className="rounded-lg border border-[#E2E6EC] bg-[#F8F9FB] p-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[#6B7280]">
                  无人值守控制密码
                </span>
                {!editingPassword && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setShowPassword((prev) => !prev)}
                      className="btn-outline inline-flex h-7 w-7 items-center justify-center rounded-md text-[#4B5563]"
                      title={showPassword ? "隐藏密码" : "显示密码"}
                      aria-label={showPassword ? "隐藏密码" : "显示密码"}
                    >
                      {showPassword ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      disabled={!hostState.controlPassword}
                      onClick={() => void handleCopyPassword()}
                      className="btn-outline inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium disabled:opacity-45"
                    >
                      {copiedPassword ? (
                        <Check className="h-3 w-3 text-[#15803D]" />
                      ) : (
                        <Copy className="h-3 w-3 text-[#4B5563]" />
                      )}
                      <span>{copiedPassword ? "已复制" : "复制"}</span>
                    </button>
                  </div>
                )}
              </div>

              {editingPassword ? (
                <div className="mt-2 space-y-2">
                  <input
                    type="text"
                    value={passwordDraft}
                    onChange={(e) => {
                      setPasswordDraft(e.target.value);
                      if (passwordError) setPasswordError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handleSavePassword();
                      } else if (e.key === "Escape") {
                        setEditingPassword(false);
                        setPasswordDraft(hostState.controlPassword);
                        setPasswordError(null);
                      }
                    }}
                    placeholder={`至少 ${MIN_PASSWORD_LENGTH} 位字符`}
                    autoComplete="off"
                    spellCheck={false}
                    className="field h-9 w-full rounded-md px-2.5 font-mono text-xs"
                  />
                  {passwordError && (
                    <p className="text-[11px] text-[#DC2626]">{passwordError}</p>
                  )}
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={savingPassword}
                      onClick={() => void handleSavePassword()}
                      className="btn-primary inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium"
                    >
                      {savingPassword && <Loader2 className="h-3 w-3 animate-spin" />}
                      保存密码
                    </button>
                    <button
                      type="button"
                      disabled={savingPassword}
                      onClick={() => {
                        setEditingPassword(false);
                        setPasswordDraft(hostState.controlPassword);
                        setPasswordError(null);
                      }}
                      className="btn-outline inline-flex h-7 items-center rounded-md px-2 text-[11px] text-[#4B5563]"
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="mt-2 truncate font-mono text-lg font-semibold tracking-wider text-[#111318]">
                    {hostState.controlPassword
                      ? showPassword
                        ? hostState.controlPassword
                        : "•".repeat(Math.min(14, Math.max(8, hostState.controlPassword.length)))
                      : "未设置"}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setPasswordDraft(hostState.controlPassword);
                        setPasswordError(null);
                        setEditingPassword(true);
                      }}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-[#2563EB] hover:underline"
                    >
                      <Pencil className="h-3 w-3" />
                      修改密码
                    </button>
                    <span className="text-[#CBD5E1]">|</span>
                    <button
                      type="button"
                      disabled={regeneratingPwd}
                      onClick={() => void handleRegeneratePasswordClick()}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-[#4B5563] hover:text-[#111318] disabled:opacity-50"
                    >
                      <RotateCcw
                        className={`h-3 w-3 ${regeneratingPwd ? "animate-spin" : ""}`}
                      />
                      重置密码
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Device Name + Account Binding Structured Rows */}
          <div className="divide-y divide-[#ECEFF4] rounded-lg border border-[#E2E6EC] bg-white">
            {/* Editable Device Name Row */}
            <div className="flex flex-wrap items-center justify-between gap-2.5 px-3.5 py-2.5">
              <span className="text-xs font-medium text-[#4B5563]">本机名称</span>
              {editingName ? (
                <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5 sm:max-w-xs">
                  <input
                    type="text"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handleSaveDeviceName();
                      } else if (e.key === "Escape") {
                        setEditingName(false);
                        setNameDraft(hostState.deviceName);
                      }
                    }}
                    maxLength={48}
                    className="field h-8 min-w-0 flex-1 rounded-md px-2.5 text-xs"
                  />
                  <button
                    type="button"
                    disabled={savingName || !nameDraft.trim()}
                    onClick={() => void handleSaveDeviceName()}
                    className="btn-primary inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-xs font-medium"
                  >
                    {savingName ? <Loader2 className="h-3 w-3 animate-spin" /> : "保存"}
                  </button>
                  <button
                    type="button"
                    disabled={savingName}
                    onClick={() => {
                      setEditingName(false);
                      setNameDraft(hostState.deviceName);
                    }}
                    className="btn-outline inline-flex h-8 w-8 items-center justify-center rounded-md text-[#6B7280]"
                    aria-label="取消重命名"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-xs font-semibold text-[#111318]">
                    {hostState.deviceName || "未命名电脑"}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setNameDraft(hostState.deviceName);
                      setEditingName(true);
                    }}
                    className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-[#4B5563] hover:bg-[#F3F4F6] hover:text-[#111318]"
                  >
                    <Pencil className="h-3 w-3" />
                    编辑
                  </button>
                </div>
              )}
            </div>

            {/* Account Binding Row */}
            <div className="flex flex-wrap items-center justify-between gap-2.5 px-3.5 py-2.5">
              <div className="flex min-w-0 items-center gap-2 text-xs">
                <Link2
                  className={`h-3.5 w-3.5 shrink-0 ${
                    hostState.ownerUsername ? "text-[#15803D]" : "text-[#6B7280]"
                  }`}
                />
                {hostState.ownerUsername ? (
                  <span className="text-[#111318]">
                    已绑定账号{" "}
                    <strong className="font-mono font-semibold">
                      @{hostState.ownerUsername}
                    </strong>{" "}
                    <span className="text-[#6B7280]">
                      · 同账号手机/电脑可直接连接
                    </span>
                  </span>
                ) : savedAccount ? (
                  <span className="text-[#4B5563]">
                    尚未绑定账号（绑定后同账号免输控制码直接接管）
                  </span>
                ) : (
                  <span className="text-[#6B7280]">
                    登录账号后可一键绑定本机，免输控制码随时连接
                  </span>
                )}
              </div>

              {hostState.ownerUsername ? (
                <button
                  type="button"
                  disabled={bindingBusy}
                  onClick={() => void handleBindToggle("unbind")}
                  className="btn-outline inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2.5 text-xs font-medium text-[#4B5563] hover:text-[#DC2626] disabled:opacity-50"
                >
                  {bindingBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Unlink className="h-3.5 w-3.5" />
                  )}
                  解绑
                </button>
              ) : savedAccount ? (
                <button
                  type="button"
                  disabled={bindingBusy || !hasServerUrl}
                  onClick={() => void handleBindToggle("bind")}
                  className="btn-primary inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs font-medium disabled:cursor-not-allowed"
                >
                  {bindingBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Link2 className="h-3.5 w-3.5" />
                  )}
                  绑定到当前账号 (@{savedAccount.user.username})
                </button>
              ) : null}
            </div>

            {/* Subtle LAN IP & MAC Metadata Row (WOL readiness) */}
            {(hostState.lanIp || (hostState.macAddresses && hostState.macAddresses.length > 0)) && (
              <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 text-xs">
                <div className="flex items-center gap-2 text-[#4B5563]">
                  <Network className="h-3.5 w-3.5 shrink-0 text-[#6B7280]" />
                  <span>局域网 / WOL</span>
                </div>
                <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-[#374151]">
                  {hostState.lanIp && (
                    <span className="rounded border border-[#E2E6EC] bg-[#F8F9FB] px-1.5 py-0.5">
                      {hostState.lanIp}
                    </span>
                  )}
                  {hostState.macAddresses?.[0] && (
                    <span className="rounded border border-[#E2E6EC] bg-[#F8F9FB] px-1.5 py-0.5 text-[#4B5563]">
                      {hostState.macAddresses[0]}
                    </span>
                  )}
                  {hostState.macAddresses && hostState.macAddresses.length > 0 && (
                    <span className="rounded border border-[#BBF7D0] bg-[#ECFDF3] px-1.5 py-0.5 font-sans text-[10px] font-medium text-[#15803D]">
                      WOL 就绪
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Pro Unattended Host Settings */}
          <div className="overflow-hidden rounded-lg border border-[#E2E6EC] bg-white">
            <div className="flex items-center justify-between border-b border-[#ECEFF4] bg-[#F8F9FB] px-3.5 py-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#6B7280]">
                无人值守与专业采集设置
              </span>
              {hostState.privacyScreenActive && (
                <span className="inline-flex items-center gap-1 rounded border border-[#93C5FD] bg-[#EFF6FF] px-1.5 py-0.5 text-[10px] font-semibold text-[#1D4ED8]">
                  <EyeOff className="h-3 w-3" />
                  隐私防窥中
                </span>
              )}
            </div>

            <div className="divide-y divide-[#ECEFF4]">
              {/* Access Approval Mode Segmented Control */}
              <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5">
                <div className="flex min-w-0 flex-1 items-start gap-2.5">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#4B5563]" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-[#111318]">接入策略</p>
                    <p className="mt-0.5 text-[11px] leading-snug text-[#6B7280]">
                      {(hostState.accessMode ?? "auto") === "confirm"
                        ? "每次远程接入需在本机点击「允许接入」，并可细分勾选权限"
                        : "通过账号或控制密码验证后自动放行，适合 7×24 无人值守"}
                    </p>
                  </div>
                </div>
                <div
                  role="group"
                  aria-label="接入策略"
                  className="inline-flex shrink-0 rounded-lg border border-[#CBD2DC] bg-[#F4F5F7] p-0.5"
                >
                  {(
                    [
                      { id: "auto", label: "无人值守自动接入" },
                      { id: "confirm", label: "来访弹窗审批" },
                    ] as Array<{ id: AccessApprovalMode; label: string }>
                  ).map((option) => {
                    const active = (hostState.accessMode ?? "auto") === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        disabled={Boolean(busySettingKey)}
                        onClick={() => void handleChangeAccessMode(option.id)}
                        className={`h-7 rounded-md px-2.5 text-[11px] font-medium transition disabled:opacity-50 ${
                          active
                            ? "bg-[#2563EB] text-white shadow-xs"
                            : "text-[#4B5563] hover:text-[#111318]"
                        }`}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <HostSettingToggleRow
                icon={<Power className="h-3.5 w-3.5 text-[#4B5563]" />}
                title="开机自启（Login Item）"
                description="登录系统后自动静默拉起 VeloDeck 本机被控服务"
                checked={Boolean(hostState.autoLaunch)}
                busy={busySettingKey === "autoLaunch"}
                disabled={Boolean(busySettingKey)}
                onToggle={() =>
                  void handleToggleProConfig("autoLaunch", !hostState.autoLaunch)
                }
              />

              <HostSettingToggleRow
                icon={<Moon className="h-3.5 w-3.5 text-[#4B5563]" />}
                title="7×24 防休眠保活"
                description="阻止电脑自动休眠断网，保障全天候无人值守远程接入"
                checked={Boolean(hostState.preventSleep)}
                busy={busySettingKey === "preventSleep"}
                disabled={Boolean(busySettingKey)}
                onToggle={() =>
                  void handleToggleProConfig("preventSleep", !hostState.preventSleep)
                }
              />

              <HostSettingToggleRow
                icon={<Volume2 className="h-3.5 w-3.5 text-[#4B5563]" />}
                title="系统音频同步采集"
                description="远控会话建立时同步采集并传输本机系统声音"
                checked={Boolean(hostState.audioCaptureEnabled)}
                busy={busySettingKey === "audioCaptureEnabled"}
                disabled={Boolean(busySettingKey)}
                onToggle={() =>
                  void handleToggleProConfig(
                    "audioCaptureEnabled",
                    !hostState.audioCaptureEnabled,
                  )
                }
              />

              <HostSettingToggleRow
                icon={<Clipboard className="h-3.5 w-3.5 text-[#4B5563]" />}
                title="双向剪贴板自动同步"
                description="在本机与远控端之间自动实时同步复制的文本内容"
                checked={hostState.clipboardAutoSync !== false}
                busy={busySettingKey === "clipboardAutoSync"}
                disabled={Boolean(busySettingKey)}
                onToggle={() =>
                  void handleToggleProConfig(
                    "clipboardAutoSync",
                    hostState.clipboardAutoSync === false,
                  )
                }
              />

              <HostSettingToggleRow
                icon={<EyeOff className="h-3.5 w-3.5 text-[#4B5563]" />}
                title="隐私防窥黑屏"
                description="开启后本机屏幕显示纯黑，按 Cmd/Ctrl+Opt/Alt+Esc 可随时紧急解除"
                checked={Boolean(hostState.privacyScreenActive)}
                busy={busySettingKey === "privacyScreenActive"}
                disabled={Boolean(busySettingKey) || !handlers.onSetPrivacyScreen}
                onToggle={() => void handleTogglePrivacyScreen()}
              />
            </div>
          </div>

          {/* Multi-Monitor Display Selector */}
          {hostState.displays.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-medium text-[#374151]">
                  共享显示器（{hostState.displays.length} 块）
                </span>
                <span className="text-[11px] text-[#6B7280]">
                  选择被远程采集与键鼠映射的目标屏幕
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {hostState.displays.map((display, idx) => {
                  const active = display.id === hostState.activeDisplayId;
                  const busy = selectingDisplayId === display.id;
                  return (
                    <button
                      key={display.id}
                      type="button"
                      disabled={Boolean(selectingDisplayId)}
                      onClick={() => void handleSelectDisplayClick(display.id)}
                      title={display.name}
                      className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition ${
                        active
                          ? "border-[#2563EB] bg-[#EFF6FF] text-[#1D4ED8]"
                          : "border-[#CBD2DC] bg-white text-[#374151] hover:bg-[#F8F9FB]"
                      }`}
                    >
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Monitor className="h-3.5 w-3.5" />
                      )}
                      <span>
                        显示器 {idx + 1}
                        {display.primary ? "（主）" : ""}
                      </span>
                      <span className="font-mono text-[11px] opacity-80">
                        · {display.width}×{display.height}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* macOS System Permissions Checklist */}
          {isMacHost && (
            <div className="overflow-hidden rounded-lg border border-[#E2E6EC] bg-white">
              <div className="flex items-center justify-between gap-2 border-b border-[#ECEFF4] bg-[#F8F9FB] px-3.5 py-2">
                <div className="flex items-center gap-1.5">
                  {needsMacPermission ? (
                    <ShieldAlert className="h-3.5 w-3.5 text-[#D97706]" />
                  ) : (
                    <ShieldCheck className="h-3.5 w-3.5 text-[#15803D]" />
                  )}
                  <span className="text-xs font-semibold text-[#374151]">
                    macOS 权限检查
                  </span>
                </div>
                <button
                  type="button"
                  disabled={refreshingPerms}
                  onClick={() => void handleRefreshPermsClick()}
                  className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-[#4B5563] hover:bg-[#ECEFF4] hover:text-[#111318] disabled:opacity-50"
                >
                  <RefreshCw
                    className={`h-3 w-3 ${refreshingPerms ? "animate-spin text-[#2563EB]" : ""}`}
                  />
                  刷新权限状态
                </button>
              </div>

              <div className="divide-y divide-[#ECEFF4] text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[#111318]">
                      屏幕录制权限（画面采集）
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                        hostState.permissions.screenCapture
                          ? "bg-[#ECFDF3] text-[#15803D]"
                          : "bg-[#FFFBEB] text-[#B45309]"
                      }`}
                    >
                      {hostState.permissions.screenCapture ? "已授权" : "未授权"}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handlers.onOpenPermissionSettings("screen")}
                    className="btn-outline inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium"
                  >
                    <span>打开设置</span>
                    <ExternalLink className="h-3 w-3 text-[#6B7280]" />
                  </button>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[#111318]">
                      辅助功能权限（鼠标与键盘控制）
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                        hostState.permissions.accessibility
                          ? "bg-[#ECFDF3] text-[#15803D]"
                          : "bg-[#FFFBEB] text-[#B45309]"
                      }`}
                    >
                      {hostState.permissions.accessibility ? "已授权" : "未授权"}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void handlers.onOpenPermissionSettings("accessibility")
                    }
                    className="btn-outline inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium"
                  >
                    <span>打开设置</span>
                    <ExternalLink className="h-3 w-3 text-[#6B7280]" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Last Received File Notice */}
          {hostState.lastReceivedFile && (
            <div className="flex items-start gap-2.5 rounded-lg border border-[#E2E6EC] bg-[#F8F9FB] px-3.5 py-2.5 text-xs">
              <FileCheck2 className="mt-0.5 h-4 w-4 shrink-0 text-[#15803D]" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-[#111318]">
                    最近接收文件：{hostState.lastReceivedFile.fileName}
                  </span>
                  {hostState.lastReceivedFile.at > 0 && (
                    <span className="font-mono text-[11px] text-[#6B7280]">
                      {formatReceivedTime(hostState.lastReceivedFile.at)}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate font-mono text-[11px] text-[#6B7280]">
                  {hostState.lastReceivedFile.savedPath}
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );

  if (embedded) {
    return <div>{content}</div>;
  }

  return <section className="panel overflow-hidden rounded-xl">{content}</section>;
}

function HostSettingToggleRow({
  icon,
  title,
  description,
  checked,
  busy,
  disabled,
  onToggle,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  checked: boolean;
  busy: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <span className="mt-0.5 shrink-0">{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-[#111318]">{title}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-[#6B7280]">
            {description}
          </p>
        </div>
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        disabled={disabled}
        onClick={onToggle}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] disabled:cursor-not-allowed disabled:opacity-50 ${
          checked
            ? "border-[#2563EB] bg-[#2563EB]"
            : "border-[#CBD2DC] bg-[#E5E7EB]"
        }`}
      >
        <span
          className={`inline-flex h-4.5 w-4.5 transform items-center justify-center rounded-full bg-white shadow-xs transition-transform ${
            checked ? "translate-x-5" : "translate-x-0.5"
          }`}
        >
          {busy && (
            <Loader2 className="h-2.5 w-2.5 animate-spin text-[#2563EB]" />
          )}
        </span>
      </button>
    </div>
  );
}
