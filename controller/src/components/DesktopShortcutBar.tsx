import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Keyboard,
  RotateCcw,
  X,
} from "lucide-react";
import type {
  ControlCommand,
  DevicePlatform,
  KeyModifiers,
} from "@velodeck/protocol";

export interface DesktopShortcutBarProps {
  targetPlatform?: DevicePlatform;
  onSendKeyEvent: (
    cmd: Extract<ControlCommand, { action: "key_event" }>,
  ) => void;
  onClose: () => void;
}

type ModifierKey = "ctrl" | "alt" | "shift" | "meta";

interface LatchedModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

const EMPTY_MODS: LatchedModifiers = {
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
};

interface ComboShortcutDef {
  id: string;
  label: string;
  hint: string;
  code: string;
  key: string;
  modifiers: KeyModifiers;
}

interface NavKeyDef {
  label: string;
  code: string;
  key: string;
}

const NAV_KEYS: NavKeyDef[] = [
  { label: "Esc", code: "Escape", key: "Escape" },
  { label: "Tab", code: "Tab", key: "Tab" },
  { label: "Enter", code: "Enter", key: "Enter" },
  { label: "⌫", code: "Backspace", key: "Backspace" },
  { label: "Del", code: "Delete", key: "Delete" },
  { label: "↑", code: "ArrowUp", key: "ArrowUp" },
  { label: "↓", code: "ArrowDown", key: "ArrowDown" },
  { label: "←", code: "ArrowLeft", key: "ArrowLeft" },
  { label: "→", code: "ArrowRight", key: "ArrowRight" },
  { label: "Home", code: "Home", key: "Home" },
  { label: "End", code: "End", key: "End" },
  { label: "PgUp", code: "PageUp", key: "PageUp" },
  { label: "PgDn", code: "PageDown", key: "PageDown" },
];

const FUNCTION_KEYS: NavKeyDef[] = Array.from({ length: 12 }, (_, idx) => {
  const name = `F${idx + 1}`;
  return { label: name, code: name, key: name };
});

