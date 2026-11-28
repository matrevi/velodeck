import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  CornerDownLeft,
  Loader2,
  RefreshCw,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import type { RemoteClient, TerminalEvent } from "../transport/RemoteClient";

export interface RemoteTerminalSheetProps {
  client: RemoteClient;
  terminalReady: boolean;
  deviceName: string;
  disabled?: boolean;
  disabledReason?: string;
  isActiveTab?: boolean;
  onShowToast?: (level: "info" | "warn" | "error", text: string) => void;
  onClose: () => void;
}

interface AnsiStyle {
  color: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

interface StyledSpan {
  text: string;
  style: AnsiStyle;
}

interface TerminalLine {
  id: number;
  spans: StyledSpan[];
  plain: string;
}

const MAX_TERMINAL_LINES = 2000;
const MAX_PENDING_ESCAPE_LEN = 512;

const EMPTY_STYLE: AnsiStyle = {
  color: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
};

const ANSI_STANDARD_COLORS: Record<number, string> = {
  30: "#6B7280",
  31: "#F87171",
  32: "#4ADE80",
  33: "#FBBF24",
  34: "#60A5FA",
  35: "#C084FC",
  36: "#22D3EE",
  37: "#E5E7EB",
  90: "#9CA3AF",
  91: "#FCA5A5",
  92: "#86EFAC",
  93: "#FDE68A",
  94: "#93C5FD",
  95: "#D8B4FE",
  96: "#67E8F9",
  97: "#FFFFFF",
};

function ansi256ToCss(idx: number): string {
  if (idx < 0 || idx > 255) return "#E5E7EB";
  const basic16 = [
    "#52525B",
    "#EF4444",
    "#22C55E",
    "#F59E0B",
    "#3B82F6",
    "#A855F7",
    "#06B6D4",
    "#E4E4E7",
    "#71717A",
    "#F87171",
    "#4ADE80",
    "#FBBF24",
    "#60A5FA",
    "#C084FC",
    "#22D3EE",
    "#FFFFFF",
  ];
  if (idx < 16) return basic16[idx] ?? "#E5E7EB";
  if (idx >= 232) {
    const shade = 8 + (idx - 232) * 10;
    return `rgb(${shade}, ${shade}, ${shade})`;
  }
  const n = idx - 16;
  const r = Math.floor(n / 36);
  const g = Math.floor((n % 36) / 6);
  const b = n % 6;
  const step = (v: number) => (v === 0 ? 0 : 55 + v * 40);
  return `rgb(${step(r)}, ${step(g)}, ${step(b)})`;
}

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return (
    a.color === b.color &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline
  );
}

function applySgrCodes(current: AnsiStyle, rawParams: string): AnsiStyle {
  const next: AnsiStyle = { ...current };
  const parts = rawParams
    .split(";")
    .map((p) => (p === "" ? 0 : Number.parseInt(p, 10)))
    .filter((n) => Number.isFinite(n));
  if (parts.length === 0) {
    return { ...EMPTY_STYLE };
  }

  for (let i = 0; i < parts.length; i += 1) {
    const code = parts[i]!;
    if (code === 0) {
      next.color = null;
      next.bold = false;
      next.dim = false;
      next.italic = false;
      next.underline = false;
    } else if (code === 1) {
      next.bold = true;
    } else if (code === 2) {
      next.dim = true;
    } else if (code === 3) {
      next.italic = true;
    } else if (code === 4) {
      next.underline = true;
    } else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) {
      next.italic = false;
    } else if (code === 24) {
      next.underline = false;
    } else if (code === 39) {
      next.color = null;
    } else if (ANSI_STANDARD_COLORS[code]) {
      next.color = ANSI_STANDARD_COLORS[code]!;
    } else if (code === 38) {
      const mode = parts[i + 1];
      if (mode === 5 && i + 2 < parts.length) {
        next.color = ansi256ToCss(parts[i + 2]!);
        i += 2;
      } else if (mode === 2 && i + 4 < parts.length) {
        const r = Math.max(0, Math.min(255, parts[i + 2]!));
        const g = Math.max(0, Math.min(255, parts[i + 3]!));
        const b = Math.max(0, Math.min(255, parts[i + 4]!));
        next.color = `rgb(${r}, ${g}, ${b})`;
        i += 4;
      }
    } else if (code === 48 || code === 58) {
      const mode = parts[i + 1];
      if (mode === 5 && i + 2 < parts.length) {
        i += 2;
      } else if (mode === 2 && i + 4 < parts.length) {
        i += 4;
      }
    }
  }
  return next;
}

