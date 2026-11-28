import { useEffect, useRef, useState } from "react";
import { MessageSquare, Send, X } from "lucide-react";
import type { ChatMessage } from "@velodeck/protocol";

export interface SessionChatDrawerProps {
  messages: ChatMessage[];
  deviceName: string;
  disabled?: boolean;
  onSendMessage: (text: string) => boolean;
  onMarkRead: () => void;
  onClose: () => void;
}

function formatChatTime(ts: number): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export function SessionChatDrawer({
  messages,
  deviceName,
  disabled = false,
  onSendMessage,
  onMarkRead,
  onClose,
}: SessionChatDrawerProps) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isNearBottomRef = useRef(true);
  const hasInitialScrolledRef = useRef(false);
  const isComposingRef = useRef(false);

  const lastMessage =
    messages.length > 0 ? messages[messages.length - 1] : undefined;
  const lastMessageId = lastMessage?.id;
  const lastMessageSender = lastMessage?.sender;

  useEffect(() => {
    onMarkRead();
  }, [onMarkRead, messages.length, lastMessageId]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const isOwnMessage = lastMessageSender === "controller";
    if (!hasInitialScrolledRef.current || isOwnMessage || isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      isNearBottomRef.current = true;
      hasInitialScrolledRef.current = true;
    }
  }, [messages.length, lastMessageId, lastMessageSender]);

  useEffect(() => {
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 30);
    const handleKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  function handleListScroll() {
    const el = listRef.current;
    if (!el) return;
    isNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= 64;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isComposingRef.current) return;
    const trimmed = draft.trim();
    if (!trimmed || disabled) return;
    if (onSendMessage(trimmed)) {
      setDraft("");
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-end bg-black/60 sm:items-stretch sm:p-3"
      onClick={onClose}
      onKeyDown={(e) => e.stopPropagation()}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="会话消息"
        onClick={(e) => e.stopPropagation()}
        className="animate-sheet-up safe-bottom flex h-[70dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-[#2C313D] bg-[#111318] text-white shadow-[0_24px_48px_rgba(0,0,0,0.82)] sm:h-full sm:max-w-sm sm:rounded-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-[#262A34] px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#2C313D] bg-[#0B0D12] text-[#60A5FA]">
              <MessageSquare className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0">
              <h3 className="truncate text-xs font-semibold text-white">
                会话消息
              </h3>
              <p className="truncate text-[11px] text-zinc-400">
                与 {deviceName || "远端电脑"} 实时通信
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="关闭会话消息"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/10 text-zinc-300 hover:bg-white/15 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Message List */}
        <div
          ref={listRef}
          onScroll={handleListScroll}
          className="min-h-0 flex-1 space-y-2.5 overflow-y-auto bg-[#0B0D12] p-3.5 select-text"
        >
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-[#262A34] bg-[#141821] text-zinc-500">
                <MessageSquare className="h-5 w-5" />
              </div>
              <p className="text-xs font-medium text-zinc-300">暂无会话消息</p>
              <p className="text-[11px] leading-relaxed text-zinc-500">
                可直接给远端电脑前的使用者发送文字提示或协助指引，双方即时互通。
              </p>
            </div>
          ) : (
            messages.map((msg) => {
              const isLocal = msg.sender === "controller";
              return (
                <div
                  key={msg.id}
                  className={`flex flex-col ${isLocal ? "items-end" : "items-start"}`}
                >
                  <div className="mb-1 flex items-center gap-1.5 px-0.5 text-[10px] text-zinc-500">
                    <span>
                      {isLocal
                        ? "我（控制端）"
                        : msg.senderName || deviceName || "被控电脑"}
                    </span>
                    <span className="font-mono">{formatChatTime(msg.ts)}</span>
                  </div>
                  <div
                    className={`max-w-[85%] whitespace-pre-wrap break-words rounded-xl border px-3 py-2 text-xs leading-relaxed ${
                      isLocal
                        ? "border-[#2563EB] bg-[#2563EB] text-white"
                        : "border-[#2C313D] bg-[#191D26] text-zinc-100"
                    }`}
                  >
                    {msg.text}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Composer */}
        <form
          onSubmit={handleSubmit}
          className="flex items-center gap-2 border-t border-[#262A34] bg-[#111318] p-3"
        >
          <input
            ref={inputRef}
            type="text"
            disabled={disabled}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.nativeEvent.isComposing || e.keyCode === 229) {
                if (e.key === "Enter") {
                  e.preventDefault();
                }
                return;
              }
            }}
            placeholder={
              disabled ? "当前连接暂不支持发送消息" : "输入消息，按 Enter 发送..."
            }
            maxLength={1000}
            className="h-9 min-w-0 flex-1 rounded-lg border border-[#2C313D] bg-[#0B0D12] px-3 text-xs text-white placeholder:text-zinc-500 focus:border-[#2563EB] focus:outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={disabled || !draft.trim()}
            className="btn-primary inline-flex h-9 shrink-0 items-center gap-1 rounded-lg px-3 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Send className="h-3.5 w-3.5" />
            <span>发送</span>
          </button>
        </form>
      </aside>
    </div>
  );
}
