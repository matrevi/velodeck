import type { ControlCommand } from "@velodeck/protocol";

export interface ContentRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ContainerRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface NormalizedPoint {
  x: number;
  y: number;
  inside: boolean;
}

export interface PointerInput {
  pointerId: number;
  clientX: number;
  clientY: number;
  containerRect: ContainerRect;
  contentW: number;
  contentH: number;
  timestampMs?: number;
}

export type GestureDragMode = "auto" | "continuous" | "swipe";

export interface GestureRecognizerOptions {
  onCommand: (command: ControlCommand) => void;
  moveThresholdPx?: number;
  tapMaxMs?: number;
  longPressMs?: number;
  quickFlickMaxMs?: number;
  continuousDisplacementPx?: number;
  moveThrottleMs?: number;
  pinchMinDelta?: number;
  dragMode?: GestureDragMode;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function roundNorm(value: number): number {
  return Math.round(clamp(value, 0, 1) * 10000) / 10000;
}

/**
 * Computes the rendered image rectangle inside a container using `object-fit: contain`.
 */
export function computeContentRect(
  containerW: number,
  containerH: number,
  contentW: number,
  contentH: number,
): ContentRect {
  const safeContainerW = Math.max(0, containerW);
  const safeContainerH = Math.max(0, containerH);

  if (safeContainerW <= 0 || safeContainerH <= 0 || contentW <= 0 || contentH <= 0) {
    return {
      left: 0,
      top: 0,
      width: safeContainerW,
      height: safeContainerH,
    };
  }

  const containerRatio = safeContainerW / safeContainerH;
  const contentRatio = contentW / contentH;

  if (Math.abs(containerRatio - contentRatio) < 1e-6) {
    return {
      left: 0,
      top: 0,
      width: safeContainerW,
      height: safeContainerH,
    };
  }

  if (contentRatio > containerRatio) {
    const width = safeContainerW;
    const height = width / contentRatio;
    return {
      left: 0,
      top: (safeContainerH - height) / 2,
      width,
      height,
    };
  }

  const height = safeContainerH;
  const width = height * contentRatio;
  return {
    left: (safeContainerW - width) / 2,
    top: 0,
    width,
    height,
  };
}

/**
 * Maps viewport client coordinates on a letterboxed surface to normalized [0..1] display coordinates.
 */
export function clientPointToNormalized(
  clientX: number,
  clientY: number,
  containerRect: ContainerRect,
  contentW: number,
  contentH: number,
): NormalizedPoint {
  const content = computeContentRect(
    containerRect.width,
    containerRect.height,
    contentW,
    contentH,
  );

  if (content.width <= 0 || content.height <= 0) {
    return { x: 0.5, y: 0.5, inside: false };
  }

  const relX = clientX - (containerRect.left + content.left);
  const relY = clientY - (containerRect.top + content.top);
  const rawX = relX / content.width;
  const rawY = relY / content.height;
  const inside = rawX >= 0 && rawX <= 1 && rawY >= 0 && rawY <= 1;

  return {
    x: roundNorm(rawX),
    y: roundNorm(rawY),
    inside,
  };
}

interface TrackedPointer {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  lastClientX: number;
  lastClientY: number;
  startNorm: NormalizedPoint;
  lastNorm: NormalizedPoint;
  lastSentNorm: NormalizedPoint | null;
  startTime: number;
  movedBeyondThreshold: boolean;
  continuousStarted: boolean;
  lastMoveSentAt: number;
}

interface PinchState {
  startDist: number;
  lastDist: number;
  cx: number;
  cy: number;
  startTime: number;
  emitted: boolean;
}

export class GestureRecognizer {
  private readonly onCommand: (command: ControlCommand) => void;
  private readonly moveThresholdPx: number;
  private readonly longPressMs: number;
  private readonly quickFlickMaxMs: number;
  private readonly continuousDisplacementPx: number;
  private readonly moveThrottleMs: number;
  private readonly pinchMinDelta: number;
  private readonly dragMode: GestureDragMode;

  private readonly pointers = new Map<number, TrackedPointer>();
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private trailingMoveTimer: ReturnType<typeof setTimeout> | null = null;
  private trailingMovePointerId: number | null = null;
  private longPressFired = false;
  private pinchState: PinchState | null = null;
  private suppressUntilAllUp = false;

