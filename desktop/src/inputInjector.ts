import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type InputPlatform = "darwin" | "win32" | "linux";

export interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InputPermissionsSnapshot {
  accessibility: boolean;
  screenCapture: boolean;
  platform: InputPlatform;
}

export interface KeyModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface NativeInputPayload {
  action: string;
  x?: number;
  y?: number;
  button?: "left" | "right" | "middle";
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  phase?: "down" | "up" | "press";
  code?: string;
  key?: string;
  modifiers?: KeyModifiers;
  text?: string;
  submit?: boolean;
}

export interface NativeInputInjectorOptions {
  platform?: InputPlatform;
  resourcesPath?: string;
  desktopRootDir?: string;
  isPackaged?: boolean;
  mapPoint?: (point: { x: number; y: number }) => { x: number; y: number };
}

const MAX_WHEEL_DELTA = 2000;
const MAX_TEXT_LENGTH = 4096;
const SWIPE_SCROLL_GAIN = 0.65;

function clampUnit(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function clampDelta(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  const rounded = Math.round(value);
  return Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, rounded));
}

function sanitizeMouseButton(raw: unknown): "left" | "right" | "middle" {
  if (raw === "right" || raw === "middle" || raw === "left") {
    return raw;
  }
  if (typeof raw === "number") {
    if (raw === 2) return "right";
    if (raw === 1) return "middle";
  }
  return "left";
}

function sanitizeClickCount(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 1;
  }
  return Math.max(1, Math.min(3, Math.round(raw)));
}

function extractModifiers(cmd: Record<string, unknown>): KeyModifiers {
  const nested =
    cmd.modifiers && typeof cmd.modifiers === "object"
      ? (cmd.modifiers as Record<string, unknown>)
      : null;
  return {
    ctrl: Boolean(nested ? nested.ctrl : cmd.ctrl),
    alt: Boolean(nested ? nested.alt : cmd.alt),
    shift: Boolean(nested ? nested.shift : cmd.shift),
    meta: Boolean(nested ? nested.meta : cmd.meta),
  };
}

/**
 * Pure helper mapping normalized `[0, 1]` remote pointer coordinates to target display
 * logical coordinates, supporting multi-monitor negative X/Y offsets and clamping to
 * `[bounds.x, bounds.x + bounds.width - 1]` so right/bottom edges never spill onto an adjacent monitor.
 */
export function mapNormalizedPointToDisplay(
  normX: number,
  normY: number,
  bounds: DisplayBounds,
): { x: number; y: number } {
  const cx = clampUnit(normX, 0);
  const cy = clampUnit(normY, 0);
  const safeWidth = Number.isFinite(bounds.width) && bounds.width > 0 ? bounds.width : 1;
  const safeHeight = Number.isFinite(bounds.height) && bounds.height > 0 ? bounds.height : 1;
  const baseX = Number.isFinite(bounds.x) ? bounds.x : 0;
  const baseY = Number.isFinite(bounds.y) ? bounds.y : 0;

  return {
    x: Math.round(baseX + cx * Math.max(0, safeWidth - 1)),
    y: Math.round(baseY + cy * Math.max(0, safeHeight - 1)),
  };
}

/**
 * Pure translation layer converting both desktop mouse/keyboard control commands AND
 * legacy mobile touch/key control commands into native input helper NDJSON payloads.
 */
