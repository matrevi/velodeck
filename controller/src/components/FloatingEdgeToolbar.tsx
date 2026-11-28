import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ArrowLeft,
  Circle,
  Crosshair,
  Eye,
  EyeOff,
  FolderOpen,
  Gauge,
  GripHorizontal,
  GripVertical,
  Home,
  Keyboard,
  Layers,
  Lock,
  LogOut,
  Maximize2,
  MessageSquare,
  Moon,
  PanelTopOpen,
  PenTool,
  Pin,
  SlidersHorizontal,
  Square,
  Terminal,
  Unlock,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { TransportMode } from "@velodeck/protocol";
import {
  formatRecordingDuration,
} from "../desktop/recorder";
import {
  isWebRtcStaticIdle,
  type RemoteClient,
  type SessionStatus,
  type SocketStatus,
} from "../transport/RemoteClient";

export type ToolbarEdge = "top" | "bottom" | "left" | "right";
export type ViewportChromeMode = "standard" | "floating";
export type ViewportViewStyle = "adaptive" | "original" | "stretch";

export interface FloatingToolbarPosition {
  edge: ToolbarEdge;
  ratio: number; // 0.08..0.92 along the snapped edge
}

export const CHROME_MODE_STORAGE_KEY = "velodeck.viewport.chromeMode.v1";
export const FLOATING_TOOLBAR_STORAGE_KEY = "velodeck.viewport.floatingToolbar.v1";
export const VIEW_STYLE_STORAGE_KEY = "velodeck.viewport.viewStyle.v1";

const DEFAULT_TOOLBAR_POSITION: FloatingToolbarPosition = {
  edge: "top",
  ratio: 0.5,
};

function getSafeStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    return null;
  }
  return null;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0.1, Math.min(0.9, value));
}

export function loadChromeMode(storage?: Storage): ViewportChromeMode {
  const store = getSafeStorage(storage);
  if (!store) return "standard";
  try {
    return store.getItem(CHROME_MODE_STORAGE_KEY) === "floating"
      ? "floating"
      : "standard";
  } catch {
    return "standard";
  }
}

export function saveChromeMode(mode: ViewportChromeMode, storage?: Storage): void {
  const store = getSafeStorage(storage);
  if (!store) return;
  try {
    store.setItem(
      CHROME_MODE_STORAGE_KEY,
      mode === "floating" ? "floating" : "standard",
    );
  } catch {
    // Ignore storage errors
  }
}

export function loadViewStyle(storage?: Storage): ViewportViewStyle {
  const store = getSafeStorage(storage);
  if (!store) return "adaptive";
  try {
    const raw = store.getItem(VIEW_STYLE_STORAGE_KEY);
    if (raw === "original" || raw === "stretch") return raw;
    return "adaptive";
  } catch {
    return "adaptive";
  }
}

export function saveViewStyle(style: ViewportViewStyle, storage?: Storage): void {
  const store = getSafeStorage(storage);
  if (!store) return;
  try {
    store.setItem(VIEW_STYLE_STORAGE_KEY, style);
  } catch {
    // Ignore storage errors
  }
}

export function loadFloatingToolbarPosition(
  storage?: Storage,
): FloatingToolbarPosition {
  const store = getSafeStorage(storage);
  if (!store) return DEFAULT_TOOLBAR_POSITION;
  try {
    const raw = store.getItem(FLOATING_TOOLBAR_STORAGE_KEY);
    if (!raw) return DEFAULT_TOOLBAR_POSITION;
    const parsed = JSON.parse(raw) as Partial<FloatingToolbarPosition>;
    if (
      parsed &&
      (parsed.edge === "top" ||
        parsed.edge === "bottom" ||
        parsed.edge === "left" ||
        parsed.edge === "right")
    ) {
      return {
        edge: parsed.edge,
        ratio: clampRatio(typeof parsed.ratio === "number" ? parsed.ratio : 0.5),
      };
    }
    return DEFAULT_TOOLBAR_POSITION;
  } catch {
    return DEFAULT_TOOLBAR_POSITION;
  }
}

export function saveFloatingToolbarPosition(
  pos: FloatingToolbarPosition,
  storage?: Storage,
): void {
  const store = getSafeStorage(storage);
  if (!store) return;
  try {
    store.setItem(
      FLOATING_TOOLBAR_STORAGE_KEY,
      JSON.stringify({ edge: pos.edge, ratio: clampRatio(pos.ratio) }),
    );
  } catch {
    // Ignore storage errors
  }
}