class TerminalBuffer {
  private lines: TerminalLine[] = [];
  private nextLineId = 1;
  private currentStyle: AnsiStyle = { ...EMPTY_STYLE };
  private pendingEscape = "";
  private lineOverwritable = false;

  constructor() {
    this.lines = [{ id: this.nextLineId++, spans: [], plain: "" }];
  }

  public clear(): TerminalLine[] {
    this.lines = [{ id: this.nextLineId++, spans: [], plain: "" }];
    this.currentStyle = { ...EMPTY_STYLE };
    this.pendingEscape = "";
    this.lineOverwritable = false;
    return this.getSnapshot();
  }

  public getSnapshot(): TerminalLine[] {
    return this.lines.map((line) => ({
      id: line.id,
      plain: line.plain,
      spans: line.spans.map((s) => ({ text: s.text, style: { ...s.style } })),
    }));
  }

  public getPlainText(): string {
    return this.lines.map((l) => l.plain).join("\n");
  }

  public appendText(chunk: string): void {
    if (!chunk) return;
    const text = this.pendingEscape + chunk;
    this.pendingEscape = "";

    let i = 0;
    const len = text.length;
    while (i < len) {
      const ch = text[i]!;

      // Escape sequence (CSI / OSC / VT100 charset / single-char)
      if (ch === "\x1b") {
        if (i + 1 >= len) {
          this.pendingEscape = text.slice(i);
          break;
        }
        const nextCh = text[i + 1]!;
        if (nextCh === "[") {
          // CSI: \x1b[ params (0x20..0x3F) finalByte (0x40..0x7E)
          let j = i + 2;
          let found = false;
          let aborted = false;
          while (j < len) {
            const code = text.charCodeAt(j);
            if (code >= 0x40 && code <= 0x7e) {
              found = true;
              break;
            }
            if (code < 0x20 || code > 0x3f || j - i >= MAX_PENDING_ESCAPE_LEN) {
              aborted = true;
              break;
            }
            j += 1;
          }
          if (aborted) {
            // Abort malformed/unterminated CSI and resume at the unexpected byte
            i = j;
            continue;
          }
          if (!found) {
            if (len - i <= MAX_PENDING_ESCAPE_LEN) {
              this.pendingEscape = text.slice(i);
              break;
            }
            i += 2;
            continue;
          }
          const finalByte = text[j]!;
          const params = text.slice(i + 2, j);
          if (finalByte === "m") {
            this.currentStyle = applySgrCodes(this.currentStyle, params);
          } else if (finalByte === "J" && (params === "2" || params === "3")) {
            this.lines = [{ id: this.nextLineId++, spans: [], plain: "" }];
            this.lineOverwritable = false;
          } else if (finalByte === "K") {
            if (
              params === "2" ||
              params === "1" ||
              ((params === "" || params === "0") && this.lineOverwritable)
            ) {
              this.resetCurrentLine();
              this.lineOverwritable = false;
            }
          }
          i = j + 1;
          continue;
        }
        if (nextCh === "]") {
          // OSC: ends with BEL (\x07) or ST (\x1b\\)
          let j = i + 2;
          let found = false;
          let aborted = false;
          while (j < len) {
            if (text[j] === "\x07") {
              j += 1;
              found = true;
              break;
            }
            if (text[j] === "\x1b" && j + 1 < len && text[j + 1] === "\\") {
              j += 2;
              found = true;
              break;
            }
            if (j - i >= MAX_PENDING_ESCAPE_LEN) {
              aborted = true;
              break;
            }
            j += 1;
          }
          if (aborted) {
            i = j;
            continue;
          }
          if (!found) {
            if (len - i <= MAX_PENDING_ESCAPE_LEN) {
              this.pendingEscape = text.slice(i);
              break;
            }
            i = len;
            break;
          }
          i = j;
          continue;
        }
        // 3-byte VT100 charset designation sequences (e.g. \x1b(B, \x1b)0)
        if (nextCh === "(" || nextCh === ")" || nextCh === "*" || nextCh === "+") {
          if (i + 2 >= len) {
            this.pendingEscape = text.slice(i);
            break;
          }
          i += 3;
          continue;
        }
        // Skip 2-byte escape
        i += 2;
        continue;
      }

      if (ch === "\r") {
        if (i + 1 < len && text[i + 1] === "\n") {
          this.pushNewLine();
          i += 2;
          continue;
        }
        this.lineOverwritable = true;
        i += 1;
        continue;
      }

      if (ch === "\n") {
        this.pushNewLine();
        i += 1;
        continue;
      }

      if (ch === "\b") {
        this.backspaceChar();
        i += 1;
        continue;
      }

      // Skip other non-printable control chars except tab
      const code = ch.charCodeAt(0);
      if (code < 0x20 && ch !== "\t") {
        i += 1;
        continue;
      }

      if (this.lineOverwritable) {
        this.resetCurrentLine();
        this.lineOverwritable = false;
      }

      // Preserve UTF-16 surrogate pairs (emoji / supplementary CJK) intact
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
        const nextCode = text.charCodeAt(i + 1);
        if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
          this.appendChar(text.slice(i, i + 2));
          i += 2;
          continue;
        }
      }

