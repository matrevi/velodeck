import { useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  LogOut,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { MIN_PASSWORD_LENGTH, type SavedAccountSession } from "../state/auth";

export interface SecuritySettingsModalProps {
  open: boolean;
  savedAccount: SavedAccountSession | null;
  onClose: () => void;
  onChangePassword: (input: {
    currentPassword: string;
    newPassword: string;
  }) => Promise<void>;
  onLogoutAllSessions: () => Promise<void>;
}

export function SecuritySettingsModal({
  open,
  savedAccount,
  onClose,
  onChangePassword,
  onLogoutAllSessions,
}: SecuritySettingsModalProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [changingPwd, setChangingPwd] = useState(false);
  const [pwdError, setPwdError] = useState<string | null>(null);
  const [pwdSuccess, setPwdSuccess] = useState<string | null>(null);

  const [confirmLogoutAll, setConfirmLogoutAll] = useState(false);
  const [loggingOutAll, setLoggingOutAll] = useState(false);
  const [logoutAllError, setLogoutAllError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setShowCurrent(false);
    setShowNew(false);
    setChangingPwd(false);
    setPwdError(null);
    setPwdSuccess(null);
    setConfirmLogoutAll(false);
    setLoggingOutAll(false);
    setLogoutAllError(null);
  }, [open]);

  if (!open || !savedAccount) return null;

  const isNewPasswordLongEnough = newPassword.length >= MIN_PASSWORD_LENGTH;
  const passwordsMatch =
    confirmPassword.length > 0 && newPassword === confirmPassword;
  const canSubmitPwd =
    currentPassword.length > 0 &&
    isNewPasswordLongEnough &&
    passwordsMatch &&
    !changingPwd;

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (changingPwd) return;

    setPwdError(null);
    setPwdSuccess(null);

    if (!currentPassword) {
      setPwdError("请输入当前密码");
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setPwdError(`新密码长度不能少于 ${MIN_PASSWORD_LENGTH} 位`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwdError("两次输入的新密码不一致");
      return;
    }
    if (newPassword === currentPassword) {
      setPwdError("新密码不能与当前密码相同");
      return;
    }

    setChangingPwd(true);
    try {
      await onChangePassword({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPwdSuccess("密码已更新，其他设备登录态已立即失效");
    } catch (err) {
      setPwdError(err instanceof Error ? err.message : "修改密码失败，请稍后重试");
    } finally {
      setChangingPwd(false);
    }
  }

  async function handleConfirmLogoutAll() {
    if (loggingOutAll) return;
    setLogoutAllError(null);
    setLoggingOutAll(true);
    try {
      await onLogoutAllSessions();
      onClose();
    } catch (err) {
      setLogoutAllError(
        err instanceof Error ? err.message : "退出全部设备失败，请稍后重试",
      );
      setLoggingOutAll(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="modal-panel animate-sheet-up safe-bottom max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl text-[#111318] sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#E2E6EC] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="h-5 w-5 text-[#15803D]" />
            <div>
              <h2 className="text-sm font-semibold text-[#111318]">账号安全设置</h2>
              <p className="text-xs text-[#6B7280]">
                {savedAccount.user.displayName || savedAccount.user.username}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[#6B7280] hover:bg-[#F3F4F6] hover:text-[#111318]"
            aria-label="关闭安全设置"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="divide-y divide-[#ECEFF4]">
          <form
            onSubmit={(e) => void handlePasswordSubmit(e)}
            className="space-y-3.5 p-5"
          >
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-[#2563EB]" />
              <h3 className="text-sm font-semibold text-[#111318]">修改账号密码</h3>
            </div>
            <p className="text-xs leading-relaxed text-[#6B7280]">
              修改后将自动刷新本机凭证，其他已登录终端会立即失效下线。
            </p>

            <div>
              <label
                htmlFor="security-current-pwd"
                className="mb-1 block text-xs font-medium text-[#374151]"
              >
                当前密码
              </label>
              <div className="relative">
                <input
                  id="security-current-pwd"
                  type={showCurrent ? "text" : "password"}
                  value={currentPassword}
                  onChange={(e) => {
                    setCurrentPassword(e.target.value);
                    setPwdError(null);
                    setPwdSuccess(null);
                  }}
                  placeholder="输入当前账号密码"
                  autoComplete="current-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  className="field h-10 w-full rounded-lg pl-3 pr-9 text-sm placeholder:text-[#9CA3AF]"
                />
                <button
                  type="button"
                  onClick={() => setShowCurrent((prev) => !prev)}
                  className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-[#6B7280] hover:text-[#111318]"
                  aria-label={showCurrent ? "隐藏当前密码" : "显示当前密码"}
                >
                  {showCurrent ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            <div>
              <label
                htmlFor="security-new-pwd"
                className="mb-1 block text-xs font-medium text-[#374151]"
              >
                新密码（至少 {MIN_PASSWORD_LENGTH} 位）
              </label>
              <div className="relative">
                <input
                  id="security-new-pwd"
                  type={showNew ? "text" : "password"}
                  value={newPassword}
                  onChange={(e) => {
                    setNewPassword(e.target.value);
                    setPwdError(null);
                    setPwdSuccess(null);
                  }}
                  placeholder={`设置至少 ${MIN_PASSWORD_LENGTH} 位新密码`}
                  autoComplete="new-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  className="field h-10 w-full rounded-lg pl-3 pr-9 text-sm placeholder:text-[#9CA3AF]"
                />
                <button
                  type="button"
                  onClick={() => setShowNew((prev) => !prev)}
                  className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-[#6B7280] hover:text-[#111318]"
                  aria-label={showNew ? "隐藏新密码" : "显示新密码"}
                >
                  {showNew ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
              {newPassword.length > 0 && !isNewPasswordLongEnough && (
                <p className="mt-1 text-xs text-[#B45309]">
                  密码长度至少 {MIN_PASSWORD_LENGTH} 位（当前 {newPassword.length}/
                  {MIN_PASSWORD_LENGTH}）
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="security-confirm-pwd"
                className="mb-1 block text-xs font-medium text-[#374151]"
              >
                确认新密码
              </label>
              <input
                id="security-confirm-pwd"
                type={showNew ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  setPwdError(null);
                  setPwdSuccess(null);
                }}
                placeholder="再次输入新密码"
                autoComplete="new-password"
                autoCapitalize="none"
                autoCorrect="off"
                className="field h-10 w-full rounded-lg px-3 text-sm placeholder:text-[#9CA3AF]"
              />
              {confirmPassword.length > 0 && !passwordsMatch && (
                <p className="mt-1 text-xs text-[#DC2626]">两次输入的新密码不一致</p>
              )}
            </div>

            {pwdError && (
              <div className="flex items-start gap-2 rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-xs text-[#991B1B]">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#DC2626]" />
                <span>{pwdError}</span>
              </div>
            )}

            {pwdSuccess && (
              <div className="flex items-start gap-2 rounded-lg border border-[#BBF7D0] bg-[#ECFDF3] px-3 py-2 text-xs text-[#166534]">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#16A34A]" />
                <span>{pwdSuccess}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={!canSubmitPwd}
              className="btn-primary flex h-10 w-full items-center justify-center gap-2 rounded-lg text-xs font-medium disabled:cursor-not-allowed"
            >
              {changingPwd ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>正在更新密码...</span>
                </>
              ) : (
                <span>保存新密码</span>
              )}
            </button>
          </form>

          <div className="space-y-3 bg-[#FFF8F8] p-5">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-[#DC2626]" />
              <h3 className="text-sm font-semibold text-[#991B1B]">
                踢出全部已登录设备
              </h3>
            </div>
            <p className="text-xs leading-relaxed text-[#6B7280]">
              立即撤销所有终端（含当前浏览器与其他手机）的登录会话，适用于设备遗失时的紧急处置。
            </p>

            {logoutAllError && (
              <div className="flex items-start gap-2 rounded-lg border border-[#FECACA] bg-white px-3 py-2 text-xs text-[#991B1B]">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#DC2626]" />
                <span>{logoutAllError}</span>
              </div>
            )}

            {confirmLogoutAll ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={loggingOutAll}
                  onClick={() => void handleConfirmLogoutAll()}
                  className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#DC2626] px-3 text-xs font-medium text-white hover:bg-[#B91C1C] disabled:opacity-60"
                >
                  {loggingOutAll ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>正在下线...</span>
                    </>
                  ) : (
                    <>
                      <LogOut className="h-3.5 w-3.5" />
                      <span>确认全部下线</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  disabled={loggingOutAll}
                  onClick={() => {
                    setConfirmLogoutAll(false);
                    setLogoutAllError(null);
                  }}
                  className="btn-outline h-9 rounded-lg px-4 text-xs font-medium"
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmLogoutAll(true)}
                className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-[#FCA5A5] bg-white text-xs font-medium text-[#B91C1C] hover:bg-[#FEF2F2]"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>踢出全部已登录设备（全部下线）</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
