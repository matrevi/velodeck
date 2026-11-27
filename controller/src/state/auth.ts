import {
  formatControlCode,
  normalizeControlCode,
  type UserProfile,
} from "@velodeck/protocol";
import {
  DEFAULT_CLOUD_API_BASE,
  DEFAULT_CLOUD_WS_URL,
  detectDefaultApiBase,
  detectDefaultRelayWsUrl,
  detectDefaultTransport,
} from "./profiles";

export {
  DEFAULT_CLOUD_API_BASE,
  DEFAULT_CLOUD_WS_URL,
  detectDefaultApiBase,
  detectDefaultRelayWsUrl,
  detectDefaultTransport,
  formatControlCode,
  normalizeControlCode,
};

export const ACCOUNT_SESSION_STORAGE_KEY = "velodeck.account.v1";
export const RECENT_CODES_STORAGE_KEY = "velodeck.recentCodes.v1";
export const SESSION_PASSWORDS_STORAGE_KEY = "velodeck.sessionPasswords.v1";
export const IOS_PWA_BANNER_DISMISSED_KEY = "velodeck.controller.iosPwaTipDismissed.v1";
export const MAX_RECENT_CODES = 10;
export const MIN_PASSWORD_LENGTH = 8;

export type RegistrationMode =
  | "first-user-then-invite"
  | "invite"
  | "open"
  | "closed";

export interface SavedAccountSession {
  authToken: string;
  user: UserProfile;
  wsUrl: string;
  apiBase: string;
}

export interface RecentControlCode {
  controlCode: string;
  /** Hydrated from sessionStorage only — NEVER persisted in localStorage. */
  controlPassword?: string;
  deviceName?: string;
  lastUsedAt: number;
}

interface PersistedRecentControlCode {
  controlCode: string;
  deviceName?: string;
  lastUsedAt: number;
}

export interface ServerInfo {
  hasAndroidApk: boolean;
  androidApkUrl?: string;
  apkSha256?: string;
  version?: string;
  registrationMode?: RegistrationMode;
  registrationOpen?: boolean;
  requiresInviteCode?: boolean;
}

export interface AuthResponse {
  token: string;
  user: UserProfile;
}

export interface RegisterAccountInput {
  username: string;
  password: string;
  displayName?: string;
  inviteCode?: string;
}

export interface LoginAccountInput {
  username: string;
  password: string;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export interface ChangePasswordResponse {
  ok: true;
  token: string;
}

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

function getSafeSessionStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      return window.sessionStorage;
    }
  } catch {
    return null;
  }
  return null;
}

/** Strips all non-digit characters and caps at 9 digits. */
export function sanitizeControlCodeInput(raw: string): string {
  return raw.replace(/\D+/g, "").slice(0, 9);
}

/** Formats partial or complete digits into grouped "683 291 405" style for input fields. */
export function formatControlCodeInput(raw: string): string {
  const digits = sanitizeControlCodeInput(raw);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)} ${digits.slice(3)}`;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 9)}`;
}

/** Checks whether raw input normalizes to an exact 9-digit control code. */
export function isValidControlCode(raw: string): boolean {
  return /^\d{9}$/.test(normalizeControlCode(raw));
}

export function buildApiUrl(apiBase: string, endpointPath: string): string {
  const normalizedBase = apiBase.trim().replace(/\/+$/, "");
  const normalizedPath = endpointPath.startsWith("/")
    ? endpointPath
    : `/${endpointPath}`;
  return `${normalizedBase}${normalizedPath}`;
}

export function getAndroidApkFileName(
  serverInfo?: Pick<ServerInfo, "version"> | null,
): string {
  const cleanVersion = (serverInfo?.version ?? "")
    .trim()
    .replace(/^v+/i, "")
    .replace(/[^0-9A-Za-z._-]/g, "");
  return cleanVersion ? `velodeck-agent-v${cleanVersion}.apk` : "velodeck-agent.apk";
}

export function getAndroidApkDownloadUrl(
  apiBase: string,
  serverInfo?: Pick<ServerInfo, "version" | "apkSha256"> | null,
): string {
  const fileName = getAndroidApkFileName(serverInfo);
  const baseUrl = buildApiUrl(apiBase, `/api/download/${fileName}`);
  const sha = serverInfo?.apkSha256?.trim();
  if (sha) {
    return `${baseUrl}?sha=${encodeURIComponent(sha.slice(0, 12))}`;
  }
  return baseUrl;
}

