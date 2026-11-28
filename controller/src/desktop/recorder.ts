export const PREFERRED_RECORDING_MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=h264,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
] as const;

export interface RecordingResult {
  blob: Blob;
  fileName: string;
  mimeType: string;
  durationSec: number;
}

export interface MediaRecorderLike {
  readonly state: string;
  readonly mimeType?: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: { error?: unknown }) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

export interface SessionRecorderOptions {
  mediaRecorderFactory?: (
    stream: MediaStream,
    options?: MediaRecorderOptions,
  ) => MediaRecorderLike;
  isTypeSupported?: (mimeType: string) => boolean;
  now?: () => number;
  setIntervalFn?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void;
  setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (id: ReturnType<typeof setTimeout>) => void;
  timesliceMs?: number;
  stopTimeoutMs?: number;
}

export interface SessionRecorderStartHooks {
  onDuration?: (durationSec: number) => void;
  onError?: (err: Error) => void;
}

const DEFAULT_TIMESLICE_MS = 1000;
const DEFAULT_STOP_TIMEOUT_MS = 3000;

/**
 * Picks the best supported local recording container/codec in preference order:
 * `video/webm;codecs=vp9,opus` -> `video/webm;codecs=h264,opus` -> `video/webm;codecs=vp8,opus` -> `video/webm` -> `video/mp4`.
 */
export function pickSupportedRecordingMimeType(
  isTypeSupportedFn?: (mimeType: string) => boolean,
): string | null {
  const checker =
    isTypeSupportedFn ??
    (typeof MediaRecorder !== "undefined" &&
    typeof MediaRecorder.isTypeSupported === "function"
      ? (mime: string) => MediaRecorder.isTypeSupported(mime)
      : null);

  if (!checker) {
    return null;
  }

  for (const candidate of PREFERRED_RECORDING_MIME_TYPES) {
    try {
      if (checker(candidate)) {
        return candidate;
      }
    } catch {
      // Ignore probe error and try next candidate
    }
  }

  return null;
}

/**
 * Builds a clean sanitized local recording filename like `VeloDeck-MacBook-20261128-084500.webm`.
 */
export function buildRecordingFileName(
  deviceName: string,
  mimeType: string,
  now: Date = new Date(),
): string {
  const sanitizedDevice =
    (deviceName || "")
      .trim()
      .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "Device";

  const pad = (n: number) => String(n).padStart(2, "0");
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const ext = mimeType.toLowerCase().includes("mp4") ? "mp4" : "webm";

  return `VeloDeck-${sanitizedDevice}-${datePart}-${timePart}.${ext}`;
}

export function formatRecordingDuration(durationSec: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(durationSec) ? durationSec : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

export function triggerRecordingDownload(blob: Blob, fileName: string): boolean {
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return false;
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    return true;
  } finally {
    window.setTimeout(() => {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // Ignore revoke failure
      }
    }, 5_000);
  }
}