      this.appendChar(ch === "\t" ? "    " : ch);
      i += 1;
    }
  }

  private currentLine(): TerminalLine {
    if (this.lines.length === 0) {
      this.lines.push({ id: this.nextLineId++, spans: [], plain: "" });
    }
    return this.lines[this.lines.length - 1]!;
  }

  private resetCurrentLine(): void {
    const line = this.currentLine();
    line.spans = [];
    line.plain = "";
  }

  private pushNewLine(): void {
    this.lineOverwritable = false;
    this.lines.push({ id: this.nextLineId++, spans: [], plain: "" });
    if (this.lines.length > MAX_TERMINAL_LINES) {
      this.lines.splice(0, this.lines.length - MAX_TERMINAL_LINES);
    }
  }

  private backspaceChar(): void {
    const line = this.currentLine();
    if (line.plain.length === 0) return;
    line.plain = Array.from(line.plain).slice(0, -1).join("");
    while (line.spans.length > 0) {
      const last = line.spans[line.spans.length - 1]!;
      const chars = Array.from(last.text);
      if (chars.length > 1) {
        last.text = chars.slice(0, -1).join("");
        break;
      }
      line.spans.pop();
      if (chars.length === 1) break;
    }
  }

  private appendChar(str: string): void {
    const line = this.currentLine();
    line.plain += str;
    const last = line.spans[line.spans.length - 1];
    if (last && sameStyle(last.style, this.currentStyle)) {
      last.text += str;
    } else {
      line.spans.push({ text: str, style: { ...this.currentStyle } });
    }
  }
}

