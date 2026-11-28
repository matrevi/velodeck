import type { BrowserWindow } from "electron";
import type { DisplayBounds, InputPlatform } from "./inputInjector";

export interface WhiteboardPoint {
  x: number;
  y: number;
}

export interface WhiteboardStroke {
  id: string;
  color: string;
  width: number;
  points: WhiteboardPoint[];
}

export interface WhiteboardOverlayManagerOptions {
  platform: InputPlatform;
}

const STROKE_LIFETIME_MS = 8000;
const IDLE_DESTROY_DELAY_MS = 8600;
const MAX_STROKE_POINTS = 2000;
const DEFAULT_STROKE_COLOR = "#ff3b30";
const SAFE_COLOR_REGEX =
  /^(?:#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\))$/;

function clampUnit(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/**
 * Validates and normalizes an incoming remote whiteboard stroke.
 */
export function sanitizeWhiteboardStroke(raw: unknown): WhiteboardStroke | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.points) || obj.points.length === 0) {
    return null;
  }

  const points: WhiteboardPoint[] = [];
  const limit = Math.min(obj.points.length, MAX_STROKE_POINTS);
  for (let i = 0; i < limit; i += 1) {
    const pt = obj.points[i];
    if (!pt || typeof pt !== "object") continue;
    const x = clampUnit((pt as Record<string, unknown>).x);
    const y = clampUnit((pt as Record<string, unknown>).y);
    if (x !== null && y !== null) {
      points.push({ x, y });
    }
  }
  if (points.length === 0) {
    return null;
  }

  const rawId = typeof obj.id === "string" ? obj.id.trim().slice(0, 64) : "";
  const id = rawId || `stroke-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const rawColor = typeof obj.color === "string" ? obj.color.trim() : "";
  const color = SAFE_COLOR_REGEX.test(rawColor) ? rawColor : DEFAULT_STROKE_COLOR;

  const rawWidth = typeof obj.width === "number" && Number.isFinite(obj.width)
    ? obj.width
    : 4;
  const width = Math.max(1, Math.min(32, Math.round(rawWidth * 10) / 10));

  return { id, color, width, points };
}

function buildWhiteboardHtmlDataUrl(): string {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>VeloDeck Whiteboard Overlay</title>
<style>
  html, body, canvas {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: transparent;
    overflow: hidden;
    pointer-events: none;
    user-select: none;
  }
  canvas {
    display: block;
  }
</style>
</head>
<body>
<canvas id="wb"></canvas>
<script>
(() => {
  const LIFETIME_MS = ${STROKE_LIFETIME_MS};
  const FADE_MS = 1500;
  const canvas = document.getElementById("wb");
  const ctx = canvas.getContext("2d");
  const strokes = new Map();
  let rafId = null;

  function resize() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  window.addEventListener("resize", resize);
  resize();

  function drawFrame(now) {
    rafId = null;
    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);

    for (const [id, entry] of strokes.entries()) {
      const age = now - entry.updatedAt;
      if (age >= LIFETIME_MS) {
        strokes.delete(id);
        continue;
      }
      const remaining = LIFETIME_MS - age;
      const alpha = remaining < FADE_MS ? Math.max(0, remaining / FADE_MS) : 1;
      const pts = entry.points;
      if (!pts || pts.length === 0) continue;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = entry.color;
      ctx.fillStyle = entry.color;
      ctx.lineWidth = entry.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.shadowColor = "rgba(0, 0, 0, 0.48)";
      ctx.shadowBlur = 5;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 1.5;

      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0].x * w, pts[0].y * h, Math.max(2, entry.width * 0.55), 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(pts[0].x * w, pts[0].y * h);
        for (let i = 1; i < pts.length - 1; i += 1) {
          const xc = ((pts[i].x + pts[i + 1].x) * 0.5) * w;
          const yc = ((pts[i].y + pts[i + 1].y) * 0.5) * h;
          ctx.quadraticCurveTo(pts[i].x * w, pts[i].y * h, xc, yc);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(last.x * w, last.y * h);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (strokes.size > 0) {
      rafId = requestAnimationFrame(drawFrame);
    }
  }

  function scheduleRender() {
    if (rafId === null) {
      rafId = requestAnimationFrame(drawFrame);
    }
  }

  window.__velodeckWhiteboard = {
    addStroke(stroke) {
      if (!stroke || !Array.isArray(stroke.points) || stroke.points.length === 0) return;
      strokes.set(stroke.id, {
        id: stroke.id,
        color: stroke.color || "${DEFAULT_STROKE_COLOR}",
        width: Number(stroke.width) || 4,
        points: stroke.points,
        updatedAt: performance.now(),
      });
      scheduleRender();
    },
    clear() {
      strokes.clear();
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    },
  };
})();
</script>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function loadElectronRuntime(): typeof import("electron") {
  // Lazy runtime require keeps pure helpers testable under plain Node.js
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("electron") as typeof import("electron");
}

/**
 * Manages a lazy, transparent, frameless, click-through whiteboard overlay window
 * over the active captured display. Strokes fade out automatically after 8 seconds
 * and the window is destroyed on clear, idle expiry, session end, or app quit.
 */
export class WhiteboardOverlayManager {
  private readonly platform: InputPlatform;
  private overlayWindow: BrowserWindow | null = null;
  private windowLoaded = false;
  private pendingStrokes: WhiteboardStroke[] = [];
  private idleTimer: NodeJS.Timeout | null = null;
  private currentBounds: DisplayBounds | null = null;
  private disposed = false;

  constructor(options: WhiteboardOverlayManagerOptions) {
    this.platform = options.platform;
  }

  public isOverlayWindow(win: BrowserWindow | null | undefined): boolean {
    return Boolean(win && this.overlayWindow && win === this.overlayWindow);
  }

  public drawStroke(stroke: WhiteboardStroke, bounds: DisplayBounds): void {
    if (this.disposed) return;
    this.ensureOverlayWindow(bounds);
    this.resetIdleTimer();

    if (
      this.overlayWindow &&
      !this.overlayWindow.isDestroyed() &&
      this.windowLoaded
    ) {
      this.pushStrokeToWindow(this.overlayWindow, stroke);
      if (!this.overlayWindow.isVisible()) {
        this.overlayWindow.showInactive();
      }
    } else {
      this.pendingStrokes.push(stroke);
      if (this.pendingStrokes.length > 64) {
        this.pendingStrokes.shift();
      }
    }
  }

  public updateBounds(bounds: DisplayBounds): void {
    this.currentBounds = { ...bounds };
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      try {
        this.overlayWindow.setBounds(this.currentBounds);
      } catch {
        // Ignore bounds update errors
      }
    }
  }

  public clear(): void {
    this.clearIdleTimer();
    this.pendingStrokes = [];
    this.destroyOverlayWindow();
  }

  public dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.destroyOverlayWindow();
    }, IDLE_DESTROY_DELAY_MS);
    this.idleTimer.unref?.();
  }

  private ensureOverlayWindow(bounds: DisplayBounds): void {
    const sameBounds =
      this.currentBounds &&
      this.currentBounds.x === bounds.x &&
      this.currentBounds.y === bounds.y &&
      this.currentBounds.width === bounds.width &&
      this.currentBounds.height === bounds.height;

    this.currentBounds = { ...bounds };

    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      if (!sameBounds) {
        try {
          this.overlayWindow.setBounds(this.currentBounds);
        } catch {
          // Ignore
        }
      }
      return;
    }

    const electron = loadElectronRuntime();
    const { BrowserWindow: ElectronBrowserWindow } = electron;

    this.windowLoaded = false;
    const win = new ElectronBrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      hasShadow: false,
      enableLargerThanScreen: true,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });

    this.overlayWindow = win;
    win.setIgnoreMouseEvents(true);

    if (this.platform === "darwin") {
      win.setAlwaysOnTop(true, "screen-saver", 2);
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } else {
      win.setAlwaysOnTop(true, "screen-saver");
    }

    win.setBounds(this.currentBounds);

    win.on("closed", () => {
      if (this.overlayWindow === win) {
        this.overlayWindow = null;
        this.windowLoaded = false;
      }
    });

    win.webContents.once("did-finish-load", () => {
      if (this.overlayWindow !== win || win.isDestroyed() || this.disposed) {
        return;
      }
      this.windowLoaded = true;
      const queued = this.pendingStrokes.splice(0, this.pendingStrokes.length);
      for (const stroke of queued) {
        this.pushStrokeToWindow(win, stroke);
      }
      if (queued.length > 0 && !win.isVisible()) {
        win.showInactive();
      }
    });

    void win.loadURL(buildWhiteboardHtmlDataUrl());
  }

  private pushStrokeToWindow(win: BrowserWindow, stroke: WhiteboardStroke): void {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    const serialized = JSON.stringify(stroke);
    void win.webContents
      .executeJavaScript(
        `window.__velodeckWhiteboard && window.__velodeckWhiteboard.addStroke(${serialized});`,
        false,
      )
      .catch(() => undefined);
  }

  private destroyOverlayWindow(): void {
    const win = this.overlayWindow;
    this.overlayWindow = null;
    this.windowLoaded = false;
    if (!win || win.isDestroyed()) return;
    try {
      win.destroy();
    } catch {
      // Best-effort cleanup
    }
  }
}
