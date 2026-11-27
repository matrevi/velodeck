import { Fragment, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  Server,
  Share,
  ShieldAlert,
  Smartphone,
  Ticket,
  Trash2,
  User,
  X,
} from "lucide-react";
import {
  MIN_PASSWORD_LENGTH,
  dismissIosPwaBanner,
  formatControlCode,
  getAndroidApkDownloadUrl,
  getAndroidApkFileName,
  loginAccount,
  registerAccount,
  sanitizeControlCodeInput,
  shouldShowIosPwaBanner,
  type AuthResponse,
  type RecentControlCode,
  type SavedAccountSession,
  type ServerInfo,
} from "../state/auth";
import { isPrivateHost } from "../state/profiles";
import type { RemoteClientState } from "../transport/RemoteClient";

export interface LaunchViewProps {
  apiBase: string;
  serverInfo: ServerInfo;
  initialTab?: "code" | "account";
  savedAccount: SavedAccountSession | null;
  recentCodes: RecentControlCode[];
  profileCount: number;
  clientState: RemoteClientState;
  codeOfflineNotice: {
    controlCode: string;
    deviceName?: string;
  } | null;
  onConnectWithCode: (input: {
    controlCode: string;
    controlPassword: string;
    rememberPassword: boolean;
  }) => void;
  onCancelCodeConnect: () => void;
  onRetryCodeConnect: () => void;
  onDeleteRecentCode: (controlCode: string) => void;
  onAccountAuthed: (auth: AuthResponse, isRegister: boolean) => void;
  onReturnToAccountDashboard: () => void;
  onOpenConnections: () => void;
}

