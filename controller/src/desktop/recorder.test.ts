import { describe, expect, it, vi } from "vitest";
import {
  PREFERRED_RECORDING_MIME_TYPES,
  PREFERRED_VIDEO_ONLY_RECORDING_MIME_TYPES,
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

interface FakeTrack {
  id: string;
  kind: "video" | "audio";
  addEventListener: (event: string, cb: () => void) => void;
  removeEventListener: (event: string, cb: () => void) => void;
  emitEnded: () => void;
  listenerCount: (event: string) => number;
}

function createFakeTrack(id: string, kind: "video" | "audio"): FakeTrack {
  const listeners = new Map<string, Set<() => void>>();
  return {
    id,
    kind,
    addEventListener(event: string, cb: () => void) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(cb);
    },
    removeEventListener(event: string, cb: () => void) {
      listeners.get(event)?.delete(cb);
    },
    emitEnded() {
      for (const cb of Array.from(listeners.get("ended") ?? [])) {
        cb();
      }
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

function createFakeStream(trackCount = 1): MediaStream & { fakeTracks: FakeTrack[] } {
  const tracks: FakeTrack[] = Array.from({ length: trackCount }, (_, idx) =>
    createFakeTrack(`track-${idx}`, idx === 0 ? "video" : "audio"),
  );
  return {
    fakeTracks: tracks,
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
  } as unknown as MediaStream & { fakeTracks: FakeTrack[] };
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

  it("picks video-only MIME types when hasAudio is false", () => {
    expect(pickSupportedRecordingMimeType(() => true, false)).toBe(
      PREFERRED_VIDEO_ONLY_RECORDING_MIME_TYPES[0],
    );
    expect(
      pickSupportedRecordingMimeType(
        (m) => m === "video/webm;codecs=vp9,opus" || m === "video/webm;codecs=h264",
        false,
      ),
    ).toBe("video/webm;codecs=h264");
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

  it("forwards MediaRecorder errors to onError hook and clears duration timer", () => {
    let createdMock: MockMediaRecorder | null = null;
    const onError = vi.fn();
    const clearIntervalSpy = vi.fn();

    const recorder = new SessionRecorder({
      mediaRecorderFactory: (stream, opts) => {
        createdMock = new MockMediaRecorder(stream, opts);
        return createdMock;
      },
      isTypeSupported: () => true,
      setIntervalFn: () => 99 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: clearIntervalSpy,
    });

    recorder.start(createFakeStream(1), "Lab-PC", { onError });
    createdMock!.emitError(new Error("codec stalled"));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]?.message).toBe("codec stalled");
    expect(clearIntervalSpy).toHaveBeenCalledWith(99);
  });

  it("selects video-only MIME type when stream has no audio track", () => {
    const seenOptions: Array<MediaRecorderOptions | undefined> = [];
    const recorder = new SessionRecorder({
      mediaRecorderFactory: (stream, opts) => {
        seenOptions.push(opts);
        return new MockMediaRecorder(stream, opts);
      },
      isTypeSupported: () => true,
      setIntervalFn: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });

    const { mimeType } = recorder.start(createFakeStream(1), "VideoOnlyPC");
    expect(mimeType).toBe("video/webm;codecs=vp9");
    expect(seenOptions).toEqual([{ mimeType: "video/webm;codecs=vp9" }]);
  });

  it("retries without MIME options if codec-specific start throws, and rolls back completely if retry also fails", () => {
    const receivedOpts: Array<MediaRecorderOptions | undefined> = [];
    let shouldFailAll = false;

    const recorder = new SessionRecorder({
      mediaRecorderFactory: (stream, opts) => {
        receivedOpts.push(opts);
        const mock = new MockMediaRecorder(stream, opts);
        mock.start = (timeslice?: number) => {
          if (shouldFailAll || opts?.mimeType) {
            throw new Error("unsupported codec at start");
          }
          MockMediaRecorder.prototype.start.call(mock, timeslice);
        };
        return mock;
      },
      isTypeSupported: () => true,
      setIntervalFn: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });

    // 1. Codec-specific start fails -> retries with options=undefined and succeeds
    const started = recorder.start(createFakeStream(1), "RetryPC");
    expect(started.mimeType).toBe("video/webm");
    expect(receivedOpts).toEqual([{ mimeType: "video/webm;codecs=vp9" }, undefined]);
    expect(recorder.isRecording()).toBe(true);

    // 2. If both fail, recorder rolls back cleanly and is NOT permanently wedged
    const recorder2 = new SessionRecorder({
      mediaRecorderFactory: (stream, opts) => {
        const mock = new MockMediaRecorder(stream, opts);
        mock.start = () => {
          if (shouldFailAll) {
            throw new Error("hardware encoder busy");
          }
          MockMediaRecorder.prototype.start.call(mock, 1000);
        };
        return mock;
      },
      isTypeSupported: () => true,
      setIntervalFn: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });

    shouldFailAll = true;
    expect(() => recorder2.start(createFakeStream(1), "FailPC")).toThrow(
      "hardware encoder busy",
    );
    expect(recorder2.isRecording()).toBe(false);

    // Subsequent start after transient failure must succeed cleanly
    shouldFailAll = false;
    expect(() => recorder2.start(createFakeStream(1), "FailPC")).not.toThrow();
    expect(recorder2.isRecording()).toBe(true);
  });

  it("isolates late events from finalized recorders so they cannot pollute a new session", async () => {
    const mocks: MockMediaRecorder[] = [];
    const onError2 = vi.fn();

    const recorder = new SessionRecorder({
      mediaRecorderFactory: (stream, opts) => {
        const m = new MockMediaRecorder(stream, opts);
        mocks.push(m);
        return m;
      },
      isTypeSupported: () => true,
      setIntervalFn: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });

    recorder.start(createFakeStream(1), "First");
    const firstMock = mocks[0]!;
    firstMock.emitChunk(new Uint8Array([1, 2]));
    const savedOnData = firstMock.ondataavailable;
    const savedOnError = firstMock.onerror;
    await recorder.stop();

    // Handlers cleared on finalize
    expect(firstMock.ondataavailable).toBeNull();
    expect(firstMock.onerror).toBeNull();
    expect(firstMock.onstop).toBeNull();

    // Start second session and invoke stale closures from first session
    recorder.start(createFakeStream(1), "Second", { onError: onError2 });
    const secondMock = mocks[1]!;
    savedOnData?.({ data: new Blob([new Uint8Array([99, 99, 99, 99])]) });
    savedOnError?.({ error: new Error("stale error") });
    expect(onError2).not.toHaveBeenCalled();

    secondMock.emitChunk(new Uint8Array([5]));
    const res2 = await recorder.stop();
    expect(res2!.blob.size).toBe(4); // 1 byte from secondMock + 3 trailing flush bytes (no stale 4 bytes!)
  });

  it("fires onStreamEnded when video track ends and detaches listeners on stop", async () => {
    const onStreamEnded = vi.fn();
    const stream1 = createFakeStream(2);
    const recorder = new SessionRecorder({
      mediaRecorderFactory: (s, o) => new MockMediaRecorder(s, o),
      isTypeSupported: () => true,
      setIntervalFn: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });

    recorder.start(stream1, "LivePC", { onStreamEnded });
    expect(stream1.fakeTracks[0]!.listenerCount("ended")).toBe(1);

    stream1.fakeTracks[0]!.emitEnded();
    stream1.fakeTracks[0]!.emitEnded(); // only fires once
    expect(onStreamEnded).toHaveBeenCalledTimes(1);
    expect(stream1.fakeTracks[0]!.listenerCount("ended")).toBe(0);
    await recorder.stop();

    // If stopped before track ends, listener is detached and does not fire later
    const onStreamEnded2 = vi.fn();
    const stream2 = createFakeStream(1);
    recorder.start(stream2, "LivePC2", { onStreamEnded: onStreamEnded2 });
    expect(stream2.fakeTracks[0]!.listenerCount("ended")).toBe(1);
    await recorder.stop();
    expect(stream2.fakeTracks[0]!.listenerCount("ended")).toBe(0);
    stream2.fakeTracks[0]!.emitEnded();
    expect(onStreamEnded2).not.toHaveBeenCalled();
  });
});
