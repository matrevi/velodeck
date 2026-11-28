import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { InputPlatform } from "./inputInjector";

export const MAX_CONCURRENT_TERMINALS = 4;
export const DEFAULT_TERMINAL_COLS = 100;
export const DEFAULT_TERMINAL_ROWS = 30;
export const MIN_TERMINAL_COLS = 20;
export const MAX_TERMINAL_COLS = 300;
export const MIN_TERMINAL_ROWS = 5;
export const MAX_TERMINAL_ROWS = 120;

const MAX_WRITE_BYTES = 64 * 1024;
const SCRIPT_FALLBACK_WINDOW_MS = 1000;

export interface TerminalSize {
  cols: number;
  rows: number;
}

export type RemoteTerminalEvent =
  | { type: "term_ready"; termId: string; shell: string; cwd: string }
  | { type: "term_data"; termId: string; data: string }
  | { type: "term_exit"; termId: string; exitCode: number }
  | { type: "term_error"; termId: string; error: string };

export interface RemoteTerminalManagerOptions {
  platform?: InputPlatform;
  onEvent: (event: RemoteTerminalEvent) => void;
}

interface ActiveTerminalSession {
  termId: string;
  child: ChildProcessWithoutNullStreams;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  usingScriptWrapper: boolean;
  detached: boolean;
  startedAt: number;
  pendingWrites: string[];
  exited: boolean;
}

/**
 * Clamps terminal dimensions to `20..300` cols × `5..120` rows (default `100×30`).
 */
export function sanitizeTerminalSize(
  cols?: number,
  rows?: number,
): TerminalSize {
  const safeCols =
    typeof cols === "number" && Number.isFinite(cols)
      ? Math.max(MIN_TERMINAL_COLS, Math.min(MAX_TERMINAL_COLS, Math.round(cols)))
      : DEFAULT_TERMINAL_COLS;
  const safeRows =
    typeof rows === "number" && Number.isFinite(rows)
      ? Math.max(MIN_TERMINAL_ROWS, Math.min(MAX_TERMINAL_ROWS, Math.round(rows)))
      : DEFAULT_TERMINAL_ROWS;
  return { cols: safeCols, rows: safeRows };
}

function sanitizeTermId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
}

function resolveStartCwd(requestedCwd?: string): string {
  const home = os.homedir();
  if (
    typeof requestedCwd === "string" &&
    requestedCwd.trim().length > 0 &&
    !requestedCwd.includes("\0")
  ) {
    try {
      const resolved = path.resolve(requestedCwd.trim());
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        return resolved;
      }
    } catch {
      // Fall back to home directory
    }
  }
  return home;
}

function resolvePosixShell(platform: InputPlatform): string {
  const envShell = (process.env.SHELL ?? "").trim();
  if (
    (envShell === "/bin/zsh" || envShell === "/bin/bash") &&
    fs.existsSync(envShell)
  ) {
    return envShell;
  }
  const candidates =
    platform === "darwin"
      ? ["/bin/zsh", "/bin/bash", "/bin/sh"]
      : ["/bin/bash", "/bin/zsh", "/bin/sh"];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "/bin/sh";
}

function buildSpawnSpec(
  platform: InputPlatform,
  size: TerminalSize,
  preferScriptWrapper: boolean,
): {
  command: string;
  args: string[];
  shell: string;
  env: NodeJS.ProcessEnv;
  usingScriptWrapper: boolean;
} {
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    COLUMNS: String(size.cols),
    LINES: String(size.rows),
    LANG: process.env.LANG || "en_US.UTF-8",
  };

  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoExit",
        "-Command",
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
      ],
      shell: "powershell.exe",
      env: baseEnv,
      usingScriptWrapper: false,
    };
  }

  const shell = resolvePosixShell(platform);
  const scriptBin = "/usr/bin/script";
  if (preferScriptWrapper && fs.existsSync(scriptBin)) {
    if (platform === "darwin") {
      return {
        command: scriptBin,
        args: ["-q", "/dev/null", shell, "-i"],
        shell,
        env: baseEnv,
        usingScriptWrapper: true,
      };
    }
    return {
      command: scriptBin,
      args: ["-q", "-c", `${shell} -i`, "/dev/null"],
      shell,
      env: baseEnv,
      usingScriptWrapper: true,
    };
  }

  return {
    command: shell,
    args: ["-i"],
    shell,
    env: baseEnv,
    usingScriptWrapper: false,
  };
}