export function computeSnapEdge(
  clientX: number,
  clientY: number,
  bounds: { left: number; top: number; width: number; height: number },
): FloatingToolbarPosition {
  const w = Math.max(1, bounds.width);
  const h = Math.max(1, bounds.height);
  const relX = Math.max(0, Math.min(w, clientX - bounds.left));
  const relY = Math.max(0, Math.min(h, clientY - bounds.top));

  const distTop = relY;
  const distBottom = h - relY;
  const distLeft = relX;
  const distRight = w - relX;

  const minDist = Math.min(distTop, distBottom, distLeft, distRight);
  if (minDist === distTop) {
    return { edge: "top", ratio: clampRatio(relX / w) };
  }
  if (minDist === distBottom) {
    return { edge: "bottom", ratio: clampRatio(relX / w) };
  }
  if (minDist === distLeft) {
    return { edge: "left", ratio: clampRatio(relY / h) };
  }
  return { edge: "right", ratio: clampRatio(relY / h) };
}

export function getViewStyleLabel(style: ViewportViewStyle): string {
  switch (style) {
    case "original":
      return "1:1";
    case "stretch":
      return "拉伸";
    default:
      return "适应";
  }
}

export function getNextViewStyle(current: ViewportViewStyle): ViewportViewStyle {
  if (current === "adaptive") return "original";
  if (current === "original") return "stretch";
  return "adaptive";
}

export interface FloatingEdgeToolbarProps {
  client: RemoteClient;
  socketStatus: SocketStatus;
  sessionStatus: SessionStatus;
  activeTransport: TransportMode | null;
  isStreamingReady: boolean;
  isDesktopTarget: boolean;
  desktopApp: boolean;
  embedded?: boolean;
  topInsetPx?: number;
  viewStyle: ViewportViewStyle;
  viewOnly: boolean;
  isRecording: boolean;
  recordingDurationSec: number;
  audioMuted: boolean;
  isAudioLive: boolean;
  isPrivacyOrBlackScreenActive: boolean;
  isBlockInputActive?: boolean;
  isPointerLocked?: boolean;
  pointerLockDisabled?: boolean;
  isWhiteboardActive?: boolean;
  terminalDisabled?: boolean;
  unreadChatCount?: number;
  isAlwaysOnTop: boolean;
  onExpandStandardChrome: () => void;
  onCycleViewStyle: () => void;
  onToggleViewOnly: () => void;
  onToggleRecording: () => void;
  onToggleAudio?: () => void;
  onOpenShortcuts: () => void;
  onOpenFiles: () => void;
  onOpenQuality?: () => void;
  onTogglePointerLock?: () => void;
  onOpenTerminal?: () => void;
  onToggleBlockInput?: () => void;
  onToggleWhiteboard?: () => void;
  onOpenChat?: () => void;
  onAndroidBack?: () => void;
  onAndroidHome?: () => void;
  onAndroidRecents?: () => void;
  onOpenUnlock?: () => void;
  onTogglePrivacyOrBlackScreen: () => void;
  onToggleAlwaysOnTop?: () => void;
  onOpenMore: () => void;
  onExit: () => void;
}

const EDGE_MARGIN_PX = 8;