export function LaunchView({
  apiBase,
  serverInfo,
  initialTab = "code",
  savedAccount,
  recentCodes,
  profileCount,
  clientState,
  codeOfflineNotice,
  onConnectWithCode,
  onCancelCodeConnect,
  onRetryCodeConnect,
  onDeleteRecentCode,
  onAccountAuthed,
  onReturnToAccountDashboard,
  onOpenConnections,
}: LaunchViewProps) {
  const [activeTab, setActiveTab] = useState<"code" | "account">(initialTab);
  const [showIosBanner, setShowIosBanner] = useState(false);
  const [copiedSha256, setCopiedSha256] = useState(false);

  // Tab 1: Control-Code form state (rememberPassword defaults to false for security)
  const [codeDigits, setCodeDigits] = useState("");
  const [codeFocused, setCodeFocused] = useState(false);
  const [codePassword, setCodePassword] = useState("");
  const [showCodePassword, setShowCodePassword] = useState(false);
  const [rememberPassword, setRememberPassword] = useState(false);
  const [localCodeHint, setLocalCodeHint] = useState<string | null>(null);
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const passwordInputRef = useRef<HTMLInputElement | null>(null);

  // Tab 2: Account login / register form state
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [showAccountPassword, setShowAccountPassword] = useState(false);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    setShowIosBanner(shouldShowIosPwaBanner());
  }, []);

  const isCodeConnecting =
    clientState.authType === "code" &&
    (clientState.socketStatus === "connecting" ||
      clientState.socketStatus === "authenticating" ||
      clientState.socketStatus === "reconnecting");

  const codeError =
    clientState.authType === "code" &&
    (clientState.socketStatus === "error" ||
      clientState.socketStatus === "reconnecting")
      ? clientState.errorMessage
      : null;

  const isCodeReady = codeDigits.length === 9 && codePassword.trim().length > 0;
  const apkUrl = getAndroidApkDownloadUrl(apiBase, serverInfo);
  const apkFileName = getAndroidApkFileName(serverInfo);
  const hasAndroidApk = serverInfo.hasAndroidApk;
  const apkSha256 = serverInfo.apkSha256;

  const isRegistrationClosed =
    serverInfo.registrationMode === "closed" ||
    serverInfo.registrationOpen === false;
  const requiresInviteCode =
    !isRegistrationClosed &&
    (serverInfo.requiresInviteCode === true ||
      serverInfo.registrationMode === "invite");

  const isRegisterPasswordTooShort =
    authMode === "register" &&
    accountPassword.length > 0 &&
    accountPassword.length < MIN_PASSWORD_LENGTH;

  const isAccountSubmitDisabled =
    !username.trim() ||
    !accountPassword ||
    authSubmitting ||
    (authMode === "register" &&
      (isRegistrationClosed ||
        accountPassword.length < MIN_PASSWORD_LENGTH ||
        (requiresInviteCode && !inviteCode.trim())));

  const isCleartextPublicHttp =
    typeof window !== "undefined" &&
    window.location.protocol === "http:" &&
    Boolean(window.location.hostname) &&
    !isPrivateHost(window.location.hostname);

  function handleDismissIosTip() {
    setShowIosBanner(false);
    dismissIosPwaBanner();
  }

  async function handleCopySha256() {
    if (!apkSha256) return;
    try {
      await navigator.clipboard.writeText(apkSha256);
      setCopiedSha256(true);
      window.setTimeout(() => setCopiedSha256(false), 1600);
    } catch {
      // Ignore clipboard denial
    }
  }

  function handleCodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isCodeReady || isCodeConnecting) return;
    setLocalCodeHint(null);
    onConnectWithCode({
      controlCode: codeDigits,
      controlPassword: codePassword,
      rememberPassword,
    });
  }

  function handleTapRecentCode(entry: RecentControlCode) {
    const clean = sanitizeControlCodeInput(entry.controlCode);
    setCodeDigits(clean);
    setLocalCodeHint(null);

    if (entry.controlPassword) {
      setCodePassword(entry.controlPassword);
      setRememberPassword(true);
      onConnectWithCode({
        controlCode: clean,
        controlPassword: entry.controlPassword,
        rememberPassword: true,
      });
    } else {
      setCodePassword("");
      setRememberPassword(false);
      setLocalCodeHint("本次会话未缓存该设备密码，请输入无人值守控制密码");
      window.setTimeout(() => {
        passwordInputRef.current?.focus();
      }, 30);
    }
  }

  async function handleAccountSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedUsername = username.trim();
    if (!trimmedUsername || !accountPassword || authSubmitting) return;

    if (authMode === "register") {
      if (isRegistrationClosed) {
        setAuthError("服务器已关闭公开注册");
        return;
      }
      if (accountPassword.length < MIN_PASSWORD_LENGTH) {
        setAuthError(`登录密码至少需要 ${MIN_PASSWORD_LENGTH} 位`);
        return;
      }
      if (requiresInviteCode && !inviteCode.trim()) {
        setAuthError("请输入管理员提供的邀请码");
        return;
      }
    }

    setAuthError(null);
    setAuthSubmitting(true);
    try {
      const result =
        authMode === "register"
          ? await registerAccount(apiBase, {
              username: trimmedUsername,
              password: accountPassword,
              displayName: displayName.trim() || undefined,
              inviteCode: inviteCode.trim() || undefined,
            })
          : await loginAccount(apiBase, {
              username: trimmedUsername,
              password: accountPassword,
            });
      onAccountAuthed(result, authMode === "register");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "请求失败，请稍后重试";
      setAuthError(message);
    } finally {
      setAuthSubmitting(false);
    }
  }

  const slotGroups = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
  ];

  return (
    <div className="flex min-h-[100dvh] flex-col bg-[#F4F5F7] text-[#111318]">
      {/* Committed Deep-Ink Hardware Shell Header */}
      <header className="safe-top sticky top-0 z-30 border-b border-[#232732] bg-[#111318] text-white">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <img
              src="./icon.svg"
              alt="VeloDeck 极控"
              className="h-7 w-7 rounded-lg bg-[#1C212C] ring-1 ring-white/20"
            />
            <span className="text-[15px] font-semibold tracking-tight text-white">
              VeloDeck 极控
            </span>
            <span className="hidden text-xs text-zinc-500 sm:inline">/</span>
            <span className="hidden text-xs text-zinc-300 sm:inline">
              远程控机控制台
            </span>
          </div>

          <div className="flex items-center gap-2">
            {savedAccount && (
              <button
                type="button"
                onClick={onReturnToAccountDashboard}
                className="btn-shell inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium"
              >
                <ArrowLeft className="h-3.5 w-3.5 text-blue-400" />
                <span className="max-w-[130px] truncate">
                  {savedAccount.user.displayName || savedAccount.user.username}
                </span>
              </button>
            )}
            <button
              type="button"
              onClick={onOpenConnections}
              className="btn-shell inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium"
            >
              <Server className="h-3.5 w-3.5 text-zinc-400" />
              <span>局域网 / 自建</span>
              {profileCount > 0 && (
                <span className="rounded bg-white/15 px-1.5 py-0.2 font-mono text-[10px]">
                  {profileCount}
                </span>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Main Operational Workspace */}
      <main className="safe-bottom mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-6 sm:px-6 lg:py-10">
        {/* Optional iOS Add-to-Home-Screen Utility Strip */}
        {showIosBanner && (
          <div className="mb-5 flex items-center gap-3 rounded-lg border border-[#D8E2F8] bg-[#EFF4FF] px-3.5 py-2.5 text-xs text-[#1E3A8A]">
            <Share className="h-4 w-4 shrink-0 text-[#2563EB]" />
            <p className="min-w-0 flex-1 leading-snug">
              在 Safari 中轻点「分享」→「添加到主屏幕」，即可像系统 App 一样全屏控机。
            </p>
            <button
              type="button"
              onClick={handleDismissIosTip}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#1E3A8A]/70 hover:bg-[#DBEAFE] hover:text-[#1E3A8A]"
              aria-label="关闭主屏幕提示"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Primary Two-Column Operational Grid (Connect Console + Recent & Client Download) */}
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
          {/* Primary Task Panel (Left 7 cols on desktop) */}
          <section className="panel overflow-hidden rounded-xl lg:col-span-7">
            {/* Standard Platform Tab Bar */}
            <div
              role="tablist"
              aria-label="连接方式"
              className="flex border-b border-[#E2E6EC] bg-[#F8F9FB] px-5 pt-2"
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "code"}
                onClick={() => setActiveTab("code")}
                className={`relative -mb-px inline-flex items-center gap-2 border-b-2 px-3 py-3 text-sm font-medium transition-colors ${
                  activeTab === "code"
                    ? "border-[#2563EB] text-[#111318]"
                    : "border-transparent text-[#6B7280] hover:text-[#111318]"
                }`}
              >
                <KeyRound className="h-4 w-4" />
                <span>控制码连接</span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "account"}
                onClick={() => setActiveTab("account")}
                className={`relative -mb-px inline-flex items-center gap-2 border-b-2 px-3 py-3 text-sm font-medium transition-colors ${
                  activeTab === "account"
                    ? "border-[#2563EB] text-[#111318]"
                    : "border-transparent text-[#6B7280] hover:text-[#111318]"
                }`}
              >
                <User className="h-4 w-4" />
                <span>账号登录</span>
              </button>
            </div>

            <div className="p-5 sm:p-6">
              {activeTab === "code" ? (
                <form onSubmit={handleCodeSubmit} className="space-y-5">
                  <div>
                    <h1 className="text-lg font-semibold tracking-tight text-[#111318]">
                      输入 9 位设备控制码
                    </h1>
                    <p className="mt-1 text-xs text-[#6B7280]">
                      在被控 Android 手机上打开 VeloDeck Agent 即可看到本机永久控制码与密码。
                    </p>
                  </div>

                  {/* Signature Move: Mechanical 3-3-3 Segmented Hardware Code Slots */}
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <label
                        htmlFor="control-code-input"
                        className="text-xs font-medium text-[#374151]"
                      >
                        设备控制码
                      </label>
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-mono text-xs ${
                            codeDigits.length === 9
                              ? "font-medium text-[#15803D]"
                              : "text-[#6B7280]"
                          }`}
                        >
                          {codeDigits.length}/9
                        </span>
                        {codeDigits.length > 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              setCodeDigits("");
                              setLocalCodeHint(null);
                              codeInputRef.current?.focus();
                            }}
                            className="text-xs text-[#6B7280] underline hover:text-[#111318]"
                          >
                            清空
                          </button>
                        )}
                      </div>
                    </div>

                    <div
                      className="relative cursor-text"
                      onClick={() => codeInputRef.current?.focus()}
                    >
                      {/* Native accessible input overlaid transparently for flawless iOS numeric keyboard & paste */}
                      <input
                        ref={codeInputRef}
                        id="control-code-input"
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={11}
                        value={codeDigits}
                        onFocus={() => setCodeFocused(true)}
                        onBlur={() => setCodeFocused(false)}
                        onChange={(e) => {
                          const clean = sanitizeControlCodeInput(e.target.value);
                          setCodeDigits(clean);
                          setLocalCodeHint(null);
                          if (clean.length === 9) {
                            passwordInputRef.current?.focus();
                          }
                        }}
                        aria-label="被控手机 9 位控制码"
                        className="absolute inset-0 z-10 h-full w-full cursor-text opacity-0"
                      />

                      <div className="flex items-center gap-1.5 sm:gap-2">
                        {slotGroups.map((group, groupIdx) => (
                          <Fragment key={groupIdx}>
                            <div className="grid flex-1 grid-cols-3 gap-1 sm:gap-1.5">
                              {group.map((slotIndex) => {
                                const char = codeDigits[slotIndex] ?? "";
                                const isActiveSlot =
                                  codeFocused &&
                                  (codeDigits.length === slotIndex ||
                                    (codeDigits.length === 9 && slotIndex === 8));
                                return (
                                  <div
                                    key={slotIndex}
                                    className={`flex h-12 items-center justify-center rounded-lg border font-mono text-lg font-semibold transition-colors sm:h-13 sm:text-xl ${
                                      isActiveSlot
                                        ? "border-[#2563EB] bg-[#EFF4FF] text-[#111318] ring-2 ring-[#2563EB]/20"
                                        : char
                                          ? "border-[#94A3B8] bg-white text-[#111318]"
                                          : "border-[#D5DBE3] bg-[#F8F9FB] text-[#9CA3AF]"
                                    }`}
                                  >
                                    {char || (
                                      <span className="h-1 w-1 rounded-full bg-[#CBD5E1]" />
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                            {groupIdx < 2 && (
                              <span
                                aria-hidden="true"
                                className="shrink-0 font-mono text-sm text-[#94A3B8]"
                              >
                                -
                              </span>
                            )}
                          </Fragment>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Unattended Control Password */}
                  <div>
                    <label
                      htmlFor="control-password-input"
                      className="mb-1.5 block text-xs font-medium text-[#374151]"
                    >
                      无人值守控制密码
                    </label>
                    <div className="relative">
                      <input
                        ref={passwordInputRef}
                        id="control-password-input"
                        type={showCodePassword ? "text" : "password"}
                        value={codePassword}
                        onChange={(e) => {
                          setCodePassword(e.target.value);
                          setLocalCodeHint(null);
                        }}
                        placeholder={`输入设备控制密码（建议 ≥ ${MIN_PASSWORD_LENGTH} 位）`}
                        autoComplete="off"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        className="field h-11 w-full rounded-lg pl-3.5 pr-10 text-sm placeholder:text-[#9CA3AF]"
                      />
                      <button
                        type="button"
                        onClick={() => setShowCodePassword((prev) => !prev)}
                        className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F3F4F6] hover:text-[#111318]"
                        aria-label={showCodePassword ? "隐藏密码" : "显示密码"}
                      >
                        {showCodePassword ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                    {codePassword.length > 0 &&
                      codePassword.length < MIN_PASSWORD_LENGTH && (
                        <p className="mt-1.5 text-xs text-[#B45309]">
                          新版被控端要求控制密码至少 {MIN_PASSWORD_LENGTH} 位（旧版设备仍可连接）
                        </p>
                      )}
                  </div>

                  {/* Session-Only Remember Checkbox */}
                  <label className="flex cursor-pointer items-center gap-2 select-none text-xs text-[#4B5563]">
                    <input
                      type="checkbox"
                      checked={rememberPassword}
                      onChange={(e) => setRememberPassword(e.target.checked)}
                      className="h-4 w-4 rounded border-[#CBD5E1] accent-[#2563EB]"
                    />
                    <span>本次会话记住密码（关闭标签页后自动清除）</span>
                  </label>

                  {/* Contextual Status & Errors */}
                  {localCodeHint && (
                    <div className="flex items-start gap-2 rounded-lg border border-[#BFDBFE] bg-[#EFF6FF] px-3 py-2.5 text-xs text-[#1E40AF]">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#2563EB]" />
                      <span>{localCodeHint}</span>
                    </div>
                  )}

                  {codeError && (
                    <div className="flex items-start gap-2 rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-3 py-2.5 text-xs text-[#991B1B]">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#DC2626]" />
                      <span className="flex-1">{codeError}</span>
                    </div>
                  )}

                  {codeOfflineNotice && (
                    <div className="space-y-2.5 rounded-lg border border-[#FDE68A] bg-[#FFFBEB] p-3.5 text-xs text-[#92400E]">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#D97706]" />
                        <div className="min-w-0 flex-1 leading-relaxed">
                          <p className="font-semibold text-[#78350F]">
                            设备当前未在线
                          </p>
                          <p className="mt-0.5">
                            「
                            {codeOfflineNotice.deviceName ||
                              formatControlCode(codeOfflineNotice.controlCode)}
                            」暂未连上服务器，请确认手机端 VeloDeck Agent 处于运行状态。
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={onRetryCodeConnect}
                          className="btn-outline inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          重试连接
                        </button>
                        <button
                          type="button"
                          onClick={onCancelCodeConnect}
                          className="h-8 rounded-md px-2.5 text-xs font-medium text-[#78350F] hover:underline"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-3 pt-1">
                    <button
                      type="submit"
                      disabled={!isCodeReady || isCodeConnecting}
                      className="btn-primary flex h-11 flex-1 items-center justify-center gap-2 rounded-lg text-sm font-medium disabled:cursor-not-allowed"
                    >
                      {isCodeConnecting ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span>
                            {clientState.socketStatus === "reconnecting"
                              ? "正在重新连接..."
                              : "正在建立连接..."}
                          </span>
                        </>
                      ) : (
                        <>
                          <span>连接并控制</span>
                          <ArrowRight className="h-4 w-4" />
                        </>
                      )}
                    </button>

                    {isCodeConnecting && (
                      <button
                        type="button"
                        onClick={onCancelCodeConnect}
                        className="btn-outline h-11 rounded-lg px-4 text-xs font-medium"
                      >
                        取消
                      </button>
                    )}
                  </div>
                </form>
              ) : (
                <form
                  onSubmit={(e) => void handleAccountSubmit(e)}
                  className="space-y-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h1 className="text-lg font-semibold tracking-tight text-[#111318]">
                        {authMode === "login" ? "登录你的账号" : "注册个人账号"}
                      </h1>
                      <p className="mt-1 text-xs text-[#6B7280]">
                        两台手机登录同一账号后，即可免输控制码直接管理名下所有设备。
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setAuthMode((m) => (m === "login" ? "register" : "login"));
                        setAuthError(null);
                      }}
                      className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-[#2563EB] hover:bg-[#EFF4FF]"
                    >
                      {authMode === "login" ? "注册新账号" : "返回登录"}
                    </button>
                  </div>

                  {authMode === "register" && isRegistrationClosed ? (
                    <div className="space-y-3 rounded-lg border border-[#FDE68A] bg-[#FFFBEB] p-4 text-xs text-[#92400E]">
                      <div className="flex items-center gap-2 font-semibold text-[#78350F]">
                        <Lock className="h-4 w-4 text-[#D97706]" />
                        <span>服务器已关闭公开注册</span>
                      </div>
                      <p className="leading-relaxed">
                        当前中继实例仅允许已有账号登录，请联系管理员或在服务器配置中调整注册策略。
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setAuthMode("login");
                          setAuthError(null);
                        }}
                        className="btn-outline h-8 rounded-md px-3 text-xs font-medium"
                      >
                        返回账号登录
                      </button>
                    </div>
                  ) : (
                    <>
                      <div>
                        <label
                          htmlFor="account-username-input"
                          className="mb-1.5 block text-xs font-medium text-[#374151]"
                        >
                          用户名 / 手机号
                        </label>
                        <input
                          id="account-username-input"
                          type="text"
                          value={username}
                          onChange={(e) => {
                            setUsername(e.target.value);
                            setAuthError(null);
                          }}
                          placeholder="输入用户名或手机号（3–32 位）"
                          autoCapitalize="none"
                          autoCorrect="off"
                          autoComplete="username"
                          spellCheck={false}
                          className="field h-11 w-full rounded-lg px-3.5 text-sm placeholder:text-[#9CA3AF]"
                        />
                      </div>

                      <div>
                        <div className="mb-1.5 flex items-center justify-between">
                          <label
                            htmlFor="account-password-input"
                            className="text-xs font-medium text-[#374151]"
                          >
                            密码
                          </label>
                          {authMode === "register" && (
                            <span
                              className={`text-xs ${
                                isRegisterPasswordTooShort
                                  ? "text-[#B45309]"
                                  : accountPassword.length >= MIN_PASSWORD_LENGTH
                                    ? "text-[#15803D]"
                                    : "text-[#6B7280]"
                              }`}
                            >
                              {accountPassword.length >= MIN_PASSWORD_LENGTH
                                ? `符合要求 (${accountPassword.length} 位)`
                                : `至少 ${MIN_PASSWORD_LENGTH} 位`}
                            </span>
                          )}
                        </div>
                        <div className="relative">
                          <input
                            id="account-password-input"
                            type={showAccountPassword ? "text" : "password"}
                            value={accountPassword}
                            onChange={(e) => {
                              setAccountPassword(e.target.value);
                              setAuthError(null);
                            }}
                            placeholder={
                              authMode === "register"
                                ? `设置至少 ${MIN_PASSWORD_LENGTH} 位登录密码`
                                : "输入账号密码"
                            }
                            autoComplete={
                              authMode === "register"
                                ? "new-password"
                                : "current-password"
                            }
                            autoCapitalize="none"
                            autoCorrect="off"
                            className="field h-11 w-full rounded-lg pl-3.5 pr-10 text-sm placeholder:text-[#9CA3AF]"
                          />
                          <button
                            type="button"
                            onClick={() => setShowAccountPassword((prev) => !prev)}
                            className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F3F4F6] hover:text-[#111318]"
                            aria-label={showAccountPassword ? "隐藏密码" : "显示密码"}
                          >
                            {showAccountPassword ? (
                              <EyeOff className="h-4 w-4" />
                            ) : (
                              <Eye className="h-4 w-4" />
                            )}
                          </button>
                        </div>
                      </div>

                      {authMode === "register" && requiresInviteCode && (
                        <div>
                          <label
                            htmlFor="account-invite-code-input"
                            className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-[#374151]"
                          >
                            <Ticket className="h-3.5 w-3.5 text-[#2563EB]" />
                            <span>服务器邀请码（必填）</span>
                          </label>
                          <input
                            id="account-invite-code-input"
                            type="text"
                            value={inviteCode}
                            onChange={(e) => {
                              setInviteCode(e.target.value);
                              setAuthError(null);
                            }}
                            placeholder="填写服务器 .env 中的邀请码"
                            autoCapitalize="none"
                            autoCorrect="off"
                            autoComplete="off"
                            spellCheck={false}
                            className="field h-11 w-full rounded-lg px-3.5 font-mono text-sm placeholder:font-sans placeholder:text-[#9CA3AF]"
                          />
                        </div>
                      )}

                      {authMode === "register" && (
                        <div>
                          <label
                            htmlFor="account-nickname-input"
                            className="mb-1.5 block text-xs font-medium text-[#374151]"
                          >
                            显示昵称（选填）
                          </label>
                          <input
                            id="account-nickname-input"
                            type="text"
                            value={displayName}
                            onChange={(e) => setDisplayName(e.target.value)}
                            placeholder="例如：个人设备"
                            className="field h-11 w-full rounded-lg px-3.5 text-sm placeholder:text-[#9CA3AF]"
                          />
                        </div>
                      )}

                      {authError && (
                        <div className="flex items-start gap-2 rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-3 py-2.5 text-xs text-[#991B1B]">
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#DC2626]" />
                          <span className="flex-1">{authError}</span>
                        </div>
                      )}

                      <button
                        type="submit"
                        disabled={isAccountSubmitDisabled}
                        className="btn-primary flex h-11 w-full items-center justify-center gap-2 rounded-lg text-sm font-medium disabled:cursor-not-allowed"
                      >
                        {authSubmitting ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            <span>
                              {authMode === "register" ? "正在注册..." : "正在登录..."}
                            </span>
                          </>
                        ) : (
                          <>
                            <span>
                              {authMode === "register"
                                ? "注册并进入设备列表"
                                : "登录"}
                            </span>
                            <ArrowRight className="h-4 w-4" />
                          </>
                        )}
                      </button>
                    </>
                  )}
                </form>
              )}
            </div>
          </section>

          {/* Secondary Operational Column: Recent Devices + Android Agent Download */}
          <aside className="space-y-5 lg:col-span-5">
            {/* Recent Control-Code Devices List */}
            {recentCodes.length > 0 && (
              <section className="panel overflow-hidden rounded-xl">
                <div className="flex items-center justify-between border-b border-[#E2E6EC] bg-[#F8F9FB] px-4 py-2.5">
                  <h2 className="text-xs font-semibold text-[#374151]">
                    最近连接过的设备
                  </h2>
                  <span className="font-mono text-[11px] text-[#6B7280]">
                    {recentCodes.length} 台
                  </span>
                </div>
                <ul className="divide-y divide-[#ECEFF4]">
                  {recentCodes.map((entry) => {
                    const formatted = formatControlCode(entry.controlCode);
                    const hasSessionPwd = Boolean(entry.controlPassword);
                    return (
                      <li
                        key={entry.controlCode}
                        className="flex items-center gap-2 px-4 py-3 transition-colors hover:bg-[#F8F9FB]"
                      >
                        <button
                          type="button"
                          disabled={isCodeConnecting}
                          onClick={() => handleTapRecentCode(entry)}
                          className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left disabled:opacity-50"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-sm font-semibold tracking-wider text-[#111318]">
                                {formatted}
                              </span>
                              {hasSessionPwd && (
                                <span className="rounded bg-[#ECFDF3] px-1.5 py-0.5 text-[10px] font-medium text-[#15803D]">
                                  本次免密
                                </span>
                              )}
                            </div>
                            <p className="mt-0.5 truncate text-xs text-[#6B7280]">
                              {entry.deviceName || "控制码设备"}
                            </p>
                          </div>
                          <span className="shrink-0 text-xs font-medium text-[#2563EB]">
                            填入
                          </span>
                        </button>

                        <button
                          type="button"
                          onClick={() => onDeleteRecentCode(entry.controlCode)}
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[#9CA3AF] hover:bg-[#FEF2F2] hover:text-[#DC2626]"
                          aria-label={`删除 ${formatted}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {/* Android 被控端下载与快速配置清单 */}
            <section className="panel overflow-hidden rounded-xl">
              <div className="border-b border-[#E2E6EC] bg-[#F8F9FB] px-4 py-2.5">
                <h2 className="text-xs font-semibold text-[#374151]">
                  被控 Android 手机配置
                </h2>
              </div>

              <div className="divide-y divide-[#ECEFF4] px-4 text-xs">
                <div className="flex items-start gap-3 py-3.5">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#111318] font-mono text-[11px] font-semibold text-white">
                    1
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-[#111318]">
                      在被控 Android 手机上安装客户端
                    </p>
                    <p className="mt-0.5 text-[#6B7280]">
                      已内置当前服务器地址，装完打开自动上线。
                    </p>
                    {hasAndroidApk && (
                      <div className="mt-2.5 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <a
                            href={apkUrl}
                            download={apkFileName}
                            className="btn-outline inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-[#111318]"
                          >
                            <Download className="h-3.5 w-3.5 text-[#2563EB]" />
                            下载 Release APK
                          </a>
                          {apkSha256 && (
                            <button
                              type="button"
                              onClick={() => void handleCopySha256()}
                              className="inline-flex h-8 items-center gap-1 rounded-md px-2 font-mono text-[11px] text-[#6B7280] hover:bg-[#F3F4F6] hover:text-[#111318]"
                              title={apkSha256}
                            >
                              <span>SHA256 {apkSha256.slice(0, 8)}</span>
                              {copiedSha256 ? (
                                <Check className="h-3 w-3 text-[#15803D]" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                            </button>
                          )}
                        </div>
                        <p className="text-[11px] text-[#9CA3AF]">
                          若 Chrome 提示「已阻止不安全的下载」，点右上角下载图标选择「保留 / 仍要下载」即可（微信内请用系统浏览器打开）。
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-start gap-3 py-3.5">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#E5E7EB] font-mono text-[11px] font-semibold text-[#374151]">
                    2
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-[#111318]">
                      按 App 首页 3 步开关开启长期保活
                    </p>
                    <p className="mt-0.5 text-[#6B7280]">
                      开启无障碍、忽略电池优化并授予一次永久录屏权限，之后免确认连接。
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 py-3.5">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#E5E7EB] font-mono text-[11px] font-semibold text-[#374151]">
                    3
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-[#111318]">
                      输入 9 位控制码或登录同一账号即可接管
                    </p>
                    <p className="mt-0.5 text-[#6B7280]">
                      支持息屏唤醒、锁屏 PIN 解锁、中文输入法与剪贴板双向同步。
                    </p>
                  </div>
                </div>
              </div>
            </section>
          </aside>
        </div>

        {/* Quiet Single-Line Operational Footer */}
        <div className="mt-auto pt-8">
          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[#E2E6EC] pt-4 text-xs text-[#6B7280]">
            <div className="flex items-center gap-2">
              <Smartphone className="h-3.5 w-3.5 text-[#9CA3AF]" />
              <span>VeloDeck 极控 · 自托管远程控制</span>
            </div>
            {isCleartextPublicHttp && (
              <span className="inline-flex items-center gap-1.5 text-[#92400E]">
                <ShieldAlert className="h-3.5 w-3.5 text-[#D97706]" />
                <span>当前为纯 IP HTTP 连接，绑定域名后可一键升级全站 TLS</span>
              </span>
            )}
          </footer>
        </div>
      </main>
    </div>
  );
}