export function RemoteTerminalSheet({
  client,
  terminalReady,
  deviceName,
  disabled = false,
  disabledReason,
  isActiveTab = true,
  onShowToast,
  onClose,
}: RemoteTerminalSheetProps) {
  const bufferRef = useRef<TerminalBuffer>(new TerminalBuffer());
  const outputRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const termIdRef = useRef<string | null>(null);
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef<number>(-1);
  const isActiveTabRef = useRef(isActiveTab);
  isActiveTabRef.current = isActiveTab;
  const isComposingRef = useRef(false);
  const flushRafRef = useRef<number | null>(null);
  const focusTimerRef = useRef<number | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  const [lines, setLines] = useState<TerminalLine[]>(() =>
    bufferRef.current.getSnapshot(),
  );
  const [shellName, setShellName] = useState<string>("");
  const [cwd, setCwd] = useState<string>("");
  const [status, setStatus] = useState<
    "connecting" | "ready" | "exited" | "error" | "unavailable"
  >(() => (disabled ? "unavailable" : terminalReady ? "connecting" : "unavailable"));
  const [errorText, setErrorText] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [commandDraft, setCommandDraft] = useState("");
  const [rawInputDraft, setRawInputDraft] = useState("");
  const [rawKeyMode, setRawKeyMode] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);

  const scheduleFocusInput = useCallback((delayMs: number) => {
    if (focusTimerRef.current !== null) {
      window.clearTimeout(focusTimerRef.current);
    }
    focusTimerRef.current = window.setTimeout(() => {
      focusTimerRef.current = null;
      if (isActiveTabRef.current) {
        inputRef.current?.focus();
      }
    }, delayMs);
  }, []);

  const scheduleFlushLines = useCallback(() => {
    if (flushRafRef.current !== null) return;
    flushRafRef.current = window.requestAnimationFrame(() => {
      flushRafRef.current = null;
      setLines(bufferRef.current.getSnapshot());
    });
  }, []);

  const clearTerminalBuffer = useCallback(() => {
    if (flushRafRef.current !== null) {
      window.cancelAnimationFrame(flushRafRef.current);
      flushRafRef.current = null;
    }
    setLines(bufferRef.current.clear());
  }, []);

  useEffect(() => {
    return () => {
      if (flushRafRef.current !== null) {
        window.cancelAnimationFrame(flushRafRef.current);
        flushRafRef.current = null;
      }
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
        focusTimerRef.current = null;
      }
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    };
  }, []);

  const estimateTerminalSize = useCallback((): { cols: number; rows: number } => {
    const el = outputRef.current;
    if (!el) return { cols: 100, rows: 28 };
    const rect = el.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return { cols: 100, rows: 28 };
    const cols = Math.max(40, Math.min(240, Math.floor((rect.width - 24) / 7.4)));
    const rows = Math.max(10, Math.min(80, Math.floor((rect.height - 16) / 18)));
    return { cols, rows };
  }, []);

  const startSession = useCallback(() => {
    if (disabled || !terminalReady) {
      setStatus("unavailable");
      return;
    }
    if (termIdRef.current) {
      client.closeTerminal(termIdRef.current);
      termIdRef.current = null;
    }
    setErrorText(null);
    setExitCode(null);
    setStatus("connecting");
    const { cols, rows } = estimateTerminalSize();
    const nextId = client.openTerminal(cols, rows);
    termIdRef.current = nextId;
  }, [client, disabled, terminalReady, estimateTerminalSize]);

  // Open terminal once DataChannel is ready & close cleanly on unmount
  useEffect(() => {
    if (disabled) {
      setStatus("unavailable");
      return;
    }
    if (!terminalReady) {
      setStatus("unavailable");
      return;
    }
    startSession();
    return () => {
      if (termIdRef.current) {
        client.closeTerminal(termIdRef.current);
        termIdRef.current = null;
      }
    };
  }, [client, disabled, terminalReady, startSession]);

  // Subscribe to remote terminal events
  useEffect(() => {
    return client.onTerminalEvent((ev: TerminalEvent) => {
      if (!termIdRef.current || (ev.termId && ev.termId !== termIdRef.current)) {
        return;
      }
      if (ev.type === "term_ready") {
        setShellName(ev.shell || "shell");
        setCwd(ev.cwd || "");
        setStatus("ready");
        setErrorText(null);
        scheduleFocusInput(30);
      } else if (ev.type === "term_data") {
        bufferRef.current.appendText(ev.data);
        scheduleFlushLines();
      } else if (ev.type === "term_exit") {
        setStatus("exited");
        setExitCode(ev.exitCode);
        bufferRef.current.appendText(
          `\r\n\x1b[90m[远程终端进程已退出，退出码 ${ev.exitCode}]\x1b[0m\r\n`,
        );
        scheduleFlushLines();
      } else if (ev.type === "term_error") {
        setErrorText(ev.error);
        setStatus((prev) => (prev === "ready" ? prev : "error"));
      }
    });
  }, [client, scheduleFlushLines, scheduleFocusInput]);

  // Auto-scroll to bottom when output updates or tab becomes visible again
  useEffect(() => {
    if (!isActiveTab) return;
    const el = outputRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, isActiveTab]);

  // Sync terminal dimensions on container resize (ignore hidden 0x0 size when tab is inactive)
  useEffect(() => {
    const el = outputRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let timer: number | null = null;
    const observer = new ResizeObserver(() => {
      if (!isActiveTabRef.current) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        if (!isActiveTabRef.current) return;
        const currentRect = el.getBoundingClientRect();
        if (currentRect.width < 40 || currentRect.height < 40) return;
        if (termIdRef.current && status === "ready") {
          const { cols, rows } = estimateTerminalSize();
          client.resizeTerminal(termIdRef.current, cols, rows);
        }
      }, 150);
    });
    observer.observe(el);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [client, status, estimateTerminalSize]);

  // Escape closes when active tab is focused; suspend listener when hidden in background tab
  useEffect(() => {
    if (!isActiveTab) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape" && !rawKeyMode) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [isActiveTab, onClose, rawKeyMode]);

  const sendRaw = useCallback(
    (data: string) => {
      const id = termIdRef.current;
      if (!id || !terminalReady || disabled || status !== "ready") return;
      client.sendTerminalInput(id, data);
    },
    [client, terminalReady, disabled, status],
  );

  function handleSubmitCommand(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (isComposingRef.current) return;
    const id = termIdRef.current;
    if (!id || status !== "ready") return;
    const cmd = commandDraft;
    if (cmd.trim().length > 0) {
      historyRef.current = [
        cmd,
        ...historyRef.current.filter((item) => item !== cmd),
      ].slice(0, 60);
    }
    historyIdxRef.current = -1;
    client.sendTerminalInput(id, `${cmd}\n`);
    setCommandDraft("");
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    e.stopPropagation();

    if (e.nativeEvent.isComposing || e.keyCode === 229 || isComposingRef.current) {
      if (e.key === "Enter") {
        e.preventDefault();
      }
      return;
    }

    if (rawKeyMode && status === "ready") {
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
        const code = e.key.toLowerCase().charCodeAt(0) - 96;
        if (code >= 1 && code <= 26) {
          e.preventDefault();
          sendRaw(String.fromCharCode(code));
          return;
        }
      }
      const keyMap: Record<string, string> = {
        Enter: "\r",
        Backspace: "\x7f",
        Tab: "\t",
        Escape: "\x1b",
        ArrowUp: "\x1b[A",
        ArrowDown: "\x1b[B",
        ArrowRight: "\x1b[C",
        ArrowLeft: "\x1b[D",
      };
      if (keyMap[e.key]) {
        e.preventDefault();
        sendRaw(keyMap[e.key]!);
        return;
      }
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        sendRaw(e.key);
        return;
      }
      return;
    }

    // Standard command-line mode with terminal shortcuts
    if (e.ctrlKey && !e.metaKey && !e.altKey) {
      const lower = e.key.toLowerCase();
      if (lower === "c" && !window.getSelection()?.toString()) {
        e.preventDefault();
        sendRaw("\x03");
        return;
      }
      if (lower === "d") {
        e.preventDefault();
        sendRaw("\x04");
        return;
      }
      if (lower === "l") {
        e.preventDefault();
        clearTerminalBuffer();
        return;
      }
    }

    if (e.key === "Tab") {
      e.preventDefault();
      if (commandDraft) {
        sendRaw(`${commandDraft}\t`);
        setCommandDraft("");
      } else {
        sendRaw("\t");
      }
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (historyRef.current.length > 0) {
        const nextIdx = Math.min(
          historyRef.current.length - 1,
          historyIdxRef.current + 1,
        );
        historyIdxRef.current = nextIdx;
        setCommandDraft(historyRef.current[nextIdx] ?? "");
      } else {
        sendRaw("\x1b[A");
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIdxRef.current > 0) {
        const nextIdx = historyIdxRef.current - 1;
        historyIdxRef.current = nextIdx;
        setCommandDraft(historyRef.current[nextIdx] ?? "");
      } else if (historyIdxRef.current === 0) {
        historyIdxRef.current = -1;
        setCommandDraft("");
      } else {
        sendRaw("\x1b[B");
      }
    }
  }

  async function handleCopyOutput() {
    const plain = bufferRef.current.getPlainText().trim();
    if (!plain) return;
    try {
      await navigator.clipboard.writeText(plain);
      setCopiedOutput(true);
      onShowToast?.("info", "已复制终端输出到剪贴板");
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = null;
        setCopiedOutput(false);
      }, 1400);
    } catch {
      onShowToast?.("warn", "复制终端输出失败");
    }
  }

  const shellBasename = useMemo(() => {
    if (!shellName) return "";
    const parts = shellName.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] || shellName;
  }, [shellName]);

  const statusMeta = (() => {
    if (disabled) {
      return {
        label: "权限已禁止",
        dot: "bg-rose-400",
        text: "text-rose-300",
      };
    }
    switch (status) {
      case "ready":
        return { label: "已连通", dot: "bg-emerald-400", text: "text-emerald-300" };
      case "connecting":
        return { label: "启动中", dot: "bg-blue-400", text: "text-blue-300" };
      case "exited":
        return {
          label: `已退出 (${exitCode ?? -1})`,
          dot: "bg-amber-400",
          text: "text-amber-300",
        };
      case "error":
        return { label: "异常", dot: "bg-rose-400", text: "text-rose-300" };
      default:
        return { label: "通道未就绪", dot: "bg-zinc-500", text: "text-zinc-400" };
    }
  })();

  return (
    <div
      className={`${
        isActiveTab ? "flex" : "hidden"
      } fixed inset-0 z-[60] items-end justify-center bg-black/75 sm:items-center sm:p-4`}
      onClick={onClose}
      onKeyDown={(e) => e.stopPropagation()}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="远程终端"
        onClick={(e) => e.stopPropagation()}
        className="animate-sheet-up safe-bottom flex h-[78dvh] max-h-[680px] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-[#2C313D] bg-[#111318] text-white shadow-[0_24px_48px_rgba(0,0,0,0.82)] sm:rounded-2xl"
      >
        {/* Terminal Header Chrome */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#262A34] bg-[#111318] px-4 py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#2C313D] bg-[#0B0D12] text-[#60A5FA]">
              <Terminal className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate text-xs font-semibold text-white">
                  远程终端 · {deviceName || "远端电脑"}
                </h3>
                <span
                  className={`inline-flex items-center gap-1 rounded border border-[#262A34] bg-[#0B0D12] px-1.5 py-0.5 text-[10px] font-medium ${statusMeta.text}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${statusMeta.dot}`} />
                  {statusMeta.label}
                </span>
                {shellBasename && (
                  <span className="rounded border border-[#262A34] bg-[#191D26] px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                    {shellBasename}
                  </span>
                )}
              </div>
              {cwd && (
                <p
                  className="mt-0.5 truncate font-mono text-[10px] text-zinc-400"
                  title={cwd}
                >
                  {cwd}
                </p>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {(status === "exited" || status === "error") && !disabled && terminalReady && (
              <button
                type="button"
                onClick={startSession}
                className="btn-primary inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium"
              >
                <RefreshCw className="h-3 w-3" />
                重新打开
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭远程终端"
              className="flex h-7 w-7 items-center justify-center rounded-md bg-white/10 text-zinc-300 hover:bg-white/15 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Quick-Key Hardware Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-[#232732] bg-[#141821] px-3 py-1.5">
          <div className="flex flex-wrap items-center gap-1">
            <TerminalQuickKey
              label="Ctrl+C"
              title="发送中断信号 (SIGINT)"
              disabled={status !== "ready"}
              onClick={() => sendRaw("\x03")}
            />
            <TerminalQuickKey
              label="Ctrl+D"
              title="发送 EOF"
              disabled={status !== "ready"}
              onClick={() => sendRaw("\x04")}
            />
            <TerminalQuickKey
              label="Tab"
              title="发送 Tab 补全"
              disabled={status !== "ready"}
              onClick={() => sendRaw("\t")}
            />
            <TerminalQuickKey
              label="↑"
              icon={<ArrowUp className="h-3 w-3" />}
              title="上一条历史"
              disabled={status !== "ready"}
              onClick={() => sendRaw("\x1b[A")}
            />
            <TerminalQuickKey
              label="↓"
              icon={<ArrowDown className="h-3 w-3" />}
              title="下一条历史"
              disabled={status !== "ready"}
              onClick={() => sendRaw("\x1b[B")}
            />
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={status !== "ready"}
              onClick={() => {
                isComposingRef.current = false;
                setRawInputDraft("");
                setRawKeyMode((prev) => !prev);
                scheduleFocusInput(20);
              }}
              title="切换命令行输入模式与逐键直通模式（适合 vim/top 等全屏交互）"
              className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition disabled:opacity-40 ${
                rawKeyMode
                  ? "border-[#2563EB] bg-[#2563EB] text-white"
                  : "border-[#262A34] bg-[#191D26] text-zinc-300 hover:bg-[#232836]"
              }`}
            >
              <span>{rawKeyMode ? "逐键直通中" : "逐键直通"}</span>
            </button>
            <button
              type="button"
              onClick={clearTerminalBuffer}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-[#262A34] bg-[#191D26] px-2 text-[11px] font-medium text-zinc-300 transition hover:bg-[#232836] hover:text-white"
              title="清空当前终端输出缓冲区"
            >
              <Trash2 className="h-3 w-3" />
              <span>清屏</span>
            </button>
            <button
              type="button"
              onClick={() => void handleCopyOutput()}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-[#262A34] bg-[#191D26] px-2 text-[11px] font-medium text-zinc-300 transition hover:bg-[#232836] hover:text-white"
              title="复制全部终端输出文本"
            >
              {copiedOutput ? (
                <>
                  <Check className="h-3 w-3 text-emerald-400" />
                  <span className="text-emerald-300">已复制</span>
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" />
                  <span>复制输出</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Status / Permission / Error Notice */}
        {(disabled || !terminalReady || errorText) && (
          <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <span className="min-w-0 flex-1 leading-relaxed">
              {disabled
                ? disabledReason || "被控端当前会话权限未开放「远程终端」访问。"
                : errorText
                  ? errorText
                  : "WebRTC 终端通道尚未就绪，请确保当前处于 WebRTC 连接模式且远端桌面端已升级。"}
            </span>
          </div>
        )}

        {/* Terminal Scrollback Output Canvas (#0B0D12) */}
        <div
          ref={outputRef}
          onClick={() => {
            if (!window.getSelection()?.toString()) {
              inputRef.current?.focus();
            }
          }}
          className="min-h-0 flex-1 overflow-y-auto bg-[#0B0D12] px-4 py-3 font-mono text-xs leading-[1.55] text-zinc-200 select-text"
        >
          {status === "connecting" && lines.length <= 1 && !lines[0]?.plain ? (
            <div className="flex h-full items-center justify-center gap-2 text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin text-[#60A5FA]" />
              <span>正在远端电脑拉起交互式终端...</span>
            </div>
          ) : (
            <pre className="m-0 whitespace-pre-wrap break-words font-mono text-xs leading-[1.55]">
              {lines.map((line) => (
                <div key={line.id} className="min-h-[1.2em]">
                  {line.spans.length === 0 ? (
                    "\u00A0"
                  ) : (
                    line.spans.map((span, idx) => (
                      <span
                        key={idx}
                        style={{
                          color: span.style.color ?? undefined,
                          fontWeight: span.style.bold ? 600 : undefined,
                          opacity: span.style.dim ? 0.65 : undefined,
                          fontStyle: span.style.italic ? "italic" : undefined,
                          textDecoration: span.style.underline
                            ? "underline"
                            : undefined,
                        }}
                      >
                        {span.text}
                      </span>
                    ))
                  )}
                </div>
              ))}
            </pre>
          )}
        </div>

        {/* Interactive Command Input Footer */}
        <form
          onSubmit={handleSubmitCommand}
          className="flex items-center gap-2 border-t border-[#262A34] bg-[#111318] px-3 py-2.5"
        >
          <span className="shrink-0 font-mono text-xs font-semibold text-[#60A5FA]">
            {rawKeyMode ? "RAW>" : "$"}
          </span>
          <input
            ref={inputRef}
            type="text"
            disabled={status !== "ready"}
            value={rawKeyMode ? rawInputDraft : commandDraft}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              isComposingRef.current = false;
              if (rawKeyMode && status === "ready") {
                const committed = e.data || e.currentTarget.value;
                if (committed) {
                  sendRaw(committed);
                }
                setRawInputDraft("");
              }
            }}
            onChange={(e) => {
              if (!rawKeyMode) {
                setCommandDraft(e.target.value);
              } else if (isComposingRef.current) {
                setRawInputDraft(e.target.value);
              } else {
                setRawInputDraft("");
              }
            }}
            onKeyDown={handleInputKeyDown}
            onPaste={(e) => {
              if (rawKeyMode && status === "ready") {
                const pasted = e.clipboardData?.getData("text/plain") ?? "";
                if (pasted) {
                  e.preventDefault();
                  sendRaw(pasted);
                }
              }
            }}
            placeholder={
              status !== "ready"
                ? "等待终端就绪..."
                : rawKeyMode
                  ? "逐键直通模式：按键将实时直传远端 PTY..."
                  : "输入命令后按 Enter 执行（支持 ↑/↓ 历史、Tab 补全、Ctrl+C）..."
            }
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="h-9 min-w-0 flex-1 rounded-md border border-[#2C313D] bg-[#0B0D12] px-2.5 font-mono text-xs text-white placeholder:text-zinc-500 focus:border-[#2563EB] focus:outline-none disabled:opacity-50"
          />
          {!rawKeyMode && (
            <button
              type="submit"
              disabled={status !== "ready"}
              className="btn-primary inline-flex h-9 shrink-0 items-center gap-1 rounded-md px-3 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-45"
            >
              <CornerDownLeft className="h-3.5 w-3.5" />
              <span>执行</span>
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

function TerminalQuickKey({
  label,
  icon,
  title,
  disabled,
  onClick,
}: {
  label: string;
  icon?: React.ReactNode;
  title: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-label={title}
      className="inline-flex h-7 min-w-[2rem] items-center justify-center gap-1 rounded-md border border-[#262A34] bg-[#0B0D12] px-2 font-mono text-[11px] font-medium text-zinc-200 transition hover:border-[#3F4656] hover:bg-[#191D26] hover:text-white disabled:opacity-40"
    >
      {icon ?? label}
    </button>
  );
}
