import { useCallback, useEffect, useRef, useState } from "react";
import { PenTool, Trash2, X } from "lucide-react";
import type { WhiteboardPoint, WhiteboardStroke } from "@velodeck/protocol";

export interface WhiteboardLayerProps {
  active: boolean;
  resetKey?: string;
  topOffsetPx?: number;
  mapClientToNormalized: (
    clientX: number,
    clientY: number,
  ) => { x: number; y: number; inside: boolean } | null;
  getSurfaceContentBox: () => {
    rect: DOMRect;
    contentBox: { left: number; top: number; width: number; height: number };
  } | null;
  onCommitStroke: (stroke: WhiteboardStroke) => void;
  onClearAll: () => void;
  onClose: () => void;
}

interface FadingStroke extends WhiteboardStroke {
  createdAt: number;
}

const STROKE_LIFETIME_MS = 8_000;
const STROKE_FADE_MS = 1_500;
const MAX_IN_DRAG_POINTS = 1024;
const MAX_COMMIT_POINTS = 256;

function downsamplePoints(
  points: WhiteboardPoint[],
  maxCount: number,
): WhiteboardPoint[] {
  if (points.length <= maxCount) {
    return points.slice();
  }
  if (maxCount <= 1) {
    return points.length > 0 ? [points[0]!] : [];
  }
  const lastIdx = points.length - 1;
  if (maxCount === 2) {
    return [points[0]!, points[lastIdx]!];
  }
  const result: WhiteboardPoint[] = [points[0]!];
  const step = lastIdx / (maxCount - 1);
  for (let i = 1; i < maxCount - 1; i += 1) {
    const idx = Math.min(lastIdx - 1, Math.max(1, Math.round(i * step)));
    result.push(points[idx]!);
  }
  result.push(points[lastIdx]!);
  return result;
}

const INK_COLORS: Array<{ hex: string; label: string }> = [
  { hex: "#EF4444", label: "红色" },
  { hex: "#F59E0B", label: "琥珀" },
  { hex: "#3B82F6", label: "钴蓝" },
  { hex: "#10B981", label: "翠绿" },
];

const INK_WIDTHS: Array<{ px: number; label: string }> = [
  { px: 3, label: "细" },
  { px: 5, label: "中" },
  { px: 9, label: "粗" },
];

function createStrokeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `wb-${crypto.randomUUID().slice(0, 12)}`;
  }
  return `wb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function clampUnit(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return Math.round(v * 10000) / 10000;
}

export function WhiteboardLayer({
  active,
  resetKey,
  topOffsetPx = 12,
  mapClientToNormalized,
  getSurfaceContentBox,
  onCommitStroke,
  onClearAll,
  onClose,
}: WhiteboardLayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [inkColor, setInkColor] = useState<string>(INK_COLORS[0]!.hex);
  const [inkWidth, setInkWidth] = useState<number>(INK_WIDTHS[1]!.px);
  const [hasVisibleStrokes, setHasVisibleStrokes] = useState(false);

  const fadingStrokesRef = useRef<FadingStroke[]>([]);
  const activeStrokeRef = useRef<{
    pointerId: number;
    stroke: WhiteboardStroke;
  } | null>(null);
  const rafRef = useRef<number | null>(null);

  const mapNormToCanvasPx = useCallback(
    (
      pt: WhiteboardPoint,
      containerRect: DOMRect,
    ): { x: number; y: number } => {
      const box = getSurfaceContentBox();
      if (box && box.contentBox.width > 0 && box.contentBox.height > 0) {
        const originX = box.rect.left - containerRect.left + box.contentBox.left;
        const originY = box.rect.top - containerRect.top + box.contentBox.top;
        return {
          x: originX + pt.x * box.contentBox.width,
          y: originY + pt.y * box.contentBox.height,
        };
      }
      return {
        x: pt.x * containerRect.width,
        y: pt.y * containerRect.height,
      };
    },
    [getSurfaceContentBox],
  );

  const drawSingleStroke = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      stroke: WhiteboardStroke,
      alpha: number,
      containerRect: DOMRect,
    ) => {
      const pts = stroke.points;
      if (pts.length === 0) return;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = stroke.color;
      ctx.fillStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1;

      if (pts.length === 1) {
        const p = mapNormToCanvasPx(pts[0]!, containerRect);
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(2, stroke.width * 0.55), 0, Math.PI * 2);
        ctx.fill();
      } else {
        const mapped = pts.map((pt) => mapNormToCanvasPx(pt, containerRect));
        ctx.beginPath();
        ctx.moveTo(mapped[0]!.x, mapped[0]!.y);
        for (let i = 1; i < mapped.length - 1; i += 1) {
          const xc = (mapped[i]!.x + mapped[i + 1]!.x) * 0.5;
          const yc = (mapped[i]!.y + mapped[i + 1]!.y) * 0.5;
          ctx.quadraticCurveTo(mapped[i]!.x, mapped[i]!.y, xc, yc);
        }
        const last = mapped[mapped.length - 1]!;
        ctx.lineTo(last.x, last.y);
        ctx.stroke();
      }
      ctx.restore();
    },
    [mapNormToCanvasPx],
  );

  const renderFrame = useCallback(() => {
    rafRef.current = null;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const rect = container.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const targetW = Math.max(1, Math.round(rect.width * dpr));
    const targetH = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const now = performance.now();
    const alive: FadingStroke[] = [];
    for (const stroke of fadingStrokesRef.current) {
      const age = now - stroke.createdAt;
      if (age >= STROKE_LIFETIME_MS) continue;
      alive.push(stroke);
      const remaining = STROKE_LIFETIME_MS - age;
      const alpha =
        remaining < STROKE_FADE_MS
          ? Math.max(0, remaining / STROKE_FADE_MS)
          : 1;
      drawSingleStroke(ctx, stroke, alpha, rect);
    }
    fadingStrokesRef.current = alive;

    if (activeStrokeRef.current) {
      drawSingleStroke(ctx, activeStrokeRef.current.stroke, 1, rect);
    }

    const anyVisible = alive.length > 0 || activeStrokeRef.current !== null;
    setHasVisibleStrokes(anyVisible);

    if (anyVisible) {
      rafRef.current = window.requestAnimationFrame(renderFrame);
    }
  }, [drawSingleStroke]);

  const scheduleRender = useCallback(() => {
    if (rafRef.current === null) {
      rafRef.current = window.requestAnimationFrame(renderFrame);
    }
  }, [renderFrame]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    activeStrokeRef.current = null;
    fadingStrokesRef.current = [];
    setHasVisibleStrokes(false);
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, [resetKey]);

  useEffect(() => {
    if (!active) {
      activeStrokeRef.current = null;
      return;
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [active, onClose]);

  function handleClearAllClick() {
    activeStrokeRef.current = null;
    fadingStrokesRef.current = [];
    setHasVisibleStrokes(false);
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
    onClearAll();
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!active) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    const norm = mapClientToNormalized(e.clientX, e.clientY);
    if (!norm || !norm.inside) return;

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore capture errors
    }

    activeStrokeRef.current = {
      pointerId: e.pointerId,
      stroke: {
        id: createStrokeId(),
        color: inkColor,
        width: inkWidth,
        points: [{ x: clampUnit(norm.x), y: clampUnit(norm.y) }],
      },
    };
    setHasVisibleStrokes(true);
    scheduleRender();
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const current = activeStrokeRef.current;
    if (!active || !current || current.pointerId !== e.pointerId) return;
    e.stopPropagation();

    const norm = mapClientToNormalized(e.clientX, e.clientY);
    if (!norm) return;
    const nx = clampUnit(norm.x);
    const ny = clampUnit(norm.y);
    let pts = current.stroke.points;
    const prev = pts[pts.length - 1];
    if (prev && Math.hypot(nx - prev.x, ny - prev.y) < 0.0025) {
      return;
    }
    if (pts.length >= MAX_IN_DRAG_POINTS) {
      pts = downsamplePoints(pts, Math.floor(MAX_IN_DRAG_POINTS / 2));
      current.stroke.points = pts;
    }
    pts.push({ x: nx, y: ny });
    scheduleRender();
  }

  function finishStroke(e: React.PointerEvent<HTMLDivElement>, cancelled = false) {
    const current = activeStrokeRef.current;
    if (!current || current.pointerId !== e.pointerId) return;
    e.stopPropagation();

    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore release errors
    }

    const finished = current.stroke;
    activeStrokeRef.current = null;
    if (!cancelled && finished.points.length > 0) {
      const committedPoints = downsamplePoints(
        finished.points,
        MAX_COMMIT_POINTS,
      );
      const committedStroke: WhiteboardStroke = {
        ...finished,
        points: committedPoints,
      };
      fadingStrokesRef.current.push({
        ...committedStroke,
        points: [...committedPoints],
        createdAt: performance.now(),
      });
      onCommitStroke(committedStroke);
    }
    scheduleRender();
  }

  if (!active && !hasVisibleStrokes) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      onPointerDown={active ? handlePointerDown : undefined}
      onPointerMove={active ? handlePointerMove : undefined}
      onPointerUp={active ? (e) => finishStroke(e, false) : undefined}
      onPointerCancel={active ? (e) => finishStroke(e, true) : undefined}
      onWheel={
        active
          ? (e) => {
              e.stopPropagation();
            }
          : undefined
      }
      className={`absolute inset-0 z-30 select-none ${
        active ? "cursor-crosshair touch-none" : "pointer-events-none"
      }`}
    >
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full"
      />

      {/* Crisp Dark Hardware Ink Palette Bar */}
      {active && (
        <div
          style={{ top: topOffsetPx }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerMove={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          className="pointer-events-auto absolute left-1/2 z-40 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[#2C313D] bg-[#111318] px-2.5 py-1.5 text-xs text-zinc-200 shadow-[0_12px_32px_rgba(0,0,0,0.8)]"
        >
          <span className="inline-flex items-center gap-1 pr-1 text-[11px] font-semibold text-white">
            <PenTool className="h-3.5 w-3.5 text-[#60A5FA]" />
            <span className="hidden sm:inline">白板批注</span>
          </span>

          <span aria-hidden="true" className="h-4 w-px bg-[#262A34]" />

          {/* 4 Ink Color Swatches */}
          <div className="flex items-center gap-1">
            {INK_COLORS.map((swatch) => {
              const selected = inkColor === swatch.hex;
              return (
                <button
                  key={swatch.hex}
                  type="button"
                  onClick={() => setInkColor(swatch.hex)}
                  aria-label={`画笔颜色：${swatch.label}`}
                  title={swatch.label}
                  className={`flex h-6 w-6 items-center justify-center rounded-full border transition ${
                    selected
                      ? "border-white ring-2 ring-white/30"
                      : "border-white/20 hover:border-white/60"
                  }`}
                >
                  <span
                    className="h-4 w-4 rounded-full"
                    style={{ backgroundColor: swatch.hex }}
                  />
                </button>
              );
            })}
          </div>

          <span aria-hidden="true" className="h-4 w-px bg-[#262A34]" />

          {/* Stroke Width Pills */}
          <div className="flex items-center gap-1">
            {INK_WIDTHS.map((w) => {
              const selected = inkWidth === w.px;
              return (
                <button
                  key={w.px}
                  type="button"
                  onClick={() => setInkWidth(w.px)}
                  aria-label={`笔触粗细：${w.label}`}
                  className={`inline-flex h-6 items-center justify-center rounded-md border px-2 text-[10px] font-medium transition ${
                    selected
                      ? "border-[#2563EB] bg-[#2563EB] text-white"
                      : "border-[#262A34] bg-[#191D26] text-zinc-300 hover:bg-[#232836]"
                  }`}
                >
                  {w.label}
                </button>
              );
            })}
          </div>

          <span aria-hidden="true" className="h-4 w-px bg-[#262A34]" />

          <button
            type="button"
            onClick={handleClearAllClick}
            className="inline-flex h-6 items-center gap-1 rounded-md border border-[#262A34] bg-[#191D26] px-2 text-[11px] font-medium text-zinc-200 transition hover:bg-[#232836] hover:text-white"
            title="清除本机与远端白板全部笔迹"
          >
            <Trash2 className="h-3 w-3 text-rose-400" />
            <span>清除全部</span>
          </button>

          <button
            type="button"
            onClick={onClose}
            aria-label="退出白板批注"
            title="退出白板批注（恢复鼠标控制）"
            className="inline-flex h-6 items-center gap-1 rounded-md border border-[#2C313D] bg-white/10 px-2 text-[11px] font-medium text-zinc-100 transition hover:bg-white/20"
          >
            <X className="h-3 w-3" />
            <span className="hidden sm:inline">退出</span>
          </button>
        </div>
      )}
    </div>
  );
}
