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
const MAX_OUTPUT_CHUNK_BYTES = 14 * 1024; // Strictly <= 16 KB even with JSON framing
const PTY_FALLBACK_WINDOW_MS = 1200;

const LINUX_PYTHON_PTY_BRIDGE = [
  "import base64,errno,fcntl,json,os,pty,select,signal,struct,sys,termios,time",
  "cols=max(20,min(300,int(sys.argv[1])))",
  "rows=max(5,min(120,int(sys.argv[2])))",
  "shell=sys.argv[3]",
  "cwd=sys.argv[4] if len(sys.argv)>4 else ''",
  "master,slave=pty.openpty()",
  "fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0))",
  "pid=os.fork()",
  "if pid==0:",
  " os.close(master)",
  " os.setsid()",
  " fcntl.ioctl(slave,termios.TIOCSCTTY,0)",
  " os.dup2(slave,0);os.dup2(slave,1);os.dup2(slave,2)",
  " if slave>2: os.close(slave)",
  " if cwd:",
  "  try: os.chdir(cwd)",
  "  except Exception: pass",
  " os.execv(shell,[shell,'-i'])",
  " os._exit(127)",
  "os.close(slave)",
  "def kill_child():",
  " try: os.killpg(pid,signal.SIGHUP)",
  " except Exception: pass",
  " try: os.killpg(pid,signal.SIGTERM)",
  " except Exception: pass",
  " for _ in range(15):",
  "  try:",
  "   r,_=os.waitpid(pid,os.WNOHANG)",
  "   if r==pid: return",
  "  except ChildProcessError: return",
  "  time.sleep(0.02)",
  " try: os.killpg(pid,signal.SIGKILL)",
  " except Exception: pass",
  " try: os.waitpid(pid,0)",
  " except Exception: pass",
  "def on_sig(_s,_f): kill_child(); os._exit(0)",
  "signal.signal(signal.SIGTERM,on_sig);signal.signal(signal.SIGINT,on_sig)",
  "for fd in (master,0):",
  " fl=fcntl.fcntl(fd,fcntl.F_GETFL);fcntl.fcntl(fd,fcntl.F_SETFL,fl|os.O_NONBLOCK)",
  "buf=b'';stdin_open=True;stop=False;master_open=True",
  "while master_open and not stop:",
  " rlist=[master]+([0] if stdin_open else [])",
  " try: ready,_,_=select.select(rlist,[],[],0.2)",
  " except OSError: break",
  " if master in ready:",
  "  while True:",
  "   try: data=os.read(master,4096)",
  "   except BlockingIOError: break",
  "   except OSError: master_open=False;break",
  "   if not data: master_open=False;break",
  "   sys.stdout.write(json.dumps({'type':'data','b64':base64.b64encode(data).decode('ascii')})+'\\n');sys.stdout.flush()",
  " if stdin_open and 0 in ready:",
  "  while True:",
  "   try: chunk=os.read(0,4096)",
  "   except BlockingIOError: break",
  "   except OSError: stdin_open=False;stop=True;break",
  "   if not chunk: stdin_open=False;stop=True;break",
  "   buf+=chunk",
  "   if len(buf)>524288: buf=b''",
  "  while b'\\n' in buf:",
  "   line,buf=buf.split(b'\\n',1)",
  "   if not line.strip(): continue",
  "   try: msg=json.loads(line.decode('utf-8','ignore'))",
  "   except Exception: continue",
  "   t=msg.get('type')",
  "   if t=='data':",
  "    raw=base64.b64decode(msg.get('b64','')) if 'b64' in msg else str(msg.get('data','')).encode('utf-8')",
  "    mv=memoryview(raw);off=0",
  "    while off<len(mv):",
  "     try: off+=os.write(master,mv[off:])",
  "     except BlockingIOError: select.select([],[master],[],0.05)",
  "     except OSError: break",
  "   elif t=='resize':",
  "    nc=max(20,min(300,int(msg.get('cols',cols))));nr=max(5,min(120,int(msg.get('rows',rows))))",
  "    try: fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',nr,nc,0,0))",
  "    except Exception: pass",
  "   elif t=='close': stop=True",
  " if master_open:",
  "  try:",
  "   wp,st=os.waitpid(pid,os.WNOHANG)",
  "   if wp==pid:",
  "    master_open=False",
  "    code=(st>>8)&0xff if (st&0x7f)==0 else 128+(st&0x7f)",
  "    sys.stdout.write(json.dumps({'type':'exit','code':code})+'\\n');sys.stdout.flush();os._exit(0)",
  "  except ChildProcessError: master_open=False",
  "try: os.close(master)",
  "except Exception: pass",
  "if stop: kill_child();sys.stdout.write(json.dumps({'type':'exit','code':0})+'\\n');sys.stdout.flush();os._exit(0)",
  "code=0",
  "try:",
  " _,st=os.waitpid(pid,0)",
  " code=(st>>8)&0xff if (st&0x7f)==0 else 128+(st&0x7f)",
  "except Exception: pass",
  "sys.stdout.write(json.dumps({'type':'exit','code':code})+'\\n');sys.stdout.flush()",
].join("\n");

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
  resourcesPath?: string;
  desktopRootDir?: string;
  isPackaged?: boolean;
  onEvent: (event: RemoteTerminalEvent) => void;
}