  constructor(options: GestureRecognizerOptions) {
    this.onCommand = options.onCommand;
    this.moveThresholdPx = options.moveThresholdPx ?? 6;
    this.longPressMs = options.longPressMs ?? 450;
    this.quickFlickMaxMs = options.quickFlickMaxMs ?? 45;
    this.continuousDisplacementPx = options.continuousDisplacementPx ?? 28;
    this.moveThrottleMs = options.moveThrottleMs ?? 14;
    this.pinchMinDelta = options.pinchMinDelta ?? 0.015;
    this.dragMode = options.dragMode ?? "auto";
  }

  onPointerDown(input: PointerInput): NormalizedPoint | null {
    const now = input.timestampMs ?? Date.now();
    const norm = clientPointToNormalized(
      input.clientX,
      input.clientY,
      input.containerRect,
      input.contentW,
      input.contentH,
    );

    if (this.pointers.size === 0 && !norm.inside) {
      return null;
    }

    const tracked: TrackedPointer = {
      pointerId: input.pointerId,
      startClientX: input.clientX,
      startClientY: input.clientY,
      lastClientX: input.clientX,
      lastClientY: input.clientY,
      startNorm: norm,
      lastNorm: norm,
      lastSentNorm: null,
      startTime: now,
      movedBeyondThreshold: false,
      continuousStarted: false,
      lastMoveSentAt: now,
    };

    this.pointers.set(input.pointerId, tracked);

    if (this.pointers.size === 1) {
      this.longPressFired = false;
      this.suppressUntilAllUp = false;
      this.pinchState = null;
      this.scheduleLongPress(input.pointerId);
    } else if (this.pointers.size === 2) {
      this.clearLongPressTimer();
      this.clearTrailingMoveTimer();
      this.finishAnyContinuousPointers();
      this.startPinch(now);
    } else {
      this.clearLongPressTimer();
      this.clearTrailingMoveTimer();
    }

    return norm;
  }

  onPointerMove(input: PointerInput): NormalizedPoint | null {
    const pointer = this.pointers.get(input.pointerId);
    if (!pointer) return null;

    const now = input.timestampMs ?? Date.now();
    const norm = clientPointToNormalized(
      input.clientX,
      input.clientY,
      input.containerRect,
      input.contentW,
      input.contentH,
    );

    pointer.lastClientX = input.clientX;
    pointer.lastClientY = input.clientY;
    pointer.lastNorm = norm;

    if (this.pinchState && this.pointers.size >= 2) {
      this.updatePinch();
      return norm;
    }

    if (this.suppressUntilAllUp || this.longPressFired || this.pointers.size !== 1) {
      return norm;
    }

    const displacement = Math.hypot(
      input.clientX - pointer.startClientX,
      input.clientY - pointer.startClientY,
    );

    if (!pointer.movedBeyondThreshold && displacement >= this.moveThresholdPx) {
      pointer.movedBeyondThreshold = true;
      this.clearLongPressTimer();
    }

    if (!pointer.movedBeyondThreshold) {
      return norm;
    }

    const elapsed = Math.max(0, now - pointer.startTime);

    if (this.dragMode === "swipe") {
      return norm;
    }

    const shouldUseContinuous =
      this.dragMode === "continuous" ||
      elapsed > this.quickFlickMaxMs ||
      displacement > this.continuousDisplacementPx;

    if (shouldUseContinuous) {
      if (!pointer.continuousStarted) {
        pointer.continuousStarted = true;
        pointer.lastMoveSentAt = now;
        this.clearTrailingMoveTimer();

        // Start live drag at the actual pointer-down coordinates and immediately move
        // to the current position so on-screen content tracks 1:1 with zero dead offset.
        this.onCommand({
          action: "touch_down",
          pointerId: pointer.pointerId,
          x: pointer.startNorm.x,
          y: pointer.startNorm.y,
        });
        pointer.lastSentNorm = norm;
        this.onCommand({
          action: "touch_move",
          pointerId: pointer.pointerId,
          x: norm.x,
          y: norm.y,
        });
      } else if (now - pointer.lastMoveSentAt >= this.moveThrottleMs) {
        this.clearTrailingMoveTimer();
        pointer.lastMoveSentAt = now;
        pointer.lastSentNorm = norm;
        this.onCommand({
          action: "touch_move",
          pointerId: pointer.pointerId,
          x: norm.x,
          y: norm.y,
        });
      } else {
        this.scheduleTrailingMoveFlush(
          pointer.pointerId,
          Math.max(1, this.moveThrottleMs - (now - pointer.lastMoveSentAt)),
        );
      }
    }

    return norm;
  }

