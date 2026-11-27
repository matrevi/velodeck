// Pure-JS FIPS 180-4 SHA-256 implementation with WebCrypto fast-path.
// Required because production may run on plain HTTP where `crypto.subtle` is undefined.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function toHex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

const ASYNC_YIELD_CHUNK_BYTES = 2 * 1024 * 1024; // 2 MiB (exact multiple of 64-byte SHA-256 block)

interface Sha256Context {
  h0: number;
  h1: number;
  h2: number;
  h3: number;
  h4: number;
  h5: number;
  h6: number;
  h7: number;
  w: Uint32Array;
}

function createSha256Context(): Sha256Context {
  return {
    h0: 0x6a09e667,
    h1: 0xbb67ae85,
    h2: 0x3c6ef372,
    h3: 0xa54ff53a,
    h4: 0x510e527f,
    h5: 0x9b05688c,
    h6: 0x1f83d9ab,
    h7: 0x5be0cd19,
    w: new Uint32Array(64),
  };
}

function processBlock(ctx: Sha256Context, buf: Uint8Array, offset: number): void {
  const { w } = ctx;
  for (let i = 0; i < 16; i++) {
    const j = offset + i * 4;
    w[i] =
      ((buf[j]! << 24) |
        (buf[j + 1]! << 16) |
        (buf[j + 2]! << 8) |
        buf[j + 3]!) >>>
      0;
  }

  for (let i = 16; i < 64; i++) {
    const w15 = w[i - 15]!;
    const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
    const w2 = w[i - 2]!;
    const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
    w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
  }

  let a = ctx.h0;
  let b = ctx.h1;
  let c = ctx.h2;
  let d = ctx.h3;
  let e = ctx.h4;
  let f = ctx.h5;
  let g = ctx.h6;
  let h = ctx.h7;

  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const temp1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const temp2 = (S0 + maj) >>> 0;

    h = g;
    g = f;
    f = e;
    e = (d + temp1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) >>> 0;
  }

  ctx.h0 = (ctx.h0 + a) >>> 0;
  ctx.h1 = (ctx.h1 + b) >>> 0;
  ctx.h2 = (ctx.h2 + c) >>> 0;
  ctx.h3 = (ctx.h3 + d) >>> 0;
  ctx.h4 = (ctx.h4 + e) >>> 0;
  ctx.h5 = (ctx.h5 + f) >>> 0;
  ctx.h6 = (ctx.h6 + g) >>> 0;
  ctx.h7 = (ctx.h7 + h) >>> 0;
}

function finalizeSha256(ctx: Sha256Context, data: Uint8Array, fullLen: number): string {
  const len = data.byteLength;
  // Final padded 1 or 2 blocks (64 or 128 bytes)
  const rem = len - fullLen;
  const finalSize = rem < 56 ? 64 : 128;
  const finalBuf = new Uint8Array(finalSize);
  if (rem > 0) {
    finalBuf.set(data.subarray(fullLen, len), 0);
  }
  finalBuf[rem] = 0x80;

  // 64-bit big-endian bit length (exact up to 2^53 bits)
  const bitLenHi = Math.floor(len / 0x20000000) >>> 0;
  const bitLenLo = (len << 3) >>> 0;
  const lenPos = finalSize - 8;
  finalBuf[lenPos] = (bitLenHi >>> 24) & 0xff;
  finalBuf[lenPos + 1] = (bitLenHi >>> 16) & 0xff;
  finalBuf[lenPos + 2] = (bitLenHi >>> 8) & 0xff;
  finalBuf[lenPos + 3] = bitLenHi & 0xff;
  finalBuf[lenPos + 4] = (bitLenLo >>> 24) & 0xff;
  finalBuf[lenPos + 5] = (bitLenLo >>> 16) & 0xff;
  finalBuf[lenPos + 6] = (bitLenLo >>> 8) & 0xff;
  finalBuf[lenPos + 7] = bitLenLo & 0xff;

  processBlock(ctx, finalBuf, 0);
  if (finalSize === 128) {
    processBlock(ctx, finalBuf, 64);
  }

  return (
    toHex8(ctx.h0) +
    toHex8(ctx.h1) +
    toHex8(ctx.h2) +
    toHex8(ctx.h3) +
    toHex8(ctx.h4) +
    toHex8(ctx.h5) +
    toHex8(ctx.h6) +
    toHex8(ctx.h7)
  );
}

/**
 * Synchronous, zero-dependency pure-JS SHA-256 returning lowercase 64-char hex.
 * Streams 64-byte blocks directly from the input Uint8Array (O(1) extra memory).
 */
export function sha256HexSync(data: Uint8Array): string {
  const ctx = createSha256Context();
  const len = data.byteLength;
  const fullLen = len - (len % 64);
  for (let offset = 0; offset < fullLen; offset += 64) {
    processBlock(ctx, data, offset);
  }
  return finalizeSha256(ctx, data, fullLen);
}

async function sha256HexAsync(data: Uint8Array): Promise<string> {
  const ctx = createSha256Context();
  const len = data.byteLength;
  const fullLen = len - (len % 64);
  for (let chunkStart = 0; chunkStart < fullLen; chunkStart += ASYNC_YIELD_CHUNK_BYTES) {
    const chunkEnd = Math.min(chunkStart + ASYNC_YIELD_CHUNK_BYTES, fullLen);
    for (let offset = chunkStart; offset < chunkEnd; offset += 64) {
      processBlock(ctx, data, offset);
    }
    if (chunkEnd < fullLen) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  return finalizeSha256(ctx, data, fullLen);
}

/**
 * Computes lowercase 64-char SHA-256 hex digest.
 * Uses hardware-accelerated `crypto.subtle.digest` when available (HTTPS / localhost),
 * and seamlessly falls back to chunk-yielding pure-JS SHA-256 on plain HTTP so large
 * files never freeze video rendering or touch input.
 */
export async function computeSha256Hex(data: Uint8Array): Promise<string> {
  if (
    typeof crypto !== "undefined" &&
    crypto.subtle &&
    typeof crypto.subtle.digest === "function"
  ) {
    try {
      const digestInput: BufferSource =
        data.buffer instanceof ArrayBuffer
          ? (data as Uint8Array<ArrayBuffer>)
          : data.slice();
      const digest = await crypto.subtle.digest("SHA-256", digestInput);
      return bytesToHex(new Uint8Array(digest));
    } catch {
      // Fall through to pure-JS implementation
    }
  }
  return sha256HexAsync(data);
}
