import { AlertTriangle, Lock, ShieldAlert, Unlock, X } from "lucide-react";
import type {
  QuickConnectParams,
  QuickConnectSecurityAssessment,
} from "../state/profiles";

export interface QuickConnectConfirmModalProps {
  pending: {
    params: QuickConnectParams;
    security: QuickConnectSecurityAssessment;
  } | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function QuickConnectConfirmModal({
  pending,
  onConfirm,
  onCancel,
}: QuickConnectConfirmModalProps) {
  if (!pending) return null;

  const { params, security } = pending;
  const isSecureWss = security.protocol === "wss:";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-connect-confirm-title"
        className="modal-panel animate-sheet-up safe-bottom w-full max-w-md rounded-t-2xl text-[#111318] sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#E2E6EC] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <ShieldAlert className="h-5 w-5 text-[#D97706]" />
            <div>
              <h2
                id="quick-connect-confirm-title"
                className="text-sm font-semibold text-[#111318]"
              >
                {security.isExternalHost ? "外部连接安全确认" : "明文连接安全确认"}
              </h2>
              <p className="text-xs text-[#6B7280]">
                请核对链接中的目标主机与传输协议后再继续
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onCancel}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#6B7280] hover:bg-[#F3F4F6] hover:text-[#111318]"
            aria-label="取消"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3.5 p-5">
          <div className="space-y-2.5 rounded-lg border border-[#E2E6EC] bg-[#F8F9FB] p-3.5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#6B7280]">目标主机</span>
              <span className="truncate font-mono font-semibold text-[#111318]">
                {security.host || params.wsUrl}
              </span>
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="text-[#6B7280]">连接名称</span>
              <span className="truncate text-[#374151]">{params.label}</span>
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="text-[#6B7280]">传输协议</span>
              {isSecureWss ? (
                <span className="inline-flex items-center gap-1 rounded bg-[#ECFDF3] px-2 py-0.5 text-[11px] font-medium text-[#15803D]">
                  <Lock className="h-3 w-3" />
                  wss:// 加密传输
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded bg-[#FFFBEB] px-2 py-0.5 text-[11px] font-medium text-[#B45309]">
                  <Unlock className="h-3 w-3" />
                  ws:// 明文未加密
                </span>
              )}
            </div>

            <div className="border-t border-[#E2E6EC] pt-2">
              <p className="mb-0.5 text-[11px] text-[#6B7280]">完整连接地址</p>
              <p className="break-all font-mono text-[11px] text-[#374151]">
                {params.wsUrl}
              </p>
            </div>
          </div>

          {security.isExternalHost && (
            <div className="flex items-start gap-2 rounded-lg border border-[#FDE68A] bg-[#FFFBEB] px-3 py-2.5 text-xs leading-relaxed text-[#92400E]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#D97706]" />
              <span>该链接指向与当前页面不同的外部服务器，请确认其来源可信。</span>
            </div>
          )}

          {security.isInsecurePublicWs && (
            <div className="flex items-start gap-2 rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-3 py-2.5 text-xs leading-relaxed text-[#991B1B]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#DC2626]" />
              <span>
                目标为公网明文 <code className="font-mono">ws://</code> 连接，未经 TLS 加密。
              </span>
            </div>
          )}

          <div className="flex items-center gap-2.5 pt-1">
            <button
              type="button"
              onClick={onCancel}
              className="btn-outline h-10 flex-1 rounded-lg text-sm font-medium"
            >
              取消
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="btn-primary h-10 flex-1 rounded-lg text-sm font-medium"
            >
              确认连接
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
