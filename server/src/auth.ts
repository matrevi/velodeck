import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const LEGACY_SCRYPT_N = 16_384;
const MAX_CONCURRENT_SCRYPT = 4;

export const DEFAULT_JWT_TTL_SEC = 14 * 86_400; // 14 days

// Static precomputed dummy parameters for constant-time verification when an account/device does not exist.
const DUMMY_SALT_BUF = Buffer.from("a1b2c3d4e5f60718293a4b5c6d7e8f90", "hex");
const DUMMY_KEY_BUF = Buffer.alloc(SCRYPT_KEY_LENGTH, 0x5a);

export class AsyncSemaphore {
  private active = 0;
  private readonly maxConcurrent: number;
  private readonly waiters: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError("maxConcurrent must be a positive integer");
    }
    this.maxConcurrent = maxConcurrent;
  }

  public async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    // Permit was transferred directly from release() without decrementing `active`.
  }

  public release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Direct permit transfer prevents a newly arriving caller from overtaking a queued waiter and overshooting maxConcurrent.
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

const scryptSemaphore = new AsyncSemaphore(MAX_CONCURRENT_SCRYPT);

async function deriveScryptKey(
  password: string,
  salt: string | Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
): Promise<Buffer> {
  await scryptSemaphore.acquire();
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(password, salt, keylen, options, (err, derivedKey) => {
        if (err) {
          reject(err);
        } else {
          resolve(derivedKey);
        }
      });
    });
  } finally {
    scryptSemaphore.release();
  }
}

export interface AuthJwtInput {
  sub: string;
  username: string;
  tv: number;
  [key: string]: unknown;
}