export function translateControlCommandToNativeEvents(
  cmd: Record<string, unknown>,
  displayBounds: DisplayBounds,
  platform: InputPlatform,
): NativeInputPayload[] {
  const action = typeof cmd.action === "string" ? cmd.action : "";
  if (!action) {
    return [];
  }

  switch (action) {
    case "mouse_move": {
      const pt = mapNormalizedPointToDisplay(Number(cmd.x), Number(cmd.y), displayBounds);
      return [{ action: "mouse_move", x: pt.x, y: pt.y }];
    }

    case "mouse_down": {
      const pt = mapNormalizedPointToDisplay(Number(cmd.x), Number(cmd.y), displayBounds);
      return [
        {
          action: "mouse_down",
          x: pt.x,
          y: pt.y,
          button: sanitizeMouseButton(cmd.button),
          clickCount: sanitizeClickCount(cmd.clickCount),
        },
      ];
    }

    case "mouse_up": {
      const pt = mapNormalizedPointToDisplay(Number(cmd.x), Number(cmd.y), displayBounds);
      return [
        {
          action: "mouse_up",
          x: pt.x,
          y: pt.y,
          button: sanitizeMouseButton(cmd.button),
          clickCount: sanitizeClickCount(cmd.clickCount),
        },
      ];
    }

    case "mouse_wheel": {
      const hasCoords =
        typeof cmd.x === "number" &&
        Number.isFinite(cmd.x) &&
        typeof cmd.y === "number" &&
        Number.isFinite(cmd.y);
      const pt = hasCoords
        ? mapNormalizedPointToDisplay(cmd.x as number, cmd.y as number, displayBounds)
        : undefined;
      const deltaX = clampDelta(cmd.deltaX);
      const deltaY = clampDelta(cmd.deltaY);
      if (deltaX === 0 && deltaY === 0) {
        return [];
      }
      return [
        {
          action: "mouse_wheel",
          ...(pt ? { x: pt.x, y: pt.y } : {}),
          deltaX,
          deltaY,
        },
      ];
    }

    case "key_event": {
      const rawPhase =
        typeof cmd.phase === "string"
          ? cmd.phase
          : typeof cmd.type === "string"
            ? cmd.type
            : "press";
      const phase: "down" | "up" | "press" =
        rawPhase === "down" || rawPhase === "up" || rawPhase === "press"
          ? rawPhase
          : "press";
      const code = typeof cmd.code === "string" ? cmd.code.slice(0, 64) : "";
      const key = typeof cmd.key === "string" ? cmd.key.slice(0, 64) : "";
      if (!code && !key) {
        return [];
      }
      return [
        {
          action: "key_event",
          phase,
          code,
          key,
          modifiers: extractModifiers(cmd),
        },
      ];
    }

    case "tap": {
      const pt = mapNormalizedPointToDisplay(Number(cmd.x), Number(cmd.y), displayBounds);
      return [{ action: "tap", x: pt.x, y: pt.y, clickCount: 1 }];
    }

    case "long_press": {
      const pt = mapNormalizedPointToDisplay(Number(cmd.x), Number(cmd.y), displayBounds);
      return [{ action: "long_press", x: pt.x, y: pt.y }];
    }

    case "swipe": {
      const x1 = clampUnit(cmd.x1, 0.5);
      const y1 = clampUnit(cmd.y1, 0.5);
      const x2 = clampUnit(cmd.x2, x1);
      const y2 = clampUnit(cmd.y2, y1);
      const anchor = mapNormalizedPointToDisplay(x1, y1, displayBounds);
      const deltaX = clampDelta((x1 - x2) * displayBounds.width * SWIPE_SCROLL_GAIN);
      const deltaY = clampDelta((y1 - y2) * displayBounds.height * SWIPE_SCROLL_GAIN);
      if (deltaX === 0 && deltaY === 0) {
        return [];
      }
      return [
        {
          action: "mouse_wheel",
          x: anchor.x,
          y: anchor.y,
          deltaX,
          deltaY,
        },
      ];
    }

    case "touch_down": {
      const pt = mapNormalizedPointToDisplay(Number(cmd.x), Number(cmd.y), displayBounds);
      return [{ action: "mouse_down", x: pt.x, y: pt.y, button: "left", clickCount: 1 }];
    }

    case "touch_move": {
      const pt = mapNormalizedPointToDisplay(Number(cmd.x), Number(cmd.y), displayBounds);
      return [{ action: "mouse_move", x: pt.x, y: pt.y }];
    }

    case "touch_up": {
      const pt = mapNormalizedPointToDisplay(Number(cmd.x), Number(cmd.y), displayBounds);
      return [{ action: "mouse_up", x: pt.x, y: pt.y, button: "left", clickCount: 1 }];
    }

    case "pinch": {
      const startDist = typeof cmd.startDist === "number" ? cmd.startDist : 0;
      const endDist = typeof cmd.endDist === "number" ? cmd.endDist : 0;
      if (!Number.isFinite(startDist) || !Number.isFinite(endDist) || Math.abs(endDist - startDist) < 0.01) {
        return [];
      }
      const zoomIn = endDist > startDist;
      const mod: KeyModifiers =
        platform === "darwin"
          ? { ctrl: false, alt: false, shift: false, meta: true }
          : { ctrl: true, alt: false, shift: false, meta: false };
      return [
        {
          action: "key_event",
          phase: "press",
          code: zoomIn ? "Equal" : "Minus",
          key: zoomIn ? "=" : "-",
          modifiers: mod,
        },
      ];
    }

    case "key": {
      const remoteKey = typeof cmd.key === "string" ? cmd.key : "";
      const noMod: KeyModifiers = { ctrl: false, alt: false, shift: false, meta: false };
      switch (remoteKey) {
        case "back":
          return [{ action: "key_event", phase: "press", code: "Escape", key: "Escape", modifiers: noMod }];
        case "home":
          return platform === "darwin"
            ? [
                {
                  action: "key_event",
                  phase: "press",
                  code: "KeyH",
                  key: "h",
                  modifiers: { ctrl: false, alt: false, shift: false, meta: true },
                },
              ]
            : [
                {
                  action: "key_event",
                  phase: "press",
                  code: "KeyD",
                  key: "d",
                  modifiers: { ctrl: false, alt: false, shift: false, meta: true },
                },
              ];
        case "recents":
          return platform === "darwin"
            ? [
                {
                  action: "key_event",
                  phase: "press",
                  code: "ArrowUp",
                  key: "ArrowUp",
                  modifiers: { ctrl: true, alt: false, shift: false, meta: false },
                },
              ]
            : [
                {
                  action: "key_event",
                  phase: "press",
                  code: "Tab",
                  key: "Tab",
                  modifiers: { ctrl: false, alt: true, shift: false, meta: false },
                },
              ];
        case "enter":
          return [{ action: "key_event", phase: "press", code: "Enter", key: "Enter", modifiers: noMod }];
        case "backspace":
          return [{ action: "key_event", phase: "press", code: "Backspace", key: "Backspace", modifiers: noMod }];
        case "lock":
          return [{ action: "lock" }];
        case "screenshot":
          return platform === "darwin"
            ? [
                {
                  action: "key_event",
                  phase: "press",
                  code: "Digit4",
                  key: "4",
                  modifiers: { ctrl: false, alt: false, shift: true, meta: true },
                },
              ]
            : [
                {
                  action: "key_event",
                  phase: "press",
                  code: "KeyS",
                  key: "s",
                  modifiers: { ctrl: false, alt: false, shift: true, meta: true },
                },
              ];
        case "volume_up":
          return [
            { action: "key_event", phase: "press", code: "AudioVolumeUp", key: "AudioVolumeUp", modifiers: noMod },
          ];
        case "volume_down":
          return [
            {
              action: "key_event",
              phase: "press",
              code: "AudioVolumeDown",
              key: "AudioVolumeDown",
              modifiers: noMod,
            },
          ];
        case "volume_mute":
          return [
            {
              action: "key_event",
              phase: "press",
              code: "AudioVolumeMute",
              key: "AudioVolumeMute",
              modifiers: noMod,
            },
          ];
        default:
          return [];
      }
    }

    case "power": {
      const op =
        typeof cmd.operation === "string"
          ? cmd.operation
          : typeof cmd.op === "string"
            ? cmd.op
            : "";
      if (op === "lock") {
        return [{ action: "lock" }];
      }
      // sleep / restart / shutdown are handled by powerAndPrivacy.executePowerAction
      return [];
    }

    case "privacy_screen":
    case "audio_toggle":
      // Handled at hostManager / hostWorkerRenderer level, never injected as HID events
      return [];

    case "text": {
      const text = typeof cmd.text === "string" ? cmd.text.slice(0, MAX_TEXT_LENGTH) : "";
      const submit = Boolean(cmd.submit);
      if (!text && !submit) {
        return [];
      }
      return [{ action: "text", text, submit }];
    }

    case "wake": {
      const center = mapNormalizedPointToDisplay(0.5, 0.5, displayBounds);
      return [{ action: "mouse_move", x: center.x, y: center.y }];
    }

    default:
      return [];
  }
}

