import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Battery,
  BatteryCharging,
  Bell,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  Clipboard,
  ClipboardCopy,
  CornerDownLeft,
  Delete,
  Download,
  EyeOff,
  FileUp,
  FolderOpen,
  Gauge,
  Hand,
  Home,
  Keyboard,
  Layers,
  Lock,
  LogOut,
  Maximize2,
  Monitor,
  Moon,
  MousePointer2,
  MousePointerClick,
  Package,
  Pin,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  Send,
  SlidersHorizontal,
  Smartphone,
  Sun,
  Trash2,
  Unlock,
  Upload,
  Volume1,
  Volume2,
  VolumeX,
  X,
  XCircle,
  Zap,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  DESKTOP_QUALITY_PRESETS,
  type ControlCommand,
  type DesktopPowerOperation,
  type DeviceSummary,
  type MediaFrame,
  type MouseButton,
  type RemoteKey,
  type StreamQuality,
  type TransportMode,
  type VideoCodecPreference,
} from "@velodeck/protocol";
import { DesktopShortcutBar } from "./DesktopShortcutBar";
import { RemoteFileBrowser } from "./RemoteFileBrowser";
import {
  getDesktopBridge,
  isDesktopApp,
  isMacDesktop,
  type DesktopWindowPreset,
  type DesktopWindowState,
} from "../desktop/bridge";
import {
  GestureRecognizer,
  clientPointToNormalized,
  computeContentRect,
  type NormalizedPoint,
} from "../gestures/GestureMapper";
import {
  detectDefaultApiBase,
  getAndroidApkDownloadUrl,
  getAndroidApkFileName,
  type ServerInfo,
} from "../state/auth";
import type { QualityPreset } from "../state/profiles";
import {
  isWebRtcStaticIdle,
  type DesktopQualityPreset,
  type FileTransferPurpose,
  type FileTransferState,
  type RemoteClient,
  type RemoteClientState,
  type SessionStatus,
  type SocketStatus,
  type WebRtcTelemetry,
} from "../transport/RemoteClient";

interface RemoteViewportProps {
  client: RemoteClient;
  clientState: RemoteClientState;
  device: DeviceSummary | null;
  apiBase?: string;
  authToken?: string;
  serverInfo?: ServerInfo;
  desktopWindowState?: DesktopWindowState;
  onToggleAlwaysOnTop?: () => Promise<void> | void;
  onSetWindowPreset?: (preset: DesktopWindowPreset) => Promise<void> | void;
  onOpenNewWindow?: () => Promise<void> | void;
  onShowToast?: (level: "info" | "warn" | "error", text: string) => void;
  suppressKeyboard?: boolean;
  onExit: () => void;
}

interface TouchRipple {
  id: number;
  x: number;
  y: number;
}

type UtilityPanel =
  | "none"
  | "unlock"
  | "text"
  | "files"
  | "shortcuts"
  | "quality"
  | "more";

type VideoElementWithRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const WHEEL_SWIPE_DURATION_MS = 65;
const WHEEL_SWIPE_COOLDOWN_MS = 80;
const KEYBOARD_TEXT_DEBOUNCE_MS = 100;
const DESKTOP_MOUSE_MOVE_THROTTLE_MS = 16;
const DESKTOP_TOUCH_LONG_PRESS_MS = 450;
const DESKTOP_TOUCH_MOVE_THRESHOLD_PX = 6;
const DESKTOP_DOUBLE_TAP_WINDOW_MS = 320;
const DESKTOP_DOUBLE_TAP_MAX_DIST_PX = 28;
const DESKTOP_TRACKPAD_SENSITIVITY = 1.4;
const DESKTOP_MULTI_CLICK_WINDOW_MS = 400;
const DESKTOP_MULTI_CLICK_MAX_DIST_PX = 8;
const DESKTOP_TWO_FINGER_SCROLL_SCALE = 2.2;
const DESKTOP_MIN_ZOOM = 1;
const DESKTOP_MAX_ZOOM = 4;
const DESKTOP_PINCH_DIST_THRESHOLD_PX = 14;
const DESKTOP_SCROLL_MID_THRESHOLD_PX = 12;

type DesktopTouchInputMode = "direct" | "trackpad";

interface DesktopTouchPointer {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startNorm: NormalizedPoint;
  lastNorm: NormalizedPoint;
  startTime: number;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function roundNorm(value: number): number {
  return Math.round(clamp01(value) * 10000) / 10000;
}

function mapMouseButton(button: number): MouseButton | null {
  if (button === 0) return "left";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return null;
}

function isLocalDesktopAppShortcut(e: KeyboardEvent): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey) return false;
  const lower = e.key.toLowerCase();
  if (e.shiftKey) {
    return (
      lower === "t" ||
      lower === "c" ||
      lower === "s" ||
      lower === "b" ||
      lower === "p"
    );
  }
  return (
    e.key === "1" ||
    e.key === "2" ||
    e.key === "3" ||
    lower === "n" ||
    e.key === ","
  );
}

const DESKTOP_PREVENT_KEYS = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Backspace",
  "Delete",
  "Escape",
  "Enter",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  " ",
]);

const DESKTOP_MOD_SHORTCUT_KEYS = new Set([
  "c",
  "v",
  "x",
  "z",
  "y",
  "a",
  "s",
  "f",
  "p",
  "w",
  "t",
  "l",
  "r",
  "k",
  "b",
  "i",
  "u",
]);

function shouldPreventDefaultForDesktopKey(e: KeyboardEvent): boolean {
  if (DESKTOP_PREVENT_KEYS.has(e.key) || e.code === "Space") {
    return true;
  }
  if (/^F([1-9]|1[0-2])$/.test(e.key)) {
    return true;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    if (DESKTOP_MOD_SHORTCUT_KEYS.has(e.key.toLowerCase())) {
      return true;
    }
  }
  if (e.altKey && (e.key === "Tab" || e.key.startsWith("Arrow"))) {
    return true;
  }
  return false;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  return target.isContentEditable || target.closest("[contenteditable='true']") !== null;
}