export const FloatingEdgeToolbar = memo(function FloatingEdgeToolbar({
  client,
  socketStatus,
  sessionStatus,
  activeTransport,
  isStreamingReady,
  isDesktopTarget,
  desktopApp,
  embedded = false,
  topInsetPx = 0,
  viewStyle,
  viewOnly,
  isRecording,
  recordingDurationSec,
  audioMuted,
  isAudioLive,
  isPrivacyOrBlackScreenActive,
  isBlockInputActive = false,
  isPointerLocked = false,
  pointerLockDisabled = false,
  isWhiteboardActive = false,
  terminalDisabled = false,
  unreadChatCount = 0,
  isAlwaysOnTop,
  onExpandStandardChrome,
  onCycleViewStyle,
  onToggleViewOnly,
  onToggleRecording,
  onToggleAudio,
  onOpenShortcuts,
  onOpenFiles,
  onOpenQuality,
  onTogglePointerLock,
  onOpenTerminal,
  onToggleBlockInput,
  onToggleWhiteboard,
  onOpenChat,
  onAndroidBack,
  onAndroidHome,
  onAndroidRecents,
  onOpenUnlock,
  onTogglePrivacyOrBlackScreen,
  onToggleAlwaysOnTop,
  onOpenMore,
  onExit,
}: FloatingEdgeToolbarProps) {
  const telemetry = useSyncExternalStore(
    client.subscribeTelemetry,
    client.getTelemetrySnapshot,
  );

  const [position, setPosition] = useState<FloatingToolbarPosition>(() =>
    loadFloatingToolbarPosition(),
  );
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dragPreview, setDragPreview] = useState<FloatingToolbarPosition | null>(
    null,
  );
  const [containerSize, setContainerSize] = useState<{
    width: number;
    height: number;
  }>({ width: 0, height: 0 });
  const [toolbarSize, setToolbarSize] = useState<{
    width: number;
    height: number;
  }>({ width: 0, height: 0 });

  const rootRef = useRef<HTMLDivElement | null>(null);
  const collapseTimerRef = useRef<number | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
    bounds: { left: number; top: number; width: number; height: number };
  } | null>(null);

  useEffect(() => {
    return () => {
      if (collapseTimerRef.current !== null) {
        window.clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
    };
  }, []);

  const cancelScheduledCollapse = () => {
    if (collapseTimerRef.current !== null) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  };

  const scheduleCollapse = () => {
    cancelScheduledCollapse();
    collapseTimerRef.current = window.setTimeout(() => {
      collapseTimerRef.current = null;
      setExpanded(false);
    }, 320);
  };

  const activePos = dragPreview ?? position;
  const isVertical = activePos.edge === "left" || activePos.edge === "right";
  const safeTopInset = Math.max(0, topInsetPx);

  // Measure container and toolbar dimensions to strictly clamp within viewport bounds
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    const measure = () => {
      const offsetParent = embedded ? el.offsetParent : null;
      const cWidth =
        offsetParent instanceof HTMLElement
          ? offsetParent.clientWidth
          : typeof window !== "undefined"
            ? window.innerWidth
            : 1280;
      const cHeight =
        offsetParent instanceof HTMLElement
          ? offsetParent.clientHeight
          : typeof window !== "undefined"
            ? window.innerHeight
            : 800;
      const tRect = el.getBoundingClientRect();
      setContainerSize((prev) =>
        prev.width === cWidth && prev.height === cHeight
          ? prev
          : { width: cWidth, height: cHeight },
      );
      setToolbarSize((prev) =>
        Math.abs(prev.width - tRect.width) < 0.5 &&
        Math.abs(prev.height - tRect.height) < 0.5
          ? prev
          : { width: tRect.width, height: tRect.height },
      );
    };

    measure();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      const offsetParent = embedded ? el.offsetParent : null;
      if (offsetParent instanceof HTMLElement) {
        observer.observe(offsetParent);
      } else if (typeof document !== "undefined" && document.documentElement) {
        observer.observe(document.documentElement);
      }
      window.addEventListener("resize", measure);
      return () => {
        observer.disconnect();
        window.removeEventListener("resize", measure);
      };
    }

    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [
    embedded,
    expanded,
    activePos.edge,
    isDesktopTarget,
    isRecording,
    viewOnly,
    isBlockInputActive,
    isPointerLocked,
    unreadChatCount,
  ]);

  const statusDotClass = isStreamingReady
    ? "bg-emerald-400"
    : socketStatus === "error" ||
        sessionStatus === "error" ||
        sessionStatus === "ended"
      ? "bg-rose-400"
      : "bg-amber-400";

  const bitrateKbps = telemetry.webrtcTelemetry?.bitrateKbps ?? null;
  const isIdleWebRtc = isWebRtcStaticIdle(
    activeTransport,
    sessionStatus,
    telemetry.fps,
    bitrateKbps,
  );

  const positionStyle: React.CSSProperties = (() => {
    const hasMetrics =
      containerSize.width > 0 &&
      containerSize.height > 0 &&
      toolbarSize.width > 0 &&
      toolbarSize.height > 0;

    if (hasMetrics) {
      const W = containerSize.width;
      const H = containerSize.height;
      const tw = toolbarSize.width;
      const th = toolbarSize.height;
      const minLeft = EDGE_MARGIN_PX;
      const maxLeft = Math.max(minLeft, W - tw - EDGE_MARGIN_PX);
      const clampedLeft = Math.round(
        Math.max(minLeft, Math.min(maxLeft, activePos.ratio * W - tw / 2)),
      );
      const minTop = Math.max(EDGE_MARGIN_PX, safeTopInset);
      const maxTop = Math.max(minTop, H - th - EDGE_MARGIN_PX);
      const clampedTop = Math.round(
        Math.max(minTop, Math.min(maxTop, activePos.ratio * H - th / 2)),
      );

      switch (activePos.edge) {
        case "top":
          return {
            top: safeTopInset,
            left: clampedLeft,
          };
        case "bottom":
          return {
            bottom: 0,
            left: clampedLeft,
          };
        case "left":
          return {
            left: 0,
            top: clampedTop,
            maxHeight: Math.max(80, H - minTop - EDGE_MARGIN_PX),
          };
        case "right":
          return {
            right: 0,
            top: clampedTop,
            maxHeight: Math.max(80, H - minTop - EDGE_MARGIN_PX),
          };
      }
    }

    const pct = `${Math.round(activePos.ratio * 1000) / 10}%`;
    switch (activePos.edge) {
      case "top":
        return {
          top: safeTopInset,
          left: pct,
          transform: "translateX(-50%)",
        };
      case "bottom":
        return {
          bottom: 0,
          left: pct,
          transform: "translateX(-50%)",
        };
      case "left":
        return {
          left: 0,
          top: pct,
          transform: "translateY(-50%)",
        };
      case "right":
        return {
          right: 0,
          top: pct,
          transform: "translateY(-50%)",
        };
    }
  })();

  const edgeRadiusClass = (() => {
    switch (activePos.edge) {
      case "top":
        return safeTopInset > 0 ? "rounded-lg" : "rounded-b-lg border-t-0";
      case "bottom":
        return "rounded-t-lg border-b-0";
      case "left":
        return "rounded-r-lg border-l-0";
      case "right":
        return "rounded-l-lg border-r-0";
    }
  })();

  function getContainerBounds() {
    const offsetParent = rootRef.current?.offsetParent;
    if (offsetParent instanceof HTMLElement) {
      const r = offsetParent.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }
    return {
      left: 0,
      top: 0,
      width: typeof window !== "undefined" ? window.innerWidth : 1280,
      height: typeof window !== "undefined" ? window.innerHeight : 800,
    };
  }

  function handleGripPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    e.stopPropagation();
    e.preventDefault();
    cancelScheduledCollapse();

    const bounds = getContainerBounds();
    dragStateRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      bounds,
    };
    setDragging(true);

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore capture errors
    }
  }

  function handleGripPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.stopPropagation();

    const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
    if (dist >= 6) {
      drag.moved = true;
    }
    if (drag.moved) {
      setDragPreview(computeSnapEdge(e.clientX, e.clientY, drag.bounds));
    }
  }

  function finishGripDrag(e: React.PointerEvent<HTMLButtonElement>, cancelled = false) {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.stopPropagation();

    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore release errors
    }

    const wasMoved = drag.moved;
    dragStateRef.current = null;
    setDragging(false);

    if (!cancelled && wasMoved) {
      const snapped = computeSnapEdge(e.clientX, e.clientY, drag.bounds);
      setPosition(snapped);
      saveFloatingToolbarPosition(snapped);
      setDragPreview(null);
    } else {
      setDragPreview(null);
      if (!cancelled) {
        setExpanded((prev) => !prev);
      }
    }
  }

  const posClass = embedded ? "absolute" : "fixed";

  return (
    <>
      {/* Crisp snap-edge hairline guide while dragging */}
      {dragging && dragPreview && (
        <div
          aria-hidden="true"
          className={`pointer-events-none ${posClass} z-[54] bg-[#2563EB] ${
            dragPreview.edge === "top"
              ? "inset-x-0 top-0 h-1"
              : dragPreview.edge === "bottom"
                ? "inset-x-0 bottom-0 h-1"
                : dragPreview.edge === "left"
                  ? "inset-y-0 left-0 w-1"
                  : "inset-y-0 right-0 w-1"
          }`}
        />
      )}

      <div
        ref={rootRef}
        style={positionStyle}
        onMouseEnter={() => {
          if (dragging || dragStateRef.current) return;
          cancelScheduledCollapse();
          setExpanded(true);
        }}
        onMouseLeave={() => {
          if (!dragging && !dragStateRef.current) {
            scheduleCollapse();
          }
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerMove={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        className={`${posClass} z-[55] select-none ${
          isVertical
            ? "flex max-h-[calc(100%-1rem)] flex-col"
            : "max-w-[calc(100%-1rem)]"
        }`}
      >
        {!expanded ? (
          /* Ultra-slim edge-snapped collapsed pill */
          <button
            type="button"
            onPointerDown={handleGripPointerDown}
            onPointerMove={handleGripPointerMove}
            onPointerUp={(e) => finishGripDrag(e, false)}
            onPointerCancel={(e) => finishGripDrag(e, true)}
            aria-label="展开边缘悬浮工具栏（可拖拽吸附四边）"
            title="悬停/点击展开工具栏 · 拖拽吸附至屏幕四边"
            className={`flex items-center justify-center gap-1.5 border border-[#2C313D] bg-[#111318] text-zinc-200 shadow-[0_8px_24px_rgba(0,0,0,0.72)] transition-colors hover:border-[#3F4656] hover:text-white ${edgeRadiusClass} ${
              isVertical
                ? "w-7 flex-col px-1 py-2.5"
                : "h-6 flex-row px-2.5 py-0.5"
            }`}
          >
            {isVertical ? (
              <GripHorizontal className="h-3 w-3 shrink-0 text-zinc-500" />
            ) : (
              <GripVertical className="h-3 w-3 shrink-0 text-zinc-500" />
            )}

            <span className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass}`} />

            {!isVertical && (
              <span className="font-mono text-[10px] leading-none text-zinc-200">
                {telemetry.rttMs !== null ? `${telemetry.rttMs}ms` : "--ms"}
                {" · "}
                {isIdleWebRtc ? "静止" : `${telemetry.fps}fps`}
              </span>
            )}

            {isRecording && (
              <span
                className={`inline-flex items-center gap-1 rounded bg-rose-600 px-1 py-0.5 font-mono text-[9px] font-semibold leading-none text-white ${
                  isVertical ? "flex-col px-0.5 py-1" : ""
                }`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-white" />
                {!isVertical && formatRecordingDuration(recordingDurationSec)}
              </span>
            )}

            {viewOnly && (
              <span
                className="inline-flex items-center gap-0.5 rounded bg-amber-500/25 px-1 py-0.5 text-[9px] font-semibold leading-none text-amber-200"
                title="只读观察模式"
              >
                <Eye className="h-2.5 w-2.5 shrink-0" />
                {!isVertical && <span>只读</span>}
              </span>
            )}

            {isDesktopTarget && isBlockInputActive && (
              <span
                className="inline-flex items-center gap-0.5 rounded bg-amber-500/25 px-1 py-0.5 text-[9px] font-semibold leading-none text-amber-200"
                title="远端物理键鼠已锁定"
              >
                <Lock className="h-2.5 w-2.5 shrink-0" />
                {!isVertical && <span>键鼠锁</span>}
              </span>
            )}

            {isDesktopTarget && unreadChatCount > 0 && (
              <span
                className="inline-flex items-center gap-0.5 rounded bg-[#2563EB] px-1 py-0.5 font-mono text-[9px] font-semibold leading-none text-white"
                title={`${unreadChatCount} 条未读会话消息`}
              >
                <MessageSquare className="h-2.5 w-2.5 shrink-0" />
                {!isVertical && <span>{unreadChatCount > 99 ? "99+" : unreadChatCount}</span>}
              </span>
            )}
          </button>
        ) : (
          /* Expanded solid #111318 hardware action strip */
          <div
            role="toolbar"
            aria-label="沉浸模式悬浮控制栏"
            className={`flex items-center gap-1 border border-[#2C313D] bg-[#111318] p-1.5 text-zinc-200 shadow-[0_14px_36px_rgba(0,0,0,0.82)] ${edgeRadiusClass} ${
              isVertical
                ? "min-h-0 flex-col overflow-y-auto"
                : "max-w-full flex-row flex-wrap justify-center"
            }`}
          >
            {/* Drag-to-snap grip handle */}
            <button
              type="button"
              onPointerDown={handleGripPointerDown}
              onPointerMove={handleGripPointerMove}
              onPointerUp={(e) => finishGripDrag(e, false)}
              onPointerCancel={(e) => finishGripDrag(e, true)}
              title="拖拽吸附到上/下/左/右边缘 · 点击折叠"
              aria-label="拖拽吸附边缘或折叠工具栏"
              className={`flex shrink-0 cursor-grab items-center justify-center rounded-md border border-[#262A34] bg-[#181C24] text-zinc-400 hover:border-[#3F4656] hover:text-white active:cursor-grabbing ${
                isVertical ? "h-6 w-8" : "h-7 w-6"
              }`}
            >
              {isVertical ? (
                <GripHorizontal className="h-3.5 w-3.5" />
              ) : (
                <GripVertical className="h-3.5 w-3.5" />
              )}
            </button>

            {/* Live RTT/FPS indicator */}
            <div
              className={`flex shrink-0 items-center gap-1 rounded-md border border-[#232732] bg-[#0B0D12] font-mono text-[10px] text-zinc-300 ${
                isVertical ? "flex-col px-1 py-1 text-[9px]" : "h-7 px-2"
              }`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass}`} />
              <span>{telemetry.rttMs !== null ? `${telemetry.rttMs}ms` : "--"}</span>
              {!isVertical && (
                <>
                  <span className="text-zinc-600">·</span>
                  <span>{isIdleWebRtc ? "静止" : `${telemetry.fps}`}</span>
                </>
              )}
            </div>

            <ToolbarDivider vertical={isVertical} />

            {/* Expand full standard chrome */}
            <EdgeActionButton
              vertical={isVertical}
              icon={<PanelTopOpen className="h-3.5 w-3.5 text-sky-400" />}
              label="完整栏"
              title="展开完整顶部与底部控制栏"
              onClick={onExpandStandardChrome}
            />

            {/* View Style: adaptive / 1:1 / stretch */}
            <EdgeActionButton
              vertical={isVertical}
              icon={<Maximize2 className="h-3.5 w-3.5 text-blue-400" />}
              label={getViewStyleLabel(viewStyle)}
              title={`画面比例：${getViewStyleLabel(viewStyle)}（点击切换 适应 / 1:1 / 拉伸）`}
              active={viewStyle !== "adaptive"}
              onClick={onCycleViewStyle}
            />

            {/* View-Only lock */}
            <EdgeActionButton
              vertical={isVertical}
              icon={<Eye className="h-3.5 w-3.5" />}
              label={viewOnly ? "只读中" : "只读"}
              title={viewOnly ? "点击解除只读观察锁定" : "开启只读观察（禁止发送键鼠触控）"}
              tone={viewOnly ? "warn" : "default"}
              onClick={onToggleViewOnly}
            />

            {/* Local Session Recording */}
            <EdgeActionButton
              vertical={isVertical}
              icon={
                isRecording ? (
                  <Square className="h-3 w-3 fill-current" />
                ) : (
                  <Circle className="h-3.5 w-3.5 fill-rose-500 text-rose-500" />
                )
              }
              label={isRecording ? formatRecordingDuration(recordingDurationSec) : "录屏"}
              title={isRecording ? "停止并保存本地录屏" : "一键开始本地录屏"}
              tone={isRecording ? "danger" : "default"}
              monoLabel={isRecording}
              onClick={onToggleRecording}
            />

            {/* Android Navigation & Unlock Controls */}
            {!isDesktopTarget &&
              (onAndroidBack || onAndroidHome || onAndroidRecents || onOpenUnlock) && (
                <>
                  {onAndroidBack && (
                    <EdgeActionButton
                      vertical={isVertical}
                      icon={<ArrowLeft className="h-3.5 w-3.5" />}
                      label="返回"
                      title="返回上一页 (Back)"
                      onClick={onAndroidBack}
                    />
                  )}
                  {onAndroidHome && (
                    <EdgeActionButton
                      vertical={isVertical}
                      icon={<Home className="h-3.5 w-3.5" />}
                      label="桌面"
                      title="返回手机桌面 (Home)"
                      onClick={onAndroidHome}
                    />
                  )}
                  {onAndroidRecents && (
                    <EdgeActionButton
                      vertical={isVertical}
                      icon={<Layers className="h-3.5 w-3.5" />}
                      label="多任务"
                      title="打开多任务切换 (Recents)"
                      onClick={onAndroidRecents}
                    />
                  )}
                  {onOpenUnlock && (
                    <EdgeActionButton
                      vertical={isVertical}
                      icon={<Unlock className="h-3.5 w-3.5 text-emerald-400" />}
                      label="解锁"
                      title="锁屏解锁 / PIN 码解锁"
                      onClick={onOpenUnlock}
                    />
                  )}
                  <ToolbarDivider vertical={isVertical} />
                </>
              )}

            {/* Desktop Audio */}
            {isDesktopTarget && onToggleAudio && (
              <EdgeActionButton
                vertical={isVertical}
                icon={
                  audioMuted ? (
                    <VolumeX className="h-3.5 w-3.5" />
                  ) : (
                    <Volume2 className="h-3.5 w-3.5" />
                  )
                }
                label={audioMuted ? "静音" : "声音"}
                title={audioMuted ? "开启远端电脑声音" : "静音远端电脑声音"}
                tone={!audioMuted ? (isAudioLive ? "ok" : "active") : "default"}
                onClick={onToggleAudio}
              />
            )}

            {/* Desktop Quality / Codec / Volume Sheet */}
            {isDesktopTarget && onOpenQuality && (
              <EdgeActionButton
                vertical={isVertical}
                icon={<Gauge className="h-3.5 w-3.5 text-amber-400" />}
                label="画质"
                title="桌面画质、刷新率、编码器与音量"
                onClick={onOpenQuality}
              />
            )}

            {/* Desktop Relative Mouse Lock (Cmd/Ctrl+G) */}
            {isDesktopTarget && onTogglePointerLock && (
              <EdgeActionButton
                vertical={isVertical}
                icon={<Crosshair className="h-3.5 w-3.5 text-blue-400" />}
                label={isPointerLocked ? "已锁鼠标" : "相对鼠标"}
                title={
                  isPointerLocked
                    ? "退出相对鼠标锁定模式 (Esc / Cmd/Ctrl+G)"
                    : "开启相对鼠标锁定模式 (Cmd/Ctrl+G)"
                }
                active={isPointerLocked}
                disabled={pointerLockDisabled}
                onClick={onTogglePointerLock}
              />
            )}

            {/* Shortcuts / Input */}
            <EdgeActionButton
              vertical={isVertical}
              icon={<Keyboard className="h-3.5 w-3.5 text-sky-300" />}
              label={isDesktopTarget ? "快捷键" : "输入"}
              title={isDesktopTarget ? "打开桌面快捷键键盘" : "打开文字输入与剪贴板"}
              onClick={onOpenShortcuts}
            />

            {/* File Manager */}
            <EdgeActionButton
              vertical={isVertical}
              icon={<FolderOpen className="h-3.5 w-3.5 text-emerald-400" />}
              label="文件"
              title={isDesktopTarget ? "远端双向文件管理" : "P2P 文件直传"}
              onClick={onOpenFiles}
            />

            {/* Remote Terminal (Desktop) */}
            {isDesktopTarget && onOpenTerminal && (
              <EdgeActionButton
                vertical={isVertical}
                icon={<Terminal className="h-3.5 w-3.5 text-sky-400" />}
                label="终端"
                title={terminalDisabled ? "被控端未开放远程终端权限" : "打开远端交互式终端"}
                disabled={terminalDisabled}
                onClick={onOpenTerminal}
              />
            )}

            {/* Whiteboard Overlay (Desktop) */}
            {isDesktopTarget && onToggleWhiteboard && (
              <EdgeActionButton
                vertical={isVertical}
                icon={<PenTool className="h-3.5 w-3.5 text-amber-300" />}
                label={isWhiteboardActive ? "批注中" : "白板"}
                title={isWhiteboardActive ? "退出白板批注" : "开启远端白板批注"}
                active={isWhiteboardActive}
                onClick={onToggleWhiteboard}
              />
            )}

            {/* Block Remote Physical Input (Desktop) */}
            {isDesktopTarget && onToggleBlockInput && (
              <EdgeActionButton
                vertical={isVertical}
                icon={<Lock className="h-3.5 w-3.5" />}
                label={isBlockInputActive ? "键鼠已锁" : "锁键鼠"}
                title={
                  isBlockInputActive
                    ? "解除远端电脑物理键鼠锁定"
                    : "锁定远端电脑物理键鼠输入"
                }
                tone={isBlockInputActive ? "warn" : "default"}
                onClick={onToggleBlockInput}
              />
            )}

            {/* Session Chat (Desktop) */}
            {isDesktopTarget && onOpenChat && (
              <EdgeActionButton
                vertical={isVertical}
                icon={<MessageSquare className="h-3.5 w-3.5 text-blue-300" />}
                label="消息"
                title="打开会话消息"
                badge={unreadChatCount}
                onClick={onOpenChat}
              />
            )}

            {/* Privacy Screen (Desktop) / Black Screen (Android) */}
            <EdgeActionButton
              vertical={isVertical}
              icon={
                isDesktopTarget ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Moon className="h-3.5 w-3.5" />
                )
              }
              label={isDesktopTarget ? "隐私屏" : "黑屏"}
              title={
                isDesktopTarget
                  ? isPrivacyOrBlackScreenActive
                    ? "关闭远端隐私防窥黑屏"
                    : "开启远端隐私防窥黑屏"
                  : isPrivacyOrBlackScreenActive
                    ? "关闭手机伪装黑屏"
                    : "开启手机伪装黑屏"
              }
              active={isPrivacyOrBlackScreenActive}
              onClick={onTogglePrivacyOrBlackScreen}
            />

            {/* Always on top (Electron Desktop App) */}
            {desktopApp && onToggleAlwaysOnTop && (
              <EdgeActionButton
                vertical={isVertical}
                icon={<Pin className="h-3.5 w-3.5" />}
                label="置顶"
                title={isAlwaysOnTop ? "取消窗口置顶" : "窗口置顶浮窗"}
                active={isAlwaysOnTop}
                onClick={onToggleAlwaysOnTop}
              />
            )}

            {/* More / Settings */}
            <EdgeActionButton
              vertical={isVertical}
              icon={<SlidersHorizontal className="h-3.5 w-3.5" />}
              label="更多"
              title="画质、键位与电源控制"
              onClick={onOpenMore}
            />

            <ToolbarDivider vertical={isVertical} />

            {/* Exit */}
            <EdgeActionButton
              vertical={isVertical}
              icon={<LogOut className="h-3.5 w-3.5" />}
              label="退出"
              title="退出当前远程控制会话"
              tone="danger-subtle"
              onClick={onExit}
            />
          </div>
        )}
      </div>
    </>
  );
});

