import fsp from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_AUDIT_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_ROTATED_FILES = 2;
const MAX_PENDING_AUDIT_BUFFER_BYTES = 1 * 1024 * 1024; // 1 MB memory cap under stalled disk

export interface AuditLoggerOptions {
  maxFileBytes?: number;
  maxRotatedFiles?: number;
}

export type AuditEvent =
  | "auth.register"
  | "auth.login"
  | "auth.logout_all"
  | "auth.change_password"
  | "ws.auth"
  | "ws.auth_failed"
  | "ws.auth_timeout"
  | "ws.origin_rejected"
  | "ws.limit_hit"
  | "ws.error"
  | "rate_limit.hit"
  | "lockout.hit"
  | "agent.register"
  | "agent.credentials_rotated"
  | "device.unbind"
  | "session.start"
  | "session.end"
  | "control.wake"
  | "control.unlock"
  | "control.black_screen"
  | "control.force_portrait"
  | "control.privacy_screen"
  | "control.power"
  | "control.block_input"
  | "control.wol";

export interface AuditRecordInput {
  event: AuditEvent;
  ip: string;
  ok: boolean;
  userId?: string;
  username?: string;
  deviceId?: string;
  sessionId?: string;
  detail?: string;
}

interface AuditRecord {
  ts: string;
  event: AuditEvent;
  ip: string;
  userId?: string;
  username?: string;
  deviceId?: string;
  sessionId?: string;
  ok: boolean;
  detail?: string;
}

function sanitizeAuditField(value: string, maxLen: number): string {
  return value.replace(/[\r\n\x00-\x1f\x7f]+/g, " ").trim().slice(0, maxLen);
}

/**
 * Structured single-line JSON audit logger.
 * Strictly never accepts or emits passwords, JWTs, secrets, PINs, or clipboard text.
 */
export class AuditLogger {
  private readonly dataDir: string;
  private readonly filePath: string | null;
  private readonly maxFileBytes: number;
  private readonly maxRotatedFiles: number;
  private dirEnsured = false;
  private fileModeEnsured = false;
  private currentFileSize = -1;
  private readonly pendingLines: string[] = [];
  private pendingBytes = 0;
  private flushPromise: Promise<void> | null = null;

  constructor(dataDir: string, options: AuditLoggerOptions = {}) {
    this.dataDir = dataDir;
    this.filePath = dataDir === ":memory:" ? null : path.join(dataDir, "audit.jsonl");
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_AUDIT_FILE_BYTES;
    this.maxRotatedFiles = options.maxRotatedFiles ?? DEFAULT_MAX_ROTATED_FILES;
  }

  public log(input: AuditRecordInput): void {
    const record: AuditRecord = {
      ts: new Date().toISOString(),
      event: input.event,
      ip: sanitizeAuditField(input.ip || "unknown", 64),
      ok: Boolean(input.ok),
    };

    if (input.userId !== undefined && input.userId.length > 0) {
      record.userId = sanitizeAuditField(input.userId, 64);
    }
    if (input.username !== undefined && input.username.length > 0) {
      record.username = sanitizeAuditField(input.username, 64);
    }
    if (input.deviceId !== undefined && input.deviceId.length > 0) {
      record.deviceId = sanitizeAuditField(input.deviceId, 64);
    }
    if (input.sessionId !== undefined && input.sessionId.length > 0) {
      record.sessionId = sanitizeAuditField(input.sessionId, 64);
    }
    if (input.detail !== undefined && input.detail.length > 0) {
      record.detail = sanitizeAuditField(input.detail, 200);
    }

    const line = `${JSON.stringify(record)}\n`;
    try {
      process.stdout.write(line);
    } catch {
      // Ignore stdout write errors.
    }

    if (this.filePath) {
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (this.pendingBytes + lineBytes <= MAX_PENDING_AUDIT_BUFFER_BYTES) {
        this.pendingLines.push(line);
        this.pendingBytes += lineBytes;
        this.scheduleFlush();
      }
    }
  }

  public async flush(): Promise<void> {
    if (this.pendingLines.length > 0 && !this.flushPromise) {
      this.scheduleFlush();
    }
    while (this.flushPromise) {
      await this.flushPromise;
    }
  }

  private scheduleFlush(): void {
    if (!this.filePath || this.flushPromise || this.pendingLines.length === 0) {
      return;
    }
    this.flushPromise = this.drainBuffer().finally(() => {
      this.flushPromise = null;
      if (this.pendingLines.length > 0) {
        this.scheduleFlush();
      }
    });
  }

  private async drainBuffer(): Promise<void> {
    if (!this.filePath) {
      this.pendingLines.length = 0;
      this.pendingBytes = 0;
      return;
    }

    while (this.pendingLines.length > 0) {
      const chunk = this.pendingLines.join("");
      const chunkBytes = this.pendingBytes;
      this.pendingLines.length = 0;
      this.pendingBytes = 0;

      try {
        if (!this.dirEnsured) {
          await fsp.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
          await fsp.chmod(this.dataDir, 0o700).catch(() => {});
          this.dirEnsured = true;
        }

        if (this.currentFileSize < 0) {
          try {
            const st = await fsp.stat(this.filePath);
            this.currentFileSize = st.size;
          } catch {
            this.currentFileSize = 0;
          }
          this.fileModeEnsured = false;
        }

        if (this.currentFileSize > 0 && this.currentFileSize + chunkBytes > this.maxFileBytes) {
          await this.rotateFiles();
          this.currentFileSize = 0;
          this.fileModeEnsured = false;
        }

        await fsp.appendFile(this.filePath, chunk, { encoding: "utf8", mode: 0o600 });
        this.currentFileSize += chunkBytes;

        if (!this.fileModeEnsured) {
          await fsp.chmod(this.filePath, 0o600).catch(() => {});
          this.fileModeEnsured = true;
        }
      } catch {
        // Never allow audit file I/O failure to crash server handling.
      }
    }
  }

  private async rotateFiles(): Promise<void> {
    if (!this.filePath || this.maxRotatedFiles <= 0) {
      return;
    }
    for (let i = this.maxRotatedFiles; i >= 1; i -= 1) {
      const src = i === 1 ? this.filePath : `${this.filePath}.${i - 1}`;
      const dst = `${this.filePath}.${i}`;
      try {
        await fsp.rename(src, dst);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "ENOENT") {
          // Best-effort rotation; ignore non-ENOENT rename errors.
        }
      }
    }
  }
}