function extractApiError(payload: unknown, fallback: string): string {
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim().length > 0) {
      return translateServerError(record.error.trim());
    }
    if (typeof record.message === "string" && record.message.trim().length > 0) {
      return translateServerError(record.message.trim());
    }
  }
  return fallback;
}

function translateServerError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("already exists") || lower.includes("username taken")) {
    return "该账号已被注册，请直接登录或更换用户名";
  }
  if (
    lower.includes("invalid username or password") ||
    lower.includes("invalid credentials") ||
    lower.includes("wrong password")
  ) {
    return "账号或密码不正确，请核对后重试";
  }
  if (lower.includes("current password")) {
    return "当前密码不正确，请核对后重试";
  }
  if (lower.includes("registration closed") || lower.includes("registration is closed")) {
    return "服务器已关闭公开注册";
  }
  if (lower.includes("invite code") || lower.includes("invalid invite")) {
    return "邀请码无效或未填写，请核对后重试";
  }
  if (lower.includes("password") && (lower.includes("short") || lower.includes("at least"))) {
    return `密码长度太短，请至少输入 ${MIN_PASSWORD_LENGTH} 位密码`;
  }
  if (lower.includes("username") && (lower.includes("short") || lower.includes("invalid"))) {
    return "用户名格式不正确，请使用 3-32 位字母、数字或手机号";
  }
  if (lower.includes("unauthorized")) {
    return "登录状态已失效，请重新登录";
  }
  if (lower.includes("rate limit") || lower.includes("too many")) {
    return "操作过于频繁，请稍后再试";
  }
  return message;
}

async function parseJsonSafe(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function isValidUserProfile(value: unknown): value is UserProfile {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.userId === "string" &&
    candidate.userId.length > 0 &&
    typeof candidate.username === "string" &&
    candidate.username.length > 0 &&
    typeof candidate.displayName === "string"
  );
}

function isValidRegistrationMode(value: unknown): value is RegistrationMode {
  return (
    value === "first-user-then-invite" ||
    value === "invite" ||
    value === "open" ||
    value === "closed"
  );
}

