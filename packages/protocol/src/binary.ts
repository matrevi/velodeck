export const FRAME_MAGIC = 0x4d; // 'M'
export const FRAME_TYPE_JPEG = 0x01;
export const FRAME_TYPE_H264 = 0x02;
export const FRAME_FLAG_KEYFRAME = 0x01;
export const FRAME_HEADER_FIXED_SIZE = 20;

export type MediaFrameType = typeof FRAME_TYPE_JPEG | typeof FRAME_TYPE_H264;

export interface MediaFrame {
  frameType: MediaFrameType;
  width: number;
  height: number;
  rotation: 0 | 1 | 2 | 3;
  keyframe: boolean;
  timestampMs: number;
  sessionId: string;
  payload: Uint8Array;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toUint8Array(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

/**
 * Encodes a binary media frame:
 * [0]      magic = 0x4D ('M')
 * [1]      frameType (1 = JPEG, 2 = H264)
 * [2..3]   width (uint16 BE)
 * [4..5]   height (uint16 BE)
 * [6]      rotation (0..3)
 * [7]      flags (bit 0 = keyframe)
 * [8..15]  timestampMs (uint64 BE via hi/lo uint32)
 * [16..19] sessionId byte length L (uint32 BE)
 * [20..20+L-1] sessionId UTF-8 bytes
 * [20+L..end]  payload bytes
 */
export function encodeMediaFrame(frame: MediaFrame): Uint8Array {
  const sessionBytes = frame.sessionId ? textEncoder.encode(frame.sessionId) : new Uint8Array(0);
  if (sessionBytes.byteLength > 256) {
    throw new Error(`sessionId exceeds max 256 UTF-8 bytes: ${sessionBytes.byteLength}`);
  }
  const totalLen = FRAME_HEADER_FIXED_SIZE + sessionBytes.byteLength + frame.payload.byteLength;
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  out[0] = FRAME_MAGIC;
  out[1] = frame.frameType;
  view.setUint16(2, frame.width & 0xffff, false);
  view.setUint16(4, frame.height & 0xffff, false);
  out[6] = frame.rotation & 0x03;
  out[7] = frame.keyframe ? FRAME_FLAG_KEYFRAME : 0;

  const ts = Math.max(0, Math.floor(frame.timestampMs));
  const hi = Math.floor(ts / 0x100000000);
  const lo = ts >>> 0;
  view.setUint32(8, hi >>> 0, false);
  view.setUint32(12, lo, false);

  view.setUint32(16, sessionBytes.byteLength, false);
  if (sessionBytes.byteLength > 0) {
    out.set(sessionBytes, FRAME_HEADER_FIXED_SIZE);
  }
  out.set(frame.payload, FRAME_HEADER_FIXED_SIZE + sessionBytes.byteLength);
  return out;
}

export function decodeMediaFrame(input: Uint8Array | ArrayBuffer): MediaFrame {
  const bytes = toUint8Array(input);
  if (bytes.byteLength < FRAME_HEADER_FIXED_SIZE) {
    throw new Error(`Media frame too short: ${bytes.byteLength} bytes`);
  }
  if (bytes[0] !== FRAME_MAGIC) {
    throw new Error(`Invalid media frame magic: 0x${bytes[0]?.toString(16)}`);
  }

  const rawType = bytes[1];
  if (rawType !== FRAME_TYPE_JPEG && rawType !== FRAME_TYPE_H264) {
    throw new Error(`Unsupported media frame type: ${rawType}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(2, false);
  const height = view.getUint16(4, false);
  const rotation = ((bytes[6] ?? 0) & 0x03) as 0 | 1 | 2 | 3;
  const keyframe = ((bytes[7] ?? 0) & FRAME_FLAG_KEYFRAME) !== 0;
  const hi = view.getUint32(8, false);
  const lo = view.getUint32(12, false);
  const timestampMs = hi * 0x100000000 + lo;

  const sessionLen = view.getUint32(16, false);
  const payloadOffset = FRAME_HEADER_FIXED_SIZE + sessionLen;
  if (sessionLen > 256 || payloadOffset > bytes.byteLength) {
    throw new Error(`Invalid sessionId length ${sessionLen} for frame of ${bytes.byteLength} bytes`);
  }

  const sessionId =
    sessionLen > 0 ? textDecoder.decode(bytes.subarray(FRAME_HEADER_FIXED_SIZE, payloadOffset)) : "";
  const payload = bytes.subarray(payloadOffset);

  return {
    frameType: rawType,
    width,
    height,
    rotation,
    keyframe,
    timestampMs,
    sessionId,
    payload,
  };
}

/**
 * Fast header-only inspection for the relay server to route binary frames by sessionId.
 */
export function peekMediaFrameSessionId(input: Uint8Array | ArrayBuffer): string | null {
  const bytes = toUint8Array(input);
  if (bytes.byteLength < FRAME_HEADER_FIXED_SIZE || bytes[0] !== FRAME_MAGIC) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sessionLen = view.getUint32(16, false);
  if (sessionLen === 0 || sessionLen > 256 || FRAME_HEADER_FIXED_SIZE + sessionLen > bytes.byteLength) {
    return null;
  }
  return textDecoder.decode(bytes.subarray(FRAME_HEADER_FIXED_SIZE, FRAME_HEADER_FIXED_SIZE + sessionLen));
}