type TerminalSpawnMode =
  | "json-pty-bridge"
  | "script-wrapper"
  | "direct-shell"
  | "win-powershell";

interface SpawnSpec {
  command: string;
  args: string[];
  shell: string;
  env: NodeJS.ProcessEnv;
  mode: TerminalSpawnMode;
  fallbackStage: number;
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
  jsonLineBuffer: string;
  mode: TerminalSpawnMode;
  fallbackStage: number;
  detached: boolean;
  startedAt: number;
  pendingWrites: string[];
  sawPtyOutput: boolean;
  exited: boolean;
}

function defaultDesktopRootDir(): string {
  if (typeof __dirname === "string" && __dirname.length > 0) {
    return path.resolve(__dirname, "..");
  }
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "native"))) {
    return cwd;
  }
  const nested = path.join(cwd, "desktop");
  if (fs.existsSync(path.join(nested, "native"))) {
    return nested;
  }
  return cwd;
}

/**
 * Truncates a string to at most `maxBytes` UTF-8 bytes without ever splitting
 * a UTF-16 surrogate pair or multi-byte character.
 */
export function truncateUtf8Safe(input: string, maxBytes: number): string {
  if (maxBytes <= 0 || input.length === 0) return "";
  if (Buffer.byteLength(input, "utf8") <= maxBytes) {
    return input;
  }
  let bytes = 0;
  let offset = 0;
  while (offset < input.length) {
    const cp = input.codePointAt(offset);
    if (cp === undefined) break;
    const charBytes =
      cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (bytes + charBytes > maxBytes) {
      break;
    }
    bytes += charBytes;
    offset += cp > 0xffff ? 2 : 1;
  }
  return input.slice(0, offset);
}

/**
 * Splits a string into UTF-8 chunks each strictly <= `maxBytes` bytes without
 * breaking surrogate pairs.
 */