export async function fetchServerInfo(
  apiBase: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ServerInfo> {
  try {
    const res = await fetchImpl(buildApiUrl(apiBase, "/api/info"), {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return { hasAndroidApk: false };
    }
    const data = (await parseJsonSafe(res)) as Record<string, unknown> | null;
    if (!data || typeof data !== "object") {
      return { hasAndroidApk: false };
    }
    const info: ServerInfo = {
      hasAndroidApk: Boolean(data.hasAndroidApk),
    };
    if (typeof data.androidApkUrl === "string" && data.androidApkUrl.trim()) {
      info.androidApkUrl = data.androidApkUrl.trim();
    }
    if (typeof data.apkSha256 === "string" && data.apkSha256.trim()) {
      info.apkSha256 = data.apkSha256.trim();
    }
    if (typeof data.version === "string" && data.version.trim()) {
      info.version = data.version.trim();
    }
    if (isValidRegistrationMode(data.registrationMode)) {
      info.registrationMode = data.registrationMode;
    }
    if (typeof data.registrationOpen === "boolean") {
      info.registrationOpen = data.registrationOpen;
    }
    if (typeof data.requiresInviteCode === "boolean") {
      info.requiresInviteCode = data.requiresInviteCode;
    }
    return info;
  } catch {
    return { hasAndroidApk: false };
  }
}

export async function registerAccount(
  apiBase: string,
  input: RegisterAccountInput,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthResponse> {
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`密码长度不能少于 ${MIN_PASSWORD_LENGTH} 位`);
  }

  const payload: Record<string, string> = {
    username: input.username.trim(),
    password: input.password,
  };
  if (input.displayName && input.displayName.trim()) {
    payload.displayName = input.displayName.trim();
  }
  if (input.inviteCode && input.inviteCode.trim()) {
    payload.inviteCode = input.inviteCode.trim();
  }

  let res: Response;
  try {
    res = await fetchImpl(buildApiUrl(apiBase, "/api/auth/register"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error("无法连接到服务器，请检查网络或服务地址");
  }

  const data = await parseJsonSafe(res);
  if (!res.ok) {
    throw new Error(extractApiError(data, "注册失败，请检查账号信息"));
  }

  const body = data as Record<string, unknown> | null;
  if (!body || typeof body.token !== "string" || !isValidUserProfile(body.user)) {
    throw new Error("服务器返回数据格式异常，请稍后重试");
  }

  return {
    token: body.token,
    user: body.user,
  };
}

export async function loginAccount(
  apiBase: string,
  input: LoginAccountInput,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthResponse> {
  let res: Response;
  try {
    res = await fetchImpl(buildApiUrl(apiBase, "/api/auth/login"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        username: input.username.trim(),
        password: input.password,
      }),
    });
  } catch {
    throw new Error("无法连接到服务器，请检查网络或服务地址");
  }

  const data = await parseJsonSafe(res);
  if (!res.ok) {
    throw new Error(extractApiError(data, "登录失败，请检查账号和密码"));
  }

  const body = data as Record<string, unknown> | null;
  if (!body || typeof body.token !== "string" || !isValidUserProfile(body.user)) {
    throw new Error("服务器返回数据格式异常，请稍后重试");
  }

  return {
    token: body.token,
    user: body.user,
  };
}

export async function logoutAllSessionsApi(
  apiBase: string,
  authToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(buildApiUrl(apiBase, "/api/auth/logout-all"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({}),
    });
  } catch {
    throw new Error("网络异常，退出全部设备失败");
  }

  if (!res.ok) {
    const data = await parseJsonSafe(res);
    throw new Error(extractApiError(data, "退出全部设备失败，请稍后再试"));
  }
}

export async function changePasswordApi(
  apiBase: string,
  authToken: string,
  input: ChangePasswordInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ChangePasswordResponse> {
  if (input.newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`新密码长度不能少于 ${MIN_PASSWORD_LENGTH} 位`);
  }

  let res: Response;
  try {
    res = await fetchImpl(buildApiUrl(apiBase, "/api/auth/change-password"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
      }),
    });
  } catch {
    throw new Error("网络异常，修改密码失败");
  }

  const data = await parseJsonSafe(res);
  if (!res.ok) {
    throw new Error(extractApiError(data, "修改密码失败，请核对当前密码"));
  }

  const body = data as Record<string, unknown> | null;
  if (!body || typeof body.token !== "string" || body.token.length === 0) {
    throw new Error("服务器返回数据格式异常，请稍后重试");
  }

  return {
    ok: true,
    token: body.token,
  };
}

export async function unbindDeviceApi(
  apiBase: string,
  authToken: string,
  deviceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(buildApiUrl(apiBase, "/api/devices/unbind"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ deviceId }),
    });
  } catch {
    throw new Error("网络异常，解绑设备失败");
  }

  if (!res.ok) {
    const data = await parseJsonSafe(res);
    throw new Error(extractApiError(data, "解绑设备失败，请稍后再试"));
  }
}

function isValidSavedAccount(value: unknown): value is SavedAccountSession {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.authToken === "string" &&
    candidate.authToken.length > 0 &&
    isValidUserProfile(candidate.user) &&
    typeof candidate.wsUrl === "string" &&
    typeof candidate.apiBase === "string"
  );
}

