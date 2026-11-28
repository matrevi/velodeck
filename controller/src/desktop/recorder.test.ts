import { describe, expect, it, vi } from "vitest";
import {
  PREFERRED_RECORDING_MIME_TYPES,
  SessionRecorder,
  buildRecordingFileName,
  formatRecordingDuration,
  pickSupportedRecordingMimeType,
  type MediaRecorderLike,
} from "./recorder";

class MockMediaRecorder implements MediaRecorderLike {
  state = "inactive";
  readonly mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: { error?: unknown }) => void) | null = null;
  startedWithTimeslice: number | undefined;

  constructor(
    public readonly stream: MediaStream,
    options?: MediaRecorderOptions,
  ) {
    this.mimeType = options?.mimeType ?? "video/webm";
  }

  start(timeslice?: number): void {
    this.state = "recording";
    this.startedWithTimeslice = timeslice;
  }

  emitChunk(bytes: Uint8Array): void {
    this.ondataavailable?.({
      data: new Blob([bytes as BlobPart], { type: this.mimeType }),
    });
  }

  emitError(err: Error): void {
    this.onerror?.({ error: err });
  }

  stop(): void {
    this.state = "inactive";
    // Flush trailing chunk before firing onstop, matching browser MediaRecorder behavior
    this.emitChunk(new Uint8Array([9, 8, 7]));
    queueMicrotask(() => {
      this.onstop?.();
    });
  }
}

function createFakeStream(trackCount = 1): MediaStream {
  const tracks = Array.from({ length: trackCount }, (_, idx) => ({
    id: `track-${idx}`,
    kind: idx === 0 ? "video" : "audio",
  }));
  return {
    getTracks: () => tracks,
  } as unknown as MediaStream;
}

describe("pickSupportedRecordingMimeType", () => {
  it("picks MIME types strictly in preference order", () => {
    expect(pickSupportedRecordingMimeType(() => true)).toBe(
      "video/webm;codecs=vp9,opus",
    );

    expect(
      pickSupportedRecordingMimeType((m) => m === "video/webm;codecs=h264,opus" || m === "video/webm"),
    ).toBe("video/webm;codecs=h264,opus");

    expect(
      pickSupportedRecordingMimeType((m) => m === "video/webm;codecs=vp8,opus" || m === "video/mp4"),
    ).toBe("video/webm;codecs=vp8,opus");

    expect(
      pickSupportedRecordingMimeType((m) => m === "video/webm" || m === "video/mp4"),
    ).toBe("video/webm");

    expect(pickSupportedRecordingMimeType((m) => m === "video/mp4")).toBe(
      "video/mp4",
    );

    expect(pickSupportedRecordingMimeType(() => false)).toBeNull();
  });

  it("handles exceptions thrown by isTypeSupported gracefully", () => {
    const picked = pickSupportedRecordingMimeType((mime) => {
      if (mime === PREFERRED_RECORDING_MIME_TYPES[0]) {
        throw new Error("probe failure");
      }
      return mime === "video/webm;codecs=h264,opus";
    });
    expect(picked).toBe("video/webm;codecs=h264,opus");
  });
});

describe("buildRecordingFileName", () => {
  it("formats sanitized device names, timestamp, and extension cleanly", () => {
    const fixedDate = new Date(2026, 10, 28, 8, 45, 0); // 2026-11-28 08:45:00 local
    expect(
      buildRecordingFileName("MacBook Pro", "video/webm;codecs=vp9,opus", fixedDate),
    ).toBe("VeloDeck-MacBook-Pro-20261128-084500.webm");

    expect(
      buildRecordingFileName("Office/PC:01*", "video/mp4", fixedDate),
    ).toBe("VeloDeck-Office-PC-01-20261128-084500.mp4");

    expect(buildRecordingFileName("测试电脑", "video/webm", fixedDate)).toBe(
      "VeloDeck-测试电脑-20261128-084500.webm",
    );

    expect(buildRecordingFileName("   ///   ", "video/webm", fixedDate)).toBe(
      "VeloDeck-Device-20261128-084500.webm",
    );
  });
});

