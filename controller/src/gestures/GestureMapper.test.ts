import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlCommand } from "@velodeck/protocol";
import {
  GestureRecognizer,
  clientPointToNormalized,
  computeContentRect,
  type ContainerRect,
} from "./GestureMapper";

describe("computeContentRect", () => {
  it("pillarboxes a portrait phone inside a landscape viewport", () => {
    // Portrait phone 1080x2400 (ratio 0.45) inside 1200x800 landscape viewport
    const rect = computeContentRect(1200, 800, 1080, 2400);
    expect(rect.top).toBeCloseTo(0, 4);
    expect(rect.height).toBeCloseTo(800, 4);
    expect(rect.width).toBeCloseTo(360, 4);
    expect(rect.left).toBeCloseTo(420, 4);
  });

  it("letterboxes a landscape phone inside a portrait viewport", () => {
    // Landscape phone 2400x1080 (ratio 2.2222) inside 400x800 portrait viewport
    const rect = computeContentRect(400, 800, 2400, 1080);
    expect(rect.left).toBeCloseTo(0, 4);
    expect(rect.width).toBeCloseTo(400, 4);
    expect(rect.height).toBeCloseTo(180, 4);
    expect(rect.top).toBeCloseTo(310, 4);
  });

  it("fills the entire container when aspect ratios match exactly", () => {
    const rect = computeContentRect(540, 1200, 1080, 2400);
    expect(rect).toEqual({
      left: 0,
      top: 0,
      width: 540,
      height: 1200,
    });
  });

  it("handles zero or negative content sizes gracefully", () => {
    const rect = computeContentRect(390, 844, 0, 0);
    expect(rect).toEqual({
      left: 0,
      top: 0,
      width: 390,
      height: 844,
    });
  });
});

describe("clientPointToNormalized", () => {
  const container: ContainerRect = {
    left: 20,
    top: 40,
    width: 1200,
    height: 800,
  };
  // Portrait 1080x2400 inside 1200x800 -> content rect left=420, top=0, width=360, height=800
  // In client coords: x in [440, 800], y in [40, 840]

  it("maps center and corners accurately within the letterboxed content rect", () => {
    const center = clientPointToNormalized(620, 440, container, 1080, 2400);
    expect(center).toEqual({ x: 0.5, y: 0.5, inside: true });

    const topLeft = clientPointToNormalized(440, 40, container, 1080, 2400);
    expect(topLeft).toEqual({ x: 0, y: 0, inside: true });

    const bottomRight = clientPointToNormalized(800, 840, container, 1080, 2400);
    expect(bottomRight).toEqual({ x: 1, y: 1, inside: true });

    const quarter = clientPointToNormalized(530, 240, container, 1080, 2400);
    expect(quarter).toEqual({ x: 0.25, y: 0.25, inside: true });
  });

  it("clamps coordinates to [0, 1] and reports inside=false outside the content rect", () => {
    const leftBar = clientPointToNormalized(100, 440, container, 1080, 2400);
    expect(leftBar).toEqual({ x: 0, y: 0.5, inside: false });

    const rightBottomOutside = clientPointToNormalized(1150, 950, container, 1080, 2400);
    expect(rightBottomOutside).toEqual({ x: 1, y: 1, inside: false });
  });
});

