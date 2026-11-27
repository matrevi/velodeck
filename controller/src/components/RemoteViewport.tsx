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
  FileUp,
  Home,
  Keyboard,
  Layers,
  Lock,
  LogOut,
  Moon,
  Package,
  Power,
  RefreshCw,
  Send,
  SlidersHorizontal,
  Smartphone,
  Sun,
  Trash2,
  Unlock,
  Upload,
  Volume1,
  Volume2,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import type {
  ControlCommand,
  DeviceSummary,
  MediaFrame,
  RemoteKey,
  TransportMode,
} from "@velodeck/protocol";
import { GestureRecognizer, clientPointToNormalized } from "../gestures/GestureMapper";
import {
  detectDefaultApiBase,
  getAndroidApkDownloadUrl,
  getAndroidApkFileName,
  type ServerInfo,
} from "../state/auth";
import type { QualityPreset } from "../state/profiles";
import {
  isWebRtcStaticIdle,
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
  onExit: () => void;
}

interface TouchRipple {
  id: number;
  x: number;
  y: number;
}

type UtilityPanel = "none" | "unlock" | "text" | "files" | "more";

type VideoElementWithRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const WHEEL_SWIPE_DURATION_MS = 65;
const WHEEL_SWIPE_COOLDOWN_MS = 80;
const KEYBOARD_TEXT_DEBOUNCE_MS = 100;

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
  onExit,
}: RemoteViewportProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
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
  const [hasCanvasFrame, setHasCanvasFrame] = useState(false);
  const [hasVideoFrame, setHasVideoFrame] = useState(false);
  const [nowTs, setNowTs] = useState(() => Date.now());

  const [pinValue, setPinValue] = useState("");
  const [inputText, setInputText] = useState("");
  const [submitAfterText, setSubmitAfterText] = useState(false);
  const [copiedRemoteClip, setCopiedRemoteClip] = useState(false);
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

  const targetDeviceId = clientState.activeDeviceId ?? device?.deviceId ?? "";

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

  // Clean up transient timers (wheel, ripples, clipboard badge) on unmount
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
      if (kbTextTimerRef.current !== null) {
        window.clearTimeout(kbTextTimerRef.current);
        kbTextTimerRef.current = null;
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
  ]);

  // P1-5: Reset recognizer on overlay appearance or session switch
  useEffect(() => {
    if (showOverlay) {
      recognizer.reset();
    }
  }, [showOverlay, recognizer]);

  useEffect(() => {
    recognizer.reset();
  }, [clientState.sessionId, recognizer]);

  // P1-6: Desktop keyboard & paste shortcuts when streaming and no utility sheet is open
  useEffect(() => {
    if (!isStreamingReady || activePanel !== "none") {
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
  }, [client, targetDeviceId, isStreamingReady, activePanel, dockExpanded]);

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

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 && e.pointerType === "mouse") return;

    // P1-4: Retry video playback on user gesture if browser autoplay policy paused it
    const videoEl = videoRef.current;
    if (videoEl && videoEl.paused && clientState.mediaStream) {
      void videoEl.play().catch(() => undefined);
    }

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
    const input = buildPointerInput(e);
    if (!input) return;
    recognizer.onPointerMove(input);
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const input = buildPointerInput(e);
    if (!input) return;
    recognizer.onPointerUp(input);
  }

  function handlePointerCancel(e: React.PointerEvent<HTMLDivElement>) {
    recognizer.onPointerCancel(e.pointerId);
  }

  // P0-3 & P0-4: Accurate letterbox wheel coordinates + normalized deltaMode + strict non-overlapping cooldown
  function handleWheel(e: React.WheelEvent<HTMLDivElement>) {
    if (e.ctrlKey || !isStreamingReady) return;
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
  ) {
    setApkFetchState((prev) => (prev.error ? { ...prev, error: null } : prev));
    const isApk = file.name.toLowerCase().endsWith(".apk");
    const purpose: FileTransferPurpose =
      purposeOverride ?? (isApk && autoInstallApk ? "apk_install" : "file");
    try {
      await client.sendFileOverWebRtc(file, {
        fileName: file.name,
        mimeType: file.type || undefined,
        purpose,
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
    setActivePanel("files");
    void handleSendLocalFile(file);
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

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="fixed inset-0 z-40 h-[100dvh] w-screen overflow-hidden bg-black text-white select-none"
    >
      {/* Pitch-Black OLED Remote Screen Surface */}
      <div
        ref={surfaceRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onWheel={handleWheel}
        className="relative h-full w-full touch-none"
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
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

        {ripples.map((ripple) => (
          <span
            key={ripple.id}
            style={{ left: ripple.x, top: ripple.y }}
            className="animate-touch-ripple pointer-events-none absolute h-10 w-10 rounded-full border-2 border-[#60A5FA] bg-[#2563EB]/20"
          />
        ))}
      </div>

      {/* Drag & Drop File Transfer Overlay */}
      {isDraggingFile && (
        <div className="pointer-events-none fixed inset-0 z-[55] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
          <div className="flex w-full max-w-md flex-col items-center rounded-2xl border-2 border-dashed border-[#60A5FA] bg-[#111318]/95 px-6 py-8 text-center shadow-[0_24px_48px_rgba(0,0,0,0.75)]">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-[#2563EB]/20 text-[#60A5FA]">
              <FileUp className="h-6 w-6" />
            </div>
            <p className="text-sm font-semibold text-white">
              {autoInstallApk
                ? "松手即通过 WebRTC P2P 直传到手机（.apk 将自动拉起安装）"
                : "松手即通过 WebRTC P2P 直传到手机"}
            </p>
            <p className="mt-1.5 text-xs text-zinc-400">
              {isFileChannelReady
                ? "普通文件将保存至手机 Download/VeloDeck/，不占用云端转发带宽"
                : "当前 WebRTC P2P 文件通道尚未就绪，松手后将打开传输面板查看状态"}
            </p>
          </div>
        </div>
      )}

      {/* Compact Background Transfer Progress Pill (when transfer runs while sheet is closed) */}
      {(isFileTransferActive || apkFetchState.active) && activePanel !== "files" && (
        <div
          className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-3 sm:justify-start"
          style={{ paddingTop: "max(3.5rem, calc(env(safe-area-inset-top) + 2.8rem))" }}
        >
          <button
            type="button"
            onClick={() => setActivePanel("files")}
            className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-blue-500/40 bg-[#111318]/95 px-3 py-1.5 text-xs font-medium text-blue-200 shadow-[0_8px_24px_rgba(0,0,0,0.6)] hover:border-blue-400"
          >
            <Upload className="h-3.5 w-3.5 animate-pulse text-blue-400" />
            <span>
              {apkFetchState.active
                ? "正在拉取最新 APK..."
                : activeFileTransfer?.status === "verifying"
                  ? "正在校验 SHA-256..."
                  : `P2P 传输 ${fileTransferPct}%`}
            </span>
          </button>
        </div>
      )}

      {/* Crisp Solid-Ink Top Telemetry Capsule (isolated leaf subscription — zero viewport re-renders at 1Hz) */}
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

      {/* Screen-Off Notice Banner (when physical phone genuinely entered Display.STATE_OFF) */}
      {isStreamingReady && !showOverlay && device?.screenOn === false && (
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
                (device?.locked
                  ? "手机处于锁屏状态，如黑屏可点击下方强制唤醒。"
                  : clientState.desiredTransport === "ws-jpeg" ||
                      clientState.activeTransport === "ws-jpeg"
                    ? "正在拉取实时帧画面，请稍候。"
                    : "若 WebRTC 超过 7.5 秒未连通将自动切换至 WS 帧流。")}
            </p>

            <div className="mt-5 space-y-2.5">
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={handleRetryOverlay}
                  className="btn-primary flex h-10 items-center justify-center gap-1.5 rounded-lg text-xs font-medium"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  立即重试
                </button>

                <button
                  type="button"
                  onClick={sendWake}
                  className="btn-shell flex h-10 items-center justify-center gap-1.5 rounded-lg text-xs font-medium text-amber-300"
                >
                  <Zap className="h-3.5 w-3.5" />
                  强制唤醒
                </button>
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
                输入到手机
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
                {clientState.remoteClipboard || "暂无从手机同步过来的剪贴板内容"}
              </p>
            </div>
          </div>
        </DarkSheet>
      )}

      {/* P2P File Transfer & Remote OTA APK Upgrade Sheet */}
      {activePanel === "files" && (
        <DarkSheet
          title="P2P 文件直传与远程升级"
          onClose={() => setActivePanel("none")}
        >
          <FileTransferSheetContent
            client={client}
            clientState={clientState}
            device={device}
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
        </DarkSheet>
      )}

      {/* Quality & Hardware Controls Sheet */}
      {activePanel === "more" && (
        <DarkSheet title="画质与硬件控制" onClose={() => setActivePanel("none")}>
          <div className="space-y-4">
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

            <QualityPresetSelector
              client={client}
              qualityPreset={clientState.qualityPreset}
              activeTransport={clientState.activeTransport}
            />

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
              <p className="mb-2 text-xs font-medium text-zinc-400">硬件按键</p>
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

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-3 sm:justify-end"
      style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
    >
      <button
        type="button"
        onClick={onToggleDock}
        className="pointer-events-auto flex max-w-[calc(100vw-1.5rem)] items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border border-[#2C313D] bg-[#111318] px-2.5 py-1.5 text-xs text-zinc-200 shadow-[0_8px_24px_rgba(0,0,0,0.55)] transition hover:border-[#3F4656] sm:gap-2 sm:px-3"
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
        <span className="shrink-0 rounded bg-[#2563EB]/25 px-1.5 py-0.5 text-[10px] font-semibold text-[#93C5FD]">
          <span className="sm:hidden">{transportShort}</span>
          <span className="hidden sm:inline">{transportFull}</span>
        </span>
        {device && (
          <span className="inline-flex shrink-0 items-center gap-0.5 font-mono text-[11px] text-zinc-300">
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
                  当前为 WS 帧流通道，P2P 文件直传需切换至 WebRTC 模式且手机端版本 ≥ v0.2.16。
                </p>
              ) : !isP2pSupported ? (
                <p>
                  手机端 Agent 版本较旧，暂不支持 P2P 文件通道。请先一次性升级至 v0.2.16+，之后即可全程远程一键推送升级。
                </p>
              ) : (
                <p>
                  WebRTC 文件通道尚未就绪。请等待 WebRTC 连通，或确认手机端已升级至 v0.2.16+。
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
          </div>
        </div>
      )}

      {/* Action 1: One-click Server APK OTA Upgrade */}
      {serverInfo?.hasAndroidApk && (
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
          选择本地文件直传到手机
        </button>

        <div className="mt-2.5 flex items-center justify-between gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={autoInstallApk}
              onChange={(e) => onToggleAutoInstallApk(e.target.checked)}
              className="h-4 w-4 rounded accent-[#2563EB]"
            />
            APK 传完自动拉起安装
          </label>
          <span className="text-[10px] text-zinc-500">支持拖拽至画面</span>
        </div>

        <p className="mt-1.5 text-[11px] text-zinc-500">
          普通文件默认保存至手机 <span className="font-mono text-zinc-400">Download/VeloDeck/</span>
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
  onClose,
  children,
}: {
  title: string;
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
        className="animate-sheet-up safe-bottom max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-[#2C313D] bg-[#111318] p-5 text-white shadow-[0_24px_48px_rgba(0,0,0,0.75)] sm:rounded-2xl"
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