describe("formatRecordingDuration", () => {
  it("formats mm:ss and h:mm:ss cleanly", () => {
    expect(formatRecordingDuration(0)).toBe("00:00");
    expect(formatRecordingDuration(9)).toBe("00:09");
    expect(formatRecordingDuration(155)).toBe("02:35");
    expect(formatRecordingDuration(3909)).toBe("1:05:09");
    expect(formatRecordingDuration(-4)).toBe("00:00");
  });
});

describe("SessionRecorder", () => {
  it("throws when stream has no tracks", () => {
    const recorder = new SessionRecorder({
      mediaRecorderFactory: (s, o) => new MockMediaRecorder(s, o),
      isTypeSupported: () => true,
    });
    expect(() => recorder.start(createFakeStream(0), "MacBook")).toThrow();
  });

  it("records chunks, tracks elapsed duration, and resolves blob/fileName on stop", async () => {
    let mockNow = new Date(2026, 10, 28, 8, 45, 0).getTime();
    let createdMock: MockMediaRecorder | null = null;
    const tickHolder: { fn: (() => void) | null } = { fn: null };
    const clearIntervalSpy = vi.fn();
    const durations: number[] = [];

    const recorder = new SessionRecorder({
      mediaRecorderFactory: (stream, opts) => {
        createdMock = new MockMediaRecorder(stream, opts);
        return createdMock;
      },
      isTypeSupported: (mime) => mime === "video/webm;codecs=vp9,opus",
      now: () => mockNow,
      setIntervalFn: (cb) => {
        tickHolder.fn = cb;
        return 42 as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: clearIntervalSpy,
    });

    const { mimeType } = recorder.start(createFakeStream(2), "MacBook", {
      onDuration: (sec) => durations.push(sec),
    });

    expect(mimeType).toBe("video/webm;codecs=vp9,opus");
    expect(recorder.isRecording()).toBe(true);
    expect(createdMock).not.toBeNull();
    expect(createdMock!.startedWithTimeslice).toBe(1000);
    expect(durations).toEqual([0]);

    createdMock!.emitChunk(new Uint8Array([1, 2, 3, 4]));
    createdMock!.emitChunk(new Uint8Array([])); // empty chunk ignored
    mockNow += 5_000;
    tickHolder.fn?.();
    expect(durations).toEqual([0, 5]);
    expect(recorder.getDurationSec()).toBe(5);

    mockNow += 2_000;
    const [res1, res2] = await Promise.all([recorder.stop(), recorder.stop()]);

    expect(clearIntervalSpy).toHaveBeenCalledWith(42);
    expect(recorder.isRecording()).toBe(false);
    expect(res1).not.toBeNull();
    expect(res1).toBe(res2); // duplicate concurrent stop shares one result
    expect(res1!.mimeType).toBe("video/webm;codecs=vp9,opus");
    expect(res1!.durationSec).toBe(7);
    expect(res1!.fileName).toBe("VeloDeck-MacBook-20261128-084507.webm");
    expect(res1!.blob.size).toBe(7); // 4 bytes + 3 trailing bytes

    // Calling stop when idle returns null
    expect(await recorder.stop()).toBeNull();
  });

  it("forwards MediaRecorder errors to onError hook", () => {
    let createdMock: MockMediaRecorder | null = null;
    const onError = vi.fn();

    const recorder = new SessionRecorder({
      mediaRecorderFactory: (stream, opts) => {
        createdMock = new MockMediaRecorder(stream, opts);
        return createdMock;
      },
      isTypeSupported: () => true,
      setIntervalFn: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });

    recorder.start(createFakeStream(1), "Lab-PC", { onError });
    createdMock!.emitError(new Error("codec stalled"));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]?.message).toBe("codec stalled");
  });
});