describe("GestureRecognizer", () => {
  const container: ContainerRect = {
    left: 0,
    top: 0,
    width: 400,
    height: 800,
  };
  const contentW = 400;
  const contentH = 800;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("classifies a short stationary pointer down/up as a tap", () => {
    const commands: ControlCommand[] = [];
    const recognizer = new GestureRecognizer({
      onCommand: (cmd) => commands.push(cmd),
    });

    recognizer.onPointerDown({
      pointerId: 1,
      clientX: 200,
      clientY: 400,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 1000,
    });
    recognizer.onPointerMove({
      pointerId: 1,
      clientX: 204,
      clientY: 403,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 1040,
    });
    recognizer.onPointerUp({
      pointerId: 1,
      clientX: 204,
      clientY: 403,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 1120,
    });

    expect(commands).toEqual([{ action: "tap", x: 0.5, y: 0.5 }]);
    recognizer.dispose();
  });

  it("classifies a stationary press >= 450ms as a long_press without duplicating tap", () => {
    const commands: ControlCommand[] = [];
    const recognizer = new GestureRecognizer({
      onCommand: (cmd) => commands.push(cmd),
    });

    recognizer.onPointerDown({
      pointerId: 1,
      clientX: 100,
      clientY: 200,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 0,
    });

    vi.advanceTimersByTime(460);

    expect(commands).toEqual([
      { action: "long_press", x: 0.25, y: 0.25, durationMs: 450 },
    ]);

    recognizer.onPointerUp({
      pointerId: 1,
      clientX: 102,
      clientY: 201,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 520,
    });

    expect(commands).toHaveLength(1);
    recognizer.dispose();
  });

  it("classifies a quick flick within 45ms and <=28px intermediate move as a clean swipe", () => {
    const commands: ControlCommand[] = [];
    const recognizer = new GestureRecognizer({
      onCommand: (cmd) => commands.push(cmd),
    });

    recognizer.onPointerDown({
      pointerId: 1,
      clientX: 200,
      clientY: 600,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 1000,
    });
    recognizer.onPointerMove({
      pointerId: 1,
      clientX: 200,
      clientY: 580,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 1020,
    });
    recognizer.onPointerUp({
      pointerId: 1,
      clientX: 200,
      clientY: 400,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 1040,
    });

    expect(commands).toEqual([
      {
        action: "swipe",
        x1: 0.5,
        y1: 0.75,
        x2: 0.5,
        y2: 0.5,
        durationMs: 60,
      },
    ]);
    recognizer.dispose();
  });

  it("emits continuous touch_down, throttled touch_move, and touch_up on sustained drag", () => {
    const commands: ControlCommand[] = [];
    const recognizer = new GestureRecognizer({
      onCommand: (cmd) => commands.push(cmd),
      dragMode: "continuous",
      moveThrottleMs: 25,
    });

    recognizer.onPointerDown({
      pointerId: 7,
      clientX: 100,
      clientY: 200,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 0,
    });
    // Crosses threshold -> emits touch_down + first touch_move
    recognizer.onPointerMove({
      pointerId: 7,
      clientX: 140,
      clientY: 200,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 10,
    });
    // Within 25ms throttle window -> skipped
    recognizer.onPointerMove({
      pointerId: 7,
      clientX: 160,
      clientY: 200,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 20,
    });
    // Past 25ms throttle window -> emitted
    recognizer.onPointerMove({
      pointerId: 7,
      clientX: 200,
      clientY: 400,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 40,
    });
    recognizer.onPointerUp({
      pointerId: 7,
      clientX: 240,
      clientY: 400,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 65,
    });

    expect(commands).toEqual([
      { action: "touch_down", pointerId: 7, x: 0.25, y: 0.25 },
      { action: "touch_move", pointerId: 7, x: 0.35, y: 0.25 },
      { action: "touch_move", pointerId: 7, x: 0.5, y: 0.5 },
      { action: "touch_up", pointerId: 7, x: 0.6, y: 0.5 },
    ]);
    recognizer.dispose();
  });

  it("classifies a two-finger pinch and suppresses stray tap on second finger release", () => {
    const commands: ControlCommand[] = [];
    const recognizer = new GestureRecognizer({
      onCommand: (cmd) => commands.push(cmd),
    });

    // Start two fingers at (0.4, 0.5) and (0.6, 0.5) -> dist = 0.2
    recognizer.onPointerDown({
      pointerId: 1,
      clientX: 160,
      clientY: 400,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 0,
    });
    recognizer.onPointerDown({
      pointerId: 2,
      clientX: 240,
      clientY: 400,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 20,
    });

    // Spread fingers apart to (0.2, 0.5) and (0.8, 0.5) -> dist = 0.6
    recognizer.onPointerMove({
      pointerId: 1,
      clientX: 80,
      clientY: 400,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 120,
    });
    recognizer.onPointerMove({
      pointerId: 2,
      clientX: 320,
      clientY: 400,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 140,
    });

    // Release both fingers
    recognizer.onPointerUp({
      pointerId: 2,
      clientX: 320,
      clientY: 400,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 220,
    });
    recognizer.onPointerUp({
      pointerId: 1,
      clientX: 80,
      clientY: 400,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 260,
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual({
      action: "pinch",
      cx: 0.5,
      cy: 0.5,
      startDist: 0.2,
      endDist: 0.6,
      durationMs: 200,
    });
    recognizer.dispose();
  });

  it("ignores pointer interactions starting in black letterbox bars", () => {
    const commands: ControlCommand[] = [];
    const recognizer = new GestureRecognizer({
      onCommand: (cmd) => commands.push(cmd),
    });

    const wideContainer: ContainerRect = {
      left: 0,
      top: 0,
      width: 1200,
      height: 800,
    };
    // Portrait phone 1080x2400 -> content starts at x=420
    const down = recognizer.onPointerDown({
      pointerId: 1,
      clientX: 50,
      clientY: 400,
      containerRect: wideContainer,
      contentW: 1080,
      contentH: 2400,
      timestampMs: 0,
    });
    expect(down).toBeNull();

    recognizer.onPointerUp({
      pointerId: 1,
      clientX: 50,
      clientY: 400,
      containerRect: wideContainer,
      contentW: 1080,
      contentH: 2400,
      timestampMs: 80,
    });

    expect(commands).toEqual([]);
    recognizer.dispose();
  });

  it("eliminates the 420-449ms tap dead zone by emitting tap for any stationary release < longPressMs", () => {
    const commands: ControlCommand[] = [];
    const recognizer = new GestureRecognizer({
      onCommand: (cmd) => commands.push(cmd),
    });

    recognizer.onPointerDown({
      pointerId: 1,
      clientX: 200,
      clientY: 400,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 1000,
    });
    recognizer.onPointerUp({
      pointerId: 1,
      clientX: 202,
      clientY: 401,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 1445,
    });

    expect(commands).toEqual([{ action: "tap", x: 0.5, y: 0.5 }]);
    recognizer.dispose();
  });

  it("flushes resting throttled coordinates via trailing timer and cancels cleanly on reset/up", () => {
    const commands: ControlCommand[] = [];
    const recognizer = new GestureRecognizer({
      onCommand: (cmd) => commands.push(cmd),
      dragMode: "continuous",
      moveThrottleMs: 25,
    });

    recognizer.onPointerDown({
      pointerId: 3,
      clientX: 100,
      clientY: 200,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 0,
    });
    // Crosses threshold -> emits touch_down + touch_move
    recognizer.onPointerMove({
      pointerId: 3,
      clientX: 140,
      clientY: 200,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 10,
    });
    // Within 25ms throttle window -> schedules trailing flush
    recognizer.onPointerMove({
      pointerId: 3,
      clientX: 180,
      clientY: 240,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 18,
    });

    expect(commands).toHaveLength(2);

    // Finger rests -> trailing timer fires and delivers final resting coordinate
    vi.advanceTimersByTime(25);
    expect(commands).toEqual([
      { action: "touch_down", pointerId: 3, x: 0.25, y: 0.25 },
      { action: "touch_move", pointerId: 3, x: 0.35, y: 0.25 },
      { action: "touch_move", pointerId: 3, x: 0.45, y: 0.3 },
    ]);

    // Queue another throttled move and immediately reset() -> timer must be cancelled
    recognizer.onPointerMove({
      pointerId: 3,
      clientX: 220,
      clientY: 280,
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 30,
    });
    recognizer.reset();
    const countAfterReset = commands.length;
    vi.advanceTimersByTime(100);
    expect(commands).toHaveLength(countAfterReset);
    expect(commands[commands.length - 1]).toEqual({
      action: "touch_up",
      pointerId: 3,
      x: 0.55,
      y: 0.35,
    });
    recognizer.dispose();
  });

  it("enters live continuous drag immediately when displacement exceeds 28px before 45ms and tracks 1:1 from startNorm", () => {
    const commands: ControlCommand[] = [];
    const recognizer = new GestureRecognizer({
      onCommand: (cmd) => commands.push(cmd),
      dragMode: "auto",
    });

    recognizer.onPointerDown({
      pointerId: 9,
      clientX: 200,
      clientY: 640, // norm y = 0.8
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 0,
    });
    // Small move (16px: past 6px threshold, <= 28px, inside 45ms) -> still waiting in short flick window
    recognizer.onPointerMove({
      pointerId: 9,
      clientX: 200,
      clientY: 624, // norm y = 0.78
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 15,
    });
    expect(commands).toHaveLength(0);

    // Displacement exceeds 28px (40px total) at 25ms -> enters continuous live drag IMMEDIATELY without waiting 45ms,
    // anchored at exact startNorm (0.5, 0.8) with zero offset clamp!
    recognizer.onPointerMove({
      pointerId: 9,
      clientX: 200,
      clientY: 600, // norm y = 0.75
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 25,
    });

    expect(commands).toEqual([
      { action: "touch_down", pointerId: 9, x: 0.5, y: 0.8 },
      { action: "touch_move", pointerId: 9, x: 0.5, y: 0.75 },
    ]);

    // Default moveThrottleMs is 14ms: +10ms throttled, +14ms emitted
    recognizer.onPointerMove({
      pointerId: 9,
      clientX: 200,
      clientY: 560, // norm y = 0.7
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 35,
    });
    expect(commands).toHaveLength(2);

    recognizer.onPointerMove({
      pointerId: 9,
      clientX: 200,
      clientY: 520, // norm y = 0.65
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 39,
    });
    expect(commands).toHaveLength(3);
    expect(commands[2]).toEqual({ action: "touch_move", pointerId: 9, x: 0.5, y: 0.65 });

    recognizer.dispose();
  });

  it("transitions into 1:1 continuous drag after 45ms even for small displacements (>6px, <=28px)", () => {
    const commands: ControlCommand[] = [];
    const recognizer = new GestureRecognizer({
      onCommand: (cmd) => commands.push(cmd),
      dragMode: "auto",
    });

    recognizer.onPointerDown({
      pointerId: 10,
      clientX: 200,
      clientY: 640, // norm y = 0.8
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 0,
    });
    recognizer.onPointerMove({
      pointerId: 10,
      clientX: 200,
      clientY: 632, // 8px (>= 6px threshold, <= 28px)
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 30,
    });
    expect(commands).toHaveLength(0);

    recognizer.onPointerMove({
      pointerId: 10,
      clientX: 200,
      clientY: 620, // 20px (<= 28px), elapsed = 50ms > 45ms
      containerRect: container,
      contentW,
      contentH,
      timestampMs: 50,
    });

    expect(commands).toEqual([
      { action: "touch_down", pointerId: 10, x: 0.5, y: 0.8 },
      { action: "touch_move", pointerId: 10, x: 0.5, y: 0.775 },
    ]);

    recognizer.dispose();
  });
});