function ToolbarDivider({ vertical }: { vertical: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={
        vertical
          ? "my-0.5 h-px w-6 shrink-0 bg-[#262A34]"
          : "mx-0.5 h-4 w-px shrink-0 bg-[#262A34]"
      }
    />
  );
}

function EdgeActionButton({
  vertical,
  icon,
  label,
  title,
  active = false,
  disabled = false,
  badge = 0,
  tone = "default",
  monoLabel = false,
  onClick,
}: {
  vertical: boolean;
  icon: React.ReactNode;
  label: string;
  title: string;
  active?: boolean;
  disabled?: boolean;
  badge?: number;
  tone?: "default" | "active" | "ok" | "warn" | "danger" | "danger-subtle";
  monoLabel?: boolean;
  onClick: () => void;
}) {
  const effectiveTone = active && tone === "default" ? "active" : tone;
  const toneClass = (() => {
    switch (effectiveTone) {
      case "active":
        return "border-[#2563EB] bg-[#2563EB] text-white";
      case "ok":
        return "border-emerald-500/50 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30";
      case "warn":
        return "border-amber-400/60 bg-amber-500/25 text-amber-100 hover:bg-amber-500/35";
      case "danger":
        return "border-rose-500 bg-rose-600 text-white hover:bg-rose-500";
      case "danger-subtle":
        return "border-rose-500/35 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25";
      default:
        return "border-[#262A34] bg-[#191D26] text-zinc-200 hover:border-[#3F4656] hover:bg-[#232836] hover:text-white";
    }
  })();

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`relative inline-flex shrink-0 items-center justify-center rounded-md border text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${toneClass} ${
        vertical ? "h-8 w-8 flex-col p-0" : "h-7 gap-1 px-2"
      }`}
    >
      {icon}
      {!vertical && (
        <span className={monoLabel ? "font-mono" : ""}>{label}</span>
      )}
      {badge > 0 && (
        <span
          className={`inline-flex items-center justify-center rounded-full bg-rose-500 font-mono text-[9px] font-bold leading-none text-white ${
            vertical
              ? "absolute -right-1 -top-1 h-4 min-w-4 px-1"
              : "ml-0.5 h-4 min-w-4 px-1"
          }`}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}