export function DesktopShortcutBar({
  targetPlatform,
  onSendKeyEvent,
  onClose,
}: DesktopShortcutBarProps) {
  const isMac = targetPlatform === "darwin";
  const [latched, setLatched] = useState<LatchedModifiers>(EMPTY_MODS);
  const [showFunctionKeys, setShowFunctionKeys] = useState(false);

  const hasLatched =
    latched.ctrl || latched.alt || latched.shift || latched.meta;

  const combos: ComboShortcutDef[] = isMac
    ? [
        {
          id: "copy",
          label: "复制",
          hint: "⌘C",
          code: "KeyC",
          key: "c",
          modifiers: { meta: true },
        },
        {
          id: "paste",
          label: "粘贴",
          hint: "⌘V",
          code: "KeyV",
          key: "v",
          modifiers: { meta: true },
        },
        {
          id: "undo",
          label: "撤销",
          hint: "⌘Z",
          code: "KeyZ",
          key: "z",
          modifiers: { meta: true },
        },
        {
          id: "select_all",
          label: "全选",
          hint: "⌘A",
          code: "KeyA",
          key: "a",
          modifiers: { meta: true },
        },
        {
          id: "switch_window",
          label: "切换窗口",
          hint: "⌘Tab",
          code: "Tab",
          key: "Tab",
          modifiers: { meta: true },
        },
        {
          id: "search",
          label: "聚焦搜索",
          hint: "⌘Space",
          code: "Space",
          key: " ",
          modifiers: { meta: true },
        },
        {
          id: "force_quit",
          label: "强制退出",
          hint: "⌘⌥Esc",
          code: "Escape",
          key: "Escape",
          modifiers: { meta: true, alt: true },
        },
        {
          id: "show_desktop",
          label: "显示桌面",
          hint: "F11",
          code: "F11",
          key: "F11",
          modifiers: {},
        },
        {
          id: "close_window",
          label: "关闭窗口",
          hint: "⌘W",
          code: "KeyW",
          key: "w",
          modifiers: { meta: true },
        },
      ]
    : [
        {
          id: "copy",
          label: "复制",
          hint: "Ctrl+C",
          code: "KeyC",
          key: "c",
          modifiers: { ctrl: true },
        },
        {
          id: "paste",
          label: "粘贴",
          hint: "Ctrl+V",
          code: "KeyV",
          key: "v",
          modifiers: { ctrl: true },
        },
        {
          id: "undo",
          label: "撤销",
          hint: "Ctrl+Z",
          code: "KeyZ",
          key: "z",
          modifiers: { ctrl: true },
        },
        {
          id: "select_all",
          label: "全选",
          hint: "Ctrl+A",
          code: "KeyA",
          key: "a",
          modifiers: { ctrl: true },
        },
        {
          id: "switch_window",
          label: "切换窗口",
          hint: "Alt+Tab",
          code: "Tab",
          key: "Tab",
          modifiers: { alt: true },
        },
        {
          id: "search",
          label: "开始/搜索",
          hint: "Win",
          code: "MetaLeft",
          key: "Meta",
          modifiers: {},
        },
        {
          id: "task_mgr",
          label: "任务管理",
          hint: "Ctrl+⇧+Esc",
          code: "Escape",
          key: "Escape",
          modifiers: { ctrl: true, shift: true },
        },
        {
          id: "show_desktop",
          label: "显示桌面",
          hint: "Win+D",
          code: "KeyD",
          key: "d",
          modifiers: { meta: true },
        },
        {
          id: "close_window",
          label: "关闭窗口",
          hint: "Alt+F4",
          code: "F4",
          key: "F4",
          modifiers: { alt: true },
        },
      ];

  const modifierButtons: Array<{ id: ModifierKey; label: string }> = [
    { id: "ctrl", label: "Ctrl" },
    { id: "alt", label: isMac ? "Opt ⌥" : "Alt" },
    { id: "shift", label: "Shift ⇧" },
    { id: "meta", label: isMac ? "Cmd ⌘" : "Win ⊞" },
  ];

  function toggleModifier(mod: ModifierKey) {
    setLatched((prev) => ({ ...prev, [mod]: !prev[mod] }));
  }

  function releaseAllModifiers() {
    setLatched(EMPTY_MODS);
    const modKeyDefs: Array<{ code: string; key: string }> = [
      { code: "ControlLeft", key: "Control" },
      { code: "AltLeft", key: "Alt" },
      { code: "ShiftLeft", key: "Shift" },
      { code: "MetaLeft", key: "Meta" },
    ];
    for (const def of modKeyDefs) {
      onSendKeyEvent({
        action: "key_event",
        phase: "up",
        code: def.code,
        key: def.key,
        modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      });
    }
  }

  function sendCombo(combo: ComboShortcutDef) {
    const merged: LatchedModifiers = {
      ctrl: Boolean(combo.modifiers.ctrl || latched.ctrl),
      alt: Boolean(combo.modifiers.alt || latched.alt),
      shift: Boolean(combo.modifiers.shift || latched.shift),
      meta: Boolean(combo.modifiers.meta || latched.meta),
    };
    onSendKeyEvent({
      action: "key_event",
      phase: "press",
      code: combo.code,
      key: combo.key,
      modifiers: merged,
    });
    if (hasLatched) {
      setLatched(EMPTY_MODS);
    }
  }

  function sendKeyWithLatched(def: NavKeyDef) {
    onSendKeyEvent({
      action: "key_event",
      phase: "press",
      code: def.code,
      key: def.key,
      modifiers: { ...latched },
    });
    if (hasLatched) {
      setLatched(EMPTY_MODS);
    }
  }

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[58] px-2.5 sm:px-3"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      <div
        role="region"
        aria-label="桌面组合快捷键面板"
        className="animate-sheet-up mx-auto max-w-xl rounded-xl border border-[#2C313D] bg-[#111318] p-3 text-white shadow-[0_20px_48px_rgba(0,0,0,0.82)]"
      >
        {/* Header */}
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Keyboard className="h-3.5 w-3.5 text-[#60A5FA]" />
            <span className="text-xs font-semibold text-white">
              桌面快捷键键盘
            </span>
            <span className="rounded border border-[#262A34] bg-[#0A0C10] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
              {isMac ? "macOS" : "Win / Linux"}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowFunctionKeys((prev) => !prev)}
              className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition ${
                showFunctionKeys
                  ? "border-[#2563EB] bg-[#2563EB] text-white"
                  : "border-[#262A34] bg-[#191D26] text-zinc-300 hover:bg-[#232836]"
              }`}
            >
              <span className="font-mono">F1–F12</span>
              {showFunctionKeys ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronUp className="h-3 w-3" />
              )}
            </button>
            <button
              type="button"
              onClick={releaseAllModifiers}
              title="释放全部已锁定或卡住的修饰键"
              className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition ${
                hasLatched
                  ? "border-amber-400/50 bg-amber-500/20 text-amber-200 hover:bg-amber-500/30"
                  : "border-[#262A34] bg-[#191D26] text-zinc-400 hover:bg-[#232836] hover:text-zinc-200"
              }`}
            >
              <RotateCcw className="h-3 w-3" />
              <span>释放修饰键</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭快捷键面板"
              className="flex h-7 w-7 items-center justify-center rounded-md bg-white/10 text-zinc-300 hover:bg-white/15 hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="space-y-2">
          {/* Row 1: Sticky Modifier Keys */}
          <div className="grid grid-cols-4 gap-1.5">
            {modifierButtons.map((mod) => {
              const active = latched[mod.id];
              return (
                <button
                  key={mod.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleModifier(mod.id)}
                  className={`flex h-9 items-center justify-center gap-1.5 rounded-lg border font-mono text-xs font-semibold transition ${
                    active
                      ? "border-[#2563EB] bg-[#2563EB] text-white"
                      : "border-[#262A34] bg-[#191D26] text-zinc-200 hover:border-[#3A4152] hover:bg-[#232836]"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      active ? "bg-white" : "bg-zinc-600"
                    }`}
                  />
                  <span>{mod.label}</span>
                </button>
              );
            })}
          </div>

          {/* Row 2: High-Frequency Combos */}
          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
            {combos.map((combo) => (
              <button
                key={combo.id}
                type="button"
                onClick={() => sendCombo(combo)}
                className="flex h-10 flex-col items-center justify-center rounded-lg border border-[#262A34] bg-[#14171F] px-1.5 transition hover:border-[#3B82F6]/60 hover:bg-[#1E2433] active:scale-[0.98]"
              >
                <span className="text-[11px] font-medium leading-tight text-zinc-100">
                  {combo.label}
                </span>
                <span className="mt-0.5 font-mono text-[9px] leading-none text-zinc-400">
                  {combo.hint}
                </span>
              </button>
            ))}
          </div>

          {/* Row 3: Navigation & Special Keys */}
          <div className="flex flex-wrap gap-1">
            {NAV_KEYS.map((nav) => (
              <button
                key={nav.code}
                type="button"
                onClick={() => sendKeyWithLatched(nav)}
                className="flex h-8 min-w-[2.5rem] flex-1 items-center justify-center rounded-md border border-[#262A34] bg-[#0A0C10] px-2 font-mono text-[11px] font-medium text-zinc-200 transition hover:border-[#3A4152] hover:bg-[#191D26] active:scale-[0.97]"
              >
                {nav.label}
              </button>
            ))}
          </div>

          {/* Expandable Row 4: F1-F12 */}
          {showFunctionKeys && (
            <div className="grid grid-cols-6 gap-1 border-t border-[#1F2430] pt-2">
              {FUNCTION_KEYS.map((fnKey) => (
                <button
                  key={fnKey.code}
                  type="button"
                  onClick={() => sendKeyWithLatched(fnKey)}
                  className="flex h-8 items-center justify-center rounded-md border border-[#262A34] bg-[#0A0C10] font-mono text-[11px] font-medium text-zinc-200 transition hover:border-[#3B82F6]/60 hover:bg-[#191D26] active:scale-[0.97]"
                >
                  {fnKey.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