export function splitUtf8Chunks(input: string, maxBytes: number): string[] {
  if (!input) return [];
  if (Buffer.byteLength(input, "utf8") <= maxBytes) {
    return [input];
  }
  const chunks: string[] = [];
  let start = 0;
  let offset = 0;
  let bytes = 0;

  while (offset < input.length) {
    const cp = input.codePointAt(offset);
    if (cp === undefined) break;
    const step = cp > 0xffff ? 2 : 1;
    const charBytes =
      cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (bytes + charBytes > maxBytes && offset > start) {
      chunks.push(input.slice(start, offset));
      start = offset;
      bytes = 0;
    }
    bytes += charBytes;
    offset += step;
  }
  if (start < input.length) {
    chunks.push(input.slice(start));
  }
  return chunks;
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

function resolveLinuxPython3(): string | null {
  for (const candidate of ["/usr/bin/python3", "/usr/local/bin/python3", "/bin/python3"]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Manages concurrent interactive PTY/shell sessions for remote terminal over WebRTC DataChannel.
 * - macOS: uses the compiled native `velodeck-input-helper-darwin --pty-bridge` (real `openpty()`,
 *   real `TIOCSWINSZ` resize, real `Ctrl+C` `SIGINT`, clean process-group teardown).
 * - Linux: prefers `python3` real PTY bridge, falling back to `script -qfc` (with `-f` flush) and direct shell.
 * - Windows: spawns `powershell.exe -NoLogo -NoProfile -Command -` with UTF-8 Input/OutputEncoding and
 *   terminates process trees via `taskkill /PID <pid> /T /F`.
 */
export class RemoteTerminalManager {
  private readonly platform: InputPlatform;
  private readonly resourcesPath: string;
  private readonly desktopRootDir: string;
  private readonly isPackaged: boolean;
  private readonly onEvent: (event: RemoteTerminalEvent) => void;
  private readonly sessions = new Map<string, ActiveTerminalSession>();

  constructor(options: RemoteTerminalManagerOptions) {
    this.platform =
      options.platform ??
      (process.platform === "darwin" || process.platform === "win32"
        ? process.platform
        : "linux");
    this.resourcesPath = options.resourcesPath ?? process.resourcesPath ?? "";
    this.desktopRootDir = options.desktopRootDir ?? defaultDesktopRootDir();
    this.isPackaged = options.isPackaged ?? false;
    this.onEvent = options.onEvent;
  }

  public get activeCount(): number {
    return this.sessions.size;
  }

  public hasSession(termId: string): boolean {
    return this.sessions.has(sanitizeTermId(termId));
  }

  public resolveDarwinPtyHelperPath(): string | null {
    if (this.platform !== "darwin") {
      return null;
    }
    const candidates = this.isPackaged
      ? [
          path.join(this.resourcesPath, "native", "velodeck-input-helper-darwin"),
          path.join(this.desktopRootDir, "native", "bin", "velodeck-input-helper-darwin"),
        ]
      : [
          path.join(this.desktopRootDir, "native", "bin", "velodeck-input-helper-darwin"),
          path.join(this.resourcesPath, "native", "velodeck-input-helper-darwin"),
        ];
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private buildSpawnSpecForStage(
    size: TerminalSize,
    cwd: string,
    stage: number,
  ): SpawnSpec | null {
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      COLUMNS: String(size.cols),
      LINES: String(size.rows),
      LANG: process.env.LANG || "en_US.UTF-8",
    };

    if (this.platform === "win32") {
      if (stage > 0) return null;
      return {
        command: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-Command", "-"],
        shell: "powershell.exe",
        env: baseEnv,
        mode: "win-powershell",
        fallbackStage: 0,
      };
    }

    const shell = resolvePosixShell(this.platform);

    if (this.platform === "darwin") {
      if (stage === 0) {
        const helperPath = this.resolveDarwinPtyHelperPath();
        if (helperPath) {
          return {
            command: helperPath,
            args: ["--pty-bridge", String(size.cols), String(size.rows), shell, cwd],
            shell,
            env: baseEnv,
            mode: "json-pty-bridge",
            fallbackStage: 0,
          };
        }
      }
      if (stage <= 1) {
        return {
          command: shell,
          args: ["-i"],
          shell,
          env: baseEnv,
          mode: "direct-shell",
          fallbackStage: 1,
        };
      }
      return null;
    }

    // Linux: stage 0 = python3 PTY bridge, stage 1 = script -qfc, stage 2 = direct shell
    if (stage === 0) {
      const py3 = resolveLinuxPython3();
      if (py3) {
        return {
          command: py3,
          args: ["-u", "-c", LINUX_PYTHON_PTY_BRIDGE, String(size.cols), String(size.rows), shell, cwd],
          shell,
          env: baseEnv,
          mode: "json-pty-bridge",
          fallbackStage: 0,
        };
      }
    }
    if (stage <= 1) {
      const scriptBin = "/usr/bin/script";
      if (fs.existsSync(scriptBin)) {
        return {
          command: scriptBin,
          args: ["-q", "-f", "-c", `${shell} -i`, "/dev/null"],
          shell,
          env: baseEnv,
          mode: "script-wrapper",
          fallbackStage: 1,
        };
      }
    }
    if (stage <= 2) {
      return {
        command: shell,
        args: ["-i"],
        shell,
        env: baseEnv,
        mode: "direct-shell",
        fallbackStage: 2,
      };
    }
    return null;
  }

  private emitTerminalDataChunked(termId: string, text: string): void {
    if (!text) return;
    const chunks = splitUtf8Chunks(text, MAX_OUTPUT_CHUNK_BYTES);
    for (const chunk of chunks) {
      this.onEvent({ type: "term_data", termId, data: chunk });
    }
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
    const spec = this.buildSpawnSpecForStage(size, cwd, 0);
    if (!spec) {
      this.onEvent({
        type: "term_error",
        termId,
        error: "无法解析可用的远程终端启动方案",
      });
      return false;
    }

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

    if (spec.mode === "win-powershell" && child.stdin.writable) {
      try {
        child.stdin.write(
          "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false); [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $OutputEncoding = [Console]::OutputEncoding\r\n",
          "utf8",
        );
      } catch {
        // Ignore startup write error
      }
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
      jsonLineBuffer: "",
      mode: spec.mode,
      fallbackStage: spec.fallbackStage,
      detached,
      startedAt: Date.now(),
      pendingWrites: [],
      sawPtyOutput: false,
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
    let sawWrapperError = false;

    const emitExitOnce = (exitCode: number): void => {
      if (session.exited || session.child !== child) return;
      session.exited = true;
      if (this.sessions.get(termId) === session) {
        this.sessions.delete(termId);
      }
      const tailOut = session.stdoutDecoder.end();
      if (tailOut) {
        this.emitTerminalDataChunked(termId, tailOut);
      }
      const tailErr = session.stderrDecoder.end();
      if (tailErr) {
        this.emitTerminalDataChunked(termId, tailErr);
      }
      this.onEvent({ type: "term_exit", termId, exitCode });
    };

    const tryFallback = (): boolean => {
      if (
        session.exited ||
        session.child !== child ||
        this.sessions.get(termId) !== session
      ) {
        return false;
      }

      const nextSpec = this.buildSpawnSpecForStage(
        { cols: session.cols, rows: session.rows },
        session.cwd,
        session.fallbackStage + 1,
      );
      if (!nextSpec) {
        return false;
      }

      let fallbackChild: ChildProcessWithoutNullStreams;
      try {
        fallbackChild = spawn(nextSpec.command, nextSpec.args, {
          cwd: session.cwd,
          env: nextSpec.env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: session.detached,
          windowsHide: true,
        });
      } catch {
        return false;
      }

      session.child = fallbackChild;
      session.mode = nextSpec.mode;
      session.fallbackStage = nextSpec.fallbackStage;
      session.stdoutDecoder = new StringDecoder("utf8");
      session.stderrDecoder = new StringDecoder("utf8");
      session.jsonLineBuffer = "";
      session.sawPtyOutput = false;
      session.startedAt = Date.now();
      this.attachChildListeners(session, fallbackChild);

      const queued = session.pendingWrites.splice(0, session.pendingWrites.length);
      for (const chunk of queued) {
        this.writeToSession(session, chunk);
      }
      return true;
    };

    const handleJsonBridgeLine = (line: string): void => {
      let parsed: Record<string, unknown>;
      try {
        const obj: unknown = JSON.parse(line);
        if (!obj || typeof obj !== "object") return;
        parsed = obj as Record<string, unknown>;
      } catch {
        return;
      }
      const type = typeof parsed.type === "string" ? parsed.type : "";
      if (type === "data" && typeof parsed.b64 === "string") {
        session.sawPtyOutput = true;
        if (session.pendingWrites.length > 0) {
          session.pendingWrites.length = 0;
        }
        const rawBuf = Buffer.from(parsed.b64, "base64");
        const text = session.stdoutDecoder.write(rawBuf);
        if (text) {
          this.emitTerminalDataChunked(termId, text);
        }
        return;
      }
      if (type === "exit") {
        const code = typeof parsed.code === "number" ? parsed.code : 0;
        emitExitOnce(code);
        return;
      }
      if (type === "error") {
        sawWrapperError = true;
        if (!session.sawPtyOutput && Date.now() - session.startedAt < PTY_FALLBACK_WINDOW_MS) {
          return;
        }
        const errText =
          typeof parsed.error === "string" ? parsed.error : "PTY 桥接进程错误";
        this.onEvent({ type: "term_error", termId, error: errText });
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (session.exited || session.child !== child) return;

      if (session.mode === "json-pty-bridge") {
        session.jsonLineBuffer += chunk.toString("utf8");
        let nlIdx = session.jsonLineBuffer.indexOf("\n");
        while (nlIdx !== -1) {
          const line = session.jsonLineBuffer.slice(0, nlIdx).trim();
          session.jsonLineBuffer = session.jsonLineBuffer.slice(nlIdx + 1);
          if (line) {
            handleJsonBridgeLine(line);
          }
          nlIdx = session.jsonLineBuffer.indexOf("\n");
        }
        if (session.jsonLineBuffer.length > 512 * 1024) {
          session.jsonLineBuffer = "";
        }
        return;
      }

      session.sawPtyOutput = true;
      if (session.pendingWrites.length > 0) {
        session.pendingWrites.length = 0;
      }
      const text = session.stdoutDecoder.write(chunk);
      if (text) {
        this.emitTerminalDataChunked(termId, text);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (session.exited || session.child !== child) return;
      const text = session.stderrDecoder.write(chunk);
      if (!text) return;
      if (
        (session.mode === "script-wrapper" || session.mode === "json-pty-bridge") &&
        !session.sawPtyOutput &&
        Date.now() - session.startedAt < PTY_FALLBACK_WINDOW_MS &&
        /tcgetattr|ioctl|Operation not supported|not a tty|openpty|fork/i.test(text)
      ) {
        sawWrapperError = true;
        return;
      }
      this.emitTerminalDataChunked(termId, text);
    });

    child.stdin.on("error", () => {
      // Handled by exit/error listener
    });

    child.on("error", (err) => {
      if (session.child !== child) return;
      if (
        (session.mode === "json-pty-bridge" || session.mode === "script-wrapper") &&
        tryFallback()
      ) {
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
        (session.mode === "json-pty-bridge" || session.mode === "script-wrapper") &&
        !session.sawPtyOutput &&
        (sawWrapperError || (code !== 0 && elapsed < PTY_FALLBACK_WINDOW_MS))
      ) {
        if (tryFallback()) {
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
      const safePayload = truncateUtf8Safe(rawData, MAX_WRITE_BYTES);
      if (!safePayload) {
        return true;
      }

      if (session.mode === "json-pty-bridge") {
        const b64 = Buffer.from(safePayload, "utf8").toString("base64");
        session.child.stdin.write(`${JSON.stringify({ type: "data", b64 })}\n`, "utf8");
        return true;
      }

      let payload = safePayload;
      if (session.mode === "direct-shell") {
        // Without a PTY line discipline, translate CR -> LF
        payload = payload.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      } else if (session.mode === "win-powershell") {
        // PowerShell -Command - expects newline-delimited commands
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
      (session.mode === "json-pty-bridge" || session.mode === "script-wrapper") &&
      !session.sawPtyOutput &&
      Date.now() - session.startedAt < PTY_FALLBACK_WINDOW_MS &&
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
    if (session.mode === "json-pty-bridge" && session.child.stdin.writable) {
      try {
        session.child.stdin.write(
          `${JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows })}\n`,
          "utf8",
        );
      } catch {
        // Ignore closed pipe
      }
    }
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
        if (session.mode === "json-pty-bridge") {
          proc.stdin.write('{"type":"close"}\n', "utf8");
        }
        proc.stdin.end();
      }
    } catch {
      // Ignore
    }

    if (this.platform === "win32") {
      if (typeof pid === "number" && pid > 0) {
        try {
          const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          killer.on("error", () => undefined);
        } catch {
          // Fall back to direct proc.kill below
        }
      }
      try {
        if (proc.exitCode === null) {
          proc.kill();
        }
      } catch {
        // Ignore
      }
      return;
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
        if (proc.exitCode === null) {
          proc.kill(sig);
        }
      } catch {
        // Ignore
      }
    };

    const termGraceMs = session.mode === "json-pty-bridge" ? 150 : 0;
    let killTimer: NodeJS.Timeout | null = null;
    let termTimer: NodeJS.Timeout | null = null;

    const clearTimers = (): void => {
      if (termTimer !== null) {
        clearTimeout(termTimer);
        termTimer = null;
      }
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    proc.once("exit", clearTimers);

    const triggerTerm = (): void => {
      if (proc.exitCode !== null) {
        clearTimers();
        return;
      }
      sendSignal("SIGTERM");
      killTimer = setTimeout(() => {
        killTimer = null;
        if (proc.exitCode === null) {
          sendSignal("SIGKILL");
        }
      }, 1000);
      killTimer.unref?.();
    };

    if (termGraceMs > 0) {
      termTimer = setTimeout(() => {
        termTimer = null;
        triggerTerm();
      }, termGraceMs);
      termTimer.unref?.();
    } else {
      triggerTerm();
    }
  }
}
