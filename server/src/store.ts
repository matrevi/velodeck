import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  normalizeControlCode,
  type DeviceCapabilities,
  type DeviceSummary,
  type UserProfile,
} from "@velodeck/protocol";
import {
  hashPassword,
  isLegacyPasswordHash,
  timingSafeEqualHex,
  verifyPassword,
  verifyPasswordConstantTime,
} from "./auth.js";

export const DEVICE_ID_REGEX = /^[a-zA-Z0-9_-]{8,64}$/;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
export const MIN_CONTROL_PASSWORD_LENGTH = 8;

const USERNAME_PATTERN = /^[a-zA-Z0-9._@-]{3,32}$/;
const CONTROL_CODE_PATTERN = /^\d{9}$/;
const FORBIDDEN_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  ...Object.getOwnPropertyNames(Object.prototype),
]);

export type StoreErrorCode =
  | "INVALID_INPUT"
  | "USERNAME_EXISTS"
  | "INVALID_CREDENTIALS"
  | "QUOTA_EXCEEDED"
  | "REGISTRATION_LOCKED";

export interface CreateUserOptions {
  requireFirstUser?: boolean;
}

export class StoreError extends Error {
  public readonly code: StoreErrorCode;
  public readonly statusCode: number;

  constructor(code: StoreErrorCode, message: string, statusCode: number) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface StoredUser {
  userId: string;
  username: string;
  displayName: string;
  passwordHash: string;
  tokenVersion: number;
  createdAt: number;
}

export interface StoredDevice {
  deviceId: string;
  deviceSecretHash: string;
  controlCode: string;
  controlPassHash?: string;
  ownerUserId?: string;
  legacyAccessTokenHash?: string;
  summary: DeviceSummary;
}

export interface StoreLimits {
  maxUsers?: number;
  maxDevices?: number;
}

interface PersistedData {
  version: 1;
  users: Record<string, StoredUser>;
  devices: Record<string, StoredDevice>;
}

export function isValidDeviceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !FORBIDDEN_KEYS.has(value) &&
    DEVICE_ID_REGEX.test(value)
  );
}

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
}

function cloneCapabilities(cap: DeviceCapabilities): DeviceCapabilities {
  const copy: DeviceCapabilities = {
    webrtc: Boolean(cap.webrtc),
    wsJpeg: Boolean(cap.wsJpeg),
    wsH264: Boolean(cap.wsH264),
    wake: Boolean(cap.wake),
    unlock: Boolean(cap.unlock),
    accessibility: Boolean(cap.accessibility),
    mediaProjection: Boolean(cap.mediaProjection),
  };
  if (cap.rootOrShizuku !== undefined) {
    copy.rootOrShizuku = Boolean(cap.rootOrShizuku);
  }
  if (cap.p2pFileTransfer !== undefined) {
    copy.p2pFileTransfer = Boolean(cap.p2pFileTransfer);
  }
  return copy;
}

export function cloneDeviceSummary(summary: DeviceSummary): DeviceSummary {
  const copy: DeviceSummary = {
    deviceId: summary.deviceId,
    name: summary.name,
    model: summary.model,
    androidVersion: summary.androidVersion,
    online: summary.online,
    lastSeen: summary.lastSeen,
    screenWidth: summary.screenWidth,
    screenHeight: summary.screenHeight,
    rotation: summary.rotation,
    battery: summary.battery,
    charging: summary.charging,
    locked: summary.locked,
    capabilities: cloneCapabilities(summary.capabilities),
  };
  if (summary.controlCode !== undefined) {
    copy.controlCode = summary.controlCode;
  }
  if (summary.ownerUsername !== undefined) {
    copy.ownerUsername = summary.ownerUsername;
  }
  if (summary.screenOn !== undefined) {
    copy.screenOn = summary.screenOn;
  }
  if (summary.blackScreenActive !== undefined) {
    copy.blackScreenActive = summary.blackScreenActive;
  }
  if (summary.directUrl !== undefined) {
    copy.directUrl = summary.directUrl;
  }
  return copy;
}