export interface AuthJwtClaims extends AuthJwtInput {
  iat: number;
  exp: number;
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function timingSafeEqualHex(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length || aHex.length === 0 || aHex.length % 2 !== 0) {
    return false;
  }
  try {
    const a = Buffer.from(aHex, "hex");
    const b = Buffer.from(bHex, "hex");
    if (a.byteLength !== b.byteLength || a.byteLength === 0) {
      return false;
    }
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function timingSafeEqualString(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0) {
    return false;
  }
  const digestA = crypto.createHash("sha256").update(a, "utf8").digest();
  const digestB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

export async function hashPassword(password: string): Promise<string> {
  const saltBuf = crypto.randomBytes(16);
  const saltHex = saltBuf.toString("hex");
  const derived = await deriveScryptKey(password, saltBuf, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${saltHex}$${derived.toString("hex")}`;
}

export function isLegacyPasswordHash(storedHash: string): boolean {
  return !storedHash.startsWith("scrypt$") && storedHash.includes(":");
}

async function runDummyScrypt(password: string): Promise<void> {
  try {
    const derived = await deriveScryptKey(password, DUMMY_SALT_BUF, SCRYPT_KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    });
    if (derived.byteLength === DUMMY_KEY_BUF.byteLength) {
      crypto.timingSafeEqual(derived, DUMMY_KEY_BUF);
    }
  } catch {
    // Ignore errors during dummy timing equalization.
  }
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (typeof password !== "string" || typeof storedHash !== "string" || storedHash.length === 0) {
    return false;
  }

  // Versioned format: scrypt$<N>$<r>$<p>$<saltHex>$<keyHex>
  if (storedHash.startsWith("scrypt$")) {
    const parts = storedHash.split("$");
    if (parts.length !== 6) {
      return false;
    }
    const [, nStr, rStr, pStr, saltHex, keyHex] = parts;
    const N = Number.parseInt(nStr ?? "", 10);
    const r = Number.parseInt(rStr ?? "", 10);
    const p = Number.parseInt(pStr ?? "", 10);
    if (
      !Number.isInteger(N) ||
      !Number.isInteger(r) ||
      !Number.isInteger(p) ||
      N < 1024 ||
      N > 65_536 ||
      (N & (N - 1)) !== 0 ||
      r < 1 ||
      r > 16 ||
      p < 1 ||
      p > 4 ||
      128 * N * r * p > SCRYPT_MAXMEM
    ) {
      return false;
    }
    if (!saltHex || !keyHex || saltHex.length % 2 !== 0 || keyHex.length % 2 !== 0) {
      return false;
    }
    try {
      const saltBuf = Buffer.from(saltHex, "hex");
      const expected = Buffer.from(keyHex, "hex");
      if (saltBuf.byteLength < 8 || expected.byteLength !== SCRYPT_KEY_LENGTH) {
        return false;
      }
      const derived = await deriveScryptKey(password, saltBuf, expected.byteLength, {
        N,
        r,
        p,
        maxmem: SCRYPT_MAXMEM,
      });
      if (derived.byteLength !== expected.byteLength) {
        return false;
      }
      return crypto.timingSafeEqual(derived, expected);
    } catch {
      return false;
    }
  }

  // Legacy format: <saltHex>:<keyHex> (derived with Node default N=16384, r=8, p=1 and string salt)
  const parts = storedHash.split(":");
  if (parts.length !== 2) {
    return false;
  }
  const [saltHex, keyHex] = parts;
  if (!saltHex || !keyHex || keyHex.length % 2 !== 0) {
    return false;
  }
  try {
    const expected = Buffer.from(keyHex, "hex");
    if (expected.byteLength !== SCRYPT_KEY_LENGTH) {
      return false;
    }
    const derived = await deriveScryptKey(password, saltHex, expected.byteLength, {
      N: LEGACY_SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    });
    if (derived.byteLength !== expected.byteLength) {
      return false;
    }
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export async function verifyPasswordConstantTime(
  password: string,
  storedHash: string | null | undefined,
): Promise<boolean> {
  const safePassword = typeof password === "string" ? password : "";
  if (typeof storedHash !== "string" || storedHash.length === 0) {
    await runDummyScrypt(safePassword);
    return false;
  }
  const ok = await verifyPassword(safePassword, storedHash);
  if (!ok && !storedHash.startsWith("scrypt$") && !storedHash.includes(":")) {
    await runDummyScrypt(safePassword);
  }
  return ok;
}

function encodeBase64UrlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

function decodeBase64UrlJson(segment: string): unknown {
  const raw = Buffer.from(segment, "base64url").toString("utf8");
  return JSON.parse(raw);
}

export function signJwt(
  payload: AuthJwtInput,
  secret: string,
  ttlSec: number = DEFAULT_JWT_TTL_SEC,
): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const claims: AuthJwtClaims = {
    ...payload,
    tv: Number.isInteger(payload.tv) && payload.tv >= 1 ? payload.tv : 1,
    iat: nowSec,
    exp: nowSec + ttlSec,
  };
  const headerB64 = encodeBase64UrlJson({ alg: "HS256", typ: "JWT" });
  const bodyB64 = encodeBase64UrlJson(claims);
  const signingInput = `${headerB64}.${bodyB64}`;
  const sigB64 = crypto
    .createHmac("sha256", secret)
    .update(signingInput, "utf8")
    .digest("base64url");
  return `${signingInput}.${sigB64}`;
}

export function verifyJwt(token: string, secret: string): AuthJwtClaims | null {
  if (typeof token !== "string" || typeof secret !== "string" || secret.length === 0) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [headerB64, bodyB64, sigB64] = parts;
  if (!headerB64 || !bodyB64 || !sigB64) {
    return null;
  }

  try {
    const header = decodeBase64UrlJson(headerB64);
    if (
      typeof header !== "object" ||
      header === null ||
      (header as { alg?: unknown }).alg !== "HS256"
    ) {
      return null;
    }

    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(`${headerB64}.${bodyB64}`, "utf8")
      .digest();
    const providedSig = Buffer.from(sigB64, "base64url");

    if (
      providedSig.byteLength !== expectedSig.byteLength ||
      !crypto.timingSafeEqual(providedSig, expectedSig)
    ) {
      return null;
    }
    // Reject non-canonical base64url encodings
    if (providedSig.toString("base64url") !== sigB64) {
      return null;
    }

    const payload = decodeBase64UrlJson(bodyB64);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return null;
    }

    const claims = payload as Record<string, unknown>;
    if (
      typeof claims.sub !== "string" ||
      claims.sub.length === 0 ||
      typeof claims.username !== "string" ||
      claims.username.length === 0 ||
      typeof claims.tv !== "number" ||
      !Number.isInteger(claims.tv) ||
      claims.tv < 1 ||
      typeof claims.exp !== "number" ||
      !Number.isFinite(claims.exp)
    ) {
      return null;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (claims.exp <= nowSec) {
      return null;
    }

    return claims as AuthJwtClaims;
  } catch {
    return null;
  }
}

export function ensurePrivateDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    // Ignore chmod failures on filesystems that do not support POSIX permissions.
  }
}

export function loadOrCreateJwtSecret(dataDir: string, envSecret?: string): string {
  if (envSecret && envSecret.trim().length > 0) {
    if (dataDir !== ":memory:") {
      ensurePrivateDir(dataDir);
    }
    return envSecret.trim();
  }
  if (dataDir === ":memory:") {
    return crypto.randomBytes(32).toString("hex");
  }

  ensurePrivateDir(dataDir);
  const secretPath = path.join(dataDir, "jwt.secret");

  try {
    const existing = fs.readFileSync(secretPath, "utf8").trim();
    if (existing.length > 0) {
      try {
        fs.chmodSync(secretPath, 0o600);
      } catch {
        // Best-effort tighten permissions on existing secret file.
      }
      return existing;
    }
  } catch {
    // Secret file does not exist yet; create it below.
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(secretPath, `${generated}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.chmodSync(secretPath, 0o600);
    return generated;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST") {
      const existing = fs.readFileSync(secretPath, "utf8").trim();
      if (existing.length > 0) {
        try {
          fs.chmodSync(secretPath, 0o600);
        } catch {
          // Best-effort tighten permissions.
        }
        return existing;
      }
      // File existed but was empty; atomically replace it.
      const tmpPath = `${secretPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
      fs.writeFileSync(tmpPath, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(tmpPath, 0o600);
      fs.renameSync(tmpPath, secretPath);
      return generated;
    }
    throw err;
  }
}