/**
 * Manages concurrent interactive PTY/shell sessions for remote terminal over WebRTC DataChannel.
 * Capped at 4 concurrent shells per session and always cleaned up on session end or app quit.
 * Automatically falls back from `/usr/bin/script` to direct `spawn(shell, ["-i"])` when
 * BSD `script` rejects non-TTY stdin pipes (e.g. Electron main process on macOS).
 */
export class RemoteTerminalManager {
  private readonly platform: InputPlatform;
  private readonly onEvent: (event: RemoteTerminalEvent) => void;
  private readonly sessions = new Map<string, ActiveTerminalSession>();

  constructor(options: RemoteTerminalManagerOptions) {
    this.platform =
      options.platform ??
      (process.platform === "darwin" || process.platform === "win32"
        ? process.platform
        : "linux");
    this.onEvent = options.onEvent;
  }

  public get activeCount(): number {
    return this.sessions.size;
  }

  public hasSession(termId: string): boolean {
    return this.sessions.has(sanitizeTermId(termId));
  }

  public open(
    rawTermId: string,
    cols?: number,
    rows?: number,
    requestedCwd?: string,
  ): boolean {
    const termId = sanitizeTermId(rawTermId);
    if (!termId) {
      this.onEvent({
        type: "term_error",
        termId: "",
        error: "缺少有效的终端会话 ID",
      });
      return false;
    }

    if (this.sessions.has(termId)) {
      this.close(termId);
    }

    if (this.sessions.size >= MAX_CONCURRENT_TERMINALS) {
      this.onEvent({
        type: "term_error",
        termId,
        error: `并发终端数量已达上限 (${MAX_CONCURRENT_TERMINALS})`,
      });
      return false;
    }

    const size = sanitizeTerminalSize(cols, rows);
    const cwd = resolveStartCwd(requestedCwd);
    const spec = buildSpawnSpec(this.platform, size, true);
    const detached = this.platform !== "win32";

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(spec.command, spec.args, {
        cwd,
        env: spec.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached,
        windowsHide: true,
      });
    } catch (error) {
      this.onEvent({
        type: "term_error",
        termId,
        error:
          error instanceof Error
            ? error.message
            : "启动远程终端进程失败",
      });
      return false;
    }

    const session: ActiveTerminalSession = {
      termId,
      child,
      shell: spec.shell,
      cwd,
      cols: size.cols,
      rows: size.rows,
      env: spec.env,
      stdoutDecoder: new StringDecoder("utf8"),
      stderrDecoder: new StringDecoder("utf8"),
      usingScriptWrapper: spec.usingScriptWrapper,
      detached,
      startedAt: Date.now(),
      pendingWrites: [],
      exited: false,
    };
    this.sessions.set(termId, session);
    this.attachChildListeners(session, child);

