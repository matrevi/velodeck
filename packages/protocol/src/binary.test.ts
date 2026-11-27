import assert from "node:assert/strict";
import test from "node:test";
import {
  FRAME_TYPE_H264,
  FRAME_TYPE_JPEG,
  decodeMediaFrame,
  encodeMediaFrame,
  peekMediaFrameSessionId,
} from "./binary.js";

test("encodeMediaFrame and decodeMediaFrame round-trip with sessionId", () => {
  const payload = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const ts = 1795651200123;
  const encoded = encodeMediaFrame({
    frameType: FRAME_TYPE_JPEG,
    width: 720,
    height: 1600,
    rotation: 1,
    keyframe: true,
    timestampMs: ts,
    sessionId: "sess_abc123",
    payload,
  });

  assert.equal(peekMediaFrameSessionId(encoded), "sess_abc123");

  const decoded = decodeMediaFrame(encoded);
  assert.equal(decoded.frameType, FRAME_TYPE_JPEG);
  assert.equal(decoded.width, 720);
  assert.equal(decoded.height, 1600);
  assert.equal(decoded.rotation, 1);
  assert.equal(decoded.keyframe, true);
  assert.equal(decoded.timestampMs, ts);
  assert.equal(decoded.sessionId, "sess_abc123");
  assert.deepEqual(Array.from(decoded.payload), Array.from(payload));
});

test("encodeMediaFrame and decodeMediaFrame round-trip in direct mode (empty sessionId)", () => {
  const payload = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]);
  const encoded = encodeMediaFrame({
    frameType: FRAME_TYPE_H264,
    width: 1080,
    height: 2400,
    rotation: 0,
    keyframe: false,
    timestampMs: 42,
    sessionId: "",
    payload,
  });

  assert.equal(peekMediaFrameSessionId(encoded), null);

  const decoded = decodeMediaFrame(encoded);
  assert.equal(decoded.frameType, FRAME_TYPE_H264);
  assert.equal(decoded.sessionId, "");
  assert.equal(decoded.keyframe, false);
  assert.deepEqual(Array.from(decoded.payload), Array.from(payload));
});

test("decodeMediaFrame rejects malformed magic or truncated buffer", () => {
  assert.throws(() => decodeMediaFrame(new Uint8Array([0x00, 0x01])), /too short/);
  const badMagic = new Uint8Array(24);
  badMagic[0] = 0x99;
  assert.throws(() => decodeMediaFrame(badMagic), /Invalid media frame magic/);
  assert.equal(peekMediaFrameSessionId(badMagic), null);
});