  onPointerUp(input: PointerInput): NormalizedPoint | null {
    const pointer = this.pointers.get(input.pointerId);
    if (!pointer) return null;

    const now = input.timestampMs ?? Date.now();
    const norm = clientPointToNormalized(
      input.clientX,
      input.clientY,
      input.containerRect,
      input.contentW,
      input.contentH,
    );

    pointer.lastClientX = input.clientX;
    pointer.lastClientY = input.clientY;
    pointer.lastNorm = norm;

    this.clearLongPressTimer();
    this.clearTrailingMoveTimer();

    if (this.pinchState) {
      if (!this.pinchState.emitted && this.pointers.size >= 2) {
        this.updatePinch();
        this.emitPinch(now);
      }
      this.suppressUntilAllUp = true;
      this.pointers.delete(input.pointerId);
      if (this.pointers.size === 0) {
        this.pinchState = null;
        this.suppressUntilAllUp = false;
      }
      return norm;
    }

    this.pointers.delete(input.pointerId);

    if (this.suppressUntilAllUp) {
      if (this.pointers.size === 0) {
        this.suppressUntilAllUp = false;
      }
      return norm;
    }

    if (this.longPressFired) {
      this.longPressFired = false;
      return norm;
    }

    const elapsed = Math.max(0, now - pointer.startTime);
    const finalDisplacement = Math.hypot(
      input.clientX - pointer.startClientX,
      input.clientY - pointer.startClientY,
    );
    const isDrag = pointer.movedBeyondThreshold || finalDisplacement >= this.moveThresholdPx;

    if (pointer.continuousStarted) {
      this.onCommand({
        action: "touch_up",
        pointerId: pointer.pointerId,
        x: norm.x,
        y: norm.y,
      });
      return norm;
    }

    if (isDrag) {
      this.onCommand({
        action: "swipe",
        x1: pointer.startNorm.x,
        y1: pointer.startNorm.y,
        x2: norm.x,
        y2: norm.y,
        durationMs: Math.round(clamp(elapsed, 60, 280)),
      });
      return norm;
    }

    if (elapsed >= this.longPressMs) {
      this.onCommand({
        action: "long_press",
        x: pointer.startNorm.x,
        y: pointer.startNorm.y,
        durationMs: Math.round(clamp(elapsed, this.longPressMs, 1500)),
      });
      return norm;
    }

    // Any stationary release before longPressMs (when !longPressFired) emits tap — no dead zone
    this.onCommand({
      action: "tap",
      x: pointer.startNorm.x,
      y: pointer.startNorm.y,
    });

    return norm;
  }

  onPointerCancel(pointerId: number): void {
    const pointer = this.pointers.get(pointerId);
    if (!pointer) return;

    this.clearLongPressTimer();
    this.clearTrailingMoveTimer();
    if (pointer.continuousStarted) {
      this.onCommand({
        action: "touch_up",
        pointerId: pointer.pointerId,
        x: pointer.lastNorm.x,
        y: pointer.lastNorm.y,
      });
    }
    this.pointers.delete(pointerId);

    if (this.pointers.size === 0) {
      this.pinchState = null;
      this.longPressFired = false;
      this.suppressUntilAllUp = false;
    }
  }

  reset(): void {
    this.clearLongPressTimer();
    this.clearTrailingMoveTimer();
    this.finishAnyContinuousPointers();
    this.pointers.clear();
    this.pinchState = null;
    this.longPressFired = false;
    this.suppressUntilAllUp = false;
  }

  dispose(): void {
    this.reset();
  }