    this.onEvent({
      type: "term_ready",
      termId,
      shell: spec.shell,
      cwd,
    });
    return true;
  }

  private attachChildListeners(
    session: ActiveTerminalSession,
    child: ChildProcessWithoutNullStreams,
  ): void {
    const termId = session.termId;
    let sawScriptTtyError = false;

    const emitExitOnce = (exitCode: number): void => {
      if (session.exited || session.child !== child) return;
      session.exited = true;
      if (this.sessions.get(termId) === session) {
        this.sessions.delete(termId);
      }
      const tailOut = session.stdoutDecoder.end();
      if (tailOut) {
        this.onEvent({ type: "term_data", termId, data: tailOut });
      }
      const tailErr = session.stderrDecoder.end();
      if (tailErr) {
        this.onEvent({ type: "term_data", termId, data: tailErr });
      }
      this.onEvent({ type: "term_exit", termId, exitCode });
    };

    const tryFallbackToDirectShell = (): boolean => {
      if (
        session.exited ||
        session.child !== child ||
        !session.usingScriptWrapper ||
        this.sessions.get(termId) !== session
      ) {
        return false;
      }

      session.usingScriptWrapper = false;
      session.stdoutDecoder = new StringDecoder("utf8");
      session.stderrDecoder = new StringDecoder("utf8");

      let fallbackChild: ChildProcessWithoutNullStreams;
      try {
        fallbackChild = spawn(session.shell, ["-i"], {
          cwd: session.cwd,
          env: session.env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: session.detached,
          windowsHide: true,
        });
      } catch {
        return false;
      }

      session.child = fallbackChild;
      session.startedAt = Date.now();
      this.attachChildListeners(session, fallbackChild);

      // Replay any input written during the brief script-wrapper startup window
      const queued = session.pendingWrites.splice(0, session.pendingWrites.length);
      for (const chunk of queued) {
        this.writeToSession(session, chunk);
      }
      return true;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (session.exited || session.child !== child) return;
      if (session.usingScriptWrapper && session.pendingWrites.length > 0) {
        session.pendingWrites.length = 0;
      }
      const text = session.stdoutDecoder.write(chunk);
      if (text) {
        this.onEvent({ type: "term_data", termId, data: text });
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (session.exited || session.child !== child) return;
      const text = session.stderrDecoder.write(chunk);
      if (!text) return;
      if (
        session.usingScriptWrapper &&
        Date.now() - session.startedAt < SCRIPT_FALLBACK_WINDOW_MS &&
        /tcgetattr|ioctl|Operation not supported|not a tty/i.test(text)
      ) {
        sawScriptTtyError = true;
        return;
      }
      this.onEvent({ type: "term_data", termId, data: text });
    });

    child.stdin.on("error", () => {
      // Handled by exit/error listener
    });

    child.on("error", (err) => {
      if (session.child !== child) return;
      if (session.usingScriptWrapper && tryFallbackToDirectShell()) {
        return;
      }
      this.onEvent({
        type: "term_error",
        termId,
        error: err.message || "终端进程异常",
      });
      emitExitOnce(-1);
    });

    child.on("exit", (code) => {
      if (session.child !== child) return;
      const elapsed = Date.now() - session.startedAt;
      if (
        session.usingScriptWrapper &&
        (sawScriptTtyError || (code !== 0 && elapsed < SCRIPT_FALLBACK_WINDOW_MS))
      ) {
        if (tryFallbackToDirectShell()) {
          return;
        }
      }
      emitExitOnce(typeof code === "number" ? code : -1);
    });
  }

  private writeToSession(session: ActiveTerminalSession, rawData: string): boolean {
    if (session.exited || !session.child.stdin.writable) {
      return false;
    }
    try {
      let payload =
        Buffer.byteLength(rawData, "utf8") > MAX_WRITE_BYTES
          ? rawData.slice(0, MAX_WRITE_BYTES)
          : rawData;
      // When running direct pipe shell without a PTY line discipline, translate CR -> LF
      if (!session.usingScriptWrapper && this.platform !== "win32") {
        payload = payload.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      }
      session.child.stdin.write(payload, "utf8");
      return true;
    } catch {
      return false;
    }
  }

  public write(rawTermId: string, data: string): boolean {
    const termId = sanitizeTermId(rawTermId);
    const session = this.sessions.get(termId);
    if (!session || session.exited) {
      return false;
    }
    if (typeof data !== "string" || data.length === 0) {
      return true;
    }
    if (
      session.usingScriptWrapper &&
      Date.now() - session.startedAt < SCRIPT_FALLBACK_WINDOW_MS &&
      session.pendingWrites.length < 32
    ) {
      session.pendingWrites.push(data);
    }
    return this.writeToSession(session, data);
  }

  public resize(rawTermId: string, cols?: number, rows?: number): boolean {
    const termId = sanitizeTermId(rawTermId);
    const session = this.sessions.get(termId);
    if (!session || session.exited) {
      return false;
    }
    const size = sanitizeTerminalSize(cols, rows);
    session.cols = size.cols;
    session.rows = size.rows;
    return true;
  }

  public close(rawTermId: string): void {
    const termId = sanitizeTermId(rawTermId);
    const session = this.sessions.get(termId);
    if (!session) return;
    this.sessions.delete(termId);
    this.terminateChild(session);
  }

  public closeAll(): void {
    const all = Array.from(this.sessions.values());
    this.sessions.clear();
    for (const session of all) {
      this.terminateChild(session);
    }
  }

  private terminateChild(session: ActiveTerminalSession): void {
    session.exited = true;
    const proc = session.child;
    const pid = proc.pid;
    try {
      if (proc.stdin.writable) {
        proc.stdin.end();
      }
    } catch {
      // Ignore
    }
    const sendSignal = (sig: NodeJS.Signals): void => {
      if (session.detached && typeof pid === "number" && pid > 0) {
        try {
          process.kill(-pid, sig);
          return;
        } catch {
          // Fall back to direct child kill
        }
      }
      try {
        if (proc.exitCode === null && !proc.killed) {
          proc.kill(sig);
        }
      } catch {
        // Ignore
      }
    };
    sendSignal("SIGTERM");
    const killer = setTimeout(() => {
      if (proc.exitCode === null && !proc.killed) {
        sendSignal("SIGKILL");
      }
    }, 1000);
    killer.unref?.();
  }
}