export class SessionRecorder {
  private readonly mediaRecorderFactory: (
    stream: MediaStream,
    options?: MediaRecorderOptions,
  ) => MediaRecorderLike;
  private readonly isTypeSupportedFn?: (mimeType: string) => boolean;
  private readonly now: () => number;
  private readonly setIntervalFn: (
    cb: () => void,
    ms: number,
  ) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (id: ReturnType<typeof setInterval>) => void;
  private readonly setTimeoutFn: (
    cb: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (id: ReturnType<typeof setTimeout>) => void;
  private readonly timesliceMs: number;
  private readonly stopTimeoutMs: number;

  private recorder: MediaRecorderLike | null = null;
  private chunks: Blob[] = [];
  private deviceName = "Device";
  private mimeType = "video/webm";
  private startedAtMs = 0;
  private durationSec = 0;
  private durationTimer: ReturnType<typeof setInterval> | null = null;
  private stopPromise: Promise<RecordingResult | null> | null = null;
  private onDurationCb: ((durationSec: number) => void) | null = null;

  constructor(options: SessionRecorderOptions = {}) {
    this.mediaRecorderFactory =
      options.mediaRecorderFactory ??
      ((stream, recOptions) => {
        if (typeof MediaRecorder === "undefined") {
          throw new Error("当前浏览器环境不支持本地录屏 (MediaRecorder)");
        }
        return new MediaRecorder(stream, recOptions) as unknown as MediaRecorderLike;
      });
    this.isTypeSupportedFn = options.isTypeSupported;
    this.now = options.now ?? (() => Date.now());
    this.setIntervalFn =
      options.setIntervalFn ?? ((cb, ms) => globalThis.setInterval(cb, ms));
    this.clearIntervalFn =
      options.clearIntervalFn ?? ((id) => globalThis.clearInterval(id));
    this.setTimeoutFn =
      options.setTimeoutFn ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
    this.clearTimeoutFn =
      options.clearTimeoutFn ?? ((id) => globalThis.clearTimeout(id));
    this.timesliceMs = options.timesliceMs ?? DEFAULT_TIMESLICE_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }

  isRecording(): boolean {
    return this.recorder !== null && this.stopPromise === null;
  }

  getDurationSec(): number {
    if (!this.recorder) return 0;
    return Math.max(
      this.durationSec,
      Math.max(0, Math.floor((this.now() - this.startedAtMs) / 1000)),
    );
  }

  getMimeType(): string {
    return this.mimeType;
  }

  start(
    stream: MediaStream,
    deviceName: string,
    hooks: SessionRecorderStartHooks = {},
  ): { mimeType: string } {
    if (this.recorder) {
      throw new Error("录屏正在进行中");
    }
    const tracks = typeof stream?.getTracks === "function" ? stream.getTracks() : [];
    if (tracks.length === 0) {
      throw new Error("当前暂无可录制的实时音视频流");
    }

    const chosenMime = pickSupportedRecordingMimeType(this.isTypeSupportedFn);
    const recOptions: MediaRecorderOptions | undefined = chosenMime
      ? { mimeType: chosenMime }
      : undefined;

    const recorder = this.mediaRecorderFactory(stream, recOptions);
    const effectiveMime = recorder.mimeType || chosenMime || "video/webm";

    this.recorder = recorder;
    this.chunks = [];
    this.deviceName = deviceName || "Device";
    this.mimeType = effectiveMime;
    this.startedAtMs = this.now();
    this.durationSec = 0;
    this.stopPromise = null;
    this.onDurationCb = hooks.onDuration ?? null;

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };

    recorder.onerror = (event) => {
      const err =
        event.error instanceof Error
          ? event.error
          : new Error("本地录屏过程中发生编码错误");
      hooks.onError?.(err);
    };

    recorder.start(this.timesliceMs);
    this.onDurationCb?.(0);

    this.durationTimer = this.setIntervalFn(() => {
      if (!this.recorder) return;
      const nextSec = Math.max(0, Math.floor((this.now() - this.startedAtMs) / 1000));
      if (nextSec !== this.durationSec) {
        this.durationSec = nextSec;
        this.onDurationCb?.(nextSec);
      }
    }, 500);

    return { mimeType: effectiveMime };
  }

  stop(): Promise<RecordingResult | null> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    const activeRecorder = this.recorder;
    if (!activeRecorder) {
      return Promise.resolve(null);
    }

    this.clearDurationTimer();
    const finalDurationSec = Math.max(
      this.durationSec,
      Math.max(0, Math.floor((this.now() - this.startedAtMs) / 1000)),
    );
    const capturedDeviceName = this.deviceName;
    const capturedMimeType = activeRecorder.mimeType || this.mimeType || "video/webm";

    const finalize = (): RecordingResult => {
      const collected = this.chunks.slice();
      this.recorder = null;
      this.chunks = [];
      this.durationSec = 0;
      this.onDurationCb = null;
      this.stopPromise = null;

      const blob = new Blob(collected, { type: capturedMimeType });
      const fileName = buildRecordingFileName(
        capturedDeviceName,
        capturedMimeType,
        new Date(this.now()),
      );
      return {
        blob,
        fileName,
        mimeType: capturedMimeType,
        durationSec: finalDurationSec,
      };
    };

    if (activeRecorder.state === "inactive") {
      return Promise.resolve(finalize());
    }

    this.stopPromise = new Promise<RecordingResult | null>((resolve) => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (timeoutHandle !== null) {
          this.clearTimeoutFn(timeoutHandle);
          timeoutHandle = null;
        }
        activeRecorder.onstop = null;
        resolve(finalize());
      };

      activeRecorder.onstop = finish;
      timeoutHandle = this.setTimeoutFn(finish, this.stopTimeoutMs);

      try {
        activeRecorder.stop();
      } catch {
        finish();
      }
    });

    return this.stopPromise;
  }

  private clearDurationTimer(): void {
    if (this.durationTimer !== null) {
      this.clearIntervalFn(this.durationTimer);
      this.durationTimer = null;
    }
  }
}