  private scheduleTrailingMoveFlush(pointerId: number, delayMs: number): void {
    if (this.trailingMoveTimer !== null) return;
    this.trailingMovePointerId = pointerId;
    this.trailingMoveTimer = setTimeout(() => {
      const pid = this.trailingMovePointerId;
      this.trailingMoveTimer = null;
      this.trailingMovePointerId = null;
      if (pid === null) return;
      const active = this.pointers.get(pid);
      if (
        !active ||
        !active.continuousStarted ||
        this.suppressUntilAllUp ||
        this.pinchState ||
        this.pointers.size !== 1
      ) {
        return;
      }
      if (
        active.lastSentNorm &&
        active.lastSentNorm.x === active.lastNorm.x &&
        active.lastSentNorm.y === active.lastNorm.y
      ) {
        return;
      }
      active.lastMoveSentAt = Date.now();
      active.lastSentNorm = active.lastNorm;
      this.onCommand({
        action: "touch_move",
        pointerId: active.pointerId,
        x: active.lastNorm.x,
        y: active.lastNorm.y,
      });
    }, delayMs);
  }

  private clearTrailingMoveTimer(): void {
    if (this.trailingMoveTimer !== null) {
      clearTimeout(this.trailingMoveTimer);
      this.trailingMoveTimer = null;
      this.trailingMovePointerId = null;
    }
  }

  private scheduleLongPress(pointerId: number): void {
    this.clearLongPressTimer();
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      const pointer = this.pointers.get(pointerId);
      if (
        !pointer ||
        this.pointers.size !== 1 ||
        pointer.movedBeyondThreshold ||
        this.pinchState ||
        this.suppressUntilAllUp
      ) {
        return;
      }
      this.longPressFired = true;
      this.onCommand({
        action: "long_press",
        x: pointer.startNorm.x,
        y: pointer.startNorm.y,
        durationMs: this.longPressMs,
      });
    }, this.longPressMs);
  }

  private clearLongPressTimer(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  private finishAnyContinuousPointers(): void {
    for (const pointer of this.pointers.values()) {
      if (pointer.continuousStarted) {
        pointer.continuousStarted = false;
        this.onCommand({
          action: "touch_up",
          pointerId: pointer.pointerId,
          x: pointer.lastNorm.x,
          y: pointer.lastNorm.y,
        });
      }
    }
  }

  private getTwoPointers(): [TrackedPointer, TrackedPointer] | null {
    const iter = this.pointers.values();
    const first = iter.next().value;
    const second = iter.next().value;
    if (!first || !second) return null;
    return [first, second];
  }

  private startPinch(now: number): void {
    const pair = this.getTwoPointers();
    if (!pair) return;
    const [a, b] = pair;
    const dist = Math.hypot(
      a.lastNorm.x - b.lastNorm.x,
      a.lastNorm.y - b.lastNorm.y,
    );
    this.pinchState = {
      startDist: Math.max(0.01, dist),
      lastDist: Math.max(0.01, dist),
      cx: roundNorm((a.lastNorm.x + b.lastNorm.x) / 2),
      cy: roundNorm((a.lastNorm.y + b.lastNorm.y) / 2),
      startTime: now,
      emitted: false,
    };
  }

  private updatePinch(): void {
    if (!this.pinchState) return;
    const pair = this.getTwoPointers();
    if (!pair) return;
    const [a, b] = pair;
    this.pinchState.lastDist = Math.max(
      0.01,
      Math.hypot(a.lastNorm.x - b.lastNorm.x, a.lastNorm.y - b.lastNorm.y),
    );
    this.pinchState.cx = roundNorm((a.lastNorm.x + b.lastNorm.x) / 2);
    this.pinchState.cy = roundNorm((a.lastNorm.y + b.lastNorm.y) / 2);
  }

  private emitPinch(now: number): void {
    if (!this.pinchState || this.pinchState.emitted) return;
    this.pinchState.emitted = true;
    const delta = Math.abs(this.pinchState.lastDist - this.pinchState.startDist);
    if (delta < this.pinchMinDelta) {
      return;
    }
    const elapsed = Math.max(0, now - this.pinchState.startTime);
    this.onCommand({
      action: "pinch",
      cx: this.pinchState.cx,
      cy: this.pinchState.cy,
      startDist: roundNorm(this.pinchState.startDist),
      endDist: roundNorm(this.pinchState.lastDist),
      durationMs: Math.round(clamp(elapsed, 120, 600)),
    });
  }
}