export function RemoteViewport({
  client,
  clientState,
  device,
  apiBase,
  authToken,
  serverInfo,
  desktopWindowState,
  onToggleAlwaysOnTop,
  onSetWindowPreset,
  onOpenNewWindow,
  onShowToast,
  suppressKeyboard = false,
  onExit,
}: RemoteViewportProps) {
  const desktopBridge = useMemo(() => getDesktopBridge(), []);
  const desktopApp = isDesktopApp();
  const macDesktop = isMacDesktop();

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const mediaStageRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounterRef = useRef(0);
  const apkAbortRef = useRef<AbortController | null>(null);

  const resolvedApiBase = useMemo(
    () =>
      apiBase ??
      (typeof window !== "undefined" ? detectDefaultApiBase(window.location) : ""),
    [apiBase],
  );

  const [dockExpanded, setDockExpanded] = useState(false);
  const [activePanel, setActivePanel] = useState<UtilityPanel>("none");
  const [ripples, setRipples] = useState<TouchRipple[]>([]);
  const [mouseNavHint, setMouseNavHint] = useState<string | null>(null);
  const [screenshotCopied, setScreenshotCopied] = useState(false);
  const [hasCanvasFrame, setHasCanvasFrame] = useState(false);
  const [hasVideoFrame, setHasVideoFrame] = useState(false);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [touchInputMode, setTouchInputMode] =
    useState<DesktopTouchInputMode>("direct");
  const [virtualCursor, setVirtualCursor] = useState<{ x: number; y: number }>({
    x: 0.5,
    y: 0.5,
  });
  const [surfaceSize, setSurfaceSize] = useState<{
    width: number;
    height: number;
  }>({ width: 0, height: 0 });

  const [pinValue, setPinValue] = useState("");
  const [inputText, setInputText] = useState("");
  const [submitAfterText, setSubmitAfterText] = useState(false);
  const [copiedRemoteClip, setCopiedRemoteClip] = useState(false);
  const [autoClipboardSync, setAutoClipboardSync] = useState(true);
  const [audioMuted, setAudioMuted] = useState(true);
  const [audioVolume, setAudioVolume] = useState(1);
  const [viewZoom, setViewZoom] = useState(1);
  const [viewPan, setViewPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [remoteBrowserDir, setRemoteBrowserDir] = useState("");
  const [pendingPowerOp, setPendingPowerOp] =
    useState<DesktopPowerOperation | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [autoInstallApk, setAutoInstallApk] = useState(true);
  const [apkFetchState, setApkFetchState] = useState<{
    active: boolean;
    loaded: number;
    total: number;
    error: string | null;
  }>({
    active: false,
    loaded: 0,
    total: 0,
    error: null,
  });

  const hasCanvasFrameRef = useRef(false);
  const hasVideoFrameRef = useRef(false);
  const activeSessionIdRef = useRef<string | null>(clientState.sessionId);
  activeSessionIdRef.current = clientState.sessionId;

  const rippleSeqRef = useRef(0);
  const rippleTimersRef = useRef(new Set<number>());
  const copiedClipTimerRef = useRef<number | null>(null);
  const mouseNavTimerRef = useRef<number | null>(null);
  const screenshotCopiedTimerRef = useRef<number | null>(null);
  const wheelAccumRef = useRef<{
    dx: number;
    dy: number;
    x: number;
    y: number;
    timer: number | null;
    lastDispatchedAt: number;
  }>({
    dx: 0,
    dy: 0,
    x: 0.5,
    y: 0.5,
    timer: null,
    lastDispatchedAt: 0,
  });
  const kbTextBufRef = useRef("");
  const kbTextTimerRef = useRef<number | null>(null);

  const isDesktopTarget = device?.deviceType === "desktop";
  const targetDeviceId = clientState.activeDeviceId ?? device?.deviceId ?? "";

  const virtualCursorRef = useRef<{ x: number; y: number }>({ x: 0.5, y: 0.5 });
  const viewZoomRef = useRef(1);
  const viewPanRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const lastSyncedClipAtRef = useRef(0);
  const lastLocalPushedClipRef = useRef("");
  const lastDesktopPointerNormRef = useRef<{ x: number; y: number }>({
    x: 0.5,
    y: 0.5,
  });
  const desktopMoveLastSentRef = useRef(0);
  const desktopMovePendingRef = useRef<{ x: number; y: number } | null>(null);
  const desktopMoveTimerRef = useRef<number | null>(null);
  const desktopPressedButtonsRef = useRef<
    Map<string, { pointerId: number; button: MouseButton; x: number; y: number }>
  >(new Map());
  const desktopClickTrackerRef = useRef<{
    button: MouseButton;
    at: number;
    clientX: number;
    clientY: number;
    count: number;
  } | null>(null);
  const desktopPressedKeysRef = useRef<
    Map<string, { code: string; key: string }>
  >(new Map());
  const desktopTouchRef = useRef<{
    pointers: Map<number, DesktopTouchPointer>;
    mode:
      | "idle"
      | "single"
      | "drag"
      | "two_finger_pending"
      | "two_finger_scroll"
      | "two_finger_zoom_pan"
      | "long_pressed";
    longPressTimer: number | null;
    lastTap: { at: number; clientX: number; clientY: number } | null;
    lastMoveSentAt: number;
    twoFingerStartDist: number;
    twoFingerLastDist: number;
    twoFingerStartMidX: number;
    twoFingerStartMidY: number;
    twoFingerMidX: number;
    twoFingerMidY: number;
    dragStarted: boolean;
  }>({
    pointers: new Map(),
    mode: "idle",
    longPressTimer: null,
    lastTap: null,
    lastMoveSentAt: 0,
    twoFingerStartDist: 0,
    twoFingerLastDist: 0,
    twoFingerStartMidX: 0,
    twoFingerStartMidY: 0,
    twoFingerMidX: 0,
    twoFingerMidY: 0,
    dragStarted: false,
  });

  const resetDesktopInputs = useCallback(() => {
    if (desktopMoveTimerRef.current !== null) {
      window.clearTimeout(desktopMoveTimerRef.current);
      desktopMoveTimerRef.current = null;
    }
    desktopMovePendingRef.current = null;

    for (const entry of desktopPressedButtonsRef.current.values()) {
      client.sendCommand(
        {
          action: "mouse_up",
          x: entry.x,
          y: entry.y,
          button: entry.button,
        },
        targetDeviceId,
      );
    }
    desktopPressedButtonsRef.current.clear();

    const touch = desktopTouchRef.current;
    if (touch.longPressTimer !== null) {
      window.clearTimeout(touch.longPressTimer);
      touch.longPressTimer = null;
    }
    if (touch.dragStarted) {
      const first = touch.pointers.values().next().value;
      const pt = first?.lastNorm ?? lastDesktopPointerNormRef.current;
      client.sendCommand(
        {
          action: "mouse_up",
          x: pt.x,
          y: pt.y,
          button: "left",
        },
        targetDeviceId,
      );
    }
    touch.pointers.clear();
    touch.mode = "idle";
    touch.dragStarted = false;

    for (const entry of desktopPressedKeysRef.current.values()) {
      client.sendCommand(
        {
          action: "key_event",
          phase: "up",
          code: entry.code,
          key: entry.key,
          modifiers: { ctrl: false, alt: false, shift: false, meta: false },
        },
        targetDeviceId,
      );
    }
    desktopPressedKeysRef.current.clear();
  }, [client, targetDeviceId]);

  // Track surface bounds for crisp virtual cursor placement in desktop trackpad mode
  useEffect(() => {
    if (!isDesktopTarget) return;
    const el = surfaceRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      setSurfaceSize((prev) =>
        prev.width === rect.width && prev.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height },
      );
    };
    updateSize();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateSize);
      observer.observe(el);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, [isDesktopTarget]);

  const markVideoFrameReady = useCallback(() => {
    if (!hasVideoFrameRef.current) {
      hasVideoFrameRef.current = true;
      setHasVideoFrame(true);
    }
  }, []);

  // Reconnect countdown at 1Hz (P2)
  useEffect(() => {
    if (!clientState.nextReconnectAt) return;
    setNowTs(Date.now());
    const id = window.setInterval(() => setNowTs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [clientState.nextReconnectAt]);

  // Clean up transient timers (wheel, ripples, clipboard badge, mouse hint, screenshot flash) on unmount
  useEffect(() => {
    return () => {
      if (wheelAccumRef.current.timer !== null) {
        window.clearTimeout(wheelAccumRef.current.timer);
        wheelAccumRef.current.timer = null;
      }
      if (copiedClipTimerRef.current !== null) {
        window.clearTimeout(copiedClipTimerRef.current);
        copiedClipTimerRef.current = null;
      }
      if (mouseNavTimerRef.current !== null) {
        window.clearTimeout(mouseNavTimerRef.current);
        mouseNavTimerRef.current = null;
      }
      if (screenshotCopiedTimerRef.current !== null) {
        window.clearTimeout(screenshotCopiedTimerRef.current);
        screenshotCopiedTimerRef.current = null;
      }
      if (kbTextTimerRef.current !== null) {
        window.clearTimeout(kbTextTimerRef.current);
        kbTextTimerRef.current = null;
      }
      if (desktopMoveTimerRef.current !== null) {
        window.clearTimeout(desktopMoveTimerRef.current);
        desktopMoveTimerRef.current = null;
      }
      if (desktopTouchRef.current.longPressTimer !== null) {
        window.clearTimeout(desktopTouchRef.current.longPressTimer);
        desktopTouchRef.current.longPressTimer = null;
      }
      for (const timerId of rippleTimersRef.current) {
        window.clearTimeout(timerId);
      }
      rippleTimersRef.current.clear();
      apkAbortRef.current?.abort();
      apkAbortRef.current = null;
    };
  }, []);

  // Reset first-frame gates on sessionId / mediaStream change (P0-2)
  useEffect(() => {
    hasVideoFrameRef.current = false;
    setHasVideoFrame(false);
  }, [clientState.sessionId, clientState.mediaStream]);

  useEffect(() => {
    hasCanvasFrameRef.current = false;
    setHasCanvasFrame(false);
  }, [clientState.sessionId]);

  // Reset desktop zoom, audio mute, and power confirmation when target device or session changes
  useEffect(() => {
    viewZoomRef.current = 1;
    viewPanRef.current = { x: 0, y: 0 };
    setViewZoom(1);
    setViewPan({ x: 0, y: 0 });
    setPendingPowerOp(null);
  }, [clientState.sessionId, isDesktopTarget]);

  useEffect(() => {
    setAudioMuted(true);
    setRemoteBrowserDir("");
    lastSyncedClipAtRef.current = 0;
    lastLocalPushedClipRef.current = "";
  }, [targetDeviceId]);

  // Keep <video> muted & volume synchronized (Android stays strictly muted)
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    videoEl.muted = !isDesktopTarget || audioMuted;
    videoEl.volume = Math.max(0, Math.min(1, audioVolume));
  }, [isDesktopTarget, audioMuted, audioVolume, clientState.mediaStream]);

  // Auto two-way clipboard sync for desktop targets: remote -> local system clipboard
  useEffect(() => {
    if (
      !isDesktopTarget ||
      !autoClipboardSync ||
      !clientState.remoteClipboard ||
      clientState.lastClipboardAt <= 0 ||
      clientState.lastClipboardAt === lastSyncedClipAtRef.current
    ) {
      return;
    }
    const text = clientState.remoteClipboard;
    lastSyncedClipAtRef.current = clientState.lastClipboardAt;
    lastLocalPushedClipRef.current = text;

    let cancelled = false;
    const writeToLocal = async () => {
      try {
        if (typeof desktopBridge?.writeClipboardText === "function") {
          const ok = await desktopBridge.writeClipboardText(text);
          if (ok && !cancelled) {
            onShowToast?.("info", "已自动同步远端剪贴板");
          }
          return;
        }
        if (
          typeof navigator !== "undefined" &&
          navigator.clipboard &&
          typeof navigator.clipboard.writeText === "function" &&
          (typeof document === "undefined" || document.hasFocus())
        ) {
          await navigator.clipboard.writeText(text);
          if (!cancelled) {
            onShowToast?.("info", "已自动同步远端剪贴板");
          }
        }
      } catch {
        // Browser may reject clipboard write without active focus/permission
      }
    };

    void writeToLocal();
    return () => {
      cancelled = true;
    };
  }, [
    isDesktopTarget,
    autoClipboardSync,
    clientState.remoteClipboard,
    clientState.lastClipboardAt,
    desktopBridge,
    onShowToast,
  ]);

  // Auto two-way clipboard sync (Electron Desktop App only, zero prompt): local -> remote on focus
  useEffect(() => {
    if (
      !isDesktopTarget ||
      !autoClipboardSync ||
      typeof desktopBridge?.readClipboardText !== "function"
    ) {
      return;
    }
    const syncLocalToRemote = async () => {
      if (clientState.sessionStatus !== "streaming" || !targetDeviceId) return;
      try {
        const localText = await desktopBridge.readClipboardText!();
        if (
          localText &&
          localText !== lastLocalPushedClipRef.current &&
          localText !== clientState.remoteClipboard
        ) {
          lastLocalPushedClipRef.current = localText;
          client.sendCommand({ action: "clipboard_set", text: localText }, targetDeviceId);
        }
      } catch {
        // Ignore clipboard read failures
      }
    };
    window.addEventListener("focus", syncLocalToRemote);
    return () => {
      window.removeEventListener("focus", syncLocalToRemote);
    };
  }, [
    isDesktopTarget,
    autoClipboardSync,
    desktopBridge,
    client,
    targetDeviceId,
    clientState.sessionStatus,
    clientState.remoteClipboard,
  ]);

  // Reset stuck drag overlay if user cancels drag outside window or window loses focus
  useEffect(() => {
    const resetDragOverlay = () => {
      dragCounterRef.current = 0;
      setIsDraggingFile(false);
    };
    window.addEventListener("dragend", resetDragOverlay);
    window.addEventListener("blur", resetDragOverlay);
    window.addEventListener("drop", resetDragOverlay);
    return () => {
      window.removeEventListener("dragend", resetDragOverlay);
      window.removeEventListener("blur", resetDragOverlay);
      window.removeEventListener("drop", resetDragOverlay);
    };
  }, []);

  // Attach WebRTC MediaStream + observe first decoded video frame via rVFC when available (P0-2)
  useEffect(() => {
    const videoEl = videoRef.current as VideoElementWithRVFC | null;
    if (!videoEl) return;

    let cancelled = false;
    let rvfcHandle: number | null = null;
    if (clientState.mediaStream) {
      videoEl.srcObject = clientState.mediaStream;
      void videoEl.play().catch(() => undefined);

      if (videoEl.readyState >= 2 && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
        markVideoFrameReady();
      } else if (typeof videoEl.requestVideoFrameCallback === "function") {
        const onFrame = () => {
          rvfcHandle = null;
          if (cancelled) return;
          if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
            markVideoFrameReady();
          } else if (typeof videoEl.requestVideoFrameCallback === "function") {
            rvfcHandle = videoEl.requestVideoFrameCallback(onFrame);
          }
        };
        rvfcHandle = videoEl.requestVideoFrameCallback(onFrame);
      }
    } else {
      videoEl.srcObject = null;
    }

    return () => {
      cancelled = true;
      if (
        rvfcHandle !== null &&
        typeof videoEl.cancelVideoFrameCallback === "function"
      ) {
        try {
          videoEl.cancelVideoFrameCallback(rvfcHandle);
        } catch {
          // Ignore cancel errors
        }
      }
    };
  }, [clientState.mediaStream, clientState.sessionId, markVideoFrameReady]);

  // P1-7: WS-JPEG frame rendering with sessionId guard, zero extra payload copy, and cached 2D context
  useEffect(() => {
    let decoding = false;
    let pendingFrame: MediaFrame | null = null;
    let disposed = false;

    const getCanvasContext = (canvas: HTMLCanvasElement): CanvasRenderingContext2D | null => {
      if (canvasCtxRef.current && canvasCtxRef.current.canvas === canvas) {
        return canvasCtxRef.current;
      }
      const ctx =
        canvas.getContext("2d", { alpha: false, desynchronized: true }) ??
        canvas.getContext("2d");
      canvasCtxRef.current = ctx;
      return ctx;
    };

    const isStaleSessionFrame = (frame: MediaFrame): boolean => {
      const activeId = activeSessionIdRef.current;
      return Boolean(frame.sessionId && activeId && frame.sessionId !== activeId);
    };

    const markCanvasReady = () => {
      if (!hasCanvasFrameRef.current) {
        hasCanvasFrameRef.current = true;
        setHasCanvasFrame(true);
      }
    };

    const renderFrame = async (frame: MediaFrame) => {
      if (disposed || isStaleSessionFrame(frame)) return;
      decoding = true;
      try {
        const blob = new Blob([frame.payload as BlobPart], { type: "image/jpeg" });
        const canvas = canvasRef.current;
        if (!canvas || disposed || isStaleSessionFrame(frame)) return;

        if (typeof createImageBitmap === "function") {
          const bitmap = await createImageBitmap(blob);
          if (disposed || isStaleSessionFrame(frame)) {
            bitmap.close();
            return;
          }
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          const ctx = getCanvasContext(canvas);
          ctx?.drawImage(bitmap, 0, 0);
          bitmap.close();
          markCanvasReady();
        } else {
          const url = URL.createObjectURL(blob);
          try {
            const img = await new Promise<HTMLImageElement>((resolve, reject) => {
              const el = new Image();
              el.onload = () => resolve(el);
              el.onerror = reject;
              el.src = url;
            });
            if (!disposed && !isStaleSessionFrame(frame)) {
              if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
              }
              const ctx = getCanvasContext(canvas);
              ctx?.drawImage(img, 0, 0);
              markCanvasReady();
            }
          } finally {
            URL.revokeObjectURL(url);
          }
        }
      } catch {
        // Ignore corrupted frame
      } finally {
        decoding = false;
        if (!disposed && pendingFrame) {
          const next = pendingFrame;
          pendingFrame = null;
          void renderFrame(next);
        }
      }
    };

    const unsubscribe = client.onFrame((frame) => {
      if (isStaleSessionFrame(frame)) return;
      if (decoding) {
        pendingFrame = frame;
        return;
      }
      void renderFrame(frame);
    });

    return () => {
      disposed = true;
      pendingFrame = null;
      canvasCtxRef.current = null;
      unsubscribe();
    };
  }, [client]);

  const recognizer = useMemo(() => {
    return new GestureRecognizer({
      onCommand: (cmd: ControlCommand) => {
        client.sendCommand(cmd);
      },
    });
  }, [client]);

  useEffect(() => {
    return () => {
      recognizer.dispose();
    };
  }, [recognizer]);

  const isWebRtcVisible =
    clientState.activeTransport === "webrtc" &&
    clientState.mediaStream !== null &&
    hasVideoFrame;

  const isStreamingReady =
    clientState.socketStatus === "connected" &&
    clientState.sessionStatus === "streaming" &&
    (isWebRtcVisible || hasCanvasFrame);

  const showOverlay = !isStreamingReady;

  // P1-4 & P1-5: Visibility recovery (resume video, snap live edge, request keyframe) + gesture safety resets
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        recognizer.reset();
        if (isDesktopTarget) {
          resetDesktopInputs();
        }
        return;
      }
      const videoEl = videoRef.current;
      if (videoEl && clientState.mediaStream) {
        if (videoEl.paused) {
          void videoEl.play().catch(() => undefined);
        }
        try {
          if (videoEl.buffered && videoEl.buffered.length > 0) {
            const liveEdge = videoEl.buffered.end(videoEl.buffered.length - 1);
            if (Number.isFinite(liveEdge) && liveEdge - videoEl.currentTime > 0.3) {
              videoEl.currentTime = Math.max(0, liveEdge - 0.05);
            }
          }
        } catch {
          // Ignore seek errors on live MediaStream
        }
      }
      if (
        clientState.activeTransport === "webrtc" &&
        clientState.sessionStatus === "streaming"
      ) {
        client.requestKeyframe();
      }
    };

    const handleWindowBlur = () => {
      recognizer.reset();
      if (isDesktopTarget) {
        resetDesktopInputs();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [
    client,
    clientState.mediaStream,
    clientState.activeTransport,
    clientState.sessionStatus,
    recognizer,
    isDesktopTarget,
    resetDesktopInputs,
  ]);

  // P1-5: Reset recognizer & desktop held inputs on overlay appearance or session switch
  useEffect(() => {
    if (showOverlay) {
      recognizer.reset();
      if (isDesktopTarget) {
        resetDesktopInputs();
      }
    }
  }, [showOverlay, recognizer, isDesktopTarget, resetDesktopInputs]);

  useEffect(() => {
    recognizer.reset();
    if (isDesktopTarget) {
      resetDesktopInputs();
    }
  }, [clientState.sessionId, recognizer, isDesktopTarget, resetDesktopInputs]);

  // Desktop target: Full keydown / keyup forwarding with modifier state & local Electron shortcut guard
  useEffect(() => {
    if (
      !isDesktopTarget ||
      !isStreamingReady ||
      (activePanel !== "none" && activePanel !== "shortcuts") ||
      suppressKeyboard
    ) {
      if (isDesktopTarget && desktopPressedKeysRef.current.size > 0) {
        for (const entry of desktopPressedKeysRef.current.values()) {
          client.sendCommand(
            {
              action: "key_event",
              phase: "up",
              code: entry.code,
              key: entry.key,
              modifiers: { ctrl: false, alt: false, shift: false, meta: false },
            },
            targetDeviceId,
          );
        }
        desktopPressedKeysRef.current.clear();
      }
      return;
    }

    const handleDesktopKeyDown = (e: KeyboardEvent) => {
      if (
        isEditableTarget(e.target) ||
        e.isComposing ||
        e.key === "Process" ||
        e.keyCode === 229
      ) {
        return;
      }
      if (desktopApp && isLocalDesktopAppShortcut(e)) {
        return;
      }
      if (shouldPreventDefaultForDesktopKey(e)) {
        e.preventDefault();
      }

      desktopPressedKeysRef.current.set(e.code, { code: e.code, key: e.key });
      client.sendCommand(
        {
          action: "key_event",
          phase: "down",
          code: e.code,
          key: e.key,
          modifiers: {
            ctrl: e.ctrlKey,
            alt: e.altKey,
            shift: e.shiftKey,
            meta: e.metaKey,
          },
        },
        targetDeviceId,
      );
    };

    const handleDesktopKeyUp = (e: KeyboardEvent) => {
      if (
        isEditableTarget(e.target) ||
        e.isComposing ||
        e.key === "Process" ||
        e.keyCode === 229
      ) {
        return;
      }
      if (desktopApp && isLocalDesktopAppShortcut(e)) {
        return;
      }
      if (shouldPreventDefaultForDesktopKey(e)) {
        e.preventDefault();
      }

      desktopPressedKeysRef.current.delete(e.code);
      client.sendCommand(
        {
          action: "key_event",
          phase: "up",
          code: e.code,
          key: e.key,
          modifiers: {
            ctrl: e.ctrlKey,
            alt: e.altKey,
            shift: e.shiftKey,
            meta: e.metaKey,
          },
        },
        targetDeviceId,
      );
    };

    window.addEventListener("keydown", handleDesktopKeyDown);
    window.addEventListener("keyup", handleDesktopKeyUp);
    return () => {
      window.removeEventListener("keydown", handleDesktopKeyDown);
      window.removeEventListener("keyup", handleDesktopKeyUp);
      for (const entry of desktopPressedKeysRef.current.values()) {
        client.sendCommand(
          {
            action: "key_event",
            phase: "up",
            code: entry.code,
            key: entry.key,
            modifiers: { ctrl: false, alt: false, shift: false, meta: false },
          },
          targetDeviceId,
        );
      }
      desktopPressedKeysRef.current.clear();
    };
  }, [
    client,
    targetDeviceId,
    isDesktopTarget,
    desktopApp,
    isStreamingReady,
    activePanel,
    suppressKeyboard,
  ]);

  // P1-6: Android target desktop keyboard & paste shortcuts when streaming and no utility sheet is open
  useEffect(() => {
    if (
      isDesktopTarget ||
      !isStreamingReady ||
      activePanel !== "none" ||
      suppressKeyboard
    ) {
      if (kbTextTimerRef.current !== null) {
        window.clearTimeout(kbTextTimerRef.current);
        kbTextTimerRef.current = null;
      }
      kbTextBufRef.current = "";
      return;
    }

    const flushBufferedText = () => {
      if (kbTextTimerRef.current !== null) {
        window.clearTimeout(kbTextTimerRef.current);
        kbTextTimerRef.current = null;
      }
      const text = kbTextBufRef.current;
      kbTextBufRef.current = "";
      if (text) {
        client.sendCommand({ action: "text", text }, targetDeviceId);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || e.isComposing) return;

      if (e.key === "Escape") {
        e.preventDefault();
        flushBufferedText();
        if (dockExpanded) {
          setDockExpanded(false);
        } else {
          client.sendCommand({ action: "key", key: "back" }, targetDeviceId);
        }
        return;
      }

      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        flushBufferedText();
        client.sendCommand({ action: "key", key: "home" }, targetDeviceId);
        return;
      }

      if (e.key === "Backspace" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        flushBufferedText();
        client.sendCommand({ action: "key", key: "backspace" }, targetDeviceId);
        return;
      }

      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        flushBufferedText();
        client.sendCommand({ action: "key", key: "enter" }, targetDeviceId);
        return;
      }

      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        kbTextBufRef.current += e.key;
        if (kbTextTimerRef.current !== null) {
          window.clearTimeout(kbTextTimerRef.current);
        }
        kbTextTimerRef.current = window.setTimeout(
          flushBufferedText,
          KEYBOARD_TEXT_DEBOUNCE_MS,
        );
      }
    };

    const handlePaste = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!text) return;
      e.preventDefault();
      flushBufferedText();
      client.sendCommand({ action: "text", text }, targetDeviceId);
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("paste", handlePaste);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("paste", handlePaste);
      if (kbTextTimerRef.current !== null) {
        window.clearTimeout(kbTextTimerRef.current);
        kbTextTimerRef.current = null;
      }
      kbTextBufRef.current = "";
    };
  }, [
    client,
    targetDeviceId,
    isDesktopTarget,
    isStreamingReady,
    activePanel,
    dockExpanded,
    suppressKeyboard,
  ]);

  // P0-3: Always read live rendered content dimensions directly from active <video> or <canvas>
  function getRenderedContentSize(): { width: number; height: number } {
    const video = videoRef.current;
    if (
      clientState.activeTransport === "webrtc" &&
      clientState.mediaStream !== null &&
      video &&
      video.videoWidth > 0 &&
      video.videoHeight > 0
    ) {
      return { width: video.videoWidth, height: video.videoHeight };
    }
    const canvas = canvasRef.current;
    if (
      clientState.activeTransport === "ws-jpeg" &&
      hasCanvasFrameRef.current &&
      canvas &&
      canvas.width > 0 &&
      canvas.height > 0
    ) {
      return { width: canvas.width, height: canvas.height };
    }
    return {
      width: clientState.screenWidth || 1080,
      height: clientState.screenHeight || 2400,
    };
  }

  function addRipple(clientX: number, clientY: number) {
    const surface = surfaceRef.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    const id = ++rippleSeqRef.current;
    setRipples((prev) => [
      ...prev.slice(-6),
      { id, x: clientX - rect.left, y: clientY - rect.top },
    ]);
    const timerId = window.setTimeout(() => {
      rippleTimersRef.current.delete(timerId);
      setRipples((prev) => prev.filter((r) => r.id !== id));
    }, 420);
    rippleTimersRef.current.add(timerId);
  }

  function flashMouseNavHint(label: string) {
    setMouseNavHint(label);
    if (mouseNavTimerRef.current !== null) {
      window.clearTimeout(mouseNavTimerRef.current);
    }
    mouseNavTimerRef.current = window.setTimeout(() => {
      mouseNavTimerRef.current = null;
      setMouseNavHint(null);
    }, 850);
  }

  function buildPointerInput(e: React.PointerEvent<HTMLDivElement>) {
    const surface = surfaceRef.current;
    if (!surface) return null;
    const rect = surface.getBoundingClientRect();
    const content = getRenderedContentSize();
    return {
      pointerId: e.pointerId,
      clientX: e.clientX,
      clientY: e.clientY,
      containerRect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
      contentW: content.width,
      contentH: content.height,
      timestampMs: Date.now(),
    };
  }

  function getActiveMediaElement(): HTMLElement | null {
    if (!isDesktopTarget) {
      return surfaceRef.current;
    }
    if (
      clientState.activeTransport === "webrtc" &&
      clientState.mediaStream !== null &&
      videoRef.current
    ) {
      return videoRef.current;
    }
    if (
      clientState.activeTransport === "ws-jpeg" &&
      hasCanvasFrameRef.current &&
      canvasRef.current
    ) {
      return canvasRef.current;
    }
    return mediaStageRef.current ?? surfaceRef.current;
  }

  function clampDesktopPan(
    panX: number,
    panY: number,
    zoom: number,
  ): { x: number; y: number } {
    const surface = surfaceRef.current;
    if (!surface || zoom <= 1.001) {
      return { x: 0, y: 0 };
    }
    const sRect = surface.getBoundingClientRect();
    const content = getRenderedContentSize();
    const baseBox = computeContentRect(
      sRect.width,
      sRect.height,
      content.width,
      content.height,
    );
    const maxPanX = Math.max(0, (baseBox.width * zoom - sRect.width) / 2);
    const maxPanY = Math.max(0, (baseBox.height * zoom - sRect.height) / 2);
    return {
      x: Math.max(-maxPanX, Math.min(maxPanX, panX)),
      y: Math.max(-maxPanY, Math.min(maxPanY, panY)),
    };
  }

  function applyDesktopZoomAndPan(
    nextZoomRaw: number,
    nextPanX: number,
    nextPanY: number,
  ) {
    const nextZoom = Math.max(
      DESKTOP_MIN_ZOOM,
      Math.min(DESKTOP_MAX_ZOOM, Math.round(nextZoomRaw * 100) / 100),
    );
    const clamped =
      nextZoom <= 1.001
        ? { x: 0, y: 0 }
        : clampDesktopPan(nextPanX, nextPanY, nextZoom);
    viewZoomRef.current = nextZoom;
    viewPanRef.current = clamped;
    setViewZoom(nextZoom);
    setViewPan(clamped);
  }

  function resetDesktopZoom() {
    applyDesktopZoomAndPan(1, 0, 0);
  }

  function mapClientToNormalized(
    clientX: number,
    clientY: number,
  ): NormalizedPoint | null {
    const targetEl = getActiveMediaElement();
    if (!targetEl) return null;
    // When zoomed/panned, video/canvas/mediaStage getBoundingClientRect() automatically reflects
    // the CSS transform (translate3d + scale), mapping every tap/click to the exact desktop pixel.
    const rect = targetEl.getBoundingClientRect();
    const content = getRenderedContentSize();
    return clientPointToNormalized(
      clientX,
      clientY,
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      content.width,
      content.height,
    );
  }

  function getSurfaceContentBox(): {
    rect: DOMRect;
    contentBox: { left: number; top: number; width: number; height: number };
  } | null {
    const targetEl = getActiveMediaElement();
    if (!targetEl) return null;
    const rect = targetEl.getBoundingClientRect();
    const content = getRenderedContentSize();
    const contentBox = computeContentRect(
      rect.width,
      rect.height,
      content.width,
      content.height,
    );
    return { rect, contentBox };
  }

  function addRippleAtNormalized(normX: number, normY: number) {
    const box = getSurfaceContentBox();
    if (!box) return;
    const clientX = box.rect.left + box.contentBox.left + normX * box.contentBox.width;
    const clientY = box.rect.top + box.contentBox.top + normY * box.contentBox.height;
    addRipple(clientX, clientY);
  }

  function sendDesktopMouseMoveThrottled(x: number, y: number, immediate = false) {
    lastDesktopPointerNormRef.current = { x, y };
    const now = Date.now();
    const elapsed = now - desktopMoveLastSentRef.current;
    if (immediate || elapsed >= DESKTOP_MOUSE_MOVE_THROTTLE_MS) {
      if (desktopMoveTimerRef.current !== null) {
        window.clearTimeout(desktopMoveTimerRef.current);
        desktopMoveTimerRef.current = null;
      }
      desktopMovePendingRef.current = null;
      desktopMoveLastSentRef.current = now;
      client.sendCommand({ action: "mouse_move", x, y }, targetDeviceId);
      return;
    }

    desktopMovePendingRef.current = { x, y };
    if (desktopMoveTimerRef.current === null) {
      desktopMoveTimerRef.current = window.setTimeout(() => {
        desktopMoveTimerRef.current = null;
        const pending = desktopMovePendingRef.current;
        desktopMovePendingRef.current = null;
        if (!pending) return;
        desktopMoveLastSentRef.current = Date.now();
        client.sendCommand(
          { action: "mouse_move", x: pending.x, y: pending.y },
          targetDeviceId,
        );
      }, Math.max(1, DESKTOP_MOUSE_MOVE_THROTTLE_MS - elapsed));
    }
  }

  function flushDesktopMoveTimer() {
    if (desktopMoveTimerRef.current !== null) {
      window.clearTimeout(desktopMoveTimerRef.current);
      desktopMoveTimerRef.current = null;
    }
    desktopMovePendingRef.current = null;
  }

  function handleDesktopTouchDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!isStreamingReady) return;
    const norm = mapClientToNormalized(e.clientX, e.clientY);
    if (!norm) return;
    if (touchInputMode === "direct" && !norm.inside && desktopTouchRef.current.pointers.size === 0) {
      return;
    }

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore capture failures
    }

    const touch = desktopTouchRef.current;
    const now = Date.now();
    const tracked: DesktopTouchPointer = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      startNorm: norm,
      lastNorm: norm,
      startTime: now,
    };
    touch.pointers.set(e.pointerId, tracked);

    if (touch.pointers.size === 1) {
      touch.mode = "single";
      touch.dragStarted = false;
      if (touch.longPressTimer !== null) {
        window.clearTimeout(touch.longPressTimer);
      }
      touch.longPressTimer = window.setTimeout(() => {
        touch.longPressTimer = null;
        if (touch.pointers.size !== 1 || touch.mode !== "single") return;
        touch.mode = "long_pressed";
        if (touchInputMode === "trackpad") {
          const vc = virtualCursorRef.current;
          addRippleAtNormalized(vc.x, vc.y);
          flashMouseNavHint("右键");
          client.sendCommand(
            { action: "mouse_down", x: vc.x, y: vc.y, button: "right", clickCount: 1 },
            targetDeviceId,
          );
          client.sendCommand(
            { action: "mouse_up", x: vc.x, y: vc.y, button: "right" },
            targetDeviceId,
          );
        } else {
          addRipple(tracked.startX, tracked.startY);
          flashMouseNavHint("右键");
          lastDesktopPointerNormRef.current = { x: tracked.startNorm.x, y: tracked.startNorm.y };
          client.sendCommand(
            {
              action: "long_press",
              x: tracked.startNorm.x,
              y: tracked.startNorm.y,
              durationMs: DESKTOP_TOUCH_LONG_PRESS_MS,
            },
            targetDeviceId,
          );
        }
      }, DESKTOP_TOUCH_LONG_PRESS_MS);
    } else if (touch.pointers.size === 2) {
      if (touch.longPressTimer !== null) {
        window.clearTimeout(touch.longPressTimer);
        touch.longPressTimer = null;
      }
      if (touch.dragStarted) {
        touch.dragStarted = false;
        const first = touch.pointers.values().next().value;
        const pt = first?.lastNorm ?? lastDesktopPointerNormRef.current;
        client.sendCommand(
          { action: "mouse_up", x: pt.x, y: pt.y, button: "left" },
          targetDeviceId,
        );
      }
      const pts = Array.from(touch.pointers.values());
      const dist = Math.hypot(
        pts[0]!.lastX - pts[1]!.lastX,
        pts[0]!.lastY - pts[1]!.lastY,
      );
      const midX = (pts[0]!.lastX + pts[1]!.lastX) / 2;
      const midY = (pts[0]!.lastY + pts[1]!.lastY) / 2;
      touch.twoFingerStartDist = Math.max(1, dist);
      touch.twoFingerLastDist = Math.max(1, dist);
      touch.twoFingerStartMidX = midX;
      touch.twoFingerStartMidY = midY;
      touch.twoFingerMidX = midX;
      touch.twoFingerMidY = midY;
      // When already zoomed in, 2-finger gestures seamlessly pan & pinch-zoom;
      // at 1x fit-to-screen, classify pinch-scale change vs parallel 2-finger scroll.
      touch.mode =
        viewZoomRef.current > 1.05 ? "two_finger_zoom_pan" : "two_finger_pending";
    } else {
      if (touch.longPressTimer !== null) {
        window.clearTimeout(touch.longPressTimer);
        touch.longPressTimer = null;
      }
    }
  }

  function handleDesktopTouchMove(e: React.PointerEvent<HTMLDivElement>) {
    const touch = desktopTouchRef.current;
    const pointer = touch.pointers.get(e.pointerId);
    if (!pointer || !isStreamingReady) return;

    const norm = mapClientToNormalized(e.clientX, e.clientY) ?? pointer.lastNorm;
    const stepDx = e.clientX - pointer.lastX;
    const stepDy = e.clientY - pointer.lastY;
    pointer.lastX = e.clientX;
    pointer.lastY = e.clientY;
    pointer.lastNorm = norm;

    if (
      (touch.mode === "two_finger_pending" ||
        touch.mode === "two_finger_scroll" ||
        touch.mode === "two_finger_zoom_pan") &&
      touch.pointers.size >= 2
    ) {
      const pts = Array.from(touch.pointers.values());
      const currDist = Math.max(
        1,
        Math.hypot(pts[0]!.lastX - pts[1]!.lastX, pts[0]!.lastY - pts[1]!.lastY),
      );
      const midX = (pts[0]!.lastX + pts[1]!.lastX) / 2;
      const midY = (pts[0]!.lastY + pts[1]!.lastY) / 2;

      if (touch.mode === "two_finger_pending") {
        const distDelta = Math.abs(currDist - touch.twoFingerStartDist);
        const scaleRatio = currDist / Math.max(1, touch.twoFingerStartDist);
        const midDelta = Math.hypot(
          midX - touch.twoFingerStartMidX,
          midY - touch.twoFingerStartMidY,
        );
        if (
          distDelta >= DESKTOP_PINCH_DIST_THRESHOLD_PX ||
          scaleRatio >= 1.12 ||
          scaleRatio <= 0.89
        ) {
          touch.mode = "two_finger_zoom_pan";
          touch.twoFingerLastDist = currDist;
          touch.twoFingerMidX = midX;
          touch.twoFingerMidY = midY;
          return;
        }
        if (midDelta >= DESKTOP_SCROLL_MID_THRESHOLD_PX && distDelta < 10) {
          touch.mode = "two_finger_scroll";
        } else {
          return;
        }
      }

      if (touch.mode === "two_finger_zoom_pan") {
        const prevZoom = viewZoomRef.current;
        const prevPan = viewPanRef.current;
        const scaleStep = currDist / Math.max(1, touch.twoFingerLastDist);
        const nextZoom = Math.max(
          DESKTOP_MIN_ZOOM,
          Math.min(DESKTOP_MAX_ZOOM, prevZoom * scaleStep),
        );
        const surface = surfaceRef.current;
        if (surface) {
          const sRect = surface.getBoundingClientRect();
          const cx = sRect.left + sRect.width / 2;
          const cy = sRect.top + sRect.height / 2;
          const prevDx = touch.twoFingerMidX - cx;
          const prevDy = touch.twoFingerMidY - cy;
          const currDx = midX - cx;
          const currDy = midY - cy;
          const zoomRatio = nextZoom / Math.max(0.01, prevZoom);
          const nextPanX = currDx - zoomRatio * (prevDx - prevPan.x);
          const nextPanY = currDy - zoomRatio * (prevDy - prevPan.y);
          applyDesktopZoomAndPan(nextZoom, nextPanX, nextPanY);
        }
        touch.twoFingerLastDist = currDist;
        touch.twoFingerMidX = midX;
        touch.twoFingerMidY = midY;
        return;
      }

      // Parallel 2-finger scroll
      const dx = midX - touch.twoFingerMidX;
      const dy = midY - touch.twoFingerMidY;
      touch.twoFingerMidX = midX;
      touch.twoFingerMidY = midY;

      const deltaX = Math.round(-dx * DESKTOP_TWO_FINGER_SCROLL_SCALE);
      const deltaY = Math.round(-dy * DESKTOP_TWO_FINGER_SCROLL_SCALE);
      if (deltaX === 0 && deltaY === 0) return;

      const anchor =
        touchInputMode === "trackpad"
          ? virtualCursorRef.current
          : mapClientToNormalized(midX, midY) ?? pointer.lastNorm;
      client.sendCommand(
        {
          action: "mouse_wheel",
          x: anchor.x,
          y: anchor.y,
          deltaX,
          deltaY,
        },
        targetDeviceId,
      );
      return;
    }

    if (touch.mode === "long_pressed" || touch.pointers.size !== 1) return;

    const displacement = Math.hypot(
      e.clientX - pointer.startX,
      e.clientY - pointer.startY,
    );

    if (touchInputMode === "trackpad") {
      if (touch.mode === "single" && displacement >= 4) {
        if (touch.longPressTimer !== null) {
          window.clearTimeout(touch.longPressTimer);
          touch.longPressTimer = null;
        }
        touch.mode = "drag";
      }
      if (touch.mode === "drag") {
        const box = getSurfaceContentBox();
        const basisW = Math.max(1, box?.contentBox.width ?? 360);
        const basisH = Math.max(1, box?.contentBox.height ?? 640);
        const prev = virtualCursorRef.current;
        const nextX = roundNorm(
          prev.x + (stepDx * DESKTOP_TRACKPAD_SENSITIVITY) / basisW,
        );
        const nextY = roundNorm(
          prev.y + (stepDy * DESKTOP_TRACKPAD_SENSITIVITY) / basisH,
        );
        if (nextX !== prev.x || nextY !== prev.y) {
          const nextCursor = { x: nextX, y: nextY };
          virtualCursorRef.current = nextCursor;
          setVirtualCursor(nextCursor);
          sendDesktopMouseMoveThrottled(nextX, nextY);
        }
      }
      return;
    }

    // Direct touch mode: 1-finger drag maps to left-button drag
    if (!touch.dragStarted && displacement >= DESKTOP_TOUCH_MOVE_THRESHOLD_PX) {
      if (touch.longPressTimer !== null) {
        window.clearTimeout(touch.longPressTimer);
        touch.longPressTimer = null;
      }
      touch.dragStarted = true;
      touch.mode = "drag";
      flushDesktopMoveTimer();
      client.sendCommand(
        {
          action: "mouse_down",
          x: pointer.startNorm.x,
          y: pointer.startNorm.y,
          button: "left",
          clickCount: 1,
        },
        targetDeviceId,
      );
      sendDesktopMouseMoveThrottled(norm.x, norm.y, true);
      return;
    }

    if (touch.dragStarted) {
      sendDesktopMouseMoveThrottled(norm.x, norm.y);
    }
  }

  function handleDesktopTouchUp(e: React.PointerEvent<HTMLDivElement>) {
    const touch = desktopTouchRef.current;
    const pointer = touch.pointers.get(e.pointerId);
    if (!pointer) return;

    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore release failures
    }

    if (touch.longPressTimer !== null) {
      window.clearTimeout(touch.longPressTimer);
      touch.longPressTimer = null;
    }

    const norm = mapClientToNormalized(e.clientX, e.clientY) ?? pointer.lastNorm;
    touch.pointers.delete(e.pointerId);

    if (
      touch.mode === "two_finger_pending" ||
      touch.mode === "two_finger_scroll" ||
      touch.mode === "two_finger_zoom_pan"
    ) {
      if (touch.pointers.size === 0) {
        if (touch.mode === "two_finger_zoom_pan" && viewZoomRef.current < 1.04) {
          resetDesktopZoom();
        }
        touch.mode = "idle";
      }
      return;
    }

    if (touch.mode === "long_pressed") {
      if (touch.pointers.size === 0) {
        touch.mode = "idle";
      }
      return;
    }

    if (touch.dragStarted) {
      touch.dragStarted = false;
      touch.mode = "idle";
      flushDesktopMoveTimer();
      lastDesktopPointerNormRef.current = { x: norm.x, y: norm.y };
      client.sendCommand(
        { action: "mouse_up", x: norm.x, y: norm.y, button: "left" },
        targetDeviceId,
      );
      return;
    }

    if (touch.mode === "drag") {
      // Trackpad move finished without click
      touch.mode = "idle";
      return;
    }

    // Stationary tap
    touch.mode = "idle";
    const now = Date.now();
    const isDoubleTap =
      touch.lastTap !== null &&
      now - touch.lastTap.at <= DESKTOP_DOUBLE_TAP_WINDOW_MS &&
      Math.hypot(
        e.clientX - touch.lastTap.clientX,
        e.clientY - touch.lastTap.clientY,
      ) <= DESKTOP_DOUBLE_TAP_MAX_DIST_PX;

    if (touchInputMode === "trackpad") {
      const vc = virtualCursorRef.current;
      addRippleAtNormalized(vc.x, vc.y);
      const clickCount = isDoubleTap ? 2 : 1;
      touch.lastTap = isDoubleTap
        ? null
        : { at: now, clientX: e.clientX, clientY: e.clientY };
      client.sendCommand(
        { action: "mouse_down", x: vc.x, y: vc.y, button: "left", clickCount },
        targetDeviceId,
      );
      client.sendCommand(
        { action: "mouse_up", x: vc.x, y: vc.y, button: "left" },
        targetDeviceId,
      );
      return;
    }

    // Direct touch mode: tap or double-tap
    addRipple(pointer.startX, pointer.startY);
    lastDesktopPointerNormRef.current = {
      x: pointer.startNorm.x,
      y: pointer.startNorm.y,
    };
    if (isDoubleTap) {
      touch.lastTap = null;
      client.sendCommand(
        {
          action: "mouse_down",
          x: pointer.startNorm.x,
          y: pointer.startNorm.y,
          button: "left",
          clickCount: 2,
        },
        targetDeviceId,
      );
      client.sendCommand(
        {
          action: "mouse_up",
          x: pointer.startNorm.x,
          y: pointer.startNorm.y,
          button: "left",
        },
        targetDeviceId,
      );
    } else {
      touch.lastTap = { at: now, clientX: e.clientX, clientY: e.clientY };
      client.sendCommand(
        { action: "tap", x: pointer.startNorm.x, y: pointer.startNorm.y },
        targetDeviceId,
      );
    }
  }

  function handleDesktopTouchCancel(e: React.PointerEvent<HTMLDivElement>) {
    const touch = desktopTouchRef.current;
    const pointer = touch.pointers.get(e.pointerId);
    if (!pointer) return;
    if (touch.longPressTimer !== null) {
      window.clearTimeout(touch.longPressTimer);
      touch.longPressTimer = null;
    }
    if (touch.dragStarted) {
      touch.dragStarted = false;
      client.sendCommand(
        {
          action: "mouse_up",
          x: pointer.lastNorm.x,
          y: pointer.lastNorm.y,
          button: "left",
        },
        targetDeviceId,
      );
    }
    touch.pointers.delete(e.pointerId);
    if (touch.pointers.size === 0) {
      touch.mode = "idle";
    }
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // P1-4: Retry video playback on user gesture if browser autoplay policy paused it
    const videoEl = videoRef.current;
    if (videoEl && videoEl.paused && clientState.mediaStream) {
      void videoEl.play().catch(() => undefined);
    }

    if (isDesktopTarget) {
      if (e.pointerType === "touch") {
        handleDesktopTouchDown(e);
        return;
      }
      if (!isStreamingReady) return;
      const button = mapMouseButton(e.button);
      if (!button) return;
      const norm = mapClientToNormalized(e.clientX, e.clientY);
      if (!norm || !norm.inside) return;

      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore capture failures
      }

      flushDesktopMoveTimer();
      lastDesktopPointerNormRef.current = { x: norm.x, y: norm.y };

      const now = Date.now();
      const prevClick = desktopClickTrackerRef.current;
      let trackedCount = 1;
      if (
        prevClick &&
        prevClick.button === button &&
        now - prevClick.at <= DESKTOP_MULTI_CLICK_WINDOW_MS &&
        Math.hypot(e.clientX - prevClick.clientX, e.clientY - prevClick.clientY) <=
          DESKTOP_MULTI_CLICK_MAX_DIST_PX
      ) {
        trackedCount = Math.min(3, prevClick.count + 1);
      }
      desktopClickTrackerRef.current = {
        button,
        at: now,
        clientX: e.clientX,
        clientY: e.clientY,
        count: trackedCount,
      };
      const clickCount = Math.max(
        1,
        Math.min(3, e.detail > 1 ? e.detail : trackedCount),
      );

      desktopPressedButtonsRef.current.set(`${e.pointerId}:${button}`, {
        pointerId: e.pointerId,
        button,
        x: norm.x,
        y: norm.y,
      });

      client.sendCommand(
        {
          action: "mouse_down",
          x: norm.x,
          y: norm.y,
          button,
          clickCount,
        },
        targetDeviceId,
      );
      return;
    }

    if (e.pointerType === "mouse" && e.button === 1) {
      e.preventDefault();
      return;
    }
    if (e.button !== 0 && e.pointerType === "mouse") return;

    const input = buildPointerInput(e);
    if (!input) return;

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore capture failures
    }

    const norm = recognizer.onPointerDown(input);
    if (norm?.inside) {
      addRipple(e.clientX, e.clientY);
    }
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (isDesktopTarget) {
      if (e.pointerType === "touch") {
        handleDesktopTouchMove(e);
        return;
      }
      if (!isStreamingReady) return;
      const norm = mapClientToNormalized(e.clientX, e.clientY);
      if (!norm) return;
      if (!norm.inside && desktopPressedButtonsRef.current.size === 0) return;

      for (const entry of desktopPressedButtonsRef.current.values()) {
        if (entry.pointerId === e.pointerId) {
          entry.x = norm.x;
          entry.y = norm.y;
        }
      }
      sendDesktopMouseMoveThrottled(norm.x, norm.y);
      return;
    }

    const input = buildPointerInput(e);
    if (!input) return;
    recognizer.onPointerMove(input);
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (isDesktopTarget) {
      if (e.pointerType === "touch") {
        handleDesktopTouchUp(e);
        return;
      }
      const button = mapMouseButton(e.button);
      if (!button) return;
      const key = `${e.pointerId}:${button}`;
      const hadButton = desktopPressedButtonsRef.current.delete(key);
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore release failures
      }
      if (!isStreamingReady && !hadButton) return;
      const norm =
        mapClientToNormalized(e.clientX, e.clientY) ??
        lastDesktopPointerNormRef.current;
      flushDesktopMoveTimer();
      lastDesktopPointerNormRef.current = { x: norm.x, y: norm.y };
      client.sendCommand(
        {
          action: "mouse_up",
          x: norm.x,
          y: norm.y,
          button,
        },
        targetDeviceId,
      );
      return;
    }

    if (e.button !== 0 && e.pointerType === "mouse") return;
    const input = buildPointerInput(e);
    if (!input) return;
    recognizer.onPointerUp(input);
  }

  function handlePointerCancel(e: React.PointerEvent<HTMLDivElement>) {
    if (isDesktopTarget) {
      if (e.pointerType === "touch") {
        handleDesktopTouchCancel(e);
        return;
      }
      for (const [key, entry] of desktopPressedButtonsRef.current.entries()) {
        if (entry.pointerId === e.pointerId) {
          desktopPressedButtonsRef.current.delete(key);
          client.sendCommand(
            {
              action: "mouse_up",
              x: entry.x,
              y: entry.y,
              button: entry.button,
            },
            targetDeviceId,
          );
        }
      }
      return;
    }

    recognizer.onPointerCancel(e.pointerId);
  }

  function handleMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button === 1) {
      e.preventDefault();
    }
  }

  function handleContextMenu(e: React.MouseEvent<HTMLDivElement>) {
    e.preventDefault();
    if (isDesktopTarget || !isStreamingReady) return;
    addRipple(e.clientX, e.clientY);
    client.sendCommand({ action: "key", key: "back" }, targetDeviceId);
    flashMouseNavHint("返回");
  }

  function handleAuxClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 1) return;
    e.preventDefault();
    if (isDesktopTarget || !isStreamingReady) return;
    addRipple(e.clientX, e.clientY);
    client.sendCommand({ action: "key", key: "home" }, targetDeviceId);
    flashMouseNavHint("主页");
  }

  // Non-passive wheel listener for remote PC targets so preventDefault blocks browser scroll/back-swipe cleanly
  const desktopWheelHandlerRef = useRef<(e: WheelEvent) => void>(() => {});
  desktopWheelHandlerRef.current = (e: WheelEvent) => {
    if (!isStreamingReady) return;
    e.preventDefault();
    const norm = mapClientToNormalized(e.clientX, e.clientY);
    if (!norm || !norm.inside) return;
    const modeScale = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? 400 : 1;
    const deltaX = Math.round(e.deltaX * modeScale);
    const deltaY = Math.round(e.deltaY * modeScale);
    if (deltaX === 0 && deltaY === 0) return;
    client.sendCommand(
      {
        action: "mouse_wheel",
        x: norm.x,
        y: norm.y,
        deltaX,
        deltaY,
      },
      targetDeviceId,
    );
  };

  useEffect(() => {
    if (!isDesktopTarget) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const listener = (e: WheelEvent) => desktopWheelHandlerRef.current(e);
    surface.addEventListener("wheel", listener, { passive: false });
    return () => {
      surface.removeEventListener("wheel", listener);
    };
  }, [isDesktopTarget]);

  // P0-3 & P0-4: Accurate letterbox wheel coordinates + normalized deltaMode + strict non-overlapping cooldown
  function handleWheel(e: React.WheelEvent<HTMLDivElement>) {
    if (isDesktopTarget || e.ctrlKey || !isStreamingReady) return;
    const surface = surfaceRef.current;
    if (!surface) return;

    const rect = surface.getBoundingClientRect();
    const content = getRenderedContentSize();
    const norm = clientPointToNormalized(
      e.clientX,
      e.clientY,
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      content.width,
      content.height,
    );
    if (!norm.inside) return;

    const modeScale = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? 400 : 1;
    const acc = wheelAccumRef.current;
    acc.x = Math.max(0.12, Math.min(0.88, norm.x));
    acc.y = Math.max(0.15, Math.min(0.85, norm.y));
    acc.dx += e.deltaX * modeScale;
    acc.dy += e.deltaY * modeScale;

    const dispatchWheelSwipe = () => {
      const dx = acc.dx;
      const dy = acc.dy;
      const cx = acc.x;
      const cy = acc.y;
      acc.dx = 0;
      acc.dy = 0;
      acc.timer = null;

      if (Math.abs(dy) < 4 && Math.abs(dx) < 4) return;

      // Natural scroll direction: wheel down (positive dy) scrolls page down (finger drags upward)
      const shiftY = Math.max(-0.34, Math.min(0.34, -dy * 0.0016));
      const shiftX = Math.max(-0.34, Math.min(0.34, -dx * 0.0016));
      const y1 = Math.max(0.12, Math.min(0.88, cy - shiftY * 0.35));
      const y2 = Math.max(0.08, Math.min(0.92, cy + shiftY * 0.65));
      const x1 = Math.max(0.12, Math.min(0.88, cx - shiftX * 0.35));
      const x2 = Math.max(0.08, Math.min(0.92, cx + shiftX * 0.65));

      acc.lastDispatchedAt = Date.now();
      client.sendCommand(
        {
          action: "swipe",
          x1: Math.round(x1 * 10000) / 10000,
          y1: Math.round(y1 * 10000) / 10000,
          x2: Math.round(x2 * 10000) / 10000,
          y2: Math.round(y2 * 10000) / 10000,
          durationMs: WHEEL_SWIPE_DURATION_MS,
        },
        targetDeviceId,
      );
    };

    if (acc.timer !== null) return;

    const elapsedSinceLast = Date.now() - acc.lastDispatchedAt;
    const remainingCooldown = Math.max(0, WHEEL_SWIPE_COOLDOWN_MS - elapsedSinceLast);
    if (remainingCooldown === 0) {
      if (Math.abs(acc.dy) >= 4 || Math.abs(acc.dx) >= 4) {
        dispatchWheelSwipe();
        return;
      }
      acc.timer = window.setTimeout(dispatchWheelSwipe, 16);
      return;
    }

    acc.timer = window.setTimeout(dispatchWheelSwipe, remainingCooldown);
  }

  const handleToggleDock = useCallback(() => {
    setDockExpanded((prev) => {
      const next = !prev;
      if (!next) setActivePanel("none");
      return next;
    });
  }, []);

  function sendKey(key: RemoteKey) {
    client.sendCommand({ action: "key", key }, targetDeviceId);
  }

  function sendWake() {
    client.sendCommand({ action: "wake" }, targetDeviceId);
  }

  function sendBlackScreen(enabled: boolean) {
    client.sendCommand({ action: "black_screen", enabled }, targetDeviceId);
  }

  function sendForcePortrait(enabled: boolean) {
    client.sendCommand({ action: "force_portrait", enabled }, targetDeviceId);
  }

  function sendDesktopEscape() {
    client.sendCommand(
      {
        action: "key_event",
        phase: "down",
        code: "Escape",
        key: "Escape",
        modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      },
      targetDeviceId,
    );
    client.sendCommand(
      {
        action: "key_event",
        phase: "up",
        code: "Escape",
        key: "Escape",
        modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      },
      targetDeviceId,
    );
  }

  function sendDesktopRightClick() {
    const pt =
      touchInputMode === "trackpad"
        ? virtualCursorRef.current
        : lastDesktopPointerNormRef.current;
    addRippleAtNormalized(pt.x, pt.y);
    flashMouseNavHint("右键");
    client.sendCommand(
      { action: "mouse_down", x: pt.x, y: pt.y, button: "right", clickCount: 1 },
      targetDeviceId,
    );
    client.sendCommand(
      { action: "mouse_up", x: pt.x, y: pt.y, button: "right" },
      targetDeviceId,
    );
  }

  function handleSelectRemoteDisplay(displayId: string) {
    client.sendCommand({ action: "select_display", displayId }, targetDeviceId);
    flashMouseNavHint("切换显示器");
  }

  function handleToggleDesktopAudio() {
    const nextMuted = !audioMuted;
    setAudioMuted(nextMuted);
    const videoEl = videoRef.current;
    if (videoEl) {
      videoEl.muted = nextMuted;
      videoEl.volume = Math.max(0, Math.min(1, audioVolume));
      if (!nextMuted) {
        void videoEl.play().catch(() => undefined);
      }
    }
    client.sendCommand({ action: "audio_toggle", enabled: !nextMuted }, targetDeviceId);
    onShowToast?.(
      "info",
      nextMuted
        ? "已关闭远端电脑声音"
        : clientState.hasRemoteAudio
          ? "已开启远端电脑系统声音"
          : "已开启远端声音监听（等待远端音频流）",
    );
  }

  function handleTogglePrivacyScreen() {
    const nextEnabled = !device?.privacyScreenActive;
    client.sendCommand(
      { action: "privacy_screen", enabled: nextEnabled },
      targetDeviceId,
    );
    onShowToast?.(
      "info",
      nextEnabled
        ? "已请求开启远端隐私防窥黑屏（对方屏幕将显示纯黑）"
        : "已请求解除远端隐私防窥黑屏",
    );
  }

  function handleDesktopPowerAction(operation: DesktopPowerOperation) {
    if (operation === "lock") {
      setPendingPowerOp(null);
      client.sendCommand({ action: "power", operation: "lock" }, targetDeviceId);
      onShowToast?.("info", "已发送远程锁屏指令");
      return;
    }
    setPendingPowerOp(operation);
  }

  function handleConfirmDesktopPower() {
    if (!pendingPowerOp) return;
    const op = pendingPowerOp;
    setPendingPowerOp(null);
    setActivePanel("none");
    client.sendCommand({ action: "power", operation: op }, targetDeviceId);
    const labelMap: Record<DesktopPowerOperation, string> = {
      lock: "已发送锁屏指令",
      sleep: "已发送远程睡眠指令",
      restart: "已发送远程重启指令",
      shutdown: "已发送远程关机指令",
    };
    onShowToast?.("warn", labelMap[op]);
  }

  function captureCurrentFramePngDataUrl(): string | null {
    const video = videoRef.current;
    if (
      clientState.activeTransport === "webrtc" &&
      video &&
      video.videoWidth > 0 &&
      video.videoHeight > 0
    ) {
      const offscreen = document.createElement("canvas");
      offscreen.width = video.videoWidth;
      offscreen.height = video.videoHeight;
      const ctx = offscreen.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, offscreen.width, offscreen.height);
      return offscreen.toDataURL("image/png");
    }

    const canvas = canvasRef.current;
    if (
      hasCanvasFrameRef.current &&
      canvas &&
      canvas.width > 0 &&
      canvas.height > 0
    ) {
      const offscreen = document.createElement("canvas");
      offscreen.width = canvas.width;
      offscreen.height = canvas.height;
      const ctx = offscreen.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(canvas, 0, 0, offscreen.width, offscreen.height);
      return offscreen.toDataURL("image/png");
    }

    return null;
  }

  async function handleCaptureScreenshot(mode: "copy" | "save") {
    if (!desktopBridge) return;
    const dataUrl = captureCurrentFramePngDataUrl();
    if (!dataUrl) {
      onShowToast?.("warn", "当前暂无可截取的远程画面");
      return;
    }

    try {
      if (mode === "copy") {
        const res = await desktopBridge.copyScreenshotPng(dataUrl);
        if (res.ok) {
          setScreenshotCopied(true);
          if (screenshotCopiedTimerRef.current !== null) {
            window.clearTimeout(screenshotCopiedTimerRef.current);
          }
          screenshotCopiedTimerRef.current = window.setTimeout(() => {
            screenshotCopiedTimerRef.current = null;
            setScreenshotCopied(false);
          }, 1400);
          onShowToast?.("info", "已复制高清截图到剪贴板");
        } else {
          onShowToast?.("error", res.error || "复制高清截图失败");
        }
        return;
      }

      const rawLabel = device?.name || device?.model || "velodeck";
      const safeName =
        rawLabel
          .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 32) || "velodeck";
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const suggestedName = `${safeName}-${stamp}.png`;

      const res = await desktopBridge.saveScreenshotPng(dataUrl, suggestedName);
      if (res.cancelled) return;
      if (res.ok) {
        onShowToast?.(
          "info",
          res.savedPath ? `截图已保存至 ${res.savedPath}` : "高清截图已保存",
        );
      } else {
        onShowToast?.("error", res.error || "保存截图失败");
      }
    } catch {
      onShowToast?.(
        "error",
        mode === "copy" ? "复制高清截图失败" : "保存截图失败",
      );
    }
  }

  const desktopCommandHandlersRef = useRef({
    toggleBlackScreen: () => {},
    toggleForcePortrait: () => {},
    copyScreenshot: () => {},
    saveScreenshot: () => {},
  });

  desktopCommandHandlersRef.current = {
    toggleBlackScreen: () => {
      if (!isDesktopTarget) sendBlackScreen(!device?.blackScreenActive);
    },
    toggleForcePortrait: () => {
      if (!isDesktopTarget) sendForcePortrait(!device?.forcePortraitActive);
    },
    copyScreenshot: () => {
      void handleCaptureScreenshot("copy");
    },
    saveScreenshot: () => {
      void handleCaptureScreenshot("save");
    },
  };

  useEffect(() => {
    if (!desktopBridge) return;
    return desktopBridge.onCommand((command) => {
      switch (command) {
        case "toggle-black-screen":
          desktopCommandHandlersRef.current.toggleBlackScreen();
          break;
        case "toggle-force-portrait":
          desktopCommandHandlersRef.current.toggleForcePortrait();
          break;
        case "copy-screenshot":
          desktopCommandHandlersRef.current.copyScreenshot();
          break;
        case "save-screenshot":
          desktopCommandHandlersRef.current.saveScreenshot();
          break;
      }
    });
  }, [desktopBridge]);

  function handleWakeWithBlackScreen() {
    client.sendCommand({ action: "wake" }, targetDeviceId);
    client.sendCommand({ action: "black_screen", enabled: true }, targetDeviceId);
  }

  function handleSwipeUnlock() {
    client.sendCommand({ action: "unlock" }, targetDeviceId);
    setActivePanel("none");
  }

  function handleSubmitPin() {
    if (!pinValue) return;
    client.sendCommand({ action: "unlock", pin: pinValue }, targetDeviceId);
    setPinValue("");
    setActivePanel("none");
  }

  function handleSendText() {
    if (!inputText) return;
    client.sendCommand(
      { action: "text", text: inputText, submit: submitAfterText },
      targetDeviceId,
    );
    setInputText("");
  }

  function handlePushClipboard() {
    if (!inputText) return;
    client.sendCommand({ action: "clipboard_set", text: inputText }, targetDeviceId);
  }

  async function handleCopyRemoteClipboard() {
    if (!clientState.remoteClipboard) return;
    try {
      await navigator.clipboard.writeText(clientState.remoteClipboard);
      setCopiedRemoteClip(true);
      if (copiedClipTimerRef.current !== null) {
        window.clearTimeout(copiedClipTimerRef.current);
      }
      copiedClipTimerRef.current = window.setTimeout(() => {
        copiedClipTimerRef.current = null;
        setCopiedRemoteClip(false);
      }, 1500);
    } catch {
      // Ignore clipboard denial
    }
  }

  function handleRetryOverlay() {
    if (clientState.socketStatus !== "connected") {
      client.reconnectNow();
    } else if (targetDeviceId) {
      client.startSession(targetDeviceId, {
        preferredTransport: clientState.desiredTransport,
        qualityPreset: clientState.qualityPreset,
      });
    }
  }

  async function handleSendLocalFile(
    file: File,
    purposeOverride?: FileTransferPurpose,
    targetDirOverride?: string,
  ) {
    setApkFetchState((prev) => (prev.error ? { ...prev, error: null } : prev));
    const isApk = file.name.toLowerCase().endsWith(".apk");
    const purpose: FileTransferPurpose = isDesktopTarget
      ? "file"
      : (purposeOverride ?? (isApk && autoInstallApk ? "apk_install" : "file"));
    try {
      await client.sendFileOverWebRtc(file, {
        fileName: file.name,
        mimeType: file.type || undefined,
        purpose,
        ...(isDesktopTarget && targetDirOverride
          ? { targetDir: targetDirOverride }
          : {}),
      });
    } catch {
      // RemoteClient already records error state and surfaces toast notice
    }
  }

  async function handlePushLatestApk() {
    if (apkFetchState.active) return;
    const apkFileName = getAndroidApkFileName(serverInfo);
    const baseDownloadUrl = getAndroidApkDownloadUrl(resolvedApiBase, serverInfo);
    const downloadUrl = `${baseDownloadUrl}${baseDownloadUrl.includes("?") ? "&" : "?"}t=${Date.now()}`;
    const controller = new AbortController();
    apkAbortRef.current = controller;
    setApkFetchState({ active: true, loaded: 0, total: 0, error: null });

    let apkBytes: Uint8Array;
    let headerSha: string | undefined;
    try {
      const bearerToken =
        authToken ?? (clientState.authType === "account" ? client.getAuthToken() : null);
      const headers: Record<string, string> = {};
      if (bearerToken) {
        headers.Authorization = `Bearer ${bearerToken}`;
      }
      const res = await fetch(downloadUrl, {
        method: "GET",
        cache: "no-store",
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`拉取服务器最新 APK 失败 (HTTP ${res.status})`);
      }
      const rawHeaderSha = res.headers.get("x-apk-sha256")?.trim().toLowerCase() || "";
      headerSha = /^[0-9a-f]{64}$/.test(rawHeaderSha) ? rawHeaderSha : undefined;
      const headerLen = Number(res.headers.get("content-length") ?? "0");
      const total = Number.isFinite(headerLen) && headerLen > 0 ? headerLen : 0;

      if (res.body && typeof res.body.getReader === "function") {
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let loaded = 0;
        let lastEmit = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            chunks.push(value);
            loaded += value.byteLength;
            const now = Date.now();
            if (now - lastEmit >= 120 || (total > 0 && loaded >= total)) {
              lastEmit = now;
              setApkFetchState({ active: true, loaded, total, error: null });
            }
          }
        }
        const merged = new Uint8Array(loaded);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.byteLength;
        }
        apkBytes = merged;
      } else {
        const buf = await res.arrayBuffer();
        apkBytes = new Uint8Array(buf);
      }
    } catch (err) {
      if (controller.signal.aborted) {
        setApkFetchState({ active: false, loaded: 0, total: 0, error: null });
        return;
      }
      const msg = err instanceof Error ? err.message : "拉取服务器最新 APK 失败";
      setApkFetchState({ active: false, loaded: 0, total: 0, error: msg });
      return;
    } finally {
      if (apkAbortRef.current === controller) {
        apkAbortRef.current = null;
      }
    }

    setApkFetchState({ active: false, loaded: 0, total: 0, error: null });
    try {
      await client.sendFileOverWebRtc(apkBytes, {
        fileName: apkFileName,
        mimeType: "application/vnd.android.package-archive",
        purpose: "apk_install",
        expectedSha256: headerSha,
      });
    } catch {
      // RemoteClient already records error state and surfaces toast notice
    }
  }

  function handleCancelApkFetch() {
    apkAbortRef.current?.abort();
    apkAbortRef.current = null;
    setApkFetchState({ active: false, loaded: 0, total: 0, error: null });
  }

  function isFileDragEvent(e: React.DragEvent): boolean {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    return Array.from(types).includes("Files");
  }

  function handleDragEnter(e: React.DragEvent<HTMLDivElement>) {
    if (!isFileDragEvent(e)) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    setIsDraggingFile(true);
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!isFileDragEvent(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (!isFileDragEvent(e)) return;
    e.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) {
      setIsDraggingFile(false);
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDraggingFile(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const dropTargetDir =
      isDesktopTarget && activePanel === "files" && remoteBrowserDir
        ? remoteBrowserDir
        : undefined;
    setActivePanel("files");
    void handleSendLocalFile(file, undefined, dropTargetDir);
  }

  const activeFileTransfer = clientState.fileTransfer;
  const isFileTransferActive =
    activeFileTransfer !== null &&
    (activeFileTransfer.status === "preparing" ||
      activeFileTransfer.status === "sending" ||
      activeFileTransfer.status === "verifying");
  const fileTransferPct =
    activeFileTransfer && activeFileTransfer.totalBytes > 0
      ? activeFileTransfer.status === "done"
        ? 100
        : Math.min(
            100,
            Math.round((activeFileTransfer.sentBytes / activeFileTransfer.totalBytes) * 100),
          )
      : 0;
  const isFileChannelReady =
    clientState.fileChannelOpen && device?.capabilities.p2pFileTransfer !== false;

  const reconnectCountdownSec = clientState.nextReconnectAt
    ? Math.max(0, Math.ceil((clientState.nextReconnectAt - nowTs) / 1000))
    : null;

  const overlayTitle = (() => {
    if (clientState.socketStatus === "reconnecting") {
      return reconnectCountdownSec !== null
        ? `连接中断，${reconnectCountdownSec}s 后重连`
        : "正在自动重连...";
    }
    if (
      clientState.socketStatus === "connecting" ||
      clientState.socketStatus === "authenticating"
    ) {
      return "正在建立连接...";
    }
    if (clientState.socketStatus === "error") {
      return "连接验证失败";
    }
    if (clientState.sessionStatus === "negotiating") {
      return "正在协商 WebRTC 通道...";
    }
    if (clientState.sessionStatus === "fallback") {
      return "正在切换至 WS 帧流...";
    }
    if (clientState.sessionStatus === "ended") {
      return "远程会话已结束";
    }
    if (clientState.sessionStatus === "error") {
      return "未能启动远程画面";
    }
    return "正在拉取设备画面...";
  })();

  const isAlwaysOnTop = Boolean(desktopWindowState?.alwaysOnTop);
  const isPhonePreset = desktopWindowState?.preset === "phone";
  const remoteDisplays = device?.displays ?? [];
  const hasMultiDisplays = isDesktopTarget && remoteDisplays.length > 1;
  const virtualCursorPosition = useMemo(() => {
    if (
      !isDesktopTarget ||
      touchInputMode !== "trackpad" ||
      !isStreamingReady ||
      surfaceSize.width <= 0 ||
      surfaceSize.height <= 0
    ) {
      return null;
    }
    const contentW =
      clientState.activeTransport === "webrtc" &&
      videoRef.current &&
      videoRef.current.videoWidth > 0
        ? videoRef.current.videoWidth
        : clientState.activeTransport === "ws-jpeg" &&
            canvasRef.current &&
            canvasRef.current.width > 0
          ? canvasRef.current.width
          : clientState.screenWidth || 1920;
    const contentH =
      clientState.activeTransport === "webrtc" &&
      videoRef.current &&
      videoRef.current.videoHeight > 0
        ? videoRef.current.videoHeight
        : clientState.activeTransport === "ws-jpeg" &&
            canvasRef.current &&
            canvasRef.current.height > 0
          ? canvasRef.current.height
          : clientState.screenHeight || 1080;
    const box = computeContentRect(
      surfaceSize.width,
      surfaceSize.height,
      contentW,
      contentH,
    );
    const cx = surfaceSize.width / 2;
    const cy = surfaceSize.height / 2;
    const baseLeft = box.left + virtualCursor.x * box.width;
    const baseTop = box.top + virtualCursor.y * box.height;
    return {
      left: cx + viewPan.x + (baseLeft - cx) * viewZoom,
      top: cy + viewPan.y + (baseTop - cy) * viewZoom,
    };
  }, [
    isDesktopTarget,
    touchInputMode,
    isStreamingReady,
    hasVideoFrame,
    hasCanvasFrame,
    surfaceSize.width,
    surfaceSize.height,
    clientState.activeTransport,
    clientState.screenWidth,
    clientState.screenHeight,
    virtualCursor.x,
    virtualCursor.y,
    viewZoom,
    viewPan.x,
    viewPan.y,
  ]);

  const effectiveDesktopQuality: StreamQuality =
    clientState.desktopQuality ??
    DESKTOP_QUALITY_PRESETS[clientState.qualityPreset] ??
    DESKTOP_QUALITY_PRESETS.auto;
  const isPrivacyActive = Boolean(device?.privacyScreenActive);
  const isAudioLive = !audioMuted && clientState.hasRemoteAudio;

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`fixed inset-0 z-40 h-[100dvh] w-screen overflow-hidden bg-black text-white select-none ${
        desktopApp ? "flex flex-col" : ""
      }`}
    >
      {/* Native Desktop Top HUD Bar (shown ONLY in Electron Desktop App) */}
      {desktopApp && (
        <header
          className={`desktop-drag-region relative z-50 flex h-10 shrink-0 items-center justify-between gap-2 border-b border-[#232732] bg-[#111318] ${
            macDesktop ? "pl-[76px] pr-2.5" : "px-3"
          }`}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="hidden truncate text-xs font-medium text-zinc-300 sm:inline">
              {device?.name || "远端设备"}
            </span>
          </div>

          <div className="desktop-no-drag flex shrink-0 items-center gap-1.5">
            <div className="flex items-center gap-1">
              {isDesktopTarget && (
                <button
                  type="button"
                  onClick={handleToggleDesktopAudio}
                  title={
                    audioMuted
                      ? "开启远端电脑系统声音"
                      : "静音远端电脑声音"
                  }
                  aria-label={
                    audioMuted ? "开启远端电脑系统声音" : "静音远端电脑声音"
                  }
                  aria-pressed={!audioMuted}
                  className={`desktop-no-drag flex h-7 w-7 items-center justify-center rounded-md border transition ${
                    !audioMuted
                      ? isAudioLive
                        ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-300"
                        : "border-[#2563EB] bg-[#2563EB] text-white"
                      : "border-[#2C313D] bg-white/8 text-zinc-300 hover:border-[#3F4656] hover:bg-white/15 hover:text-white"
                  }`}
                >
                  {audioMuted ? (
                    <VolumeX className="h-3.5 w-3.5" />
                  ) : (
                    <Volume2 className="h-3.5 w-3.5" />
                  )}
                </button>
              )}

              <button
                type="button"
                onClick={() => void onToggleAlwaysOnTop?.()}
                title={isAlwaysOnTop ? "取消置顶浮窗" : "置顶浮窗"}
                aria-label={isAlwaysOnTop ? "取消置顶浮窗" : "置顶浮窗"}
                aria-pressed={isAlwaysOnTop}
                className={`desktop-no-drag flex h-7 w-7 items-center justify-center rounded-md border transition ${
                  isAlwaysOnTop
                    ? "border-[#2563EB] bg-[#2563EB] text-white"
                    : "border-[#2C313D] bg-white/8 text-zinc-300 hover:border-[#3F4656] hover:bg-white/15 hover:text-white"
                }`}
              >
                <Pin className="h-3.5 w-3.5" />
              </button>

              <button
                type="button"
                onClick={() =>
                  void onSetWindowPreset?.(
                    isPhonePreset ? "dashboard" : "phone",
                  )
                }
                title={
                  isPhonePreset
                    ? "切换为宽屏控制台比例 (1100×760)"
                    : "切换为手机竖屏比例 (430×880)"
                }
                aria-label={
                  isPhonePreset ? "切换为宽屏比例" : "切换为手机比例"
                }
                className="desktop-no-drag flex h-7 w-7 items-center justify-center rounded-md border border-[#2C313D] bg-white/8 text-zinc-300 transition hover:border-[#3F4656] hover:bg-white/15 hover:text-white"
              >
                {isPhonePreset ? (
                  <Monitor className="h-3.5 w-3.5" />
                ) : (
                  <Smartphone className="h-3.5 w-3.5" />
                )}
              </button>

              <button
                type="button"
                onClick={(e) =>
                  void handleCaptureScreenshot(e.shiftKey ? "save" : "copy")
                }
                title="高清截图到剪贴板（Shift+点击另存为 PNG）"
                aria-label="高清截图到剪贴板"
                className={`desktop-no-drag flex h-7 w-7 items-center justify-center rounded-md border transition ${
                  screenshotCopied
                    ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-300"
                    : "border-[#2C313D] bg-white/8 text-zinc-300 hover:border-[#3F4656] hover:bg-white/15 hover:text-white"
                }`}
              >
                {screenshotCopied ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Camera className="h-3.5 w-3.5" />
                )}
              </button>

              <button
                type="button"
                onClick={() => void onOpenNewWindow?.()}
                title="新窗口（多机同控）"
                aria-label="新窗口（多机同控）"
                className="desktop-no-drag flex h-7 w-7 items-center justify-center rounded-md border border-[#2C313D] bg-white/8 text-zinc-300 transition hover:border-[#3F4656] hover:bg-white/15 hover:text-white"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>

            <TelemetryCapsule
              client={client}
              socketStatus={clientState.socketStatus}
              sessionStatus={clientState.sessionStatus}
              activeTransport={clientState.activeTransport}
              desiredTransport={clientState.desiredTransport}
              isStreamingReady={isStreamingReady}
              device={device}
              dockExpanded={dockExpanded}
              onToggleDock={handleToggleDock}
              inline
            />
          </div>
        </header>
      )}

      {/* Pitch-Black OLED Remote Screen Surface */}
      <div
        ref={surfaceRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onMouseDown={handleMouseDown}
        onContextMenu={handleContextMenu}
        onAuxClick={handleAuxClick}
        onWheel={isDesktopTarget ? undefined : handleWheel}
        className={`relative w-full overflow-hidden touch-none ${
          desktopApp ? "min-h-0 flex-1" : "h-full"
        }`}
      >
        <div
          ref={mediaStageRef}
          style={
            isDesktopTarget && (viewZoom > 1 || viewPan.x !== 0 || viewPan.y !== 0)
              ? {
                  transform: `translate3d(${viewPan.x}px, ${viewPan.y}px, 0) scale(${viewZoom})`,
                  transformOrigin: "center center",
                  willChange: "transform",
                }
              : undefined
          }
          className="pointer-events-none absolute inset-0 h-full w-full"
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={!isDesktopTarget || audioMuted}
            disablePictureInPicture
            disableRemotePlayback
            style={{ willChange: "transform" }}
            onLoadedMetadata={(e) => {
              const el = e.currentTarget;
              if (el.videoWidth > 0 && el.videoHeight > 0) {
                markVideoFrameReady();
              }
            }}
            onLoadedData={(e) => {
              const el = e.currentTarget;
              if (el.videoWidth > 0 && el.videoHeight > 0) {
                markVideoFrameReady();
              }
            }}
            onPlaying={(e) => {
              const el = e.currentTarget;
              if (el.videoWidth > 0 && el.videoHeight > 0) {
                markVideoFrameReady();
              }
            }}
            onResize={(e) => {
              const el = e.currentTarget;
              if (el.videoWidth > 0 && el.videoHeight > 0) {
                markVideoFrameReady();
              }
            }}
            className={`pointer-events-none absolute inset-0 h-full w-full object-contain ${
              isWebRtcVisible ? "opacity-100" : "opacity-0"
            }`}
          />

          <canvas
            ref={canvasRef}
            className={`pointer-events-none absolute inset-0 h-full w-full object-contain ${
              !isWebRtcVisible && hasCanvasFrame ? "opacity-100" : "opacity-0"
            }`}
          />
        </div>

        {ripples.map((ripple) => (
          <span
            key={ripple.id}
            style={{ left: ripple.x, top: ripple.y }}
            className="animate-touch-ripple pointer-events-none absolute h-10 w-10 rounded-full border-2 border-[#60A5FA] bg-[#2563EB]/20"
          />
        ))}

        {/* Virtual Trackpad Crosshair Cursor (mobile touch trackpad mode for remote PC) */}
        {virtualCursorPosition && (
          <div
            style={{
              left: virtualCursorPosition.left,
              top: virtualCursorPosition.top,
            }}
            className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-1/2"
            aria-hidden="true"
          >
            <div className="relative flex h-5 w-5 items-center justify-center">
              <span className="absolute h-5 w-5 rounded-full border-2 border-white shadow-[0_1px_4px_rgba(0,0,0,0.85)]" />
              <span className="absolute h-3.5 w-3.5 rounded-full border border-[#111318]" />
              <span className="h-1.5 w-1.5 rounded-full bg-[#2563EB]" />
            </div>
          </div>
        )}

        {mouseNavHint && (
          <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex justify-center">
            <span className="animate-sheet-up inline-flex items-center gap-1.5 rounded-md border border-[#2C313D] bg-[#111318] px-2.5 py-1 text-[11px] font-medium text-zinc-100 shadow-[0_8px_24px_rgba(0,0,0,0.65)]">
              {mouseNavHint === "返回" ? (
                <ArrowLeft className="h-3 w-3 text-[#60A5FA]" />
              ) : mouseNavHint === "右键" ? (
                <MousePointerClick className="h-3 w-3 text-[#60A5FA]" />
              ) : mouseNavHint === "切换显示器" ? (
                <Monitor className="h-3 w-3 text-[#60A5FA]" />
              ) : (
                <Home className="h-3 w-3 text-[#60A5FA]" />
              )}
              <span>{mouseNavHint}</span>
            </span>
          </div>
        )}
      </div>

      {/* Drag & Drop File Transfer Overlay */}
      {isDraggingFile && (
        <div className="pointer-events-none fixed inset-0 z-[55] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
          <div className="flex w-full max-w-md flex-col items-center rounded-2xl border-2 border-dashed border-[#60A5FA] bg-[#111318]/95 px-6 py-8 text-center shadow-[0_24px_48px_rgba(0,0,0,0.75)]">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-[#2563EB]/20 text-[#60A5FA]">
              <FileUp className="h-6 w-6" />
            </div>
            <p className="text-sm font-semibold text-white">
              {isDesktopTarget
                ? "松手即通过 WebRTC P2P 直传到远端电脑"
                : autoInstallApk
                  ? "松手即通过 WebRTC P2P 直传到手机（.apk 将自动拉起安装）"
                  : "松手即通过 WebRTC P2P 直传到手机"}
            </p>
            <p className="mt-1.5 text-xs text-zinc-400">
              {isFileChannelReady
                ? isDesktopTarget
                  ? activePanel === "files" && remoteBrowserDir
                    ? `文件将直接保存至当前浏览目录：${remoteBrowserDir}`
                    : "文件将直接保存至远端电脑的下载目录，不占用云端转发带宽"
                  : "普通文件将保存至手机 Download/VeloDeck/，不占用云端转发带宽"
                : "当前 WebRTC P2P 文件通道尚未就绪，松手后将打开传输面板查看状态"}
            </p>
          </div>
        </div>
      )}

      {/* Desktop Floating Zoom Control Badge (shown when zoomed > 1.05x) */}
      {isDesktopTarget && isStreamingReady && viewZoom > 1.05 && (
        <div
          className="pointer-events-none fixed left-3 top-0 z-50 flex items-center gap-1.5"
          style={{
            paddingTop: desktopApp
              ? "3.25rem"
              : "max(0.75rem, env(safe-area-inset-top))",
          }}
        >
          <div className="pointer-events-auto inline-flex items-center gap-1 rounded-full border border-[#2C313D] bg-[#111318] px-2 py-1 text-xs text-zinc-100 shadow-[0_8px_24px_rgba(0,0,0,0.65)]">
            <button
              type="button"
              onClick={() =>
                applyDesktopZoomAndPan(
                  viewZoom - 0.5,
                  viewPan.x,
                  viewPan.y,
                )
              }
              className="flex h-6 w-6 items-center justify-center rounded-full bg-white/8 text-zinc-200 hover:bg-white/15"
              aria-label="缩小视图"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <span className="min-w-[2.6rem] text-center font-mono text-[11px] font-semibold text-white">
              {viewZoom.toFixed(1)}×
            </span>
            <button
              type="button"
              onClick={() =>
                applyDesktopZoomAndPan(
                  viewZoom + 0.5,
                  viewPan.x,
                  viewPan.y,
                )
              }
              className="flex h-6 w-6 items-center justify-center rounded-full bg-white/8 text-zinc-200 hover:bg-white/15"
              aria-label="放大视图"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
            <span className="mx-0.5 h-3.5 w-px bg-[#2C313D]" />
            <button
              type="button"
              onClick={resetDesktopZoom}
              className="inline-flex h-6 items-center gap-1 rounded-full bg-[#2563EB] px-2 text-[11px] font-medium text-white hover:bg-[#1D4ED8]"
            >
              <Maximize2 className="h-3 w-3" />
              <span>适应屏幕</span>
            </button>
          </div>
        </div>
      )}

      {/* Web/Mobile Quick Audio Toggle Pill for Desktop Targets */}
      {isDesktopTarget && isStreamingReady && !desktopApp && viewZoom <= 1.05 && (
        <div
          className="pointer-events-none fixed left-3 top-0 z-50"
          style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
        >
          <button
            type="button"
            onClick={handleToggleDesktopAudio}
            aria-label={audioMuted ? "开启远端电脑声音" : "静音远端电脑声音"}
            aria-pressed={!audioMuted}
            className={`pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium shadow-[0_8px_24px_rgba(0,0,0,0.55)] transition ${
              !audioMuted
                ? isAudioLive
                  ? "border-emerald-500/50 bg-[#111318] text-emerald-300"
                  : "border-[#2563EB] bg-[#2563EB] text-white"
                : "border-[#2C313D] bg-[#111318] text-zinc-300 hover:border-[#3F4656]"
            }`}
          >
            {audioMuted ? (
              <VolumeX className="h-3.5 w-3.5" />
            ) : (
              <Volume2 className="h-3.5 w-3.5" />
            )}
            <span className="hidden sm:inline">
              {audioMuted ? "静音" : isAudioLive ? "声音开启" : "监听中"}
            </span>
          </button>
        </div>
      )}

      {/* Compact Background Transfer Progress Pill (when transfer runs while sheet is closed) */}
      {(isFileTransferActive || clientState.fileDownload.active || apkFetchState.active) &&
        activePanel !== "files" && (
        <div
          className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-3 sm:justify-start"
          style={{
            paddingTop: desktopApp
              ? "3.25rem"
              : "max(3.5rem, calc(env(safe-area-inset-top) + 2.8rem))",
          }}
        >
          <button
            type="button"
            onClick={() => setActivePanel("files")}
            className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-blue-500/40 bg-[#111318] px-3 py-1.5 text-xs font-medium text-blue-200 shadow-[0_8px_24px_rgba(0,0,0,0.6)] hover:border-blue-400"
          >
            {clientState.fileDownload.active ? (
              <Download className="h-3.5 w-3.5 text-blue-400" />
            ) : (
              <Upload className="h-3.5 w-3.5 text-blue-400" />
            )}
            <span>
              {clientState.fileDownload.active
                ? `正在下载 ${
                    clientState.fileDownload.totalBytes > 0
                      ? `${Math.min(100, Math.round((clientState.fileDownload.receivedBytes / clientState.fileDownload.totalBytes) * 100))}%`
                      : "..."
                  }`
                : apkFetchState.active
                  ? "正在拉取最新 APK..."
                  : activeFileTransfer?.status === "verifying"
                    ? "正在校验 SHA-256..."
                    : `P2P 传输 ${fileTransferPct}%`}
            </span>
          </button>
        </div>
      )}

      {/* Crisp Solid-Ink Top Telemetry Capsule (Web / iOS PWA mode; Desktop renders inline in HUD bar) */}
      {!desktopApp && (
        <TelemetryCapsule
          client={client}
          socketStatus={clientState.socketStatus}
          sessionStatus={clientState.sessionStatus}
          activeTransport={clientState.activeTransport}
          desiredTransport={clientState.desiredTransport}
          isStreamingReady={isStreamingReady}
          device={device}
          dockExpanded={dockExpanded}
          onToggleDock={handleToggleDock}
        />
      )}

      {/* Screen-Off Notice Banner (when physical Android phone genuinely entered Display.STATE_OFF) */}
      {!isDesktopTarget && isStreamingReady && !showOverlay && device?.screenOn === false && (
        <div className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center px-5">
          <div className="pointer-events-auto w-full max-w-sm rounded-xl border border-[#2C313D] bg-[#111318]/92 p-5 text-center shadow-[0_24px_48px_rgba(0,0,0,0.75)] backdrop-blur-md">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-300">
              <Moon className="h-5 w-5" />
            </div>
            <h3 className="text-sm font-semibold text-white">手机物理屏幕已真熄屏</h3>
            <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">
              Android 物理真息屏/锁屏后会暂停系统画面输出，控制端也会同步黑屏。如需「手机暗屏伪装、控制端全亮操作」，请点下方唤醒并开启伪装黑屏。
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={sendWake}
                className="btn-shell flex h-9 items-center justify-center gap-1.5 rounded-lg text-xs font-medium text-amber-300"
              >
                <Sun className="h-3.5 w-3.5" />
                正常唤醒
              </button>
              <button
                type="button"
                onClick={handleWakeWithBlackScreen}
                className="btn-primary flex h-9 items-center justify-center gap-1.5 rounded-lg text-xs font-medium"
              >
                <Moon className="h-3.5 w-3.5" />
                唤醒+伪装黑屏
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Connecting / Error Overlay */}
      {showOverlay && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/80 px-5">
          <div className="w-full max-w-sm rounded-xl border border-[#282D38] bg-[#111318] p-6 text-center shadow-[0_24px_48px_rgba(0,0,0,0.65)]">
            <div className="mx-auto mb-3.5 flex h-11 w-11 items-center justify-center rounded-lg bg-white/8 text-zinc-200">
              <RefreshCw
                className={`h-5 w-5 ${
                  clientState.sessionStatus !== "error" &&
                  clientState.sessionStatus !== "ended" &&
                  clientState.socketStatus !== "error"
                    ? "animate-spin text-[#60A5FA]"
                    : "text-zinc-300"
                }`}
              />
            </div>

            <h3 className="text-base font-semibold text-white">{overlayTitle}</h3>
            <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">
              {clientState.errorMessage ||
                (!isDesktopTarget && device?.locked
                  ? "手机处于锁屏状态，如黑屏可点击下方强制唤醒。"
                  : clientState.desiredTransport === "ws-jpeg" ||
                      clientState.activeTransport === "ws-jpeg"
                    ? "正在拉取实时帧画面，请稍候。"
                    : "若 WebRTC 超过 7.5 秒未连通将自动切换至 WS 帧流。")}
            </p>

            <div className="mt-5 space-y-2.5">
              <div className={`grid gap-2.5 ${isDesktopTarget ? "grid-cols-1" : "grid-cols-2"}`}>
                <button
                  type="button"
                  onClick={handleRetryOverlay}
                  className="btn-primary flex h-10 items-center justify-center gap-1.5 rounded-lg text-xs font-medium"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  立即重试
                </button>

                {!isDesktopTarget && (
                  <button
                    type="button"
                    onClick={sendWake}
                    className="btn-shell flex h-10 items-center justify-center gap-1.5 rounded-lg text-xs font-medium text-amber-300"
                  >
                    <Zap className="h-3.5 w-3.5" />
                    强制唤醒
                  </button>
                )}
              </div>

              <button
                type="button"
                onClick={onExit}
                className="btn-shell flex h-9 w-full items-center justify-center gap-1.5 rounded-lg text-xs font-medium text-zinc-300"
              >
                <LogOut className="h-3.5 w-3.5" />
                {clientState.authType === "code" ? "断开并返回" : "返回设备列表"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Solid-Ink Bottom Control Bar */}
      {dockExpanded && (
        <div
          className="fixed inset-x-0 bottom-0 z-50 px-3"
          style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
        >
          <div className="animate-sheet-up mx-auto max-w-lg rounded-xl border border-[#2C313D] bg-[#111318] p-3 shadow-[0_20px_48px_rgba(0,0,0,0.75)]">
            <div className="mb-2.5 flex items-center justify-between px-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-xs font-semibold text-white">
                  {device?.name || "远端设备"}
                </span>
                {clientState.dataChannelOpen && (
                  <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                    DC 直通
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                {isDesktopTarget ? (
                  <button
                    type="button"
                    onClick={() =>
                      setActivePanel((p) => (p === "text" ? "none" : "text"))
                    }
                    className={`inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-[11px] font-medium transition ${
                      activePanel === "text"
                        ? "border-[#2563EB] bg-[#2563EB] text-white"
                        : "border-[#2C313D] bg-white/10 text-zinc-200 hover:bg-white/15"
                    }`}
                  >
                    <Clipboard className="h-3 w-3 text-blue-400" />
                    <span>输入/剪贴板</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      setActivePanel((p) => (p === "files" ? "none" : "files"))
                    }
                    className={`inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-[11px] font-medium transition ${
                      activePanel === "files"
                        ? "border-[#2563EB] bg-[#2563EB] text-white"
                        : isFileTransferActive || apkFetchState.active
                          ? "border-blue-500/45 bg-blue-500/20 text-blue-200 hover:bg-blue-500/30"
                          : isFileChannelReady
                            ? "border-emerald-500/35 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
                            : "border-[#2C313D] bg-white/10 text-zinc-200 hover:bg-white/15"
                    }`}
                  >
                    <Upload className="h-3 w-3" />
                    {isFileTransferActive
                      ? `传输 ${fileTransferPct}%`
                      : apkFetchState.active
                        ? "拉取 APK"
                        : "文件/升级"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={onExit}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-rose-500/35 bg-rose-500/15 px-2.5 text-[11px] font-medium text-rose-200 hover:bg-rose-500/25"
                >
                  <LogOut className="h-3 w-3" />
                  退出
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDockExpanded(false);
                    setActivePanel("none");
                  }}
                  className="flex h-7 w-7 items-center justify-center rounded-md bg-white/10 text-zinc-300 hover:bg-white/15 hover:text-white"
                  aria-label="收起控制栏"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {clientState.activeTransport === "webrtc" && (
              <LiveWebRtcTelemetryStrip client={client} compact className="mb-2.5" />
            )}

            {isDesktopTarget ? (
              <>
                {hasMultiDisplays && (
                  <div className="mb-2 flex items-center gap-1.5 overflow-x-auto pb-0.5">
                    {remoteDisplays.map((display, idx) => {
                      const active = display.id === device?.activeDisplayId;
                      return (
                        <button
                          key={display.id}
                          type="button"
                          onClick={() => handleSelectRemoteDisplay(display.id)}
                          title={display.name}
                          className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition ${
                            active
                              ? "border-[#2563EB] bg-[#2563EB] text-white"
                              : "border-[#2C313D] bg-[#191D26] text-zinc-300 hover:bg-[#232836]"
                          }`}
                        >
                          <Monitor className="h-3 w-3" />
                          <span>显示器 {idx + 1}</span>
                          <span className="font-mono text-[10px] opacity-80">
                            {display.width}×{display.height}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                <div className="grid grid-cols-4 gap-1.5">
                  <DockButton
                    icon={<ArrowLeft className="h-4 w-4" />}
                    label="Esc"
                    onClick={sendDesktopEscape}
                  />
                  <DockButton
                    icon={
                      touchInputMode === "trackpad" ? (
                        <MousePointer2 className="h-4 w-4 text-white" />
                      ) : (
                        <Hand className="h-4 w-4 text-blue-400" />
                      )
                    }
                    label={touchInputMode === "trackpad" ? "触控板" : "直点"}
                    active={touchInputMode === "trackpad"}
                    onClick={() => {
                      const next =
                        touchInputMode === "trackpad" ? "direct" : "trackpad";
                      setTouchInputMode(next);
                      onShowToast?.(
                        "info",
                        next === "trackpad"
                          ? "已切换为触控板模式（单指拖动移动虚拟光标，轻点左键，长按右键）"
                          : "已切换为直点模式（轻点左键，双击左键，长按右键，双指缩放/滚动）",
                      );
                    }}
                  />
                  <DockButton
                    icon={<Keyboard className="h-4 w-4 text-sky-400" />}
                    label="快捷键"
                    active={activePanel === "shortcuts"}
                    onClick={() =>
                      setActivePanel((p) => (p === "shortcuts" ? "none" : "shortcuts"))
                    }
                  />
                  <DockButton
                    icon={
                      audioMuted ? (
                        <VolumeX className="h-4 w-4 text-zinc-400" />
                      ) : (
                        <Volume2
                          className={`h-4 w-4 ${
                            isAudioLive ? "text-emerald-300" : "text-white"
                          }`}
                        />
                      )
                    }
                    label={audioMuted ? "声音" : isAudioLive ? "声音中" : "已开声"}
                    active={!audioMuted}
                    onClick={handleToggleDesktopAudio}
                  />
                </div>

                <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                  <DockButton
                    icon={
                      <EyeOff
                        className={`h-4 w-4 ${
                          isPrivacyActive ? "text-white" : "text-indigo-400"
                        }`}
                      />
                    }
                    label={isPrivacyActive ? "防窥中" : "隐私屏"}
                    active={isPrivacyActive}
                    onClick={handleTogglePrivacyScreen}
                  />
                  <DockButton
                    icon={<FolderOpen className="h-4 w-4 text-emerald-400" />}
                    label="文件管理"
                    active={activePanel === "files"}
                    onClick={() =>
                      setActivePanel((p) => (p === "files" ? "none" : "files"))
                    }
                  />
                  <DockButton
                    icon={<Gauge className="h-4 w-4 text-amber-400" />}
                    label={`画质(${effectiveDesktopQuality.fps}Hz)`}
                    active={activePanel === "quality"}
                    onClick={() =>
                      setActivePanel((p) => (p === "quality" ? "none" : "quality"))
                    }
                  />
                  <DockButton
                    icon={<SlidersHorizontal className="h-4 w-4 text-zinc-200" />}
                    label="更多"
                    active={activePanel === "more"}
                    onClick={() => {
                      setPendingPowerOp(null);
                      setActivePanel((p) => (p === "more" ? "none" : "more"));
                    }}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="grid grid-cols-4 gap-1.5">
                  <DockButton
                    icon={<ArrowLeft className="h-4 w-4" />}
                    label="返回"
                    onClick={() => sendKey("back")}
                  />
                  <DockButton
                    icon={<Home className="h-4 w-4" />}
                    label="主页"
                    onClick={() => sendKey("home")}
                  />
                  <DockButton
                    icon={<Layers className="h-4 w-4" />}
                    label="多任务"
                    onClick={() => sendKey("recents")}
                  />
                  <DockButton
                    icon={<Bell className="h-4 w-4" />}
                    label="通知栏"
                    onClick={() => sendKey("notifications")}
                  />
                </div>

                <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                  <DockButton
                    icon={<Sun className="h-4 w-4 text-amber-400" />}
                    label="亮屏"
                    onClick={sendWake}
                  />
                  <DockButton
                    icon={<Unlock className="h-4 w-4 text-emerald-400" />}
                    label="解锁"
                    active={activePanel === "unlock"}
                    onClick={() =>
                      setActivePanel((p) => (p === "unlock" ? "none" : "unlock"))
                    }
                  />
                  <DockButton
                    icon={<Keyboard className="h-4 w-4 text-blue-400" />}
                    label="输入/剪贴板"
                    active={activePanel === "text"}
                    onClick={() =>
                      setActivePanel((p) => (p === "text" ? "none" : "text"))
                    }
                  />
                  <DockButton
                    icon={<SlidersHorizontal className="h-4 w-4 text-zinc-200" />}
                    label="画质/更多"
                    active={activePanel === "more"}
                    onClick={() =>
                      setActivePanel((p) => (p === "more" ? "none" : "more"))
                    }
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Unlock / PIN Pad Sheet */}
      {activePanel === "unlock" && (
        <DarkSheet title="解锁设备" onClose={() => setActivePanel("none")}>
          <button
            type="button"
            onClick={handleSwipeUnlock}
            className="btn-shell mb-3.5 flex h-10 w-full items-center justify-center gap-2 rounded-lg text-xs font-medium text-emerald-300"
          >
            <Unlock className="h-4 w-4" />
            一键上滑解锁（无密码）
          </button>

          <div className="mb-3 rounded-lg border border-[#2C313D] bg-[#0A0C10] px-4 py-2.5 text-center">
            <p className="text-[11px] text-zinc-400">输入锁屏 PIN 码</p>
            <p className="mt-1 min-h-7 font-mono text-2xl tracking-[0.45em] text-white">
              {pinValue ? "•".repeat(pinValue.length) : "····"}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
              <button
                key={digit}
                type="button"
                onClick={() => setPinValue((prev) => (prev.length < 12 ? prev + digit : prev))}
                className="flex h-11 items-center justify-center rounded-lg border border-[#2C313D] bg-[#191D26] text-base font-semibold text-white hover:bg-[#232836]"
              >
                {digit}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPinValue((prev) => prev.slice(0, -1))}
              className="flex h-11 items-center justify-center rounded-lg border border-[#2C313D] bg-[#14171F] text-zinc-300 hover:bg-[#1E2330]"
              aria-label="退格"
            >
              <Delete className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setPinValue((prev) => (prev.length < 12 ? `${prev}0` : prev))}
              className="flex h-11 items-center justify-center rounded-lg border border-[#2C313D] bg-[#191D26] text-base font-semibold text-white hover:bg-[#232836]"
            >
              0
            </button>
            <button
              type="button"
              disabled={!pinValue}
              onClick={handleSubmitPin}
              className="btn-primary flex h-11 items-center justify-center rounded-lg text-xs font-semibold disabled:cursor-not-allowed"
            >
              解锁
            </button>
          </div>
        </DarkSheet>
      )}

      {/* Text Input & Clipboard Sync Sheet */}
      {activePanel === "text" && (
        <DarkSheet title="文字输入与剪贴板" onClose={() => setActivePanel("none")}>
          <div className="space-y-3">
            <textarea
              autoFocus
              rows={3}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  handleSendText();
                }
              }}
              placeholder="支持中文输入法直接输入，Cmd/Ctrl+Enter 或点击发送写入远端当前输入框..."
              className="w-full resize-none rounded-lg border border-[#2C313D] bg-[#0A0C10] p-3 text-sm text-white placeholder:text-zinc-500 focus:border-[#2563EB] focus:outline-none"
            />

            <div className="flex items-center justify-between gap-2">
              <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={submitAfterText}
                  onChange={(e) => setSubmitAfterText(e.target.checked)}
                  className="h-4 w-4 rounded accent-[#2563EB]"
                />
                发送后自动回车
              </label>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => sendKey("backspace")}
                  className="btn-shell inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-xs"
                >
                  <Delete className="h-3.5 w-3.5" />
                  退格
                </button>
                <button
                  type="button"
                  onClick={() => sendKey("enter")}
                  className="btn-shell inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-xs"
                >
                  <CornerDownLeft className="h-3.5 w-3.5" />
                  回车
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={!inputText}
                onClick={handleSendText}
                className="btn-primary flex h-10 items-center justify-center gap-1.5 rounded-lg text-xs font-medium disabled:cursor-not-allowed"
              >
                <Send className="h-3.5 w-3.5" />
                {isDesktopTarget ? "输入到远端电脑" : "输入到手机"}
              </button>

              <button
                type="button"
                disabled={!inputText}
                onClick={handlePushClipboard}
                className="btn-shell flex h-10 items-center justify-center gap-1.5 rounded-lg text-xs font-medium disabled:opacity-40"
              >
                <Clipboard className="h-3.5 w-3.5 text-blue-400" />
                写入剪贴板
              </button>
            </div>

            <div className="rounded-lg border border-[#2C313D] bg-[#0A0C10] p-3">
              {isDesktopTarget && (
                <div className="mb-2.5 flex items-center justify-between border-b border-[#1F2430] pb-2">
                  <span className="text-xs font-medium text-zinc-200">
                    双向剪贴板自动同步
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={autoClipboardSync}
                    onClick={() => setAutoClipboardSync((prev) => !prev)}
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
                      autoClipboardSync
                        ? "border-[#2563EB] bg-[#2563EB]"
                        : "border-[#3F4656] bg-[#1F2430]"
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        autoClipboardSync ? "translate-x-4.5" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-zinc-400">
                  远端最新剪贴板
                </span>
                <button
                  type="button"
                  disabled={!clientState.remoteClipboard}
                  onClick={() => void handleCopyRemoteClipboard()}
                  className="btn-shell inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] disabled:opacity-40"
                >
                  {copiedRemoteClip ? (
                    <>
                      <Check className="h-3 w-3 text-emerald-400" />
                      已复制
                    </>
                  ) : (
                    <>
                      <ClipboardCopy className="h-3 w-3" />
                      复制
                    </>
                  )}
                </button>
              </div>
              <p className="mt-1.5 max-h-20 overflow-y-auto break-all text-xs text-zinc-300">
                {clientState.remoteClipboard ||
                  (isDesktopTarget
                    ? "暂无从远端电脑同步过来的剪贴板内容"
                    : "暂无从手机同步过来的剪贴板内容")}
              </p>
            </div>
          </div>
        </DarkSheet>
      )}

      {/* Pro Desktop Combo Shortcut Pad */}
      {isDesktopTarget && activePanel === "shortcuts" && (
        <DesktopShortcutBar
          targetPlatform={device?.osPlatform}
          onSendKeyEvent={(cmd) => client.sendCommand(cmd, targetDeviceId)}
          onClose={() => setActivePanel("none")}
        />
      )}

      {/* Pro Desktop Video Quality / Refresh Rate / Codec / Audio Drawer */}
      {isDesktopTarget && activePanel === "quality" && (
        <DarkSheet
          title="桌面画质、刷新率与编码器"
          onClose={() => setActivePanel("none")}
        >
          <DesktopQualitySheetContent
            client={client}
            qualityPreset={clientState.qualityPreset}
            desktopQuality={effectiveDesktopQuality}
            activeTransport={clientState.activeTransport}
            desiredTransport={clientState.desiredTransport}
            audioMuted={audioMuted}
            audioVolume={audioVolume}
            hasRemoteAudio={clientState.hasRemoteAudio}
            onToggleAudio={handleToggleDesktopAudio}
            onChangeVolume={setAudioVolume}
          />
        </DarkSheet>
      )}

      {/* P2P File Transfer / Remote File Browser Sheet */}
      {activePanel === "files" && (
        <DarkSheet
          title={isDesktopTarget ? "远端电脑双向文件管理" : "P2P 文件直传与远程升级"}
          wide={isDesktopTarget}
          onClose={() => setActivePanel("none")}
        >
          {isDesktopTarget ? (
            <RemoteFileBrowser
              client={client}
              clientState={clientState}
              device={device}
              currentDir={remoteBrowserDir}
              onCurrentDirChange={setRemoteBrowserDir}
              onShowToast={onShowToast}
            />
          ) : (
            <FileTransferSheetContent
              client={client}
              clientState={clientState}
              device={device}
              isDesktopTarget={isDesktopTarget}
              apiBase={resolvedApiBase}
              serverInfo={serverInfo}
              autoInstallApk={autoInstallApk}
              onToggleAutoInstallApk={setAutoInstallApk}
              apkFetchState={apkFetchState}
              onPushLatestApk={() => void handlePushLatestApk()}
              onCancelApkFetch={handleCancelApkFetch}
              fileInputRef={fileInputRef}
              onSelectLocalFile={(file) => void handleSendLocalFile(file)}
              onCloseSheet={() => setActivePanel("none")}
            />
          )}
        </DarkSheet>
      )}

      {/* Quality & Hardware Controls Sheet */}
      {activePanel === "more" && (
        <DarkSheet
          title={isDesktopTarget ? "电源、显示器与桌面控制" : "画质与硬件控制"}
          onClose={() => {
            setPendingPowerOp(null);
            setActivePanel("none");
          }}
        >
          <div className="space-y-4">
            {isDesktopTarget ? (
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setActivePanel("files")}
                  className="flex h-10 items-center justify-between rounded-lg border border-[#2C313D] bg-[#191D26] px-3 text-xs font-medium text-zinc-100 transition hover:bg-[#232836]"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <FolderOpen
                      className={`h-4 w-4 ${
                        isFileChannelReady ? "text-emerald-400" : "text-blue-400"
                      }`}
                    />
                    文件管理
                  </span>
                  <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-zinc-300">
                    {isFileChannelReady ? "就绪" : "查看"}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setActivePanel("text")}
                  className="flex h-10 items-center justify-between rounded-lg border border-[#2C313D] bg-[#191D26] px-3 text-xs font-medium text-zinc-100 transition hover:bg-[#232836]"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Clipboard className="h-4 w-4 text-blue-400" />
                    输入/剪贴板
                  </span>
                  <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-zinc-300">
                    {autoClipboardSync ? "自动" : "手动"}
                  </span>
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setActivePanel("files")}
                className="flex h-10 w-full items-center justify-between rounded-lg border border-[#2C313D] bg-[#191D26] px-3 text-xs font-medium text-zinc-100 transition hover:bg-[#232836]"
              >
                <span className="inline-flex items-center gap-2">
                  <Upload
                    className={`h-4 w-4 ${
                      isFileChannelReady ? "text-emerald-400" : "text-blue-400"
                    }`}
                  />
                  P2P 文件直传与远程升级
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    isFileChannelReady
                      ? "bg-emerald-500/20 text-emerald-300"
                      : "bg-white/10 text-zinc-400"
                  }`}
                >
                  {isFileChannelReady ? "P2P 就绪" : "查看"}
                </span>
              </button>
            )}

            {/* Desktop Zoom & Mouse Quick Row */}
            {isDesktopTarget && (
              <div>
                <p className="mb-2 text-xs font-medium text-zinc-400">
                  缩放视图与辅助操作
                </p>
                <div className="grid grid-cols-3 gap-1.5">
                  <DockButton
                    icon={<Maximize2 className="h-4 w-4 text-blue-400" />}
                    label={viewZoom > 1.05 ? "适应屏幕" : "已适应"}
                    active={viewZoom <= 1.05}
                    onClick={() => {
                      resetDesktopZoom();
                      setActivePanel("none");
                    }}
                  />
                  <DockButton
                    icon={<ZoomIn className="h-4 w-4 text-sky-400" />}
                    label="放大 2×"
                    active={viewZoom >= 1.95}
                    onClick={() => {
                      applyDesktopZoomAndPan(2, 0, 0);
                      setActivePanel("none");
                    }}
                  />
                  <DockButton
                    icon={<MousePointerClick className="h-4 w-4 text-emerald-400" />}
                    label="右键单击"
                    onClick={() => {
                      sendDesktopRightClick();
                      setActivePanel("none");
                    }}
                  />
                </div>
              </div>
            )}

            {hasMultiDisplays && (
              <div>
                <p className="mb-2 text-xs font-medium text-zinc-400">
                  远端显示器切换
                </p>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {remoteDisplays.map((display, idx) => {
                    const active = display.id === device?.activeDisplayId;
                    return (
                      <button
                        key={display.id}
                        type="button"
                        onClick={() => handleSelectRemoteDisplay(display.id)}
                        className={`flex h-9 items-center justify-between rounded-lg border px-2.5 text-xs font-medium transition ${
                          active
                            ? "border-[#2563EB] bg-[#2563EB] text-white"
                            : "border-[#2C313D] bg-[#191D26] text-zinc-200 hover:bg-[#232836]"
                        }`}
                      >
                        <span className="inline-flex items-center gap-1.5 truncate">
                          <Monitor className="h-3.5 w-3.5 shrink-0" />
                          显示器 {idx + 1}
                          {display.primary ? "（主）" : ""}
                        </span>
                        <span
                          className={`font-mono text-[10px] ${
                            active ? "text-blue-100" : "text-zinc-400"
                          }`}
                        >
                          {display.width}×{display.height}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {!isDesktopTarget && (
              <QualityPresetSelector
                client={client}
                qualityPreset={clientState.qualityPreset}
                activeTransport={clientState.activeTransport}
              />
            )}

            <div>
              <p className="mb-2 text-xs font-medium text-zinc-400">传输通道</p>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    { id: "webrtc", label: "WebRTC（低延迟）" },
                    { id: "ws-jpeg", label: "WS 帧流（强兼容）" },
                  ] as Array<{ id: TransportMode; label: string }>
                ).map((item) => {
                  const active =
                    (clientState.activeTransport ?? clientState.desiredTransport) ===
                    item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => client.setTransport(item.id)}
                      className={`h-9 rounded-lg border text-xs font-medium transition ${
                        active
                          ? "border-[#2563EB] bg-[#2563EB] text-white"
                          : "border-[#2C313D] bg-[#191D26] text-zinc-200 hover:bg-[#232836]"
                      }`}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {clientState.activeTransport === "webrtc" && (
              <LiveWebRtcTelemetryStrip client={client} showHeader />
            )}

            <div>
              <p className="mb-2 text-xs font-medium text-zinc-400">
                {isDesktopTarget ? "隐私与远程电源管理" : "硬件按键"}
              </p>
              {isDesktopTarget ? (
                <div className="space-y-2.5">
                  {/* Privacy Screen Toggle Row */}
                  <button
                    type="button"
                    onClick={handleTogglePrivacyScreen}
                    className={`flex h-10 w-full items-center justify-between rounded-lg border px-3 text-xs font-medium transition ${
                      isPrivacyActive
                        ? "border-[#2563EB] bg-[#2563EB] text-white"
                        : "border-[#2C313D] bg-[#191D26] text-zinc-100 hover:bg-[#232836]"
                    }`}
                  >
                    <span className="inline-flex items-center gap-2">
                      <EyeOff className="h-4 w-4" />
                      <span>
                        {isPrivacyActive ? "关闭隐私防窥黑屏" : "开启隐私防窥黑屏"}
                      </span>
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        isPrivacyActive
                          ? "bg-white/20 text-white"
                          : "bg-white/10 text-zinc-400"
                      }`}
                    >
                      {isPrivacyActive ? "防窥中" : "已关闭"}
                    </span>
                  </button>

                  {/* Remote Power Grid */}
                  <div className="grid grid-cols-4 gap-1.5">
                    <DockButton
                      icon={<Lock className="h-4 w-4 text-amber-400" />}
                      label="锁屏"
                      onClick={() => handleDesktopPowerAction("lock")}
                    />
                    <DockButton
                      icon={<Moon className="h-4 w-4 text-indigo-400" />}
                      label="睡眠"
                      active={pendingPowerOp === "sleep"}
                      onClick={() => handleDesktopPowerAction("sleep")}
                    />
                    <DockButton
                      icon={<RotateCw className="h-4 w-4 text-amber-300" />}
                      label="重启电脑"
                      active={pendingPowerOp === "restart"}
                      onClick={() => handleDesktopPowerAction("restart")}
                    />
                    <DockButton
                      icon={<Power className="h-4 w-4 text-rose-400" />}
                      label="关闭电脑"
                      active={pendingPowerOp === "shutdown"}
                      onClick={() => handleDesktopPowerAction("shutdown")}
                    />
                  </div>

                  {/* Inline 2-Step Confirmation Box for Destructive Power Ops */}
                  {pendingPowerOp && pendingPowerOp !== "lock" && (
                    <div className="rounded-lg border border-rose-500/40 bg-rose-500/12 p-3 text-xs">
                      <div className="flex items-start gap-2 text-rose-200">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                        <div className="min-w-0 flex-1 leading-relaxed">
                          <p className="font-semibold text-white">
                            {pendingPowerOp === "sleep"
                              ? "确认让远端电脑进入睡眠？"
                              : pendingPowerOp === "restart"
                                ? "确认重启远端电脑？"
                                : "确认关闭远端电脑？"}
                          </p>
                          <p className="mt-0.5 text-[11px] text-rose-200/85">
                            {pendingPowerOp === "sleep"
                              ? "进入睡眠后将暂停画面并可能断开当前远程连接。"
                              : pendingPowerOp === "restart"
                                ? "重启将关闭所有未保存的程序；若已开启开机自启，系统启动后会自动恢复在线。"
                                : "关机后远程连接将彻底断开，无法再远程重新开机！"}
                          </p>
                        </div>
                      </div>
                      <div className="mt-2.5 flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setPendingPowerOp(null)}
                          className="btn-shell h-8 rounded-md px-3 text-xs font-medium"
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          onClick={handleConfirmDesktopPower}
                          className="inline-flex h-8 items-center gap-1 rounded-md border border-rose-500 bg-rose-600 px-3 text-xs font-semibold text-white hover:bg-rose-500"
                        >
                          <Power className="h-3.5 w-3.5" />
                          {pendingPowerOp === "sleep"
                            ? "确认睡眠"
                            : pendingPowerOp === "restart"
                              ? "确认重启"
                              : "确认关机"}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Session Operations */}
                  <div className="grid grid-cols-2 gap-1.5 pt-1">
                    <DockButton
                      icon={<RefreshCw className="h-4 w-4 text-blue-400" />}
                      label="强制重连"
                      onClick={() => {
                        setPendingPowerOp(null);
                        setActivePanel("none");
                        client.reconnectNow();
                      }}
                    />
                    <DockButton
                      icon={<LogOut className="h-4 w-4 text-rose-400" />}
                      label="断开退出"
                      onClick={onExit}
                    />
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-1.5">
                  <DockButton
                    icon={<Moon className={`h-4 w-4 ${device?.blackScreenActive ? "text-indigo-300" : "text-indigo-400"}`} />}
                    label={device?.blackScreenActive ? "关闭伪装黑屏" : "伪装黑屏"}
                    active={Boolean(device?.blackScreenActive)}
                    onClick={() => sendBlackScreen(!device?.blackScreenActive)}
                  />
                  <DockButton
                    icon={<Smartphone className={`h-4 w-4 ${device?.forcePortraitActive ? "text-white" : "text-sky-400"}`} />}
                    label={device?.forcePortraitActive ? "解除强制竖屏" : "强制竖屏"}
                    active={Boolean(device?.forcePortraitActive)}
                    onClick={() => sendForcePortrait(!device?.forcePortraitActive)}
                  />
                  <DockButton
                    icon={<Lock className="h-4 w-4" />}
                    label="真锁屏"
                    onClick={() => sendKey("lock")}
                  />
                  <DockButton
                    icon={<Camera className="h-4 w-4" />}
                    label="截屏"
                    onClick={() => sendKey("screenshot")}
                  />
                  <DockButton
                    icon={<Power className="h-4 w-4" />}
                    label="电源菜单"
                    onClick={() => sendKey("power_dialog")}
                  />
                  <DockButton
                    icon={<Volume2 className="h-4 w-4" />}
                    label="音量 +"
                    onClick={() => sendKey("volume_up")}
                  />
                  <DockButton
                    icon={<Volume1 className="h-4 w-4" />}
                    label="音量 -"
                    onClick={() => sendKey("volume_down")}
                  />
                  <DockButton
                    icon={<RefreshCw className="h-4 w-4 text-blue-400" />}
                    label="强制重连"
                    onClick={() => {
                      setActivePanel("none");
                      client.reconnectNow();
                    }}
                  />
                  <DockButton
                    icon={<LogOut className="h-4 w-4 text-rose-400" />}
                    label="断开退出"
                    onClick={onExit}
                  />
                </div>
              )}
            </div>
          </div>
        </DarkSheet>
      )}
    </div>
  );
}

interface TelemetryCapsuleProps {
  client: RemoteClient;
  socketStatus: SocketStatus;
  sessionStatus: SessionStatus;
  activeTransport: TransportMode | null;
  desiredTransport: TransportMode;
  isStreamingReady: boolean;
  device: DeviceSummary | null;
  dockExpanded: boolean;
  onToggleDock: () => void;
  inline?: boolean;
}

const TelemetryCapsule = memo(function TelemetryCapsule({
  client,
  socketStatus,
  sessionStatus,
  activeTransport,
  desiredTransport,
  isStreamingReady,
  device,
  dockExpanded,
  onToggleDock,
  inline = false,
}: TelemetryCapsuleProps) {
  const telemetry = useSyncExternalStore(
    client.subscribeTelemetry,
    client.getTelemetrySnapshot,
  );

  const statusDotClass = isStreamingReady
    ? "bg-emerald-400"
    : socketStatus === "error" ||
        sessionStatus === "error" ||
        sessionStatus === "ended"
      ? "bg-rose-400"
      : "bg-amber-400";

  const transportFull =
    activeTransport === "webrtc"
      ? telemetry.webrtcRoute === "p2p"
        ? "WebRTC · P2P"
        : telemetry.webrtcRoute === "turn"
          ? "WebRTC · TURN"
          : "WebRTC"
      : activeTransport === "ws-jpeg"
        ? "WS"
        : desiredTransport === "webrtc"
          ? "WebRTC"
          : "WS";

  const transportShort =
    activeTransport === "webrtc"
      ? telemetry.webrtcRoute === "p2p"
        ? "RTC·P2P"
        : telemetry.webrtcRoute === "turn"
          ? "RTC·TURN"
          : "RTC"
      : activeTransport === "ws-jpeg"
        ? "WS"
        : desiredTransport === "webrtc"
          ? "RTC"
          : "WS";

  const bitrateKbps = telemetry.webrtcTelemetry?.bitrateKbps ?? null;
  const isIdleWebRtc = isWebRtcStaticIdle(
    activeTransport,
    sessionStatus,
    telemetry.fps,
    bitrateKbps,
  );

  const capsuleButton = (
    <button
      type="button"
      onClick={onToggleDock}
      className={
        inline
          ? "desktop-no-drag flex h-7 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-md border border-[#2C313D] bg-white/8 px-2 text-xs text-zinc-200 transition hover:border-[#3F4656] hover:bg-white/14"
          : "pointer-events-auto flex max-w-[calc(100vw-1.5rem)] items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border border-[#2C313D] bg-[#111318] px-2.5 py-1.5 text-xs text-zinc-200 shadow-[0_8px_24px_rgba(0,0,0,0.55)] transition hover:border-[#3F4656] sm:gap-2 sm:px-3"
      }
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass}`} />
      <span className="shrink-0 font-mono text-[11px] text-white">
        {telemetry.rttMs !== null ? `${telemetry.rttMs}ms` : "--ms"}
      </span>
      <span className="shrink-0 text-zinc-600">·</span>
      <span className="shrink-0 font-mono text-[11px] text-zinc-300">
        {isIdleWebRtc ? (
          <>
            <span className="sm:hidden">静止</span>
            <span className="hidden sm:inline">静止节能</span>
          </>
        ) : (
          `${telemetry.fps} FPS`
        )}
      </span>
      <span
        className={`${inline ? "hidden sm:inline" : ""} shrink-0 rounded bg-[#2563EB]/25 px-1.5 py-0.5 text-[10px] font-semibold text-[#93C5FD]`}
      >
        <span className="sm:hidden">{transportShort}</span>
        <span className="hidden sm:inline">{transportFull}</span>
      </span>
      {device && device.deviceType !== "desktop" && (
        <span
          className={`${inline ? "hidden md:inline-flex" : "inline-flex"} shrink-0 items-center gap-0.5 font-mono text-[11px] text-zinc-300`}
        >
          {device.charging ? (
            <BatteryCharging className="h-3.5 w-3.5 text-emerald-400" />
          ) : (
            <Battery className="h-3.5 w-3.5 text-zinc-400" />
          )}
          {device.battery}%
        </span>
      )}
      <span className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-zinc-200">
        {dockExpanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <SlidersHorizontal className="h-3 w-3" />
        )}
      </span>
    </button>
  );

  if (inline) {
    return capsuleButton;
  }

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-3 sm:justify-end"
      style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
    >
      {capsuleButton}
    </div>
  );
});

const QualityPresetSelector = memo(function QualityPresetSelector({
  client,
  qualityPreset,
  activeTransport,
}: {
  client: RemoteClient;
  qualityPreset: QualityPreset;
  activeTransport: TransportMode | null;
}) {
  const telemetry = useSyncExternalStore(
    client.subscribeTelemetry,
    client.getTelemetrySnapshot,
  );

  const wt = telemetry.webrtcTelemetry;
  const liveShortSide =
    wt && wt.width > 0
      ? wt.height > 0
        ? Math.min(wt.width, wt.height)
        : wt.width
      : 0;
  const autoDesc =
    qualityPreset === "auto" && activeTransport === "webrtc" && liveShortSide > 0
      ? `${liveShortSide}p · ${telemetry.fps > 2 ? `${telemetry.fps}fps` : "自适应"}`
      : "自适应网速";

  const presets: Array<{ id: QualityPreset; title: string; desc: string }> = [
    { id: "auto", title: "智能", desc: autoDesc },
    { id: "eco", title: "省流", desc: "540p · 30fps" },
    { id: "balanced", title: "均衡", desc: "900p · 60fps" },
    { id: "hd", title: "高清", desc: "1080p · 60fps" },
  ];

  return (
    <div>
      <p className="mb-2 text-xs font-medium text-zinc-400">画质预设</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {presets.map((preset) => {
          const active = qualityPreset === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => client.setQuality(preset.id)}
              className={`rounded-lg border px-1.5 py-2 text-center transition ${
                active
                  ? "border-[#2563EB] bg-[#2563EB] text-white"
                  : "border-[#2C313D] bg-[#191D26] text-zinc-200 hover:bg-[#232836]"
              }`}
            >
              <div className="text-xs font-semibold">{preset.title}</div>
              <div
                className={`mt-0.5 whitespace-nowrap font-mono text-[10px] ${
                  active ? "text-blue-100" : "text-zinc-400"
                }`}
              >
                {preset.desc}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
});

const LiveWebRtcTelemetryStrip = memo(function LiveWebRtcTelemetryStrip({
  client,
  compact = false,
  showHeader = false,
  className,
}: {
  client: RemoteClient;
  compact?: boolean;
  showHeader?: boolean;
  className?: string;
}) {
  const telemetry = useSyncExternalStore(
    client.subscribeTelemetry,
    client.getTelemetrySnapshot,
  );

  if (!telemetry.webrtcTelemetry) {
    return null;
  }

  return (
    <div className={className}>
      {showHeader && (
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-medium text-zinc-400">实时链路诊断</p>
          <button
            type="button"
            onClick={() => client.requestKeyframe()}
            className="btn-shell inline-flex h-6 items-center gap-1 rounded px-2 text-[10px] font-medium text-zinc-300 hover:text-white"
          >
            <RefreshCw className="h-2.5 w-2.5 text-blue-400" />
            刷新关键帧
          </button>
        </div>
      )}
      <WebRtcTelemetryStrip telemetry={telemetry.webrtcTelemetry} compact={compact} />
    </div>
  );
});

const WebRtcTelemetryStrip = memo(function WebRtcTelemetryStrip({
  telemetry,
  compact = false,
}: {
  telemetry: WebRtcTelemetry;
  compact?: boolean;
}) {
  const codecLabel = telemetry.codec || "--";
  const resLabel =
    telemetry.width > 0 && telemetry.height > 0
      ? `${telemetry.width}×${telemetry.height}`
      : "--×--";
  const bitrateLabel =
    telemetry.bitrateKbps >= 1000
      ? `${(telemetry.bitrateKbps / 1000).toFixed(1)} Mbps`
      : `${telemetry.bitrateKbps} kbps`;
  const decodeLabel =
    telemetry.decodeMs !== null ? `${telemetry.decodeMs}ms` : "--ms";
  const jitterBufferLabel =
    telemetry.jitterBufferMs !== null ? `${telemetry.jitterBufferMs}ms` : "--ms";

  const lossTone =
    telemetry.packetsLost >= 10
      ? "border-rose-500/40 bg-rose-500/15 text-rose-300"
      : telemetry.packetsLost > 0
        ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
        : "border-[#262B37] bg-[#14171F] text-zinc-300";

  const freezeTone =
    telemetry.freezeCount >= 3
      ? "border-rose-500/40 bg-rose-500/15 text-rose-300"
      : telemetry.freezeCount > 0
        ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
        : "border-[#262B37] bg-[#14171F] text-zinc-300";

  const iceTone =
    telemetry.icePair?.startsWith("TURN")
      ? "border-amber-500/35 bg-amber-500/15 text-amber-300"
      : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";

  return (
    <div
      className={`rounded-lg border border-[#282D38] bg-[#0A0C10] ${
        compact ? "px-2 py-1.5" : "px-2.5 py-2"
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded border border-[#262B37] bg-[#14171F] px-1.5 py-0.5 font-mono text-[10px] leading-tight text-zinc-100">
          {codecLabel} {resLabel}
        </span>
        <span className="rounded border border-[#262B37] bg-[#14171F] px-1.5 py-0.5 font-mono text-[10px] leading-tight text-blue-300">
          {bitrateLabel}
        </span>
        <span className="rounded border border-[#262B37] bg-[#14171F] px-1.5 py-0.5 font-mono text-[10px] leading-tight text-zinc-300">
          解码 {decodeLabel}
        </span>
        <span className="rounded border border-[#262B37] bg-[#14171F] px-1.5 py-0.5 font-mono text-[10px] leading-tight text-zinc-300">
          缓冲 {jitterBufferLabel}
        </span>
        <span
          className={`rounded border px-1.5 py-0.5 font-mono text-[10px] leading-tight ${lossTone}`}
        >
          丢包 {telemetry.packetsLost}
        </span>
        <span
          className={`rounded border px-1.5 py-0.5 font-mono text-[10px] leading-tight ${freezeTone}`}
        >
          冻结 {telemetry.freezeCount}
        </span>
        {telemetry.icePair && (
          <span
            className={`rounded border px-1.5 py-0.5 font-mono text-[10px] leading-tight ${iceTone}`}
          >
            {telemetry.icePair}
          </span>
        )}
      </div>
    </div>
  );
});

function DockButton({
  icon,
  label,
  active = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-13 flex-col items-center justify-center gap-1 rounded-lg border text-[11px] font-medium transition ${
        active
          ? "border-[#2563EB] bg-[#2563EB] text-white"
          : "border-[#282D38] bg-[#191D26] text-zinc-200 hover:bg-[#232836]"
      }`}
    >
      {icon}
      <span className="leading-none">{label}</span>
    </button>
  );
}

function formatTransferBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${Math.round(bytes)} B`;
}

function formatTransferSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "--";
  if (bytesPerSec >= 1024 * 1024) {
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  if (bytesPerSec >= 1024) {
    return `${Math.round(bytesPerSec / 1024)} KB/s`;
  }
  return `${Math.round(bytesPerSec)} B/s`;
}

const FileTransferSheetContent = memo(function FileTransferSheetContent({
  client,
  clientState,
  device,
  isDesktopTarget,
  apiBase,
  serverInfo,
  autoInstallApk,
  onToggleAutoInstallApk,
  apkFetchState,
  onPushLatestApk,
  onCancelApkFetch,
  fileInputRef,
  onSelectLocalFile,
  onCloseSheet,
}: {
  client: RemoteClient;
  clientState: RemoteClientState;
  device: DeviceSummary | null;
  isDesktopTarget: boolean;
  apiBase: string;
  serverInfo?: ServerInfo;
  autoInstallApk: boolean;
  onToggleAutoInstallApk: (checked: boolean) => void;
  apkFetchState: {
    active: boolean;
    loaded: number;
    total: number;
    error: string | null;
  };
  onPushLatestApk: () => void;
  onCancelApkFetch: () => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onSelectLocalFile: (file: File) => void;
  onCloseSheet: () => void;
}) {
  const telemetry = useSyncExternalStore(
    client.subscribeTelemetry,
    client.getTelemetrySnapshot,
  );

  const isP2pSupported = device?.capabilities.p2pFileTransfer !== false;
  const isFileReady = clientState.fileChannelOpen && isP2pSupported;
  const ft: FileTransferState | null = clientState.fileTransfer;
  const isTransferActive =
    ft !== null &&
    (ft.status === "preparing" ||
      ft.status === "sending" ||
      ft.status === "verifying");
  const isBusy = isTransferActive || apkFetchState.active;
  const apkDownloadUrl = getAndroidApkDownloadUrl(apiBase, serverInfo);
  const apkFileName = getAndroidApkFileName(serverInfo);

  const transferPct =
    ft && ft.totalBytes > 0
      ? ft.status === "done"
        ? 100
        : Math.min(100, Math.round((ft.sentBytes / ft.totalBytes) * 100))
      : 0;

  const apkFetchPct =
    apkFetchState.total > 0
      ? Math.min(100, Math.round((apkFetchState.loaded / apkFetchState.total) * 100))
      : null;

  const statusMeta = (() => {
    if (!ft) return null;
    switch (ft.status) {
      case "preparing":
        return { label: "准备中", tone: "bg-blue-500/20 text-blue-300" };
      case "sending":
        return { label: "直传中", tone: "bg-blue-500/20 text-blue-300" };
      case "verifying":
        return { label: "校验中", tone: "bg-indigo-500/20 text-indigo-300" };
      case "done":
        if (ft.needsInstallPermission) {
          return { label: "已打开未知来源授权页", tone: "bg-amber-500/20 text-amber-300" };
        }
        if (ft.installLaunched) {
          return { label: "已拉起安装界面", tone: "bg-emerald-500/20 text-emerald-300" };
        }
        return { label: "已保存", tone: "bg-emerald-500/20 text-emerald-300" };
      case "error":
        return { label: "传输失败", tone: "bg-rose-500/20 text-rose-300" };
      case "cancelled":
        return { label: "已取消", tone: "bg-zinc-500/20 text-zinc-300" };
      default:
        return { label: "空闲", tone: "bg-zinc-500/20 text-zinc-300" };
    }
  })();

  return (
    <div className="space-y-3.5">
      {/* Live P2P Channel Status Badge */}
      {isFileReady ? (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
          <span>
            {telemetry.webrtcRoute === "turn"
              ? "WebRTC TURN 文件通道已就绪"
              : "WebRTC P2P 文件通道已就绪（直传不占云端带宽）"}
          </span>
        </div>
      ) : (
        <div className="space-y-2 rounded-lg border border-amber-500/35 bg-amber-500/10 p-3 text-xs text-amber-200">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div className="space-y-1 leading-relaxed">
              {clientState.activeTransport !== "webrtc" ? (
                <p>
                  {isDesktopTarget
                    ? "当前为 WS 帧流通道，P2P 文件直传需切换至 WebRTC 模式。"
                    : "当前为 WS 帧流通道，P2P 文件直传需切换至 WebRTC 模式并确保手机端为最新版 Agent。"}
                </p>
              ) : !isP2pSupported ? (
                <p>
                  {isDesktopTarget
                    ? "远端主机暂不支持 P2P 文件通道，请升级至最新版 VeloDeck 桌面端。"
                    : "手机端 Agent 版本较旧，暂不支持 P2P 文件通道。请先一次性升级至最新版，之后即可全程远程一键推送升级。"}
                </p>
              ) : (
                <p>
                  {isDesktopTarget
                    ? "WebRTC 文件通道尚未就绪，请等待 WebRTC 通道连通。"
                    : "WebRTC 文件通道尚未就绪。请等待 WebRTC 连通，或确认手机端已升级至最新版 Agent。"}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            {clientState.activeTransport !== "webrtc" && (
              <button
                type="button"
                onClick={() => client.setTransport("webrtc")}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-amber-400/40 bg-amber-400/15 px-2.5 text-[11px] font-medium text-amber-100 hover:bg-amber-400/25"
              >
                <Zap className="h-3 w-3" />
                切换至 WebRTC
              </button>
            )}
            {!isDesktopTarget && (
              <a
                href={apkDownloadUrl}
                download={apkFileName}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-7 items-center gap-1 rounded-md border border-[#2C313D] bg-[#191D26] px-2.5 text-[11px] font-medium text-zinc-200 hover:bg-[#232836]"
              >
                <Download className="h-3 w-3 text-blue-400" />
                下载最新 APK
              </a>
            )}
          </div>
        </div>
      )}

      {/* Action 1: One-click Server APK OTA Upgrade (Android targets only) */}
      {!isDesktopTarget && serverInfo?.hasAndroidApk && (
        <div className="rounded-lg border border-[#2C313D] bg-[#0A0C10] p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
                <Package className="h-3.5 w-3.5 text-blue-400" />
                远程一键推送新版 Agent
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
                从服务器拉取最新 {apkFileName} 并经 WebRTC 直传到手机自动拉起安装
                {serverInfo.version ? `（服务端 v${serverInfo.version}）` : ""}
              </p>
              {serverInfo.apkSha256 && (
                <p className="mt-1 truncate font-mono text-[10px] text-zinc-500">
                  SHA-256: {serverInfo.apkSha256.slice(0, 16)}…
                </p>
              )}
            </div>
          </div>

          <button
            type="button"
            disabled={!isFileReady || isBusy}
            onClick={onPushLatestApk}
            className="btn-primary mt-2.5 flex h-9 w-full items-center justify-center gap-1.5 rounded-lg text-xs font-medium disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Upload className="h-3.5 w-3.5" />
            {apkFetchState.active
              ? "正在拉取服务器最新 APK..."
              : "一键推送云端最新 APK 升级"}
          </button>

          {apkFetchState.active && (
            <div className="mt-2.5 space-y-1.5 rounded-md border border-blue-500/25 bg-blue-500/10 p-2.5">
              <div className="flex items-center justify-between text-[11px] text-blue-200">
                <span>正在拉取服务器最新 APK...</span>
                <span className="font-mono">
                  {apkFetchState.total > 0
                    ? `${formatTransferBytes(apkFetchState.loaded)} / ${formatTransferBytes(apkFetchState.total)} (${apkFetchPct}%)`
                    : formatTransferBytes(apkFetchState.loaded)}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-[#3B82F6] transition-all"
                  style={{ width: `${apkFetchPct ?? 35}%` }}
                />
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={onCancelApkFetch}
                  className="text-[11px] text-zinc-300 hover:text-white"
                >
                  取消拉取
                </button>
              </div>
            </div>
          )}

          {apkFetchState.error && (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-rose-300">
              <XCircle className="h-3.5 w-3.5 shrink-0" />
              {apkFetchState.error}
            </p>
          )}
        </div>
      )}

      {/* Action 2: Local File Picker */}
      <div className="rounded-lg border border-[#2C313D] bg-[#0A0C10] p-3">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) {
              onSelectLocalFile(file);
            }
          }}
        />
        <button
          type="button"
          disabled={!isFileReady || isBusy}
          onClick={() => fileInputRef.current?.click()}
          className="btn-shell flex h-10 w-full items-center justify-center gap-2 rounded-lg text-xs font-medium text-zinc-100 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <FileUp className="h-4 w-4 text-blue-400" />
          {isDesktopTarget ? "选择本地文件直传到远端电脑" : "选择本地文件直传到手机"}
        </button>

        <div className="mt-2.5 flex items-center justify-between gap-2">
          {!isDesktopTarget ? (
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
              <input
                type="checkbox"
                checked={autoInstallApk}
                onChange={(e) => onToggleAutoInstallApk(e.target.checked)}
                className="h-4 w-4 rounded accent-[#2563EB]"
              />
              APK 传完自动拉起安装
            </label>
          ) : (
            <span className="text-[11px] text-zinc-400">
              P2P 直传 · SHA-256 自动校验
            </span>
          )}
          <span className="text-[10px] text-zinc-500">支持拖拽至画面</span>
        </div>

        <p className="mt-1.5 text-[11px] text-zinc-500">
          {isDesktopTarget ? (
            <>
              文件默认保存至远端电脑的{" "}
              <span className="font-mono text-zinc-400">Downloads/VeloDeck/</span>
            </>
          ) : (
            <>
              普通文件默认保存至手机{" "}
              <span className="font-mono text-zinc-400">Download/VeloDeck/</span>
            </>
          )}
        </p>
      </div>

      {/* Live Transfer Progress Panel */}
      {ft && statusMeta && (
        <div className="rounded-lg border border-[#2C313D] bg-[#0A0C10] p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-xs font-semibold text-white">
                {ft.fileName}
              </span>
              <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-zinc-300">
                {ft.purpose === "apk_install" ? "APK 安装" : "文件"}
              </span>
            </div>
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${statusMeta.tone}`}
            >
              {statusMeta.label}
            </span>
          </div>

          <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className={`h-full rounded-full transition-all duration-150 ${
                ft.status === "error"
                  ? "bg-rose-500"
                  : ft.status === "cancelled"
                    ? "bg-zinc-500"
                    : ft.status === "done"
                      ? ft.needsInstallPermission
                        ? "bg-amber-400"
                        : "bg-emerald-400"
                      : "bg-[#3B82F6]"
              }`}
              style={{
                width: `${
                  ft.status === "preparing" && ft.totalBytes === 0
                    ? 12
                    : transferPct
                }%`,
              }}
            />
          </div>

          <div className="mt-1.5 flex items-center justify-between font-mono text-[11px] text-zinc-400">
            <span>
              {formatTransferBytes(ft.sentBytes)} / {formatTransferBytes(ft.totalBytes)} ({transferPct}%)
            </span>
            <span>
              {ft.status === "sending"
                ? formatTransferSpeed(ft.speedBytesPerSec)
                : ft.status === "verifying"
                  ? "SHA-256 校验中"
                  : ""}
            </span>
          </div>

          {ft.message && (
            <p
              className={`mt-2 text-xs leading-relaxed ${
                ft.status === "error"
                  ? "text-rose-300"
                  : ft.needsInstallPermission
                    ? "text-amber-200"
                    : ft.status === "done"
                      ? "text-emerald-200"
                      : "text-zinc-300"
              }`}
            >
              {ft.message}
            </p>
          )}

          {ft.savedPath && !ft.message?.includes(ft.savedPath) && (
            <p className="mt-1 break-all font-mono text-[10px] text-zinc-500">
              {ft.savedPath}
            </p>
          )}

          <div className="mt-3 flex items-center justify-end gap-2">
            {isTransferActive ? (
              <button
                type="button"
                onClick={() => client.cancelFileTransfer()}
                className="inline-flex h-8 items-center gap-1 rounded-md border border-rose-500/35 bg-rose-500/15 px-3 text-xs font-medium text-rose-200 hover:bg-rose-500/25"
              >
                <X className="h-3.5 w-3.5" />
                取消传输
              </button>
            ) : (
              <>
                {(ft.installLaunched || ft.needsInstallPermission) && (
                  <button
                    type="button"
                    onClick={onCloseSheet}
                    className="btn-primary inline-flex h-8 items-center gap-1 rounded-md px-3 text-xs font-medium"
                  >
                    去手机画面操作
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => client.clearFileTransfer()}
                  className="btn-shell inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-xs text-zinc-300"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  清除记录
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

function DarkSheet({
  title,
  wide = false,
  onClose,
  children,
}: {
  title: string;
  wide?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/75 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`animate-sheet-up safe-bottom max-h-[85dvh] w-full ${
          wide ? "max-w-2xl" : "max-w-md"
        } overflow-y-auto rounded-t-2xl border border-[#2C313D] bg-[#111318] p-5 text-white shadow-[0_24px_48px_rgba(0,0,0,0.75)] sm:rounded-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-white/10 text-zinc-300 hover:bg-white/15 hover:text-white"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const DesktopQualitySheetContent = memo(function DesktopQualitySheetContent({
  client,
  qualityPreset,
  desktopQuality,
  activeTransport,
  desiredTransport,
  audioMuted,
  audioVolume,
  hasRemoteAudio,
  onToggleAudio,
  onChangeVolume,
}: {
  client: RemoteClient;
  qualityPreset: QualityPreset;
  desktopQuality: StreamQuality;
  activeTransport: TransportMode | null;
  desiredTransport: TransportMode;
  audioMuted: boolean;
  audioVolume: number;
  hasRemoteAudio: boolean;
  onToggleAudio: () => void;
  onChangeVolume: (vol: number) => void;
}) {
  const telemetry = useSyncExternalStore(
    client.subscribeTelemetry,
    client.getTelemetrySnapshot,
  );
  const wt = telemetry.webrtcTelemetry;

  const activePresetId: DesktopQualityPreset = (() => {
    if (desktopQuality.auto) return "auto";
    if (desktopQuality.maxWidth >= 3840) return "ultra";
    if (desktopQuality.maxWidth >= 2560) return "hd";
    if (desktopQuality.maxWidth >= 1920) return "balanced";
    if (desktopQuality.maxWidth <= 1280) return "eco";
    return qualityPreset;
  })();

  const presets: Array<{
    id: DesktopQualityPreset;
    title: string;
    desc: string;
  }> = [
    { id: "auto", title: "智能 (Auto)", desc: "自适应网速" },
    { id: "eco", title: "流畅", desc: "720p · 60fps" },
    { id: "balanced", title: "高清", desc: "1080p · 60fps" },
    { id: "hd", title: "2K 高刷", desc: "1440p · 90fps" },
    { id: "ultra", title: "4K 极致", desc: "2160p · 120fps" },
  ];

  const fpsOptions = [30, 60, 90, 120] as const;
  const codecOptions: Array<{ id: VideoCodecPreference; label: string }> = [
    { id: "auto", label: "自动" },
    { id: "h264", label: "H.264" },
    { id: "hevc", label: "HEVC" },
    { id: "av1", label: "AV1" },
    { id: "vp9", label: "VP9" },
  ];

  const activeCodec: VideoCodecPreference = desktopQuality.codec ?? "auto";

  function applyPreset(id: DesktopQualityPreset) {
    const base = DESKTOP_QUALITY_PRESETS[id];
    client.setDesktopStreamQuality(
      {
        ...base,
        codec: activeCodec,
      },
      id,
    );
  }

  function applyFps(fps: number) {
    client.setDesktopStreamQuality({
      ...desktopQuality,
      fps,
      auto: false,
    });
  }

  function applyCodec(codec: VideoCodecPreference) {
    client.setDesktopStreamQuality({
      ...desktopQuality,
      codec,
    });
  }

  const resReadout =
    wt && wt.width > 0 && wt.height > 0 ? `${wt.width}×${wt.height}` : "--×--";
  const bitrateReadout =
    wt && wt.bitrateKbps >= 1000
      ? `${(wt.bitrateKbps / 1000).toFixed(1)} Mbps`
      : wt
        ? `${wt.bitrateKbps} kbps`
        : "--";

  return (
    <div className="space-y-4">
      {/* Live Bitrate / FPS / Resolution Telemetry Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#262A34] bg-[#0A0C10] px-3 py-2 font-mono text-xs">
        <div className="flex items-center gap-2 text-zinc-200">
          <span className="text-white font-semibold">{resReadout}</span>
          <span className="text-zinc-600">·</span>
          <span className="text-emerald-300">{telemetry.fps} FPS</span>
          <span className="text-zinc-600">·</span>
          <span className="text-blue-300">{bitrateReadout}</span>
        </div>
        <span className="rounded border border-[#262A34] bg-[#14171F] px-1.5 py-0.5 text-[10px] text-zinc-300">
          {wt?.codec || activeCodec.toUpperCase()}
        </span>
      </div>

      {/* Resolution / Quality Presets */}
      <div>
        <p className="mb-2 text-xs font-medium text-zinc-400">画质档位</p>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {presets.map((preset) => {
            const active = activePresetId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPreset(preset.id)}
                className={`rounded-lg border px-2 py-2 text-center transition ${
                  active
                    ? "border-[#2563EB] bg-[#2563EB] text-white"
                    : "border-[#2C313D] bg-[#191D26] text-zinc-200 hover:bg-[#232836]"
                }`}
              >
                <div className="text-xs font-semibold">{preset.title}</div>
                <div
                  className={`mt-0.5 whitespace-nowrap font-mono text-[10px] ${
                    active ? "text-blue-100" : "text-zinc-400"
                  }`}
                >
                  {preset.desc}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Independent Refresh Rate Pills */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-medium text-zinc-400">目标刷新率</p>
          <span className="font-mono text-[11px] text-zinc-500">
            当前目标 {desktopQuality.fps} fps
          </span>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {fpsOptions.map((fps) => {
            const active = desktopQuality.fps === fps;
            return (
              <button
                key={fps}
                type="button"
                onClick={() => applyFps(fps)}
                className={`h-9 rounded-lg border font-mono text-xs font-semibold transition ${
                  active
                    ? "border-[#2563EB] bg-[#2563EB] text-white"
                    : "border-[#2C313D] bg-[#191D26] text-zinc-200 hover:bg-[#232836]"
                }`}
              >
                {fps} fps
              </button>
            );
          })}
        </div>
      </div>

      {/* Independent Video Codec Pills */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-medium text-zinc-400">首选视频编码器</p>
          <span className="text-[11px] text-zinc-500">
            硬件编解码自动回退
          </span>
        </div>
        <div className="grid grid-cols-5 gap-1.5">
          {codecOptions.map((item) => {
            const active = activeCodec === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => applyCodec(item.id)}
                className={`h-9 rounded-lg border font-mono text-[11px] font-semibold transition ${
                  active
                    ? "border-[#2563EB] bg-[#2563EB] text-white"
                    : "border-[#2C313D] bg-[#191D26] text-zinc-200 hover:bg-[#232836]"
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Desktop System Audio & Volume Slider */}
      <div className="rounded-lg border border-[#262A34] bg-[#0A0C10] p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggleAudio}
              className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition ${
                !audioMuted
                  ? "border-[#2563EB] bg-[#2563EB] text-white"
                  : "border-[#2C313D] bg-[#191D26] text-zinc-200 hover:bg-[#232836]"
              }`}
            >
              {audioMuted ? (
                <VolumeX className="h-3.5 w-3.5" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" />
              )}
              <span>{audioMuted ? "已静音" : "声音开启"}</span>
            </button>
            <span className="text-[11px] text-zinc-400">
              {hasRemoteAudio ? "已收到远端音频流" : "等待远端音频"}
            </span>
          </div>
          <span className="font-mono text-xs text-zinc-300">
            {Math.round((audioMuted ? 0 : audioVolume) * 100)}%
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={audioMuted ? 0 : audioVolume}
          onChange={(e) => {
            const val = Number(e.target.value);
            onChangeVolume(val);
            if (audioMuted && val > 0) {
              onToggleAudio();
            }
          }}
          aria-label="远端电脑音量"
          className="mt-2.5 h-1.5 w-full cursor-pointer accent-[#2563EB]"
        />
      </div>

      {/* Transport Switch + Live WebRTC Diagnostics */}
      <div>
        <p className="mb-2 text-xs font-medium text-zinc-400">传输通道</p>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              { id: "webrtc", label: "WebRTC（低延迟）" },
              { id: "ws-jpeg", label: "WS 帧流（强兼容）" },
            ] as Array<{ id: TransportMode; label: string }>
          ).map((item) => {
            const active = (activeTransport ?? desiredTransport) === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => client.setTransport(item.id)}
                className={`h-9 rounded-lg border text-xs font-medium transition ${
                  active
                    ? "border-[#2563EB] bg-[#2563EB] text-white"
                    : "border-[#2C313D] bg-[#191D26] text-zinc-200 hover:bg-[#232836]"
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      {activeTransport === "webrtc" && (
        <LiveWebRtcTelemetryStrip client={client} showHeader />
      )}
    </div>
  );
});