export class NativeInputInjector {
  private readonly platform: InputPlatform;
  private readonly resourcesPath: string;
  private readonly desktopRootDir: string;
  private readonly isPackaged: boolean;
  private readonly mapPoint?: (point: { x: number; y: number }) => { x: number; y: number };

  private child: ChildProcessWithoutNullStreams | null = null;
  private disposed = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempts = 0;
  private lastSpawnAt = 0;

  constructor(options: NativeInputInjectorOptions = {}) {
    this.platform =
      options.platform ??
      (process.platform === "darwin" || process.platform === "win32"
        ? process.platform
        : "linux");
    this.resourcesPath = options.resourcesPath ?? process.resourcesPath ?? "";
    this.desktopRootDir = options.desktopRootDir ?? path.resolve(__dirname, "..");
    this.isPackaged = options.isPackaged ?? false;
    this.mapPoint = options.mapPoint;
  }

  public resolveHelperPath(): string | null {
    if (this.platform === "darwin") {
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

    if (this.platform === "win32") {
      const candidates = this.isPackaged
        ? [
            path.join(this.resourcesPath, "native", "win-input-helper.ps1"),
            path.join(this.desktopRootDir, "native", "win-input-helper.ps1"),
          ]
        : [
            path.join(this.desktopRootDir, "native", "win-input-helper.ps1"),
            path.join(this.resourcesPath, "native", "win-input-helper.ps1"),
          ];
      for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
          return candidate;
        }
      }
      return null;
    }