function cloneStoredDevice(device: StoredDevice): StoredDevice {
  const copy: StoredDevice = {
    deviceId: device.deviceId,
    deviceSecretHash: device.deviceSecretHash,
    controlCode: device.controlCode,
    summary: cloneDeviceSummary(device.summary),
  };
  if (device.controlPassHash !== undefined) {
    copy.controlPassHash = device.controlPassHash;
  }
  if (device.ownerUserId !== undefined) {
    copy.ownerUserId = device.ownerUserId;
  }
  if (device.legacyAccessTokenHash !== undefined) {
    copy.legacyAccessTokenHash = device.legacyAccessTokenHash;
  }
  return copy;
}

function toUserProfile(user: StoredUser): UserProfile {
  return {
    userId: user.userId,
    username: user.username,
    displayName: user.displayName,
  };
}

function mapToNullProtoRecord<T>(map: Map<string, T>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  for (const [key, value] of map.entries()) {
    if (isForbiddenKey(key)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

export class VeloDeckStore {
  private readonly dataDir: string;
  private readonly filePath: string | null;
  private readonly bakPath: string | null;
  private readonly maxUsers: number;
  private readonly maxDevices: number;
  private readonly users = new Map<string, StoredUser>();
  private readonly devices = new Map<string, StoredDevice>();
  private readonly userIdByUsername = new Map<string, string>();
  private readonly deviceIdByControlCode = new Map<string, string>();
  private dirty = false;
  private writePromise: Promise<void> | null = null;
  private dirEnsured = false;

  constructor(dataDir: string, limits: StoreLimits = {}) {
    this.dataDir = dataDir;
    this.filePath = dataDir === ":memory:" ? null : path.join(dataDir, "store.json");
    this.bakPath = this.filePath ? `${this.filePath}.bak` : null;
    this.maxUsers = limits.maxUsers ?? 100;
    this.maxDevices = limits.maxDevices ?? 100;
    this.cleanupStaleTempFiles();
    this.loadFromDisk();
  }

  private cleanupStaleTempFiles(): void {
    if (!this.filePath) {
      return;
    }
    try {
      if (!fs.existsSync(this.dataDir)) {
        return;
      }
      const baseName = path.basename(this.filePath);
      const tmpPrefix = `${baseName}.tmp.`;
      const bakTmpPrefix = `${baseName}.bak.tmp.`;
      for (const entry of fs.readdirSync(this.dataDir)) {
        if (entry.startsWith(tmpPrefix) || entry.startsWith(bakTmpPrefix)) {
          try {
            fs.unlinkSync(path.join(this.dataDir, entry));
          } catch {
            // Best-effort cleanup of stale temp files from previous crashed writes.
          }
        }
      }
    } catch {
      // Ignore directory read errors on startup.
    }
  }

  private readParsedStoreFile(targetPath: string): Partial<PersistedData> | null {
    if (!fs.existsSync(targetPath)) {
      return null;
    }
    const raw = fs.readFileSync(targetPath, "utf8").trim();
    if (raw.length === 0) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Persisted store root must be a JSON object");
    }
    return parsed as Partial<PersistedData>;
  }

  private loadFromDisk(): void {
    if (!this.filePath) {
      return;
    }

    let parsed: Partial<PersistedData> | null = null;
    let recoveredFromBackup = false;

    try {
      parsed = this.readParsedStoreFile(this.filePath);
    } catch (err) {
      console.warn(
        "[velodeck-server] Primary store.json is corrupt or unreadable; attempting recovery from store.json.bak:",
        err,
      );
      parsed = null;
    }

    if (!parsed && this.bakPath && fs.existsSync(this.bakPath)) {
      try {
        parsed = this.readParsedStoreFile(this.bakPath);
        if (parsed) {
          recoveredFromBackup = true;
          console.warn("[velodeck-server] Recovered store state from store.json.bak.");
        }
      } catch (err) {
        console.error(
          "[velodeck-server] Failed to recover store state from store.json.bak:",
          err,
        );
        parsed = null;
      }
    }

    if (!parsed) {
      return;
    }

    if (parsed.users && typeof parsed.users === "object" && !Array.isArray(parsed.users)) {
      for (const [userId, user] of Object.entries(parsed.users)) {
        if (!Object.hasOwn(parsed.users, userId) || isForbiddenKey(userId)) {
          continue;
        }
        if (
          !user ||
          typeof user !== "object" ||
          typeof user.username !== "string" ||
          typeof user.passwordHash !== "string"
        ) {
          continue;
        }
        const resolvedUserId =
          typeof user.userId === "string" && user.userId.length > 0 && !isForbiddenKey(user.userId)
            ? user.userId
            : userId;
        if (isForbiddenKey(resolvedUserId)) {
          continue;
        }
        const normalizedUsername = user.username.trim().toLowerCase();
        if (normalizedUsername.length === 0 || isForbiddenKey(normalizedUsername)) {
          continue;
        }
        const tokenVersion =
          typeof user.tokenVersion === "number" &&
          Number.isInteger(user.tokenVersion) &&
          user.tokenVersion >= 1
            ? user.tokenVersion
            : 1;
        const record: StoredUser = {
          userId: resolvedUserId,
          username: normalizedUsername,
          displayName:
            typeof user.displayName === "string" && user.displayName.length > 0
              ? user.displayName
              : normalizedUsername,
          passwordHash: user.passwordHash,
          tokenVersion,
          createdAt: typeof user.createdAt === "number" ? user.createdAt : Date.now(),
        };
        this.users.set(record.userId, record);
        this.userIdByUsername.set(record.username, record.userId);
      }
    }

    if (parsed.devices && typeof parsed.devices === "object" && !Array.isArray(parsed.devices)) {
      for (const [deviceId, device] of Object.entries(parsed.devices)) {
        if (!Object.hasOwn(parsed.devices, deviceId) || isForbiddenKey(deviceId)) {
          continue;
        }
        if (!device || typeof device !== "object" || !device.summary) {
          continue;
        }
        const resolvedDeviceId =
          typeof device.deviceId === "string" && device.deviceId.length > 0
            ? device.deviceId
            : deviceId;
        if (isForbiddenKey(resolvedDeviceId) || !isValidDeviceId(resolvedDeviceId)) {
          continue;
        }
        const cloned = cloneStoredDevice({
          ...device,
          deviceId: resolvedDeviceId,
        });
        // Every persisted device starts offline until its live WebSocket connects.
        cloned.summary.online = false;
        cloned.summary.deviceId = resolvedDeviceId;
        if (cloned.controlCode && CONTROL_CODE_PATTERN.test(cloned.controlCode)) {
          cloned.summary.controlCode = cloned.controlCode;
          this.deviceIdByControlCode.set(cloned.controlCode, cloned.deviceId);
        }
        if (cloned.ownerUserId) {
          const owner = this.users.get(cloned.ownerUserId);
          if (owner) {
            cloned.summary.ownerUsername = owner.username;
          } else {
            delete cloned.ownerUserId;
            delete cloned.summary.ownerUsername;
          }
        }
        this.devices.set(cloned.deviceId, cloned);
      }
    }

    if (recoveredFromBackup) {
      this.persist();
    }
  }

  private persist(): void {
    if (!this.filePath) {
      return;
    }
    this.dirty = true;
    this.scheduleWrite();
  }

  private scheduleWrite(): void {
    if (!this.filePath || this.writePromise) {
      return;
    }
    this.writePromise = (async () => {
      try {
        while (this.dirty) {
          this.dirty = false;
          try {
            await this.writeSnapshotToDisk();
          } catch (err) {
            console.error("[velodeck-server] Failed to persist store.json:", err);
          }
        }
      } finally {
        this.writePromise = null;
        if (this.dirty) {
          this.scheduleWrite();
        }
      }
    })();
  }

  private async writeSnapshotToDisk(): Promise<void> {
    if (!this.filePath) {
      return;
    }
    if (!this.dirEnsured) {
      await fsp.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      await fsp.chmod(this.dataDir, 0o700).catch(() => {});
      this.dirEnsured = true;
    }

    const data: PersistedData = {
      version: 1,
      users: mapToNullProtoRecord(this.users),
      devices: mapToNullProtoRecord(this.devices),
    };
    const payload = JSON.stringify(data, null, 2);
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;

    let handle: fsp.FileHandle | null = null;
    try {
      handle = await fsp.open(tmpPath, "w", 0o600);
      await handle.writeFile(payload, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;

      await fsp.chmod(tmpPath, 0o600).catch(() => {});

      // Refresh .bak atomically from the previous known-good store.json before replacing it.
      if (this.bakPath) {
        const bakTmpPath = `${this.bakPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
        try {
          await fsp.copyFile(this.filePath, bakTmpPath);
          await fsp.chmod(bakTmpPath, 0o600).catch(() => {});
          await fsp.rename(bakTmpPath, this.bakPath);
        } catch (err) {
          await fsp.unlink(bakTmpPath).catch(() => {});
          const code = (err as NodeJS.ErrnoException | undefined)?.code;
          if (code !== "ENOENT") {
            console.warn("[velodeck-server] Failed to refresh store.json.bak:", err);
          }
        }
      }

      await fsp.rename(tmpPath, this.filePath);
    } catch (err) {
      if (handle) {
        await handle.close().catch(() => {});
      }
      await fsp.unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  public async flush(): Promise<void> {
    if (this.dirty && !this.writePromise) {
      this.scheduleWrite();
    }
    while (this.writePromise) {
      await this.writePromise;
    }
  }

  public getUserCount(): number {
    return this.users.size;
  }

  public getDeviceCount(): number {
    return this.devices.size;
  }

  public deviceCount(): number {
    return this.devices.size;
  }

  public async createUser(
    username: string,
    password: string,
    displayName?: string,
    options?: CreateUserOptions,
  ): Promise<UserProfile> {
    if (typeof username !== "string") {
      throw new StoreError("INVALID_INPUT", "用户名格式无效", 400);
    }
    const trimmed = username.trim();
    if (!USERNAME_PATTERN.test(trimmed) || isForbiddenKey(trimmed.toLowerCase())) {
      throw new StoreError(
        "INVALID_INPUT",
        "用户名需为 3-32 位字母、数字或 . _ @ - 字符",
        400,
      );
    }
    if (
      typeof password !== "string" ||
      password.length < MIN_PASSWORD_LENGTH ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      throw new StoreError(
        "INVALID_INPUT",
        `密码长度需为 ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} 位`,
        400,
      );
    }

    const normalized = trimmed.toLowerCase();
    if (options?.requireFirstUser && this.users.size > 0) {
      throw new StoreError(
        "REGISTRATION_LOCKED",
        "公网注册已自动锁定，请联系管理员配置邀请码",
        403,
      );
    }
    if (this.userIdByUsername.has(normalized)) {
      throw new StoreError("USERNAME_EXISTS", "该用户名已被注册", 409);
    }
    if (this.users.size >= this.maxUsers) {
      throw new StoreError("QUOTA_EXCEEDED", "已达到服务器最大用户数量限制", 403);
    }

    const passwordHash = await hashPassword(password);

    // Re-check first-user gate, uniqueness & quota after async scrypt to avoid TOCTOU races.
    if (options?.requireFirstUser && this.users.size > 0) {
      throw new StoreError(
        "REGISTRATION_LOCKED",
        "公网注册已自动锁定，请联系管理员配置邀请码",
        403,
      );
    }
    if (this.userIdByUsername.has(normalized)) {
      throw new StoreError("USERNAME_EXISTS", "该用户名已被注册", 409);
    }
    if (this.users.size >= this.maxUsers) {
      throw new StoreError("QUOTA_EXCEEDED", "已达到服务器最大用户数量限制", 403);
    }

    const cleanDisplayName =
      typeof displayName === "string" && displayName.trim().length > 0
        ? displayName.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 64)
        : trimmed;

    const user: StoredUser = {
      userId: `usr_${crypto.randomBytes(12).toString("hex")}`,
      username: normalized,
      displayName: cleanDisplayName.length > 0 ? cleanDisplayName : trimmed,
      passwordHash,
      tokenVersion: 1,
      createdAt: Date.now(),
    };

    this.users.set(user.userId, user);
    this.userIdByUsername.set(user.username, user.userId);
    this.persist();
    return toUserProfile(user);
  }

  public async authenticateUser(
    username: string,
    password: string,
  ): Promise<UserProfile | null> {
    if (typeof username !== "string" || typeof password !== "string") {
      await verifyPasswordConstantTime("", null);
      return null;
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      await verifyPasswordConstantTime("", null);
      return null;
    }
    const normalized = username.trim().toLowerCase();
    const userId = this.userIdByUsername.get(normalized);
    const user = userId ? this.users.get(userId) : undefined;

    const ok = await verifyPasswordConstantTime(password, user?.passwordHash ?? null);
    if (!ok || !user) {
      return null;
    }

    // Transparently upgrade legacy N=16384 hashes on successful login.
    if (isLegacyPasswordHash(user.passwordHash)) {
      user.passwordHash = await hashPassword(password);
      this.persist();
    }

    return toUserProfile(user);
  }

  public getUserById(userId: string): UserProfile | null {
    if (typeof userId !== "string" || userId.length === 0) {
      return null;
    }
    const user = this.users.get(userId);
    return user ? toUserProfile(user) : null;
  }

  public getUserTokenVersion(userId: string): number | null {
    if (typeof userId !== "string" || userId.length === 0) {
      return null;
    }
    const user = this.users.get(userId);
    return user ? user.tokenVersion : null;
  }

  public getUserWithTokenVersion(
    userId: string,
  ): { user: UserProfile; tokenVersion: number } | null {
    if (typeof userId !== "string" || userId.length === 0) {
      return null;
    }
    const user = this.users.get(userId);
    if (!user) {
      return null;
    }
    return { user: toUserProfile(user), tokenVersion: user.tokenVersion };
  }

  public bumpTokenVersion(userId: string): number | null {
    if (typeof userId !== "string" || userId.length === 0) {
      return null;
    }
    const user = this.users.get(userId);
    if (!user) {
      return null;
    }
    user.tokenVersion += 1;
    this.persist();
    return user.tokenVersion;
  }

  public async changeUserPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ user: UserProfile; tokenVersion: number }> {
    const user = this.users.get(userId);
    const currentValid = await verifyPasswordConstantTime(
      typeof currentPassword === "string" ? currentPassword : "",
      user?.passwordHash ?? null,
    );
    if (!user || !currentValid) {
      throw new StoreError("INVALID_CREDENTIALS", "当前密码错误", 401);
    }
    if (
      typeof newPassword !== "string" ||
      newPassword.length < MIN_PASSWORD_LENGTH ||
      newPassword.length > MAX_PASSWORD_LENGTH
    ) {
      throw new StoreError(
        "INVALID_INPUT",
        `新密码长度需为 ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} 位`,
        400,
      );
    }
    user.passwordHash = await hashPassword(newPassword);
    user.tokenVersion += 1;
    this.persist();
    return { user: toUserProfile(user), tokenVersion: user.tokenVersion };
  }

  public async setDeviceControlPassword(
    deviceId: string,
    newPassword: string,
  ): Promise<{ controlPassHash: string; changed: boolean }> {
    if (!isValidDeviceId(deviceId)) {
      throw new StoreError("INVALID_INPUT", "无效的设备 ID", 400);
    }
    const existing = this.devices.get(deviceId);
    if (existing?.controlPassHash) {
      const same = await verifyPassword(newPassword, existing.controlPassHash);
      if (same) {
        return { controlPassHash: existing.controlPassHash, changed: false };
      }
    }
    if (
      typeof newPassword !== "string" ||
      newPassword.length < MIN_CONTROL_PASSWORD_LENGTH ||
      newPassword.length > MAX_PASSWORD_LENGTH
    ) {
      throw new StoreError(
        "INVALID_INPUT",
        `无人值守密码长度需为 ${MIN_CONTROL_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} 位`,
        400,
      );
    }
    const nextHash = await hashPassword(newPassword);
    if (existing) {
      const changed = Boolean(existing.controlPassHash);
      existing.controlPassHash = nextHash;
      this.persist();
      return { controlPassHash: nextHash, changed };
    }
    return { controlPassHash: nextHash, changed: false };
  }

  public async verifyDeviceControlPassword(
    controlCode: string,
    password: string,
  ): Promise<StoredDevice | null> {
    const normalized = typeof controlCode === "string" ? normalizeControlCode(controlCode) : "";
    const device =
      CONTROL_CODE_PATTERN.test(normalized)
        ? this.getDeviceByControlCode(normalized)
        : null;
    const safePassword =
      typeof password === "string" && password.length <= MAX_PASSWORD_LENGTH ? password : "";

    const ok = await verifyPasswordConstantTime(safePassword, device?.controlPassHash ?? null);
    if (!ok || !device) {
      return null;
    }
    return device;
  }

  public generateUniqueControlCode(): string {
    for (let attempts = 0; attempts < 10_000; attempts += 1) {
      const code = crypto.randomInt(100_000_000, 1_000_000_000).toString();
      if (!this.deviceIdByControlCode.has(code)) {
        return code;
      }
    }
    throw new Error("Unable to allocate unique 9-digit control code");
  }

  public getDevice(deviceId: string): StoredDevice | null {
    if (!isValidDeviceId(deviceId)) {
      return null;
    }
    const device = this.devices.get(deviceId);
    return device ? cloneStoredDevice(device) : null;
  }

  public getDeviceByControlCode(code: string): StoredDevice | null {
    if (typeof code !== "string") {
      return null;
    }
    const normalized = normalizeControlCode(code);
    if (!CONTROL_CODE_PATTERN.test(normalized)) {
      return null;
    }
    const deviceId = this.deviceIdByControlCode.get(normalized);
    if (!deviceId) {
      return null;
    }
    const device = this.devices.get(deviceId);
    return device ? cloneStoredDevice(device) : null;
  }

  public saveDevice(record: StoredDevice): void {
    if (!isValidDeviceId(record.deviceId)) {
      throw new StoreError("INVALID_INPUT", "无效的设备 ID", 400);
    }
    const previous = this.devices.get(record.deviceId);
    if (!previous && this.devices.size >= this.maxDevices) {
      throw new StoreError("QUOTA_EXCEEDED", "已达到服务器最大设备数量限制", 403);
    }
    if (previous && previous.controlCode && previous.controlCode !== record.controlCode) {
      if (this.deviceIdByControlCode.get(previous.controlCode) === record.deviceId) {
        this.deviceIdByControlCode.delete(previous.controlCode);
      }
    }

    const cloned = cloneStoredDevice(record);
    cloned.summary.controlCode = cloned.controlCode;
    this.devices.set(cloned.deviceId, cloned);
    this.deviceIdByControlCode.set(cloned.controlCode, cloned.deviceId);
    this.persist();
  }

  public updateDeviceSummaryInMemory(deviceId: string, summary: DeviceSummary): void {
    if (!isValidDeviceId(deviceId)) {
      return;
    }
    const existing = this.devices.get(deviceId);
    if (!existing) {
      return;
    }
    const cloned = cloneDeviceSummary(summary);
    cloned.controlCode = existing.controlCode;
    existing.summary = cloned;
  }

  public listDevicesByOwner(userId: string): DeviceSummary[] {
    if (typeof userId !== "string" || userId.length === 0) {
      return [];
    }
    const results: DeviceSummary[] = [];
    for (const device of this.devices.values()) {
      if (device.ownerUserId === userId) {
        results.push(cloneDeviceSummary(device.summary));
      }
    }
    return results;
  }

  public listDevicesByLegacyTokenHash(hexHash: string): DeviceSummary[] {
    if (typeof hexHash !== "string" || hexHash.length === 0) {
      return [];
    }
    const results: DeviceSummary[] = [];
    for (const device of this.devices.values()) {
      if (
        device.legacyAccessTokenHash &&
        timingSafeEqualHex(device.legacyAccessTokenHash, hexHash)
      ) {
        results.push(cloneDeviceSummary(device.summary));
      }
    }
    return results;
  }

  public unbindDevice(userId: string, deviceId: string): boolean {
    if (!isValidDeviceId(deviceId)) {
      return false;
    }
    const device = this.devices.get(deviceId);
    if (!device || device.ownerUserId !== userId) {
      return false;
    }
    delete device.ownerUserId;
    delete device.summary.ownerUsername;
    this.persist();
    return true;
  }
}