export function loadAccountSession(storage?: Storage): SavedAccountSession | null {
  const store = getSafeStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(ACCOUNT_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValidSavedAccount(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveAccountSession(
  session: SavedAccountSession | null,
  storage?: Storage,
): void {
  const store = getSafeStorage(storage);
  if (!store) return;
  try {
    if (session) {
      store.setItem(ACCOUNT_SESSION_STORAGE_KEY, JSON.stringify(session));
    } else {
      store.removeItem(ACCOUNT_SESSION_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota errors
  }
}

export function clearAccountSession(storage?: Storage): void {
  saveAccountSession(null, storage);
}

export function loadSessionPasswords(
  sessionStore?: Storage,
): Record<string, string> {
  const store = getSafeSessionStorage(sessionStore);
  if (!store) return {};
  try {
    const raw = store.getItem(SESSION_PASSWORDS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const cleanCode = sanitizeControlCodeInput(key);
      if (cleanCode.length === 9 && typeof value === "string" && value.length > 0) {
        result[cleanCode] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function saveSessionPasswordsMap(
  passwords: Record<string, string>,
  sessionStore?: Storage,
): void {
  const store = getSafeSessionStorage(sessionStore);
  if (!store) return;
  try {
    const entries = Object.entries(passwords).filter(
      ([code, pwd]) => sanitizeControlCodeInput(code).length === 9 && pwd.length > 0,
    );
    if (entries.length === 0) {
      store.removeItem(SESSION_PASSWORDS_STORAGE_KEY);
    } else {
      const cleanMap: Record<string, string> = {};
      for (const [code, pwd] of entries) {
        cleanMap[sanitizeControlCodeInput(code)] = pwd;
      }
      store.setItem(SESSION_PASSWORDS_STORAGE_KEY, JSON.stringify(cleanMap));
    }
  } catch {
    // Ignore storage quota errors
  }
}

export function clearSessionPasswords(sessionStore?: Storage): void {
  const store = getSafeSessionStorage(sessionStore);
  if (!store) return;
  try {
    store.removeItem(SESSION_PASSWORDS_STORAGE_KEY);
  } catch {
    // Ignore
  }
}

function isValidRecentCode(value: unknown): value is RecentControlCode {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.controlCode === "string" &&
    /^\d{9}$/.test(normalizeControlCode(candidate.controlCode)) &&
    typeof candidate.lastUsedAt === "number" &&
    (candidate.controlPassword === undefined ||
      typeof candidate.controlPassword === "string") &&
    (candidate.deviceName === undefined || typeof candidate.deviceName === "string")
  );
}

export function loadRecentCodes(
  storage?: Storage,
  sessionStore?: Storage,
): RecentControlCode[] {
  const store = getSafeStorage(storage);
  if (!store) return [];
  try {
    const raw = store.getItem(RECENT_CODES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const persistedClean: PersistedRecentControlCode[] = [];
    let hadLegacyPasswords = false;

    for (const item of parsed) {
      if (!isValidRecentCode(item)) continue;
      if ("controlPassword" in item && item.controlPassword !== undefined) {
        hadLegacyPasswords = true;
      }
      const clean = normalizeControlCode(item.controlCode);
      if (seen.has(clean)) continue;
      seen.add(clean);
      const entry: PersistedRecentControlCode = {
        controlCode: clean,
        lastUsedAt: item.lastUsedAt,
      };
      if (item.deviceName) {
        entry.deviceName = item.deviceName;
      }
      persistedClean.push(entry);
      if (persistedClean.length >= MAX_RECENT_CODES) break;
    }

    // Purge any legacy plaintext controlPassword fields persisted in localStorage
    if (hadLegacyPasswords) {
      try {
        store.setItem(RECENT_CODES_STORAGE_KEY, JSON.stringify(persistedClean));
      } catch {
        // Ignore storage write errors
      }
    }

    // Hydrate optional per-session passwords from sessionStorage only
    const sessionPasswords = loadSessionPasswords(sessionStore);
    return persistedClean.map((entry) => {
      const sessionPwd = sessionPasswords[entry.controlCode];
      return sessionPwd
        ? { ...entry, controlPassword: sessionPwd }
        : { ...entry };
    });
  } catch {
    return [];
  }
}

export function saveRecentCodes(
  codes: RecentControlCode[],
  storage?: Storage,
  sessionStore?: Storage,
): void {
  const store = getSafeStorage(storage);
  const capped = codes.slice(0, MAX_RECENT_CODES);

  // Strip controlPassword before writing to localStorage (only persist metadata)
  const sanitizedForLocal: PersistedRecentControlCode[] = [];
  const sessionPasswords: Record<string, string> = {};

  for (const item of capped) {
    const cleanCode = sanitizeControlCodeInput(item.controlCode);
    if (cleanCode.length !== 9) continue;
    const entry: PersistedRecentControlCode = {
      controlCode: cleanCode,
      lastUsedAt: item.lastUsedAt,
    };
    if (item.deviceName) {
      entry.deviceName = item.deviceName;
    }
    sanitizedForLocal.push(entry);

    if (item.controlPassword && item.controlPassword.length > 0) {
      sessionPasswords[cleanCode] = item.controlPassword;
    }
  }

  if (store) {
    try {
      store.setItem(RECENT_CODES_STORAGE_KEY, JSON.stringify(sanitizedForLocal));
    } catch {
      // Ignore storage quota errors
    }
  }

  saveSessionPasswordsMap(sessionPasswords, sessionStore);
}

export interface UpsertRecentCodeInput {
  controlCode: string;
  controlPassword?: string;
  deviceName?: string;
  rememberPassword?: boolean;
  lastUsedAt?: number;
}

export function upsertRecentCode(
  codes: RecentControlCode[],
  input: UpsertRecentCodeInput,
): RecentControlCode[] {
  const cleanCode = sanitizeControlCodeInput(input.controlCode);
  if (cleanCode.length !== 9) {
    return codes;
  }

  const existing = codes.find(
    (item) => sanitizeControlCodeInput(item.controlCode) === cleanCode,
  );
  const rest = codes.filter(
    (item) => sanitizeControlCodeInput(item.controlCode) !== cleanCode,
  );

  const nextEntry: RecentControlCode = {
    controlCode: cleanCode,
    lastUsedAt: input.lastUsedAt ?? Date.now(),
  };

  if (input.rememberPassword === false) {
    // Explicitly omit saved password when user unchecks "remember password"
  } else if (input.controlPassword !== undefined) {
    if (input.controlPassword.length > 0) {
      nextEntry.controlPassword = input.controlPassword;
    }
  } else if (existing?.controlPassword) {
    nextEntry.controlPassword = existing.controlPassword;
  }

  const resolvedName = input.deviceName?.trim() || existing?.deviceName;
  if (resolvedName) {
    nextEntry.deviceName = resolvedName;
  }

  return [nextEntry, ...rest].slice(0, MAX_RECENT_CODES);
}

export function saveRecentCodeEntry(
  input: UpsertRecentCodeInput,
  storage?: Storage,
  sessionStore?: Storage,
): RecentControlCode[] {
  const current = loadRecentCodes(storage, sessionStore);
  const next = upsertRecentCode(current, input);
  saveRecentCodes(next, storage, sessionStore);
  return next;
}

export const saveRecentControlCode = saveRecentCodeEntry;

export function updateRecentCodeDeviceName(
  controlCode: string,
  deviceName: string,
  storage?: Storage,
  sessionStore?: Storage,
): RecentControlCode[] {
  const cleanCode = sanitizeControlCodeInput(controlCode);
  const trimmedName = deviceName.trim();
  const current = loadRecentCodes(storage, sessionStore);
  if (cleanCode.length !== 9 || !trimmedName) {
    return current;
  }

  const exists = current.some(
    (item) => sanitizeControlCodeInput(item.controlCode) === cleanCode,
  );
  if (!exists) {
    return current;
  }

  const next = current.map((item) =>
    sanitizeControlCodeInput(item.controlCode) === cleanCode
      ? { ...item, deviceName: trimmedName }
      : item,
  );
  saveRecentCodes(next, storage, sessionStore);
  return next;
}

export function removeRecentCode(
  codes: RecentControlCode[],
  controlCode: string,
): RecentControlCode[] {
  const cleanCode = sanitizeControlCodeInput(controlCode);
  return codes.filter(
    (item) => sanitizeControlCodeInput(item.controlCode) !== cleanCode,
  );
}

export function deleteRecentCodeEntry(
  controlCode: string,
  storage?: Storage,
  sessionStore?: Storage,
): RecentControlCode[] {
  const current = loadRecentCodes(storage, sessionStore);
  const next = removeRecentCode(current, controlCode);
  saveRecentCodes(next, storage, sessionStore);
  return next;
}

export function shouldShowIosPwaBanner(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  try {
    if (window.localStorage.getItem(IOS_PWA_BANNER_DISMISSED_KEY) === "1") {
      return false;
    }
  } catch {
    // Ignore
  }

  const ua = navigator.userAgent || "";
  const isIos = /iPhone|iPad|iPod/i.test(ua);
  const isSafari = /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
  const isStandalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.("(display-mode: standalone)")?.matches === true;

  return isIos && isSafari && !isStandalone;
}

export function dismissIosPwaBanner(): void {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(IOS_PWA_BANNER_DISMISSED_KEY, "1");
    }
  } catch {
    // Ignore
  }
}
