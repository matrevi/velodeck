import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeSha256Hex, sha256HexSync } from "./sha256";

function encodeUtf8(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

describe("sha256 utility", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("matches NIST FIPS 180-4 test vectors (empty, abc, 56-byte boundary, multi-block)", async () => {
    const vectors: Array<[string, string]> = [
      ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
      [
        "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
      ],
      [
        "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
        "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
      ],
    ];

    for (const [input, expected] of vectors) {
      const bytes = encodeUtf8(input);
      expect(sha256HexSync(bytes)).toBe(expected);
      await expect(computeSha256Hex(bytes)).resolves.toBe(expected);
    }
  });

  it("matches Node crypto for a 100 KB binary buffer and subarray slices", async () => {
    const buf = new Uint8Array(100 * 1024);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = (i * 31 + (i >> 3) + 17) & 0xff;
    }

    const expectedFull = createHash("sha256").update(buf).digest("hex");
    expect(sha256HexSync(buf)).toBe(expectedFull);
    await expect(computeSha256Hex(buf)).resolves.toBe(expectedFull);

    // Non-zero byteOffset subarray view (exact 64-byte and 55-byte boundary checks)
    const sub = buf.subarray(13, 13 + 64 * 10 + 55);
    const expectedSub = createHash("sha256").update(sub).digest("hex");
    expect(sha256HexSync(sub)).toBe(expectedSub);
    await expect(computeSha256Hex(sub)).resolves.toBe(expectedSub);
  });

  it("falls back cleanly to pure-JS SHA-256 when crypto.subtle is unavailable (plain HTTP)", async () => {
    vi.stubGlobal("crypto", {});
    const bytes = encodeUtf8("plain-http-fallback-check");
    const expected = createHash("sha256").update(bytes).digest("hex");
    await expect(computeSha256Hex(bytes)).resolves.toBe(expected);
  });
});