    return null;
  }

  public async checkPermissions(): Promise<InputPermissionsSnapshot> {
    if (this.platform !== "darwin") {
      return {
        accessibility: true,
        screenCapture: true,
        platform: this.platform,
      };
    }
    return this.runDarwinPermissionFlag("--check-permissions");
  }

  public async requestAccessibility(): Promise<InputPermissionsSnapshot> {
    if (this.platform !== "darwin") {
      return {
        accessibility: true,
        screenCapture: true,
        platform: this.platform,
      };
    }
    return this.runDarwinPermissionFlag("--request-accessibility");
  }

  private runDarwinPermissionFlag(flag: string): Promise<InputPermissionsSnapshot> {
    const helperPath = this.resolveHelperPath();
    if (!helperPath) {
      return Promise.resolve({
        accessibility: false,
        screenCapture: false,
        platform: "darwin",
      });
    }
    return new Promise((resolve) => {
      execFile(
        helperPath,
        [flag],
        { timeout: 4000, windowsHide: true },
        (error, stdout) => {
          if (error || !stdout) {
            resolve({
              accessibility: false,
              screenCapture: false,
              platform: "darwin",
            });
            return;
          }
          try {
            const parsed = JSON.parse(stdout.trim()) as {
              accessibility?: unknown;
              screenCapture?: unknown;
            };
            resolve({
              accessibility: Boolean(parsed.accessibility),
              screenCapture: Boolean(parsed.screenCapture),
              platform: "darwin",
            });
          } catch {
            resolve({
              accessibility: false,
              screenCapture: false,
              platform: "darwin",
            });
          }
        },
      );
    });
  }

  public ensureStarted(): boolean {
    if (this.disposed) {
      return false;
    }
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return true;
    }

    const helperPath = this.resolveHelperPath();
    if (!helperPath) {
      return false;
    }

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    try {
      const spawned =
        this.platform === "darwin"
          ? spawn(helperPath, [], {
              stdio: ["pipe", "pipe", "pipe"],
            })
          : spawn(
              "powershell.exe",
              [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                helperPath,
              ],
              {
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
              },
            );

      this.child = spawned;
      this.lastSpawnAt = Date.now();

      spawned.stdout.on("data", () => {
        // Drain stdout so helper never blocks on pipe buffer
      });
      spawned.stderr.on("data", (chunk: Buffer) => {
        const msg = chunk.toString("utf8").trim();
        if (msg) {
          console.warn(`[velodeck-input-helper] ${msg}`);
        }
      });
      spawned.stdin.on("error", () => {
        // Handled by exit listener
      });

      spawned.on("error", (err) => {
        console.warn("[velodeck-input-helper] Process error:", err.message);
      });

      spawned.on("exit", (code, signal) => {
        if (this.child === spawned) {
          this.child = null;
        }
        if (this.disposed) {
          return;
        }
        const uptimeMs = Date.now() - this.lastSpawnAt;
        if (uptimeMs >= 5000) {
          this.restartAttempts = 0;
        } else {
          this.restartAttempts = Math.min(this.restartAttempts + 1, 6);
        }
        const delayMs = Math.min(10_000, 500 * 2 ** Math.max(0, this.restartAttempts - 1));
        console.warn(
          `[velodeck-input-helper] Exited (code=${code}, signal=${signal}); will allow restart in ${delayMs}ms`,
        );
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.disposed) {
            this.ensureStarted();
          }
        }, delayMs);
        this.restartTimer.unref?.();
      });

      return true;
    } catch (error) {
      console.error("[velodeck-input-helper] Failed to spawn:", error);
      return false;
    }
  }

  public sendPayload(payload: NativeInputPayload): boolean {
    if (this.disposed) {
      return false;
    }
    if (!this.ensureStarted() || !this.child || !this.child.stdin.writable) {
      return false;
    }
    try {
      let effective = payload;
      if (
        this.mapPoint &&
        typeof payload.x === "number" &&
        typeof payload.y === "number"
      ) {
        const mapped = this.mapPoint({ x: payload.x, y: payload.y });
        effective = { ...payload, x: mapped.x, y: mapped.y };
      }
      this.child.stdin.write(`${JSON.stringify(effective)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  public injectCommand(
    cmd: Record<string, unknown>,
    displayBounds: DisplayBounds,
  ): { ok: boolean; count: number } {
    const events = translateControlCommandToNativeEvents(cmd, displayBounds, this.platform);
    if (events.length === 0) {
      return { ok: true, count: 0 };
    }
    let allOk = true;
    for (const ev of events) {
      if (!this.sendPayload(ev)) {
        allOk = false;
      }
    }
    return { ok: allOk, count: events.length };
  }

  public releaseAll(): void {
    if (this.child && !this.child.killed && this.child.exitCode === null && this.child.stdin.writable) {
      try {
        this.child.stdin.write('{"action":"release_all"}\n');
      } catch {
        // Best-effort
      }
    }
  }

  public dispose(): void {
    this.disposed = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const proc = this.child;
    this.child = null;
    if (!proc) {
      return;
    }
    try {
      if (proc.stdin.writable) {
        proc.stdin.write('{"action":"release_all"}\n');
        proc.stdin.end();
      }
    } catch {
      // Ignore
    }
    try {
      proc.kill("SIGTERM");
    } catch {
      // Ignore
    }
    const forceKillTimer = setTimeout(() => {
      try {
        if (proc.exitCode === null && !proc.killed) {
          proc.kill("SIGKILL");
        }
      } catch {
        // Ignore
      }
    }, 1000);
    forceKillTimer.unref?.();
  }
}
