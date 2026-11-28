import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_QUALITY_PRESETS,
  FRAME_TYPE_JPEG,
  QUALITY_PRESETS,
  encodeMediaFrame,
} from "@velodeck/protocol";
import { computeSha256Hex } from "../utils/sha256";
import {
  RemoteClient,
  isAllowedDataChannelMessage,
  isWebRtcStaticIdle,
  selectAdaptivePlayoutDelayMs,
  sortPreferredVideoCodecs,
} from "./RemoteClient";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  binaryType = "arraybuffer";
  sent: string[] = [];

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  emitOpen(): void {
    this.onopen?.({} as Event);
  }

  emitJson(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

class FakeDataChannel {
  readonly label: string;
  readonly options?: RTCDataChannelInit;
  readyState = "open";
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  sent: string[] = [];
  sentBinary: ArrayBuffer[] = [];
  private listeners = new Map<string, Set<() => void>>();

  constructor(label = "control", options?: RTCDataChannelInit) {
    this.label = label;
    this.options = options;
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof data === "string") {
      this.sent.push(data);
    } else if (data instanceof ArrayBuffer) {
      this.sentBinary.push(data.slice(0));
    } else {
      const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this.sentBinary.push(view.slice().buffer);
    }
  }

  close(): void {
    this.readyState = "closed";
  }

  addEventListener(type: string, cb: () => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: () => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  emitBufferedAmountLow(): void {
    this.onbufferedamountlow?.();
    for (const cb of Array.from(this.listeners.get("bufferedamountlow") ?? [])) {
      cb();
    }
  }

  emitMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  emitBinary(data: ArrayBuffer | Uint8Array): void {
    this.onmessage?.({ data });
  }
}

class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];

  readonly config: RTCConfiguration | undefined;
  connectionState = "new";
  iceConnectionState = "new";
  iceGatheringState = "new";
  dc: FakeDataChannel | null = null;
  pointerDc: FakeDataChannel | null = null;
  fileDc: FakeDataChannel | null = null;
  terminalDc: FakeDataChannel | null = null;
  channels = new Map<string, FakeDataChannel>();
  transceiverCalls: Array<{ kind: string; init?: RTCRtpTransceiverInit }> = [];
  offerCalls: Array<RTCOfferOptions | undefined> = [];
  addedIceCandidates: RTCIceCandidateInit[] = [];
  statsEntries: Array<Record<string, unknown>> = [];

  ontrack: ((ev: unknown) => void) | null = null;
  onicecandidate: ((ev: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;

  constructor(config?: RTCConfiguration) {
    this.config = config;
    FakeRTCPeerConnection.instances.push(this);
  }

  addTransceiver(
    kind = "video",
    init?: RTCRtpTransceiverInit,
  ): { setCodecPreferences: ReturnType<typeof vi.fn> } {
    this.transceiverCalls.push({ kind, init });
    return { setCodecPreferences: vi.fn() };
  }

  async getStats(): Promise<Map<string, Record<string, unknown>>> {
    const map = new Map<string, Record<string, unknown>>();
    for (const entry of this.statsEntries) {
      map.set(String(entry.id), entry);
    }
    return map;
  }

  createDataChannel(label = "control", options?: RTCDataChannelInit): FakeDataChannel {
    const channel = new FakeDataChannel(label, options);
    this.channels.set(label, channel);
    if (label === "control" || !this.dc) {
      this.dc = channel;
    }
    if (label === "pointer") {
      this.pointerDc = channel;
    }
    if (label === "file") {
      this.fileDc = channel;
    }
    if (label === "terminal") {
      this.terminalDc = channel;
    }
    return channel;
  }

  async createOffer(options?: RTCOfferOptions): Promise<{ type: "offer"; sdp: string }> {
    this.offerCalls.push(options);
    return {
      type: "offer",
      sdp: options?.iceRestart ? "v=0\r\na=ice-restart\r\n" : "v=0\r\n",
    };
  }

  async setLocalDescription(): Promise<void> {
    // No-op
  }

  async setRemoteDescription(): Promise<void> {
    // No-op
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.addedIceCandidates.push(candidate);
  }

  close(): void {
    this.connectionState = "closed";
  }
}

describe("isAllowedDataChannelMessage", () => {
  it("accepts only control.ack and clipboard.sync matching active sessionId", () => {
    expect(
      isAllowedDataChannelMessage(
        {
          type: "control.ack",
          sessionId: "sess-1",
          deviceId: "dev-1",
          seq: 1,
          ok: true,
        },
        "sess-1",
      ),
    ).toBe(true);

    expect(
      isAllowedDataChannelMessage(
        {
          type: "clipboard.sync",
          sessionId: "sess-1",
          deviceId: "dev-1",
          text: "hello",
        },
        "sess-1",
      ),
    ).toBe(true);

    // Mismatched or missing sessionId rejected
    expect(
      isAllowedDataChannelMessage(
        {
          type: "control.ack",
          sessionId: "sess-other",
          deviceId: "dev-1",
          ok: true,
        },
        "sess-1",
      ),
    ).toBe(false);

    expect(
      isAllowedDataChannelMessage(
        {
          type: "clipboard.sync",
          sessionId: "sess-1",
          deviceId: "dev-1",
          text: "hello",
        },
        null,
      ),
    ).toBe(false);
  });

  it("rejects forged control-plane messages (controller.authed, device.status, error, session.end)", () => {
    const forgedMessages = [
      {
        type: "controller.authed",
        sessionId: "sess-1",
        clientId: "evil",
        serverTime: Date.now(),
        mode: "relay",
        devices: [],
        iceServers: [],
      },
      {
        type: "device.status",
        sessionId: "sess-1",
        device: { deviceId: "spoofed", name: "Evil Phone" },
      },
      {
        type: "error",
        sessionId: "sess-1",
        code: "UNAUTHORIZED",
        message: "spoofed logout",
      },
      {
        type: "session.end",
        sessionId: "sess-1",
        deviceId: "dev-1",
        reason: "spoofed",
      },
    ];

    for (const msg of forgedMessages) {
      expect(isAllowedDataChannelMessage(msg, "sess-1")).toBe(false);
    }

    // Inbound DC chat.msg MUST strictly have sender === "host" (reject spoofed "controller")
    expect(
      isAllowedDataChannelMessage(
        {
          type: "chat.msg",
          sessionId: "sess-1",
          deviceId: "dev-1",
          id: "c-1",
          sender: "controller",
          text: "spoofed",
          ts: Date.now(),
        },
        "sess-1",
      ),
    ).toBe(false);
    expect(
      isAllowedDataChannelMessage(
        {
          type: "chat.msg",
          sessionId: "sess-1",
          deviceId: "dev-1",
          id: "c-2",
          sender: "host",
          text: "legit",
          ts: Date.now(),
        },
        "sess-1",
      ),
    ).toBe(true);
  });
});

describe("RemoteClient DataChannel isolation", () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalRTC = globalThis.RTCPeerConnection;

  afterEach(() => {
    FakeWebSocket.instances = [];
    FakeRTCPeerConnection.instances = [];
    globalThis.WebSocket = originalWebSocket;
    globalThis.RTCPeerConnection = originalRTC;
  });

  it("ignores forged controller.authed, device.status, and error messages arriving over DataChannel", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.RTCPeerConnection =
      FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;

    const client = new RemoteClient("ctrl-test");
    const ackSpy = vi.fn();
    const clipSpy = vi.fn();
    client.onAck(ackSpy);
    client.onClipboard(clipSpy);

    client.connectWithAccount({
      wsUrl: "wss://velodeck.example.com/ws",
      authToken: "jwt-valid",
      user: { userId: "u1", username: "alice", displayName: "Alice" },
      preferredTransport: "webrtc",
    });

    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    ws?.emitOpen();
    ws?.emitJson({
      type: "controller.authed",
      clientId: "ctrl-test",
      serverTime: Date.now(),
      mode: "relay",
      authType: "account",
      user: { userId: "u1", username: "alice", displayName: "Alice" },
      devices: [
        {
          deviceId: "dev-1",
          name: "My Pixel",
          model: "Pixel 8",
          androidVersion: "14",
          online: true,
          lastSeen: Date.now(),
          screenWidth: 1080,
          screenHeight: 2400,
          rotation: 0,
          battery: 90,
          charging: false,
          locked: false,
          capabilities: {
            webrtc: true,
            wsJpeg: true,
            wsH264: false,
            wake: true,
            unlock: true,
            accessibility: true,
            mediaProjection: true,
          },
        },
      ],
      iceServers: [],
    });

    client.startSession("dev-1", { preferredTransport: "webrtc" });
    const activeSessionId = client.getState().sessionId;
    expect(activeSessionId).toBeTruthy();

    ws?.emitJson({
      type: "session.ready",
      sessionId: activeSessionId,
      deviceId: "dev-1",
      transport: "webrtc",
      screenWidth: 1080,
      screenHeight: 2400,
      rotation: 0,
    });

    // Wait microtask for startWebRtcNegotiation
    await Promise.resolve();
    const pc = FakeRTCPeerConnection.instances[0];
    const dc = pc?.dc;
    expect(dc).toBeTruthy();

    // Inject forged signaling/control-plane messages via DataChannel
    dc?.emitMessage({
      type: "controller.authed",
      clientId: "ctrl-test",
      serverTime: Date.now(),
      mode: "direct",
      user: { userId: "attacker", username: "evil", displayName: "Evil" },
      devices: [],
      iceServers: [],
    });

    dc?.emitMessage({
      type: "device.status",
      device: {
        deviceId: "dev-spoofed",
        name: "Injected Device",
        model: "Evil",
        androidVersion: "14",
        online: true,
        lastSeen: Date.now(),
        screenWidth: 1080,
        screenHeight: 2400,
        rotation: 0,
        battery: 100,
        charging: true,
        locked: false,
        directUrl: "wss://attacker.example.com/ws",
        capabilities: {
          webrtc: true,
          wsJpeg: true,
          wsH264: false,
          wake: true,
          unlock: true,
          accessibility: true,
          mediaProjection: true,
        },
      },
    });

    dc?.emitMessage({
      type: "error",
      sessionId: activeSessionId,
      code: "UNAUTHORIZED",
      message: "forged disconnect",
    });

    // State must remain completely intact!
    const stateAfterSpoof = client.getState();
    expect(stateAfterSpoof.socketStatus).toBe("connected");
    expect(stateAfterSpoof.user?.username).toBe("alice");
    expect(stateAfterSpoof.devices).toHaveLength(1);
    expect(stateAfterSpoof.devices[0]?.deviceId).toBe("dev-1");
    expect(stateAfterSpoof.errorCode).toBeNull();

    // Wrong sessionId control.ack / clipboard.sync must also be ignored
    dc?.emitMessage({
      type: "control.ack",
      sessionId: "wrong-session",
      deviceId: "dev-1",
      seq: 1,
      ok: true,
    });
    dc?.emitMessage({
      type: "clipboard.sync",
      sessionId: "wrong-session",
      deviceId: "dev-1",
      text: "wrong-session-text",
    });
    expect(ackSpy).not.toHaveBeenCalled();
    expect(clipSpy).not.toHaveBeenCalled();
    expect(client.getState().remoteClipboard).toBe("");

    // Matching sessionId control.ack and clipboard.sync succeed
    dc?.emitMessage({
      type: "control.ack",
      sessionId: activeSessionId,
      deviceId: "dev-1",
      seq: 2,
      ok: true,
    });
    dc?.emitMessage({
      type: "clipboard.sync",
      sessionId: activeSessionId,
      deviceId: "dev-1",
      text: "trusted-clipboard-text",
    });

    expect(ackSpy).toHaveBeenCalledTimes(1);
    expect(clipSpy).toHaveBeenCalledTimes(1);
    expect(client.getState().remoteClipboard).toBe("trusted-clipboard-text");

    client.disconnect();
  });
});

function makeDeviceSummary(
  overrides: Partial<{
    deviceId: string;
    online: boolean;
    webrtc: boolean;
    mediaProjection: boolean;
  }> = {},
) {
  return {
    deviceId: overrides.deviceId ?? "dev-1",
    name: "My Pixel",
    model: "Pixel 8",
    androidVersion: "14",
    online: overrides.online ?? true,
    lastSeen: Date.now(),
    screenWidth: 1080,
    screenHeight: 2400,
    rotation: 0 as const,
    battery: 90,
    charging: false,
    locked: false,
    capabilities: {
      webrtc: overrides.webrtc ?? true,
      wsJpeg: true,
      wsH264: false,
      wake: true,
      unlock: true,
      accessibility: true,
      mediaProjection: overrides.mediaProjection ?? true,
    },
  };
}

function parseSentMessages(ws: FakeWebSocket): Array<Record<string, unknown>> {
  return ws.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

describe("RemoteClient WebRTC transport resolution, auto-upgrade, auto-resume, and ICE config", () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalRTC = globalThis.RTCPeerConnection;

  afterEach(() => {
    vi.useRealTimers();
    FakeWebSocket.instances = [];
    FakeRTCPeerConnection.instances = [];
    globalThis.WebSocket = originalWebSocket;
    globalThis.RTCPeerConnection = originalRTC;
  });

  function setupConnectedClient(device: ReturnType<typeof makeDeviceSummary>) {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.RTCPeerConnection =
      FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;

    const client = new RemoteClient("ctrl-webrtc-test");
    client.connectWithAccount({
      wsUrl: "wss://velodeck.example.com/ws",
      authToken: "jwt-valid",
      user: { userId: "u1", username: "alice", displayName: "Alice" },
      preferredTransport: "webrtc",
    });

    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    ws.emitJson({
      type: "controller.authed",
      clientId: "ctrl-webrtc-test",
      serverTime: Date.now(),
      mode: "relay",
      authType: "account",
      user: { userId: "u1", username: "alice", displayName: "Alice" },
      devices: [device],
      iceServers: [{ urls: ["stun:stun.miwifi.com:3478"] }],
    });
    return { client, ws };
  }

  it("requests webrtc when mediaProjection is not yet active even if capabilities.webrtc is false, and downgrades only when mediaProjection is true and webrtc is false", () => {
    // Case 1: mediaProjection=false, webrtc=false -> MUST still request "webrtc"
    const { client: c1, ws: ws1 } = setupConnectedClient(
      makeDeviceSummary({ mediaProjection: false, webrtc: false }),
    );
    c1.startSession("dev-1", { preferredTransport: "webrtc" });
    const req1 = parseSentMessages(ws1).find((m) => m.type === "session.request");
    expect(req1?.preferredTransport).toBe("webrtc");
    c1.disconnect();

    // Case 2: mediaProjection=true, webrtc=false -> downgrades initial request to "ws-jpeg"
    FakeWebSocket.instances = [];
    const { client: c2, ws: ws2 } = setupConnectedClient(
      makeDeviceSummary({ mediaProjection: true, webrtc: false }),
    );
    c2.startSession("dev-1", { preferredTransport: "webrtc" });
    const req2 = parseSentMessages(ws2).find((m) => m.type === "session.request");
    expect(req2?.preferredTransport).toBe("ws-jpeg");
    expect(c2.getState().desiredTransport).toBe("webrtc");
    c2.disconnect();
  });

  it("auto-upgrades active ws-jpeg session to webrtc when device.status advertises capabilities.webrtc=true, but does not loop after ICE fallback", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { client, ws } = setupConnectedClient(
        makeDeviceSummary({ mediaProjection: true, webrtc: false }),
      );

      client.startSession("dev-1", { preferredTransport: "webrtc" });
      const firstSessionId = client.getState().sessionId!;
      const firstReq = parseSentMessages(ws).find((m) => m.type === "session.request");
      expect(firstReq?.preferredTransport).toBe("ws-jpeg");

      // Agent starts ws-jpeg stream
      ws.emitJson({
        type: "session.ready",
        sessionId: firstSessionId,
        deviceId: "dev-1",
        transport: "ws-jpeg",
        screenWidth: 1080,
        screenHeight: 2400,
        rotation: 0,
      });
      expect(client.getState().sessionStatus).toBe("streaming");
      expect(client.getState().activeTransport).toBe("ws-jpeg");

      // Device later reports capabilities.webrtc=true via device.status -> auto-upgrade!
      ws.emitJson({
        type: "device.status",
        device: makeDeviceSummary({ mediaProjection: true, webrtc: true }),
      });

      const upgradedSessionId = client.getState().sessionId!;
      expect(upgradedSessionId).not.toBe(firstSessionId);
      const sessionRequestsAfterUpgrade = parseSentMessages(ws).filter(
        (m) => m.type === "session.request",
      );
      expect(sessionRequestsAfterUpgrade).toHaveLength(2);
      expect(sessionRequestsAfterUpgrade[1]?.preferredTransport).toBe("webrtc");

      // Agent responds with session.ready webrtc -> RTCPeerConnection created with fast ICE pool config
      ws.emitJson({
        type: "session.ready",
        sessionId: upgradedSessionId,
        deviceId: "dev-1",
        transport: "webrtc",
        screenWidth: 1080,
        screenHeight: 2400,
        rotation: 0,
      });
      await Promise.resolve();

      const pc = FakeRTCPeerConnection.instances[0];
      expect(pc).toBeDefined();
      expect(pc?.config).toEqual({
        iceServers: [{ urls: ["stun:stun.miwifi.com:3478"] }],
        iceCandidatePoolSize: 0,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
      });

      // Simulate ICE failure -> fallback to ws-jpeg and surface failure reason
      pc!.iceConnectionState = "failed";
      pc!.oniceconnectionstatechange?.();

      const fallbackSessionId = client.getState().sessionId!;
      expect(fallbackSessionId).not.toBe(upgradedSessionId);
      expect(client.getState().sessionStatus).toBe("fallback");
      expect(client.getState().lastNotice?.text).toContain("ICE=failed");
      expect(warnSpy).toHaveBeenCalled();

      // Fallback ws-jpeg session becomes streaming
      ws.emitJson({
        type: "session.ready",
        sessionId: fallbackSessionId,
        deviceId: "dev-1",
        transport: "ws-jpeg",
        screenWidth: 1080,
        screenHeight: 2400,
        rotation: 0,
      });
      expect(client.getState().sessionStatus).toBe("streaming");
      expect(client.getState().activeTransport).toBe("ws-jpeg");

      // Subsequent device.status with webrtc=true must NOT re-trigger auto-upgrade after ICE failure
      const reqCountBefore = parseSentMessages(ws).filter(
        (m) => m.type === "session.request",
      ).length;
      ws.emitJson({
        type: "device.status",
        device: makeDeviceSummary({ mediaProjection: true, webrtc: true }),
      });
      const reqCountAfter = parseSentMessages(ws).filter(
        (m) => m.type === "session.request",
      ).length;
      expect(reqCountAfter).toBe(reqCountBefore);
      expect(client.getState().sessionId).toBe(fallbackSessionId);

      client.disconnect();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("auto-resumes from error state when device.status reports online and mediaProjection=true", () => {
    const { client, ws } = setupConnectedClient(
      makeDeviceSummary({ mediaProjection: false, webrtc: false }),
    );

    client.startSession("dev-1", { preferredTransport: "webrtc" });
    const firstSessionId = client.getState().sessionId!;

    // Agent sends INTERNAL_ERROR because MediaProjection is not yet granted
    ws.emitJson({
      type: "error",
      code: "INTERNAL_ERROR",
      message: "MediaProjection not yet granted on Android device",
      sessionId: firstSessionId,
      deviceId: "dev-1",
    });
    expect(client.getState().sessionStatus).toBe("error");

    // Telemetry while mediaProjection is still false does NOT spam session.request
    ws.emitJson({
      type: "device.status",
      device: makeDeviceSummary({ mediaProjection: false, webrtc: false }),
    });
    expect(
      parseSentMessages(ws).filter((m) => m.type === "session.request"),
    ).toHaveLength(1);
    expect(client.getState().sessionStatus).toBe("error");

    // Once mediaProjection flips to true, auto-resume cleanly in WebRTC
    ws.emitJson({
      type: "device.status",
      device: makeDeviceSummary({ mediaProjection: true, webrtc: true }),
    });
    const reqs = parseSentMessages(ws).filter((m) => m.type === "session.request");
    expect(reqs).toHaveLength(2);
    expect(reqs[1]?.preferredTransport).toBe("webrtc");
    expect(client.getState().sessionStatus).toBe("requesting");

    client.disconnect();
  });

  it("waits 7500ms before WebRTC negotiation timeout fallback", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { client, ws } = setupConnectedClient(
        makeDeviceSummary({ mediaProjection: true, webrtc: true }),
      );

      client.startSession("dev-1", { preferredTransport: "webrtc" });
      const sessId = client.getState().sessionId!;

      ws.emitJson({
        type: "session.ready",
        sessionId: sessId,
        deviceId: "dev-1",
        transport: "webrtc",
        screenWidth: 1080,
        screenHeight: 2400,
        rotation: 0,
      });
      await Promise.resolve();

      // Still negotiating after 6000ms (previous timeout was 4500ms)
      vi.advanceTimersByTime(6_000);
      expect(client.getState().sessionStatus).toBe("negotiating");
      expect(client.getState().sessionId).toBe(sessId);

      // Falls back cleanly at 7500ms with diagnostic message
      vi.advanceTimersByTime(1_500);
      expect(client.getState().sessionStatus).toBe("fallback");
      expect(client.getState().activeTransport).toBe("ws-jpeg");
      expect(client.getState().lastNotice?.text).toContain("未收到设备端 SDP 应答");

      client.disconnect();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("sets 0ms jitterBufferTarget without clobbering playoutDelayHint, polls rich WebRTC telemetry with deltas/ICE pair & TURN protocol, preserves deltas across connected/completed, supports requestKeyframe, and resets telemetry on stop/disconnect", async () => {
    vi.useFakeTimers();
    const { client, ws } = setupConnectedClient(
      makeDeviceSummary({ mediaProjection: true, webrtc: true }),
    );

    client.startSession("dev-1", { preferredTransport: "webrtc" });
    const sessId = client.getState().sessionId!;
    ws.emitJson({
      type: "session.ready",
      sessionId: sessId,
      deviceId: "dev-1",
      transport: "webrtc",
      screenWidth: 1080,
      screenHeight: 2400,
      rotation: 0,
    });
    await Promise.resolve();

    const pc = FakeRTCPeerConnection.instances[0]!;
    expect(pc).toBeDefined();
    expect(client.getState().webrtcTelemetry).toBeNull();

    // Trigger ontrack with receiver supporting both jitterBufferTarget & playoutDelayHint:
    // MUST prefer jitterBufferTarget = 0 and NOT write playoutDelayHint back-to-back.
    const fakeReceiver = {
      playoutDelayHint: 0.1,
      jitterBufferTarget: 100,
    };
    const fakeStream = {} as MediaStream;
    pc.ontrack?.({
      receiver: fakeReceiver,
      streams: [fakeStream],
      track: {} as MediaStreamTrack,
    });
    expect(fakeReceiver.jitterBufferTarget).toBe(0);
    expect(fakeReceiver.playoutDelayHint).toBe(0.1);

    // requestKeyframe dispatches over open DataChannel
    const kfResult = client.requestKeyframe();
    expect(kfResult.sent).toBe(true);
    expect(kfResult.channel).toBe("datachannel");
    const lastDcMsg = JSON.parse(pc.dc!.sent[pc.dc!.sent.length - 1]!) as {
      type: string;
      command: { action: string };
    };
    expect(lastDcMsg.type).toBe("control.cmd");
    expect(lastDcMsg.command).toEqual({ action: "request_keyframe" });

    // Sample 1: LAN IPv4 host-host pair
    pc.statsEntries = [
      { id: "codec-96", type: "codec", mimeType: "video/H264" },
      {
        id: "in-video",
        type: "inbound-rtp",
        kind: "video",
        timestamp: 10_000,
        codecId: "codec-96",
        framesPerSecond: 60,
        frameWidth: 720,
        frameHeight: 1600,
        bytesReceived: 100_000,
        jitter: 0.004,
        jitterBufferDelay: 0.8,
        jitterBufferEmittedCount: 50,
        totalDecodeTime: 0.15,
        framesDecoded: 50,
        packetsLost: 0,
        framesDropped: 0,
        freezeCount: 0,
      },
      {
        id: "pair-1",
        type: "candidate-pair",
        nominated: true,
        state: "succeeded",
        currentRoundTripTime: 0.012,
        localCandidateId: "loc-1",
        remoteCandidateId: "rem-1",
      },
      { id: "loc-1", type: "local-candidate", candidateType: "host", address: "192.168.1.20" },
      { id: "rem-1", type: "remote-candidate", candidateType: "host", address: "192.168.1.88" },
    ];

    pc.connectionState = "connected";
    pc.onconnectionstatechange?.();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.getState().fps).toBe(60);
    expect(client.getState().rttMs).toBe(12);
    expect(client.getState().webrtcRoute).toBe("p2p");
    expect(client.getState().webrtcTelemetry).toEqual({
      codec: "H264",
      width: 720,
      height: 1600,
      bitrateKbps: 0,
      jitterMs: 4,
      jitterBufferMs: 16,
      decodeMs: 3,
      packetsLost: 0,
      framesDropped: 0,
      freezeCount: 0,
      icePair: "P2P直连 (IPv4)",
    });

    // Subsequent iceConnectionState -> completed must NOT restart stats timer or reset deltas!
    pc.iceConnectionState = "completed";
    pc.oniceconnectionstatechange?.();

    // Sample 2: 1 second later, +400_000 bytes (3200 kbps), delta decode 2.5ms, delta buffer 14.5ms, IPv6 host pair
    pc.statsEntries = [
      { id: "codec-96", type: "codec", mimeType: "video/H264" },
      {
        id: "in-video",
        type: "inbound-rtp",
        kind: "video",
        timestamp: 11_000,
        codecId: "codec-96",
        framesPerSecond: 59.6,
        frameWidth: 720,
        frameHeight: 1600,
        bytesReceived: 500_000,
        jitter: 0.005,
        jitterBufferDelay: 1.67,
        jitterBufferEmittedCount: 110,
        totalDecodeTime: 0.3,
        framesDecoded: 110,
        packetsLost: 2,
        framesDropped: 1,
        freezeCount: 1,
      },
      {
        id: "pair-1",
        type: "candidate-pair",
        nominated: true,
        state: "succeeded",
        currentRoundTripTime: 0.009,
        localCandidateId: "loc-6",
        remoteCandidateId: "rem-6",
      },
      { id: "loc-6", type: "local-candidate", candidateType: "host", address: "fe80::1" },
      { id: "rem-6", type: "remote-candidate", candidateType: "host", address: "fe80::2" },
    ];

    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.getState().webrtcTelemetry).toEqual({
      codec: "H264",
      width: 720,
      height: 1600,
      bitrateKbps: 3200,
      jitterMs: 5,
      jitterBufferMs: 14.5,
      decodeMs: 2.5,
      packetsLost: 2,
      framesDropped: 1,
      freezeCount: 1,
      icePair: "P2P直连 (IPv6)",
    });

    // Sample 3: mDNS masked host candidates -> P2P直连 (host)
    pc.statsEntries = [
      {
        id: "pair-1",
        type: "candidate-pair",
        nominated: true,
        state: "succeeded",
        localCandidateId: "loc-mdns",
        remoteCandidateId: "rem-mdns",
      },
      { id: "loc-mdns", type: "local-candidate", candidateType: "host", address: "abc123.local" },
      { id: "rem-mdns", type: "remote-candidate", candidateType: "host" },
    ];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.getState().webrtcTelemetry?.icePair).toBe("P2P直连 (host)");

    // Sample 4: srflx NAT traversal -> P2P穿透 (NAT)
    pc.statsEntries = [
      {
        id: "pair-1",
        type: "candidate-pair",
        nominated: true,
        state: "succeeded",
        localCandidateId: "loc-nat",
        remoteCandidateId: "rem-nat",
      },
      { id: "loc-nat", type: "local-candidate", candidateType: "srflx", address: "1.2.3.4" },
      { id: "rem-nat", type: "remote-candidate", candidateType: "host", address: "192.168.1.88" },
    ];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.getState().webrtcTelemetry?.icePair).toBe("P2P穿透 (NAT)");

    // Sample 5: relay without protocol -> TURN Relay
    pc.statsEntries = [
      {
        id: "pair-1",
        type: "candidate-pair",
        nominated: true,
        state: "succeeded",
        localCandidateId: "loc-turn",
        remoteCandidateId: "rem-turn",
      },
      { id: "loc-turn", type: "local-candidate", candidateType: "relay", address: "8.8.8.8" },
      { id: "rem-turn", type: "remote-candidate", candidateType: "srflx", address: "5.6.7.8" },
    ];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.getState().webrtcRoute).toBe("turn");
    expect(client.getState().webrtcTelemetry?.icePair).toBe("TURN Relay");

    // Sample 6: relay with relayProtocol udp -> TURN (UDP)
    pc.statsEntries = [
      {
        id: "pair-1",
        type: "candidate-pair",
        nominated: true,
        state: "succeeded",
        localCandidateId: "loc-turn-udp",
        remoteCandidateId: "rem-turn",
      },
      {
        id: "loc-turn-udp",
        type: "local-candidate",
        candidateType: "relay",
        address: "8.8.8.8",
        protocol: "udp",
        relayProtocol: "udp",
      },
      { id: "rem-turn", type: "remote-candidate", candidateType: "srflx", address: "5.6.7.8" },
    ];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.getState().webrtcRoute).toBe("turn");
    expect(client.getState().webrtcTelemetry?.icePair).toBe("TURN (UDP)");

    // Sample 7: relay with relayProtocol tcp -> TURN (TCP)
    pc.statsEntries = [
      {
        id: "pair-1",
        type: "candidate-pair",
        nominated: true,
        state: "succeeded",
        localCandidateId: "loc-turn-tcp",
        remoteCandidateId: "rem-turn",
      },
      {
        id: "loc-turn-tcp",
        type: "local-candidate",
        candidateType: "relay",
        address: "8.8.8.8",
        protocol: "udp",
        relayProtocol: "tcp",
      },
      { id: "rem-turn", type: "remote-candidate", candidateType: "srflx", address: "5.6.7.8" },
    ];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.getState().webrtcRoute).toBe("turn");
    expect(client.getState().webrtcTelemetry?.icePair).toBe("TURN (TCP)");

    // stopSession resets webrtcTelemetry to null
    client.stopSession();
    expect(client.getState().webrtcTelemetry).toBeNull();

    client.disconnect();
    expect(client.getState().webrtcTelemetry).toBeNull();
  });

  it("P0-1: watches WebRTC disconnected state for 4s, attempts 1 ICE restart with 5s deadline, then falls back cleanly", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { client, ws } = setupConnectedClient(
        makeDeviceSummary({ mediaProjection: true, webrtc: true }),
      );
      client.startSession("dev-1", { preferredTransport: "webrtc" });
      const sessId = client.getState().sessionId!;
      ws.emitJson({
        type: "session.ready",
        sessionId: sessId,
        deviceId: "dev-1",
        transport: "webrtc",
        screenWidth: 1080,
        screenHeight: 2400,
        rotation: 0,
      });
      await Promise.resolve();

      const pc = FakeRTCPeerConnection.instances[0]!;
      pc.connectionState = "connected";
      pc.iceConnectionState = "connected";
      pc.onconnectionstatechange?.();
      expect(client.getState().sessionStatus).toBe("streaming");

      // Transient disconnect (< 4s) that recovers must NOT trigger ICE restart or fallback
      pc.iceConnectionState = "disconnected";
      pc.oniceconnectionstatechange?.();
      await vi.advanceTimersByTimeAsync(2_000);
      pc.iceConnectionState = "connected";
      pc.oniceconnectionstatechange?.();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(pc.offerCalls).toHaveLength(1);
      expect(client.getState().activeTransport).toBe("webrtc");

      // Sustained disconnect (>= 4s) triggers 1 ICE restart with { iceRestart: true }
      pc.iceConnectionState = "disconnected";
      pc.oniceconnectionstatechange?.();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(pc.offerCalls).toHaveLength(2);
      expect(pc.offerCalls[1]).toEqual({ iceRestart: true });
      const offers = parseSentMessages(ws).filter((m) => m.type === "rtc.offer");
      expect(offers).toHaveLength(2);
      expect(offers[1]?.sdp).toContain("a=ice-restart");

      // Still waiting inside 5s recovery deadline
      await vi.advanceTimersByTimeAsync(3_000);
      expect(client.getState().activeTransport).toBe("webrtc");

      // Recovery deadline expires at 5s -> falls back to ws-jpeg
      await vi.advanceTimersByTimeAsync(2_000);
      expect(client.getState().sessionStatus).toBe("fallback");
      expect(client.getState().activeTransport).toBe("ws-jpeg");

      client.disconnect();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("P0-2: pc.ontrack attaches mediaStream without prematurely switching sessionStatus away from negotiating", async () => {
    const { client, ws } = setupConnectedClient(
      makeDeviceSummary({ mediaProjection: true, webrtc: true }),
    );
    client.startSession("dev-1", { preferredTransport: "webrtc" });
    const sessId = client.getState().sessionId!;
    ws.emitJson({
      type: "session.ready",
      sessionId: sessId,
      deviceId: "dev-1",
      transport: "webrtc",
      screenWidth: 1080,
      screenHeight: 2400,
      rotation: 0,
    });
    await Promise.resolve();

    const pc = FakeRTCPeerConnection.instances[0]!;
    const fakeStream = {} as MediaStream;
    pc.ontrack?.({
      receiver: {},
      streams: [fakeStream],
      track: {} as MediaStreamTrack,
    });
    expect(client.getState().mediaStream).toBe(fakeStream);
    expect(client.getState().sessionStatus).toBe("negotiating");

    pc.iceConnectionState = "connected";
    pc.oniceconnectionstatechange?.();
    expect(client.getState().sessionStatus).toBe("streaming");

    client.disconnect();
  });

  it("P0-6: does not loop upgrading ws-jpeg -> webrtc when agent downgraded the session", () => {
    const { client, ws } = setupConnectedClient(
      makeDeviceSummary({ mediaProjection: true, webrtc: true }),
    );
    client.startSession("dev-1", { preferredTransport: "webrtc" });
    const sessId = client.getState().sessionId!;
    expect(parseSentMessages(ws).filter((m) => m.type === "session.request")[0]?.preferredTransport).toBe(
      "webrtc",
    );

    // Agent downgrades to ws-jpeg in session.ready
    ws.emitJson({
      type: "session.ready",
      sessionId: sessId,
      deviceId: "dev-1",
      transport: "ws-jpeg",
      screenWidth: 1080,
      screenHeight: 2400,
      rotation: 0,
    });
    expect(client.getState().activeTransport).toBe("ws-jpeg");
    expect(client.getState().sessionStatus).toBe("streaming");

    // Repeated battery/status ticks advertising capabilities.webrtc=true must NOT trigger an upgrade loop
    ws.emitJson({
      type: "device.status",
      device: makeDeviceSummary({ mediaProjection: true, webrtc: true }),
    });
    expect(parseSentMessages(ws).filter((m) => m.type === "session.request")).toHaveLength(1);
    expect(client.getState().sessionId).toBe(sessId);

    client.disconnect();
  });

  it("applies fresh session.ready iceServers, clears sessionId on session.end, and auto-re-requests on agent_reconnected", async () => {
    vi.useFakeTimers();
    const { client, ws } = setupConnectedClient(
      makeDeviceSummary({ mediaProjection: true, webrtc: true }),
    );
    client.startSession("dev-1", { preferredTransport: "webrtc" });
    const sessId = client.getState().sessionId!;

    const freshTurn = [
      { urls: ["turn:turn.example.com:3478"], username: "fresh-u", credential: "fresh-p" },
    ];
    ws.emitJson({
      type: "session.ready",
      sessionId: sessId,
      deviceId: "dev-1",
      transport: "webrtc",
      screenWidth: 1080,
      screenHeight: 2400,
      rotation: 0,
      iceServers: freshTurn,
    });
    await Promise.resolve();
    expect(FakeRTCPeerConnection.instances[0]?.config?.iceServers).toEqual(freshTurn);

    // session.end with reason agent_reconnected clears sessionId and re-requests after 250ms
    ws.emitJson({
      type: "session.end",
      sessionId: sessId,
      deviceId: "dev-1",
      reason: "agent_reconnected",
    });
    expect(client.getState().sessionId).toBeNull();
    expect(client.getState().sessionStatus).toBe("requesting");

    await vi.advanceTimersByTimeAsync(250);
    const reqs = parseSentMessages(ws).filter((m) => m.type === "session.request");
    expect(reqs).toHaveLength(2);
    expect(client.getState().sessionId).toBeTruthy();

    // Normal session.end clears sessionId so retry doesn't emit stale session.end
    const secondSessId = client.getState().sessionId!;
    ws.emitJson({
      type: "session.end",
      sessionId: secondSessId,
      deviceId: "dev-1",
      reason: "agent_stopped",
    });
    expect(client.getState().sessionId).toBeNull();
    expect(client.getState().sessionStatus).toBe("ended");

    const endCountBefore = parseSentMessages(ws).filter((m) => m.type === "session.end").length;
    client.startSession("dev-1");
    const endCountAfter = parseSentMessages(ws).filter((m) => m.type === "session.end").length;
    expect(endCountAfter).toBe(endCountBefore);

    client.disconnect();
  });

  it("P1-1 & P1-2: routes 1Hz stats only to telemetryListeners, ignores WS pong during WebRTC, prefers transport.selectedCandidatePairId, and computes delta FPS", async () => {
    vi.useFakeTimers();
    const { client, ws } = setupConnectedClient(
      makeDeviceSummary({ mediaProjection: true, webrtc: true }),
    );
    client.startSession("dev-1", { preferredTransport: "webrtc" });
    const sessId = client.getState().sessionId!;
    ws.emitJson({
      type: "session.ready",
      sessionId: sessId,
      deviceId: "dev-1",
      transport: "webrtc",
      screenWidth: 1080,
      screenHeight: 2400,
      rotation: 0,
    });
    await Promise.resolve();

    const pc = FakeRTCPeerConnection.instances[0]!;
    pc.connectionState = "connected";
    pc.onconnectionstatechange?.();

    const stateSpy = vi.fn();
    const telemetrySpy = vi.fn();
    const unsubState = client.subscribe(stateSpy);
    stateSpy.mockClear(); // clear initial emit
    const unsubTelemetry = client.subscribeTelemetry(telemetrySpy);

    // Selected transport pair takes precedence over an older nominated pair; framesPerSecond absent -> delta FPS
    pc.statsEntries = [
      { id: "trans-1", type: "transport", selectedCandidatePairId: "pair-selected" },
      {
        id: "pair-old",
        type: "candidate-pair",
        nominated: true,
        state: "succeeded",
        currentRoundTripTime: 0.08,
        localCandidateId: "loc-relay",
        remoteCandidateId: "rem-relay",
      },
      {
        id: "pair-selected",
        type: "candidate-pair",
        nominated: true,
        state: "succeeded",
        currentRoundTripTime: 0.006,
        localCandidateId: "loc-host",
        remoteCandidateId: "rem-host",
      },
      { id: "loc-relay", type: "local-candidate", candidateType: "relay", address: "1.1.1.1" },
      { id: "rem-relay", type: "remote-candidate", candidateType: "relay", address: "2.2.2.2" },
      { id: "loc-host", type: "local-candidate", candidateType: "host", address: "192.168.1.2" },
      { id: "rem-host", type: "remote-candidate", candidateType: "host", address: "192.168.1.3" },
      {
        id: "in-video",
        type: "inbound-rtp",
        kind: "video",
        timestamp: 20_000,
        framesDecoded: 100,
        bytesReceived: 50_000,
      },
    ];

    await vi.advanceTimersByTimeAsync(1_000);
    expect(stateSpy).not.toHaveBeenCalled();
    expect(telemetrySpy).toHaveBeenCalledTimes(1);
    expect(client.getTelemetrySnapshot().rttMs).toBe(6);
    expect(client.getTelemetrySnapshot().webrtcRoute).toBe("p2p");
    expect(client.getTelemetrySnapshot().webrtcTelemetry?.icePair).toBe("P2P直连 (IPv4)");

    // WS pong must NOT overwrite WebRTC RTT
    ws.emitJson({ type: "pong", ts: Date.now() - 95 });
    expect(client.getTelemetrySnapshot().rttMs).toBe(6);
    expect(stateSpy).not.toHaveBeenCalled();

    // Next sample: +45 framesDecoded in 1s without framesPerSecond -> delta FPS = 45
    pc.statsEntries = [
      { id: "trans-1", type: "transport", selectedCandidatePairId: "pair-selected" },
      {
        id: "pair-selected",
        type: "candidate-pair",
        nominated: true,
        state: "succeeded",
        currentRoundTripTime: 0.006,
        localCandidateId: "loc-host",
        remoteCandidateId: "rem-host",
      },
      { id: "loc-host", type: "local-candidate", candidateType: "host", address: "192.168.1.2" },
      { id: "rem-host", type: "remote-candidate", candidateType: "host", address: "192.168.1.3" },
      {
        id: "in-video",
        type: "inbound-rtp",
        kind: "video",
        timestamp: 21_000,
        framesDecoded: 145,
        bytesReceived: 150_000,
      },
    ];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.getTelemetrySnapshot().fps).toBe(45);
    expect(stateSpy).not.toHaveBeenCalled();

    unsubState();
    unsubTelemetry();
    client.disconnect();
  });

  it("P1-3: uses in-order partial-reliability pointer DataChannel ({ ordered: true, maxRetransmits: 0 }), avoids touch split-transport & first-move races, drops under backpressure, and sends 180ms keepalive", async () => {
    vi.useFakeTimers();
    const { client, ws } = setupConnectedClient(
      makeDeviceSummary({ mediaProjection: true, webrtc: true }),
    );
    client.startSession("dev-1", { preferredTransport: "webrtc" });
    const sessId = client.getState().sessionId!;
    ws.emitJson({
      type: "session.ready",
      sessionId: sessId,
      deviceId: "dev-1",
      transport: "webrtc",
      screenWidth: 1080,
      screenHeight: 2400,
      rotation: 0,
    });
    await Promise.resolve();

    const pc = FakeRTCPeerConnection.instances[0]!;
    expect(pc.dc?.label).toBe("control");
    expect(pc.dc?.options).toEqual({ ordered: true });
    expect(pc.pointerDc?.label).toBe("pointer");
    expect(pc.pointerDc?.options).toEqual({ ordered: true, maxRetransmits: 0 });

    // Standalone touch_move routes over pointer DC
    const moveRes = client.sendCommand({ action: "touch_move", pointerId: 1, x: 0.5, y: 0.5 });
    expect(moveRes.sent).toBe(true);
    expect(moveRes.channel).toBe("datachannel");
    expect(pc.pointerDc?.sent).toHaveLength(1);
    expect(pc.dc?.sent).toHaveLength(0);

    // Full gesture over DC: touch_down + first touch_move stay on ordered control DC;
    // subsequent touch_move routes over pointer DC; touch_up closes on control DC.
    const downRes = client.sendCommand({ action: "touch_down", pointerId: 2, x: 0.1, y: 0.1 });
    const firstMoveRes = client.sendCommand({ action: "touch_move", pointerId: 2, x: 0.2, y: 0.2 });
    const secondMoveRes = client.sendCommand({ action: "touch_move", pointerId: 2, x: 0.3, y: 0.3 });
    const upRes = client.sendCommand({ action: "touch_up", pointerId: 2, x: 0.4, y: 0.4 });
    expect(downRes.channel).toBe("datachannel");
    expect(firstMoveRes.channel).toBe("datachannel");
    expect(secondMoveRes.channel).toBe("datachannel");
    expect(upRes.channel).toBe("datachannel");
    expect(pc.dc?.sent).toHaveLength(3); // touch_down, first touch_move, touch_up
    expect(pc.pointerDc?.sent).toHaveLength(2); // standalone move + second touch_move

    // Split-transport guard: if touch_down falls back to WS (control DC congested/closed),
    // subsequent touch_move and touch_up of that gesture MUST remain on WS (never jump to pointer DC!).
    pc.dc!.readyState = "connecting";
    const wsDown = client.sendCommand({ action: "touch_down", pointerId: 3, x: 0.2, y: 0.2 });
    expect(wsDown.channel).toBe("websocket");
    pc.dc!.readyState = "open"; // even if control DC opens mid-gesture, keep gesture on WS!
    const wsMove = client.sendCommand({ action: "touch_move", pointerId: 3, x: 0.3, y: 0.3 });
    const wsUp = client.sendCommand({ action: "touch_up", pointerId: 3, x: 0.4, y: 0.4 });
    expect(wsMove.channel).toBe("websocket");
    expect(wsUp.channel).toBe("websocket");
    expect(pc.pointerDc?.sent).toHaveLength(2);
    expect(pc.dc?.sent).toHaveLength(3);

    // Backpressure > 4096 drops stale touch_move
    pc.pointerDc!.bufferedAmount = 5_000;
    const dropped = client.sendCommand({ action: "touch_move", pointerId: 1, x: 0.6, y: 0.6 });
    expect(dropped.sent).toBe(false);
    expect(dropped.channel).toBe("none");
    pc.pointerDc!.bufferedAmount = 0;

    // Non-move command routes over control DC, and fails over to WS if bufferedAmount > 65536
    const dcSentBeforeTap = pc.dc!.sent.length;
    const tapRes = client.sendCommand({ action: "tap", x: 0.2, y: 0.3 });
    expect(tapRes.channel).toBe("datachannel");
    expect(pc.dc?.sent).toHaveLength(dcSentBeforeTap + 1);

    pc.dc!.bufferedAmount = 70_000;
    const failoverRes = client.sendCommand({ action: "key", key: "back" });
    expect(failoverRes.sent).toBe(true);
    expect(failoverRes.channel).toBe("websocket");
    pc.dc!.bufferedAmount = 0;

    // Streaming + idle sends dc.ping keepalive every 180ms over pointer DC
    pc.connectionState = "connected";
    pc.onconnectionstatechange?.();
    const sentBeforeKeepalive = pc.pointerDc!.sent.length;
    await vi.advanceTimersByTimeAsync(400);
    const keepalives = pc.pointerDc!.sent
      .slice(sentBeforeKeepalive)
      .filter((raw) => raw === '{"type":"dc.ping"}');
    expect(keepalives.length).toBeGreaterThanOrEqual(1);

    // setTransport no-op when already streaming desired transport
    const reqCountBefore = parseSentMessages(ws).filter((m) => m.type === "session.request").length;
    client.setTransport("webrtc");
    expect(parseSentMessages(ws).filter((m) => m.type === "session.request")).toHaveLength(
      reqCountBefore,
    );

    // ws.onclose 4003 is terminal error (no reconnect)
    ws.onclose?.({ code: 4003, reason: "FORBIDDEN_ORIGIN" } as CloseEvent);
    expect(client.getState().socketStatus).toBe("error");
    expect(client.getState().nextReconnectAt).toBeNull();

    client.disconnect();
  });

  it("clears stale sessionId and tears down PC on terminal session errors so sessionless wake works, and queues remote ICE during ICE restart", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { client, ws } = setupConnectedClient(
        makeDeviceSummary({ mediaProjection: true, webrtc: true }),
      );
      expect(client.getAuthToken()).toBe("jwt-valid");

      client.startSession("dev-1", { preferredTransport: "webrtc" });
      const sessId = client.getState().sessionId!;
      ws.emitJson({
        type: "session.ready",
        sessionId: sessId,
        deviceId: "dev-1",
        transport: "webrtc",
        screenWidth: 1080,
        screenHeight: 2400,
        rotation: 0,
      });
      await Promise.resolve();

      const pc = FakeRTCPeerConnection.instances[0]!;
      ws.emitJson({ type: "rtc.answer", sessionId: sessId, deviceId: "dev-1", sdp: "v=0\r\n" });
      await Promise.resolve();
      pc.connectionState = "connected";
      pc.iceConnectionState = "connected";
      pc.onconnectionstatechange?.();

      // Trigger ICE restart after 4s disconnect -> remoteDescriptionReady resets to false
      pc.iceConnectionState = "disconnected";
      pc.oniceconnectionstatechange?.();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(pc.offerCalls).toHaveLength(2);

      // Remote ICE arriving before restart rtc.answer MUST be queued, NOT applied prematurely!
      const restartCandidate = { candidate: "candidate:restart 1 udp 1 1.2.3.4 5000 typ host" };
      ws.emitJson({
        type: "rtc.ice",
        sessionId: sessId,
        deviceId: "dev-1",
        candidate: restartCandidate,
      });
      await Promise.resolve();
      expect(pc.addedIceCandidates).toHaveLength(0);

      // Once restart rtc.answer arrives, queued ICE candidate flushes cleanly
      ws.emitJson({
        type: "rtc.answer",
        sessionId: sessId,
        deviceId: "dev-1",
        sdp: "v=0\r\na=ice-restart-answer\r\n",
      });
      await Promise.resolve();
      expect(pc.addedIceCandidates).toEqual([restartCandidate]);

      // Terminal session error (INTERNAL_ERROR) tears down PC & clears sessionId
      ws.emitJson({
        type: "error",
        code: "INTERNAL_ERROR",
        message: "MediaProjection not yet granted",
        sessionId: sessId,
        deviceId: "dev-1",
      });
      expect(client.getState().sessionStatus).toBe("error");
      expect(client.getState().sessionId).toBeNull();
      expect(client.getState().activeTransport).toBeNull();
      expect(client.getState().mediaStream).toBeNull();
      expect(client.getState().dataChannelOpen).toBe(false);
      expect(client.getState().fileChannelOpen).toBe(false);
      expect(pc.connectionState).toBe("closed");

      // Clicking "强制唤醒" sends sessionless wake (sessionId: "") over WS instead of stale sessionId!
      const wakeRes = client.sendCommand({ action: "wake" }, "dev-1");
      expect(wakeRes.sent).toBe(true);
      expect(wakeRes.channel).toBe("websocket");
      const lastWsMsg = parseSentMessages(ws).at(-1);
      expect(lastWsMsg?.type).toBe("control.cmd");
      expect(lastWsMsg?.sessionId).toBe("");
      expect(lastWsMsg?.deviceId).toBe("dev-1");
      expect(lastWsMsg?.command).toEqual({ action: "wake" });

      client.disconnect();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("decays static ws-jpeg FPS to 0 after 1s, decays stale unchanged WebRTC framesPerSecond to 0, and clears remoteClipboard on session transitions", async () => {
    vi.useFakeTimers();
    const { client, ws } = setupConnectedClient(
      makeDeviceSummary({ mediaProjection: true, webrtc: true }),
    );
    client.startSession("dev-1", { preferredTransport: "ws-jpeg" });
    const sessId = client.getState().sessionId!;
    ws.emitJson({
      type: "session.ready",
      sessionId: sessId,
      deviceId: "dev-1",
      transport: "ws-jpeg",
      screenWidth: 1080,
      screenHeight: 2400,
      rotation: 0,
    });

    // Deliver 2 JPEG binary frames -> FPS = 2 (500ms apart so throttled FPS update emits)
    const encoded = encodeMediaFrame({
      frameType: FRAME_TYPE_JPEG,
      keyframe: true,
      rotation: 0,
      width: 720,
      height: 1600,
      timestampMs: Date.now(),
      sessionId: sessId,
      payload: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    });
    const frameBuf = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength,
    );
    ws.onmessage?.({ data: frameBuf } as MessageEvent);
    expect(client.getTelemetrySnapshot().fps).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    ws.onmessage?.({ data: frameBuf } as MessageEvent);
    expect(client.getTelemetrySnapshot().fps).toBe(2);

    // After >1s without new frames, static ws-jpeg decays cleanly to 0 FPS
    await vi.advanceTimersByTimeAsync(1_100);
    expect(client.getTelemetrySnapshot().fps).toBe(0);

    // Clipboard synced then cleared on stopSession
    ws.emitJson({
      type: "clipboard.sync",
      sessionId: sessId,
      deviceId: "dev-1",
      text: "secret-clip",
    });
    expect(client.getState().remoteClipboard).toBe("secret-clip");
    client.stopSession();
    expect(client.getState().remoteClipboard).toBe("");

    // Stale unchanged framesPerSecond in WebRTC decays to 0 when framesDecoded stops advancing
    client.startSession("dev-1", { preferredTransport: "webrtc" });
    const rtcSessId = client.getState().sessionId!;
    ws.emitJson({
      type: "session.ready",
      sessionId: rtcSessId,
      deviceId: "dev-1",
      transport: "webrtc",
      screenWidth: 1080,
      screenHeight: 2400,
      rotation: 0,
    });
    await Promise.resolve();
    const pc = FakeRTCPeerConnection.instances[0]!;
    pc.connectionState = "connected";
    pc.onconnectionstatechange?.();

    pc.statsEntries = [
      {
        id: "in-video",
        type: "inbound-rtp",
        kind: "video",
        timestamp: 30_000,
        framesPerSecond: 60,
        framesDecoded: 200,
        bytesReceived: 100_000,
      },
    ];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.getTelemetrySnapshot().fps).toBe(60);

    // Static screen: browser still reports cached framesPerSecond=60, but framesDecoded unchanged at 200
    pc.statsEntries = [
      {
        id: "in-video",
        type: "inbound-rtp",
        kind: "video",
        timestamp: 31_000,
        framesPerSecond: 60,
        framesDecoded: 200,
        bytesReceived: 100_000,
      },
    ];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.getTelemetrySnapshot().fps).toBe(0);

    client.disconnect();
  });
});

describe("sortPreferredVideoCodecs", () => {
  it("sorts H.264 Constrained High (640c*) ahead of Constrained Baseline (42e0*), other H.264, VP8, VP9, and AV1", () => {
    const input = [
      { mimeType: "video/AV1", clockRate: 90000 },
      { mimeType: "video/VP9", clockRate: 90000, sdpFmtpLine: "profile-id=0" },
      { mimeType: "video/VP8", clockRate: 90000 },
      {
        mimeType: "video/H264",
        clockRate: 90000,
        sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f",
      },
      {
        mimeType: "video/H264",
        clockRate: 90000,
        sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f",
      },
      {
        mimeType: "video/H264",
        clockRate: 90000,
        sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
      },
      {
        mimeType: "video/h264",
        clockRate: 90000,
        sdpFmtpLine: "packetization-mode=1;PROFILE-LEVEL-ID=640C1F",
      },
      {
        mimeType: "video/h264",
        clockRate: 90000,
        sdpFmtpLine: "packetization-mode=1;PROFILE-LEVEL-ID=42E028",
      },
      {
        mimeType: "video/H264",
        clockRate: 90000,
        sdpFmtpLine: "packetization-mode=1;profile-level-id=42001f",
      },
      { mimeType: "video/rtx", clockRate: 90000 },
    ];

    const snapshot = [...input];
    const ordered = sortPreferredVideoCodecs(input);

    // Must not mutate original array
    expect(input).toEqual(snapshot);

    expect(ordered.map((c) => `${c.mimeType}:${c.sdpFmtpLine ?? ""}`)).toEqual([
      "video/h264:packetization-mode=1;PROFILE-LEVEL-ID=640C1F",
      "video/H264:level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
      "video/h264:packetization-mode=1;PROFILE-LEVEL-ID=42E028",
      "video/H264:level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f",
      "video/H264:level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f",
      "video/H264:packetization-mode=1;profile-level-id=42001f",
      "video/VP8:",
      "video/AV1:",
      "video/VP9:profile-id=0",
      "video/rtx:",
    ]);
  });
});

describe("RemoteClient WebRTC P2P file transfer", () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalRTC = globalThis.RTCPeerConnection;

  afterEach(() => {
    vi.useRealTimers();
    FakeWebSocket.instances = [];
    FakeRTCPeerConnection.instances = [];
    globalThis.WebSocket = originalWebSocket;
    globalThis.RTCPeerConnection = originalRTC;
  });

  async function setupWebRtcFileChannel() {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.RTCPeerConnection =
      FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;

    const client = new RemoteClient("ctrl-file-test");
    client.connectWithAccount({
      wsUrl: "wss://velodeck.example.com/ws",
      authToken: "jwt-valid",
      user: { userId: "u1", username: "alice", displayName: "Alice" },
      preferredTransport: "webrtc",
    });

    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    ws.emitJson({
      type: "controller.authed",
      clientId: "ctrl-file-test",
      serverTime: Date.now(),
      mode: "relay",
      authType: "account",
      user: { userId: "u1", username: "alice", displayName: "Alice" },
      devices: [makeDeviceSummary({ mediaProjection: true, webrtc: true })],
      iceServers: [],
    });

    client.startSession("dev-1", { preferredTransport: "webrtc" });
    const sessId = client.getState().sessionId!;
    ws.emitJson({
      type: "session.ready",
      sessionId: sessId,
      deviceId: "dev-1",
      transport: "webrtc",
      screenWidth: 1080,
      screenHeight: 2400,
      rotation: 0,
    });
    await Promise.resolve();

    const pc = FakeRTCPeerConnection.instances[0]!;
    const fileDc = pc.fileDc!;
    return { client, ws, pc, fileDc };
  }

  it("creates ordered 'file' DataChannel during WebRTC negotiation and tracks fileChannelOpen", async () => {
    const { client, fileDc } = await setupWebRtcFileChannel();

    expect(fileDc).toBeDefined();
    expect(fileDc.label).toBe("file");
    expect(fileDc.options).toEqual({ ordered: true });
    expect(fileDc.binaryType).toBe("arraybuffer");
    expect(fileDc.bufferedAmountLowThreshold).toBe(65_536);
    expect(client.getState().fileChannelOpen).toBe(false);

    fileDc.onopen?.();
    expect(client.getState().fileChannelOpen).toBe(true);

    fileDc.onclose?.();
    expect(client.getState().fileChannelOpen).toBe(false);

    client.disconnect();
  });

  it("streams full file.offer -> file.accept -> 16 KB binary chunks (with backpressure) -> file.complete -> file.done", async () => {
    const { client, fileDc } = await setupWebRtcFileChannel();
    fileDc.onopen?.();

    // 40 KB payload => 3 ordered chunks (16384 + 16384 + 8192)
    const payload = new Uint8Array(40 * 1024);
    for (let i = 0; i < payload.length; i++) {
      payload[i] = (i * 19 + 7) & 0xff;
    }

    // Simulate backpressure pausing after chunk #1 until bufferedamountlow drains
    let binaryChunkIndex = 0;
    const origSend = fileDc.send.bind(fileDc);
    fileDc.send = (data) => {
      origSend(data);
      if (typeof data !== "string") {
        binaryChunkIndex += 1;
        if (binaryChunkIndex === 1) {
          fileDc.bufferedAmount = 300_000;
        }
      }
    };

    const transferPromise = client.sendFileOverWebRtc(payload, {
      fileName: "velodeck-agent.apk",
      mimeType: "application/vnd.android.package-archive",
      purpose: "apk_install",
    });

    await vi.waitFor(() => {
      expect(fileDc.sent).toHaveLength(1);
    });

    // Step 1: file.offer sent with valid 64-hex sha256
    const offer = JSON.parse(fileDc.sent[0]!) as Record<string, unknown>;
    expect(offer.type).toBe("file.offer");
    expect(offer.fileName).toBe("velodeck-agent.apk");
    expect(offer.size).toBe(payload.byteLength);
    expect(offer.mimeType).toBe("application/vnd.android.package-archive");
    expect(offer.purpose).toBe("apk_install");
    expect(typeof offer.transferId).toBe("string");
    expect(offer.sha256).toMatch(/^[0-9a-f]{64}$/);
    const transferId = offer.transferId as string;
    const offerSha = offer.sha256 as string;

    // Step 2: Android replies file.accept -> chunk #1 sends and hits backpressure
    fileDc.emitMessage({ type: "file.accept", transferId });
    await vi.waitFor(() => {
      expect(fileDc.sentBinary).toHaveLength(1);
    });

    expect(fileDc.sentBinary[0]!.byteLength).toBe(16_384);
    expect(client.getState().fileTransfer?.status).toBe("sending");

    // Simulate peer progress report + SCTP buffer draining
    fileDc.emitMessage({
      type: "file.progress",
      transferId,
      receivedBytes: 16_384,
      totalBytes: payload.byteLength,
    });
    fileDc.bufferedAmount = 32_768;
    fileDc.emitBufferedAmountLow();
    await vi.waitFor(() => {
      expect(fileDc.sent).toHaveLength(2);
    });

    // All 3 chunks sent + file.complete sent
    expect(fileDc.sentBinary).toHaveLength(3);
    expect(fileDc.sentBinary.map((b) => b.byteLength)).toEqual([16_384, 16_384, 8_192]);
    const reassembled = new Uint8Array(payload.byteLength);
    let pos = 0;
    for (const chunk of fileDc.sentBinary) {
      const view = new Uint8Array(chunk);
      reassembled.set(view, pos);
      pos += view.byteLength;
    }
    expect(reassembled).toEqual(payload);

    const complete = JSON.parse(fileDc.sent[1]!) as Record<string, unknown>;
    expect(complete).toEqual({
      type: "file.complete",
      transferId,
      sha256: offerSha,
    });
    expect(client.getState().fileTransfer?.status).toBe("verifying");

    // Step 3: Android verifies and responds with file.done
    fileDc.emitMessage({
      type: "file.done",
      transferId,
      savedPath: "/sdcard/Download/VeloDeck/velodeck-agent.apk",
      sha256: offerSha,
      installLaunched: true,
      needsInstallPermission: false,
      message: "已拉起系统安装界面",
    });

    const result = await transferPromise;
    expect(result.status).toBe("done");
    expect(result.sentBytes).toBe(payload.byteLength);
    expect(result.confirmedBytes).toBe(payload.byteLength);
    expect(result.savedPath).toBe("/sdcard/Download/VeloDeck/velodeck-agent.apk");
    expect(result.installLaunched).toBe(true);
    expect(result.needsInstallPermission).toBe(false);
    expect(result.message).toBe("已拉起系统安装界面");
    expect(client.getState().fileTransfer?.status).toBe("done");

    // clearFileTransfer resets completed record cleanly
    client.clearFileTransfer();
    expect(client.getState().fileTransfer).toBeNull();

    client.disconnect();
  });

  it("cancels in-flight transfer via cancelFileTransfer, sending file.cancel and setting status cancelled", async () => {
    const { client, fileDc } = await setupWebRtcFileChannel();
    fileDc.onopen?.();

    const data = new Uint8Array(2048).fill(0xab);
    const promise = client.sendFileOverWebRtc(data, {
      fileName: "report.pdf",
      purpose: "file",
    });
    await vi.waitFor(() => {
      expect(fileDc.sent).toHaveLength(1);
    });

    const offer = JSON.parse(fileDc.sent[0]!) as { transferId: string };
    expect(client.getState().fileTransfer?.status).toBe("preparing");

    client.cancelFileTransfer();

    const result = await promise;
    expect(result.status).toBe("cancelled");
    expect(client.getState().fileTransfer?.status).toBe("cancelled");
    expect(fileDc.sent).toHaveLength(2);
    expect(JSON.parse(fileDc.sent[1]!)).toEqual({
      type: "file.cancel",
      transferId: offer.transferId,
      reason: "user_cancelled",
    });

    client.disconnect();
  });

  it("marks transfer as error and rejects cleanly on peer file.error or closed file channel", async () => {
    const { client, fileDc } = await setupWebRtcFileChannel();
    fileDc.onopen?.();

    const data = new Uint8Array(1024).fill(0x55);
    const promise = client.sendFileOverWebRtc(data, {
      fileName: "broken.apk",
      purpose: "apk_install",
      expectedSha256: "a".repeat(64),
    });
    await vi.waitFor(() => {
      expect(fileDc.sent).toHaveLength(1);
    });

    const offer = JSON.parse(fileDc.sent[0]!) as { transferId: string };
    fileDc.emitMessage({
      type: "file.error",
      transferId: offer.transferId,
      error: "SHA-256 校验失败",
    });

    await expect(promise).rejects.toThrow("SHA-256 校验失败");
    expect(client.getState().fileTransfer?.status).toBe("error");
    expect(client.getState().fileTransfer?.message).toBe("SHA-256 校验失败");

    // Closed channel rejects immediately with clear guidance message
    fileDc.close();
    fileDc.onclose?.();
    await expect(
      client.sendFileOverWebRtc(data, { fileName: "next.bin" }),
    ).rejects.toThrow("WebRTC P2P 文件通道未就绪");
    expect(client.getState().fileTransfer?.status).toBe("error");

    client.disconnect();
  });
});

describe("selectAdaptivePlayoutDelayMs and isWebRtcStaticIdle", () => {
  it("uses 0ms playout delay floor across P2P, WAN, and TURN links so VCMJitterEstimator adapts organically", () => {
    expect(selectAdaptivePlayoutDelayMs("p2p", 1)).toBe(0);
    expect(selectAdaptivePlayoutDelayMs("p2p", 12)).toBe(0);
    expect(selectAdaptivePlayoutDelayMs("p2p", 35)).toBe(0);
    expect(selectAdaptivePlayoutDelayMs("p2p", 110)).toBe(0);
    expect(selectAdaptivePlayoutDelayMs("turn", 10)).toBe(0);
    expect(selectAdaptivePlayoutDelayMs("turn", 85)).toBe(0);
    expect(selectAdaptivePlayoutDelayMs("turn", null)).toBe(0);
    expect(selectAdaptivePlayoutDelayMs(null, null, 0)).toBe(0);
  });

  it("classifies WebRTC static keepalive screens as idle without masking congested low-FPS scrolling", () => {
    // 0 FPS while streaming WebRTC -> idle
    expect(isWebRtcStaticIdle("webrtc", "streaming", 0, null)).toBe(true);
    expect(isWebRtcStaticIdle("webrtc", "streaming", 0, 50)).toBe(true);

    // Static keepalive pump (~1-2 FPS, low bitrate <= 120 kbps) -> idle
    expect(isWebRtcStaticIdle("webrtc", "streaming", 1, 20)).toBe(true);
    expect(isWebRtcStaticIdle("webrtc", "streaming", 2, 80)).toBe(true);
    expect(isWebRtcStaticIdle("webrtc", "streaming", 2, 120)).toBe(true);

    // Real congested scrolling at 2 FPS (> 120 kbps) -> NOT idle
    expect(isWebRtcStaticIdle("webrtc", "streaming", 2, 121)).toBe(false);
    expect(isWebRtcStaticIdle("webrtc", "streaming", 2, 950)).toBe(false);
    expect(isWebRtcStaticIdle("webrtc", "streaming", 1, 400)).toBe(false);

    // Without bitrate measurement yet, 1-2 FPS should not claim idle
    expect(isWebRtcStaticIdle("webrtc", "streaming", 2, null)).toBe(false);

    // Active FPS (> 2) -> NOT idle even if low bitrate
    expect(isWebRtcStaticIdle("webrtc", "streaming", 3, 40)).toBe(false);
    expect(isWebRtcStaticIdle("webrtc", "streaming", 60, 2400)).toBe(false);

    // Non-WebRTC or non-streaming -> NOT idle
    expect(isWebRtcStaticIdle("ws-jpeg", "streaming", 0, 0)).toBe(false);
    expect(isWebRtcStaticIdle("webrtc", "negotiating", 0, 0)).toBe(false);
    expect(isWebRtcStaticIdle(null, "streaming", 0, 0)).toBe(false);
  });
});

describe("RemoteClient adaptive playout delay on stats polling", () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalRTC = globalThis.RTCPeerConnection;

  afterEach(() => {
    vi.useRealTimers();
    FakeWebSocket.instances = [];
    FakeRTCPeerConnection.instances = [];
    globalThis.WebSocket = originalWebSocket;
    globalThis.RTCPeerConnection = originalRTC;
  });

  it("sets jitterBufferTarget=0 once without touching playoutDelayHint or thrashing across RTT/TURN changes, and falls back to playoutDelayHint when jitterBufferTarget is absent", async () => {
    vi.useFakeTimers();
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.RTCPeerConnection =
      FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;

    const client = new RemoteClient("ctrl-adaptive-delay");
    client.connectWithAccount({
      wsUrl: "wss://velodeck.example.com/ws",
      authToken: "jwt-valid",
      user: { userId: "u1", username: "alice", displayName: "Alice" },
      preferredTransport: "webrtc",
    });

    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    ws.emitJson({
      type: "controller.authed",
      clientId: "ctrl-adaptive-delay",
      serverTime: Date.now(),
      mode: "relay",
      authType: "account",
      user: { userId: "u1", username: "alice", displayName: "Alice" },
      devices: [makeDeviceSummary({ mediaProjection: true, webrtc: true })],
      iceServers: [],
    });

    client.startSession("dev-1", { preferredTransport: "webrtc" });
    const sessId = client.getState().sessionId!;
    ws.emitJson({
      type: "session.ready",
      sessionId: sessId,
      deviceId: "dev-1",
      transport: "webrtc",
      screenWidth: 1080,
      screenHeight: 2400,
      rotation: 0,
    });
    await Promise.resolve();

    const pc = FakeRTCPeerConnection.instances[0]!;
    const playoutHistory: number[] = [];
    const jitterHistory: number[] = [];
    let playoutDelayVal = 0.1;
    let jitterTargetVal = 100;
    const trackedReceiver = {
      get playoutDelayHint() {
        return playoutDelayVal;
      },
      set playoutDelayHint(v: number) {
        playoutDelayVal = v;
        playoutHistory.push(v);
      },
      get jitterBufferTarget() {
        return jitterTargetVal;
      },
      set jitterBufferTarget(v: number) {
        jitterTargetVal = v;
        jitterHistory.push(v);
      },
    };

    pc.ontrack?.({
      receiver: trackedReceiver,
      streams: [{} as MediaStream],
      track: { kind: "video" } as MediaStreamTrack,
    });
    // MUST write ONLY jitterBufferTarget=0 and NEVER touch playoutDelayHint
    expect(jitterHistory).toEqual([0]);
    expect(playoutHistory).toEqual([]);

    // Across P2P low RTT, high WAN RTT, and TURN relay -> zero extra writes, no artificial floor!
    pc.statsEntries = [
      {
        id: "pair-1",
        type: "candidate-pair",
        nominated: true,
        state: "succeeded",
        currentRoundTripTime: 0.038,
        localCandidateId: "loc-srflx",
        remoteCandidateId: "rem-srflx",
      },
      { id: "loc-srflx", type: "local-candidate", candidateType: "srflx", address: "1.2.3.4" },
      { id: "rem-srflx", type: "remote-candidate", candidateType: "srflx", address: "5.6.7.8" },
    ];
    pc.connectionState = "connected";
    pc.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(2_000);

    pc.statsEntries = [
      {
        id: "pair-1",
        type: "candidate-pair",
        nominated: true,
        state: "succeeded",
        currentRoundTripTime: 0.085,
        localCandidateId: "loc-relay",
        remoteCandidateId: "rem-srflx",
      },
      {
        id: "loc-relay",
        type: "local-candidate",
        candidateType: "relay",
        address: "9.9.9.9",
        relayProtocol: "udp",
      },
      { id: "rem-srflx", type: "remote-candidate", candidateType: "srflx", address: "5.6.7.8" },
    ];
    await vi.advanceTimersByTimeAsync(2_000);
    expect(jitterHistory).toEqual([0]);
    expect(playoutHistory).toEqual([]);

    // Fallback test: receiver supporting ONLY playoutDelayHint (no jitterBufferTarget)
    const fallbackPlayoutHistory: number[] = [];
    let fallbackVal = 0.05;
    const legacyReceiver = {
      get playoutDelayHint() {
        return fallbackVal;
      },
      set playoutDelayHint(v: number) {
        fallbackVal = v;
        fallbackPlayoutHistory.push(v);
      },
    };
    pc.ontrack?.({
      receiver: legacyReceiver,
      streams: [{} as MediaStream],
      track: { kind: "video" } as MediaStreamTrack,
    });
    expect(fallbackPlayoutHistory).toEqual([0]);

    client.stopSession();
    client.disconnect();
  });
});

describe("RemoteClient smart auto quality preset and ws-jpeg fallback step-down", () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalRTC = globalThis.RTCPeerConnection;

  afterEach(() => {
    vi.useRealTimers();
    FakeWebSocket.instances = [];
    FakeRTCPeerConnection.instances = [];
    globalThis.WebSocket = originalWebSocket;
    globalThis.RTCPeerConnection = originalRTC;
  });

  it("defaults to auto preset on init/connect/startSession and sends auto: true via setQuality('auto')", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.RTCPeerConnection =
      FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;

    const client = new RemoteClient("ctrl-auto-quality");
    expect(client.getState().qualityPreset).toBe("auto");

    client.connectWithAccount({
      wsUrl: "wss://velodeck.example.com/ws",
      authToken: "jwt-valid",
      user: { userId: "u1", username: "alice", displayName: "Alice" },
      preferredTransport: "webrtc",
    });
    expect(client.getState().qualityPreset).toBe("auto");

    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    ws.emitJson({
      type: "controller.authed",
      clientId: "ctrl-auto-quality",
      serverTime: Date.now(),
      mode: "relay",
      authType: "account",
      user: { userId: "u1", username: "alice", displayName: "Alice" },
      devices: [makeDeviceSummary({ mediaProjection: true, webrtc: true })],
      iceServers: [],
    });

    client.startSession("dev-1");
    const req = parseSentMessages(ws).find((m) => m.type === "session.request");
    expect(req?.quality).toEqual(QUALITY_PRESETS.auto);
    expect((req?.quality as { auto?: boolean } | undefined)?.auto).toBe(true);

    const sessId = client.getState().sessionId!;
    ws.emitJson({
      type: "session.ready",
      sessionId: sessId,
      deviceId: "dev-1",
      transport: "webrtc",
      screenWidth: 1080,
      screenHeight: 2400,
      rotation: 0,
    });
    await Promise.resolve();

    const pc = FakeRTCPeerConnection.instances[0]!;
    expect(pc.dc).toBeTruthy();

    // Switch to hd then back to auto -> DataChannel carries QUALITY_PRESETS.auto with auto: true
    client.setQuality("hd");
    expect(client.getState().qualityPreset).toBe("hd");
    const hdCmd = JSON.parse(pc.dc!.sent[pc.dc!.sent.length - 1]!) as {
      type: string;
      command: { action: string; quality: Record<string, unknown> };
    };
    expect(hdCmd.type).toBe("control.cmd");
    expect(hdCmd.command).toEqual({ action: "quality", quality: QUALITY_PRESETS.hd });

    client.setQuality("auto");
    expect(client.getState().qualityPreset).toBe("auto");
    const autoCmd = JSON.parse(pc.dc!.sent[pc.dc!.sent.length - 1]!) as {
      type: string;
      command: { action: string; quality: Record<string, unknown> };
    };
    expect(autoCmd.type).toBe("control.cmd");
    expect(autoCmd.command).toEqual({ action: "quality", quality: QUALITY_PRESETS.auto });
    expect(autoCmd.command.quality.auto).toBe(true);

    client.disconnect();
  });

  it("applies clean hysteresis step-down/step-up in ws-jpeg auto mode without thrashing and leaves fixed presets untouched", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const client = new RemoteClient("ctrl-ws-auto");
    client.connectWithAccount({
      wsUrl: "wss://velodeck.example.com/ws",
      authToken: "jwt-valid",
      user: { userId: "u1", username: "alice", displayName: "Alice" },
      preferredTransport: "ws-jpeg",
    });

    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    ws.emitJson({
      type: "controller.authed",
      clientId: "ctrl-ws-auto",
      serverTime: Date.now(),
      mode: "relay",
      authType: "account",
      user: { userId: "u1", username: "alice", displayName: "Alice" },
      devices: [makeDeviceSummary({ mediaProjection: true, webrtc: false })],
      iceServers: [],
    });

    client.startSession("dev-1", { preferredTransport: "ws-jpeg" });
    const sessId = client.getState().sessionId!;
    ws.emitJson({
      type: "session.ready",
      sessionId: sessId,
      deviceId: "dev-1",
      transport: "ws-jpeg",
      screenWidth: 1080,
      screenHeight: 2400,
      rotation: 0,
    });

    const qualityCmds = () =>
      parseSentMessages(ws).filter(
        (m) =>
          m.type === "control.cmd" &&
          (m.command as { action?: string } | undefined)?.action === "quality",
      );

    // Single high-RTT spike does NOT step down (no thrashing)
    ws.emitJson({ type: "pong", ts: Date.now() - 280 });
    expect(qualityCmds()).toHaveLength(0);

    // Deadband sample resets streak
    ws.emitJson({ type: "pong", ts: Date.now() - 150 });
    ws.emitJson({ type: "pong", ts: Date.now() - 280 });
    expect(qualityCmds()).toHaveLength(0);

    // Second consecutive high-RTT sample steps down to eco (preserving auto: true)
    ws.emitJson({ type: "pong", ts: Date.now() - 300 });
    expect(qualityCmds()).toHaveLength(1);
    expect(qualityCmds()[0]?.command).toEqual({
      action: "quality",
      quality: { ...QUALITY_PRESETS.eco, auto: true },
    });
    expect(client.getState().qualityPreset).toBe("auto");

    // Low-RTT pongs within 10s cooldown do NOT step back up prematurely
    ws.emitJson({ type: "pong", ts: Date.now() - 40 });
    ws.emitJson({ type: "pong", ts: Date.now() - 40 });
    ws.emitJson({ type: "pong", ts: Date.now() - 40 });
    expect(qualityCmds()).toHaveLength(1);

    // After 10s cooldown, next healthy pong steps back up to QUALITY_PRESETS.auto
    vi.advanceTimersByTime(10_500);
    ws.emitJson({ type: "pong", ts: Date.now() - 40 });
    expect(qualityCmds()).toHaveLength(2);
    expect(qualityCmds()[1]?.command).toEqual({
      action: "quality",
      quality: QUALITY_PRESETS.auto,
    });

    // Fixed preset ("balanced") never triggers auto-step-down
    client.setQuality("balanced");
    const countAfterManual = qualityCmds().length;
    vi.advanceTimersByTime(15_000);
    ws.emitJson({ type: "pong", ts: Date.now() - 400 });
    ws.emitJson({ type: "pong", ts: Date.now() - 400 });
    ws.emitJson({ type: "pong", ts: Date.now() - 400 });
    expect(qualityCmds()).toHaveLength(countAfterManual);

    client.disconnect();
  });
});

describe("RemoteClient Pro Desktop features (FS RPC, chunked download, targetDir upload, audio transceiver, desktop quality)", () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalRTC = globalThis.RTCPeerConnection;

  afterEach(() => {
    vi.useRealTimers();
    FakeWebSocket.instances = [];
    FakeRTCPeerConnection.instances = [];
    globalThis.WebSocket = originalWebSocket;
    globalThis.RTCPeerConnection = originalRTC;
  });

  function makeDesktopDevice(deviceId = "pc-1") {
    return {
      ...makeDeviceSummary({ deviceId, mediaProjection: true, webrtc: true }),
      name: "Mac Studio",
      model: "Apple Silicon Mac",
      androidVersion: "macOS 15",
      screenWidth: 2560,
      screenHeight: 1440,
      deviceType: "desktop" as const,
      osPlatform: "darwin" as const,
      capabilities: {
        webrtc: true,
        wsJpeg: true,
        wsH264: false,
        wake: true,
        unlock: false,
        accessibility: true,
        mediaProjection: true,
        p2pFileTransfer: true,
        desktopAudio: true,
        privacyScreen: true,
        fileManager: true,
        powerControl: true,
        highRefresh: true,
      },
    };
  }

  async function setupDesktopSession() {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.RTCPeerConnection =
      FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;

    const client = new RemoteClient("ctrl-desktop-pro");
    client.connectWithAccount({
      wsUrl: "wss://velodeck.example.com/ws",
      authToken: "jwt-valid",
      user: { userId: "u1", username: "alice", displayName: "Alice" },
      preferredTransport: "webrtc",
    });

    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    ws.emitJson({
      type: "controller.authed",
      clientId: "ctrl-desktop-pro",
      serverTime: Date.now(),
      mode: "relay",
      authType: "account",
      user: { userId: "u1", username: "alice", displayName: "Alice" },
      devices: [makeDesktopDevice("pc-1"), makeDeviceSummary({ deviceId: "phone-1" })],
      iceServers: [],
    });

    client.startSession("pc-1", { preferredTransport: "webrtc" });
    const sessId = client.getState().sessionId!;
    ws.emitJson({
      type: "session.ready",
      sessionId: sessId,
      deviceId: "pc-1",
      transport: "webrtc",
      screenWidth: 2560,
      screenHeight: 1440,
      rotation: 0,
    });
    await Promise.resolve();

    const pc = FakeRTCPeerConnection.instances[0]!;
    const fileDc = pc.fileDc!;
    fileDc.onopen?.();
    return { client, ws, pc, fileDc };
  }

  it("adds audio recvonly transceiver for desktop targets (not Android) and tracks hasRemoteAudio on ontrack", async () => {
    const { client, ws, pc } = await setupDesktopSession();

    // Desktop session adds BOTH video and audio recvonly transceivers, and requests DESKTOP_QUALITY_PRESETS.auto
    expect(pc.transceiverCalls).toEqual([
      { kind: "video", init: { direction: "recvonly" } },
      { kind: "audio", init: { direction: "recvonly" } },
    ]);
    const desktopReq = parseSentMessages(ws).find((m) => m.type === "session.request");
    expect(desktopReq?.quality).toEqual(DESKTOP_QUALITY_PRESETS.auto);
    expect(client.getState().hasRemoteAudio).toBe(false);

    // Incoming stream with audio track sets hasRemoteAudio=true
    const streamWithAudio = {
      getAudioTracks: () => [{ id: "aud-1", kind: "audio" }],
      getTracks: () => [
        { id: "vid-1", kind: "video" },
        { id: "aud-1", kind: "audio" },
      ],
    } as unknown as MediaStream;
    pc.ontrack?.({
      streams: [streamWithAudio],
      track: { id: "aud-1", kind: "audio" } as MediaStreamTrack,
    });
    expect(client.getState().hasRemoteAudio).toBe(true);

    // Custom desktop quality preset sends exact quality command
    client.setDesktopStreamQuality(
      { ...DESKTOP_QUALITY_PRESETS.ultra, codec: "hevc" },
      "ultra",
    );
    const lastCmd = JSON.parse(pc.dc!.sent[pc.dc!.sent.length - 1]!) as {
      type: string;
      command: { action: string; quality: Record<string, unknown> };
    };
    expect(lastCmd.command).toEqual({
      action: "quality",
      quality: { ...DESKTOP_QUALITY_PRESETS.ultra, codec: "hevc" },
    });

    // Switching to Android target adds ONLY video transceiver (no audio transceiver)
    client.startSession("phone-1", { preferredTransport: "webrtc" });
    const phoneSessId = client.getState().sessionId!;
    ws.emitJson({
      type: "session.ready",
      sessionId: phoneSessId,
      deviceId: "phone-1",
      transport: "webrtc",
      screenWidth: 1080,
      screenHeight: 2400,
      rotation: 0,
    });
    await Promise.resolve();
    const phonePc = FakeRTCPeerConnection.instances[1]!;
    expect(phonePc.transceiverCalls).toEqual([
      { kind: "video", init: { direction: "recvonly" } },
    ]);
    expect(client.getState().hasRemoteAudio).toBe(false);

    client.disconnect();
  });

  it("handles fs_roots_req/res, fs_list_req/res, fs_mkdir_req/res, fs_delete_req/res over file DataChannel", async () => {
    const { client, fileDc } = await setupDesktopSession();

    // 1. fs_roots_req / fs_roots_res
    const rootsPromise = client.listRemoteFsRoots();
    expect(fileDc.sent).toHaveLength(1);
    const rootsReq = JSON.parse(fileDc.sent[0]!) as { type: string; reqId: string };
    expect(rootsReq.type).toBe("fs_roots_req");
    expect(typeof rootsReq.reqId).toBe("string");

    fileDc.emitMessage({
      type: "fs_roots_res",
      reqId: rootsReq.reqId,
      roots: [
        { name: "桌面", path: "/Users/alice/Desktop", kind: "desktop" },
        { name: "下载", path: "/Users/alice/Downloads", kind: "downloads" },
      ],
    });
    const roots = await rootsPromise;
    expect(roots).toEqual([
      { name: "桌面", path: "/Users/alice/Desktop", kind: "desktop" },
      { name: "下载", path: "/Users/alice/Downloads", kind: "downloads" },
    ]);

    // 2. fs_list_req / fs_list_res
    const listPromise = client.listRemoteFsDir("/Users/alice/Desktop");
    const listReq = JSON.parse(fileDc.sent[1]!) as {
      type: string;
      reqId: string;
      path: string;
    };
    expect(listReq.type).toBe("fs_list_req");
    expect(listReq.path).toBe("/Users/alice/Desktop");

    fileDc.emitMessage({
      type: "fs_list_res",
      reqId: listReq.reqId,
      path: "/Users/alice/Desktop",
      parentPath: "/Users/alice",
      entries: [
        {
          name: "notes.txt",
          path: "/Users/alice/Desktop/notes.txt",
          isDir: false,
          size: 42,
          mtimeMs: 1700000000000,
        },
      ],
    });
    const listing = await listPromise;
    expect(listing.path).toBe("/Users/alice/Desktop");
    expect(listing.parentPath).toBe("/Users/alice");
    expect(listing.entries).toHaveLength(1);
    expect(listing.entries[0]?.name).toBe("notes.txt");

    // 3. fs_mkdir_req / fs_mkdir_res
    const mkdirPromise = client.mkdirRemoteFs("/Users/alice/Desktop", "Demo");
    const mkdirReq = JSON.parse(fileDc.sent[2]!) as {
      type: string;
      reqId: string;
      parentPath: string;
      name: string;
    };
    expect(mkdirReq.type).toBe("fs_mkdir_req");
    expect(mkdirReq.parentPath).toBe("/Users/alice/Desktop");
    expect(mkdirReq.name).toBe("Demo");

    fileDc.emitMessage({
      type: "fs_mkdir_res",
      reqId: mkdirReq.reqId,
      ok: true,
      createdPath: "/Users/alice/Desktop/Demo",
    });
    expect(await mkdirPromise).toEqual({
      ok: true,
      createdPath: "/Users/alice/Desktop/Demo",
      error: undefined,
    });

    // 4. fs_delete_req / fs_delete_res
    const delPromise = client.deleteRemoteFs("/Users/alice/Desktop/notes.txt");
    const delReq = JSON.parse(fileDc.sent[3]!) as {
      type: string;
      reqId: string;
      targetPath: string;
    };
    expect(delReq.type).toBe("fs_delete_req");
    expect(delReq.targetPath).toBe("/Users/alice/Desktop/notes.txt");

    fileDc.emitMessage({
      type: "fs_delete_res",
      reqId: delReq.reqId,
      ok: true,
    });
    expect(await delPromise).toEqual({ ok: true, error: undefined });

    client.disconnect();
  });

  it("downloads remote file via chunked binary frames, verifies SHA-256, rejects corrupted digest, and supports cancel", async () => {
    const { client, fileDc } = await setupDesktopSession();

    const chunk1 = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const chunk2 = new Uint8Array([9, 10, 11, 12, 13, 14]);
    const full = new Uint8Array(chunk1.byteLength + chunk2.byteLength);
    full.set(chunk1, 0);
    full.set(chunk2, chunk1.byteLength);
    const expectedSha = await computeSha256Hex(full);

    const dlPromise = client.downloadRemoteFile("/Users/alice/Desktop/report.bin");
    const dlReq = JSON.parse(fileDc.sent[0]!) as {
      type: string;
      reqId: string;
      filePath: string;
    };
    expect(dlReq.type).toBe("fs_download_req");
    expect(dlReq.filePath).toBe("/Users/alice/Desktop/report.bin");
    expect(client.getState().fileDownload.active).toBe(true);

    fileDc.emitMessage({
      type: "fs_download_start",
      reqId: dlReq.reqId,
      fileName: "report.bin",
      size: full.byteLength,
      mimeType: "application/octet-stream",
    });
    fileDc.emitBinary(chunk1.buffer);
    fileDc.emitBinary(chunk2);
    fileDc.emitMessage({
      type: "fs_download_end",
      reqId: dlReq.reqId,
      sha256: expectedSha,
      size: full.byteLength,
    });

    const result = await dlPromise;
    expect(result.fileName).toBe("report.bin");
    expect(result.sha256).toBe(expectedSha);
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(full);
    expect(client.getState().fileDownload.active).toBe(false);
    expect(client.getState().fileDownload.error).toBeNull();

    // Corrupted SHA-256 must reject cleanly
    const badPromise = client.downloadRemoteFile("/Users/alice/Desktop/corrupt.bin");
    const badReq = JSON.parse(fileDc.sent[1]!) as { reqId: string };
    fileDc.emitMessage({
      type: "fs_download_start",
      reqId: badReq.reqId,
      fileName: "corrupt.bin",
      size: chunk1.byteLength,
      mimeType: "application/octet-stream",
    });
    fileDc.emitBinary(chunk1.buffer);
    fileDc.emitMessage({
      type: "fs_download_end",
      reqId: badReq.reqId,
      sha256: "f".repeat(64),
      size: chunk1.byteLength,
    });
    await expect(badPromise).rejects.toThrow("SHA-256");

    // Cancel sends fs_download_cancel and rejects cleanly
    const cancelPromise = client.downloadRemoteFile("/Users/alice/Desktop/huge.zip");
    const cancelReq = JSON.parse(fileDc.sent[2]!) as { reqId: string };
    client.cancelRemoteFileDownload();
    await expect(cancelPromise).rejects.toThrow("已取消下载");
    const cancelMsg = JSON.parse(fileDc.sent[3]!) as {
      type: string;
      reqId: string;
    };
    expect(cancelMsg).toEqual({
      type: "fs_download_cancel",
      reqId: cancelReq.reqId,
    });

    client.disconnect();
  });

  it("includes targetDir in file.offer when uploading into a RemoteFileBrowser folder", async () => {
    const { client, fileDc } = await setupDesktopSession();

    const payload = new Uint8Array([10, 20, 30, 40]);
    const uploadPromise = client.sendFileOverWebRtc(payload, {
      fileName: "hello.txt",
      mimeType: "text/plain",
      purpose: "file",
      targetDir: "/Users/alice/Desktop/Work",
    });

    await vi.waitFor(() => {
      expect(fileDc.sent).toHaveLength(1);
    });

    const offer = JSON.parse(fileDc.sent[0]!) as Record<string, unknown>;
    expect(offer.type).toBe("file.offer");
    expect(offer.fileName).toBe("hello.txt");
    expect(offer.targetDir).toBe("/Users/alice/Desktop/Work");

    const transferId = offer.transferId as string;
    fileDc.emitMessage({ type: "file.accept", transferId });
    await vi.waitFor(() => {
      expect(fileDc.sent).toHaveLength(2);
    });
    fileDc.emitMessage({
      type: "file.done",
      transferId,
      savedPath: "/Users/alice/Desktop/Work/hello.txt",
    });

    const done = await uploadPromise;
    expect(done.status).toBe("done");
    expect(done.savedPath).toBe("/Users/alice/Desktop/Work/hello.txt");

    client.disconnect();
  });

  it("opens terminal DataChannel only for desktop targets and supports open/input/resize/close and events", async () => {
    const { client, ws, pc } = await setupDesktopSession();

    const termDc = pc.terminalDc;
    expect(termDc).toBeTruthy();
    expect(termDc?.options).toEqual({ ordered: true });
    expect(client.getState().terminalReady).toBe(false);

    termDc!.onopen?.();
    expect(client.getState().terminalReady).toBe(true);

    const received: Array<Record<string, unknown>> = [];
    const unsub = client.onTerminalEvent((ev) => {
      received.push(ev as unknown as Record<string, unknown>);
    });

    const termId = client.openTerminal(120, 40);
    expect(termId).toMatch(/^term-/);
    expect(JSON.parse(termDc!.sent[0]!)).toEqual({
      type: "term_open",
      termId,
      cols: 120,
      rows: 40,
    });

    expect(client.sendTerminalInput(termId, "ls -la\n")).toBe(true);
    expect(JSON.parse(termDc!.sent[1]!)).toEqual({
      type: "term_data",
      termId,
      data: "ls -la\n",
    });

    expect(client.resizeTerminal(termId, 140, 48)).toBe(true);
    expect(JSON.parse(termDc!.sent[2]!)).toEqual({
      type: "term_resize",
      termId,
      cols: 140,
      rows: 48,
    });

    termDc!.emitMessage({
      type: "term_ready",
      termId,
      shell: "/bin/zsh",
      cwd: "/Users/alice",
    });
    termDc!.emitMessage({
      type: "term_data",
      termId,
      data: "hello world\r\n",
    });
    termDc!.emitMessage({
      type: "term_error",
      termId,
      error: "minor warning",
    });
    termDc!.emitMessage({
      type: "term_exit",
      termId,
      exitCode: 0,
    });

    expect(received).toEqual([
      { type: "term_ready", termId, shell: "/bin/zsh", cwd: "/Users/alice" },
      { type: "term_data", termId, data: "hello world\r\n" },
      { type: "term_error", termId, error: "minor warning" },
      { type: "term_exit", termId, exitCode: 0 },
    ]);

    client.closeTerminal(termId);
    expect(JSON.parse(termDc!.sent[3]!)).toEqual({
      type: "term_close",
      termId,
    });

    termDc!.onclose?.();
    expect(client.getState().terminalReady).toBe(false);
    unsub();

    // Switching to Android target must NOT create a terminal DataChannel
    client.startSession("phone-1", { preferredTransport: "webrtc" });
    const phoneSessId = client.getState().sessionId!;
    ws.emitJson({
      type: "session.ready",
      sessionId: phoneSessId,
      deviceId: "phone-1",
      transport: "webrtc",
      screenWidth: 1080,
      screenHeight: 2400,
      rotation: 0,
    });
    await Promise.resolve();
    const phonePc = FakeRTCPeerConnection.instances[1]!;
    expect(phonePc.terminalDc).toBeNull();

    client.disconnect();
  });

  it("routes mouse_move_relative over pointer DC, block_input/whiteboard over control DC, and updates cursor state from pointer DC and WS", async () => {
    const { client, ws, pc } = await setupDesktopSession();
    const sessId = client.getState().sessionId!;

    pc.pointerDc!.onopen?.();
    pc.dc!.onopen?.();

    const relRes = client.sendCommand({ action: "mouse_move_relative", dx: 12, dy: -7 });
    expect(relRes.sent).toBe(true);
    expect(relRes.channel).toBe("datachannel");
    expect(pc.pointerDc!.sent).toHaveLength(1);
    expect(JSON.parse(pc.pointerDc!.sent[0]!).command).toEqual({
      action: "mouse_move_relative",
      dx: 12,
      dy: -7,
    });

    client.sendCommand({ action: "block_input", enabled: true });
    client.sendCommand({ action: "whiteboard", op: "clear" });
    expect(pc.dc!.sent).toHaveLength(2);
    expect(JSON.parse(pc.dc!.sent[0]!).command).toEqual({
      action: "block_input",
      enabled: true,
    });
    expect(JSON.parse(pc.dc!.sent[1]!).command).toEqual({
      action: "whiteboard",
      op: "clear",
    });

    // Cursor update over pointer DataChannel
    pc.pointerDc!.emitMessage({
      type: "cursor.update",
      sessionId: sessId,
      deviceId: "pc-1",
      shape: "text",
      visible: true,
    });
    expect(client.getState().remoteCursorShape).toBe("text");
    expect(client.getState().remoteCursorVisible).toBe(true);

    // Mismatched sessionId cursor update over DC must be ignored
    pc.pointerDc!.emitMessage({
      type: "cursor.update",
      sessionId: "wrong-sess",
      deviceId: "pc-1",
      shape: "pointer",
      visible: false,
    });
    expect(client.getState().remoteCursorShape).toBe("text");
    expect(client.getState().remoteCursorVisible).toBe(true);

    // Cursor update over WebSocket
    ws.emitJson({
      type: "cursor.update",
      sessionId: sessId,
      deviceId: "pc-1",
      shape: "ew-resize",
      visible: false,
    });
    expect(client.getState().remoteCursorShape).toBe("ew-resize");
    expect(client.getState().remoteCursorVisible).toBe(false);

    client.disconnect();
  });

  it("handles chat.msg send/receive over control DC and WS, unread counter, deduplication, and 100-message cap", async () => {
    const { client, ws, pc } = await setupDesktopSession();
    const sessId = client.getState().sessionId!;
    pc.dc!.onopen?.();

    // Send chat from controller over control DC
    expect(client.sendChatMessage("  你好，远端电脑  ")).toBe(true);
    expect(client.getState().chatMessages).toHaveLength(1);
    expect(client.getState().chatMessages[0]?.sender).toBe("controller");
    expect(client.getState().chatMessages[0]?.text).toBe("你好，远端电脑");
    expect(client.getState().unreadChatCount).toBe(0);
    const sentChat = JSON.parse(pc.dc!.sent[0]!) as Record<string, unknown>;
    expect(sentChat.type).toBe("chat.msg");
    expect(sentChat.text).toBe("你好，远端电脑");

    // Receive chat from host over control DC
    pc.dc!.emitMessage({
      type: "chat.msg",
      sessionId: sessId,
      deviceId: "pc-1",
      id: "host-msg-1",
      sender: "host",
      senderName: "Mac Studio",
      text: "收到，可以操作",
      ts: 1700000001000,
    });
    // Duplicate ID ignored
    pc.dc!.emitMessage({
      type: "chat.msg",
      sessionId: sessId,
      deviceId: "pc-1",
      id: "host-msg-1",
      sender: "host",
      senderName: "Mac Studio",
      text: "收到，可以操作",
      ts: 1700000001000,
    });
    expect(client.getState().chatMessages).toHaveLength(2);
    expect(client.getState().unreadChatCount).toBe(1);

    // Receive chat from host over WS
    ws.emitJson({
      type: "chat.msg",
      sessionId: sessId,
      deviceId: "pc-1",
      id: "host-msg-2",
      sender: "host",
      text: "第二条消息",
      ts: 1700000002000,
    });
    expect(client.getState().chatMessages).toHaveLength(3);
    expect(client.getState().unreadChatCount).toBe(2);

    client.markChatRead();
    expect(client.getState().unreadChatCount).toBe(0);

    // Cap at 100 messages
    for (let i = 0; i < 110; i++) {
      ws.emitJson({
        type: "chat.msg",
        sessionId: sessId,
        deviceId: "pc-1",
        id: `burst-${i}`,
        sender: "host",
        text: `msg-${i}`,
        ts: 1700000003000 + i,
      });
    }
    expect(client.getState().chatMessages).toHaveLength(100);
    expect(client.getState().chatMessages[99]?.id).toBe("burst-109");

    client.disconnect();
  });

  it("handles session.pending approval wait without premature timeout, stores session.permissions, and sends sessionless WOL relay over WS", async () => {
    vi.useFakeTimers();
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.RTCPeerConnection =
      FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;

    const client = new RemoteClient("ctrl-approval-wol");
    client.connectWithAccount({
      wsUrl: "wss://velodeck.example.com/ws",
      authToken: "jwt-valid",
      user: { userId: "u1", username: "alice", displayName: "Alice" },
      preferredTransport: "webrtc",
    });

    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    ws.emitJson({
      type: "controller.authed",
      clientId: "ctrl-approval-wol",
      serverTime: Date.now(),
      mode: "relay",
      authType: "account",
      user: { userId: "u1", username: "alice", displayName: "Alice" },
      devices: [makeDesktopDevice("pc-1")],
      iceServers: [],
    });

    // Sessionless WOL relay works directly over WS with empty sessionId
    expect(client.sendWolRelay("pc-1", "AA:BB:CC:DD:EE:FF", "192.168.1.255")).toBe(
      true,
    );
    const wolMsg = parseSentMessages(ws).find(
      (m) =>
        m.type === "control.cmd" &&
        (m.command as { action?: string } | undefined)?.action === "wol",
    );
    expect(wolMsg).toMatchObject({
      type: "control.cmd",
      sessionId: "",
      deviceId: "pc-1",
      command: {
        action: "wol",
        macAddress: "AA:BB:CC:DD:EE:FF",
        broadcastIp: "192.168.1.255",
      },
    });

    // Start session and enter human approval pending state
    client.startSession("pc-1", { preferredTransport: "webrtc" });
    const sessId = client.getState().sessionId!;

    ws.emitJson({
      type: "session.pending",
      sessionId: sessId,
      deviceId: "pc-1",
      message: "等待被控端主人点击允许...",
    });
    expect(client.getState().pendingApprovalMessage).toBe("等待被控端主人点击允许...");

    // Advancing 20s while waiting for human approval must NOT timeout/fallback the session
    vi.advanceTimersByTime(20_000);
    expect(client.getState().sessionId).toBe(sessId);
    expect(client.getState().pendingApprovalMessage).toBe("等待被控端主人点击允许...");
    expect(client.getState().sessionStatus).toBe("requesting");

    // Host approves and sends session.permissions + session.ready
    ws.emitJson({
      type: "session.permissions",
      sessionId: sessId,
      deviceId: "pc-1",
      permissions: {
        mouse: true,
        keyboard: true,
        clipboard: true,
        fileTransfer: false,
        audio: true,
        terminal: false,
      },
    });
    expect(client.getState().sessionPermissions).toEqual({
      mouse: true,
      keyboard: true,
      clipboard: true,
      fileTransfer: false,
      audio: true,
      terminal: false,
    });

    ws.emitJson({
      type: "session.ready",
      sessionId: sessId,
      deviceId: "pc-1",
      transport: "webrtc",
      screenWidth: 2560,
      screenHeight: 1440,
      rotation: 0,
    });
    expect(client.getState().pendingApprovalMessage).toBeNull();
    expect(client.getState().sessionStatus).toBe("negotiating");

    client.disconnect();
  });

  it("returns empty termId from openTerminal when terminal channel is not open", async () => {
    const { client, pc } = await setupDesktopSession();

    // Closed / not open channel must return "" instead of a fake termId
    pc.terminalDc!.readyState = "connecting";
    expect(client.openTerminal(80, 24)).toBe("");
    expect(pc.terminalDc!.sent).toHaveLength(0);

    // When send() throws, return ""
    pc.terminalDc!.readyState = "open";
    const origSend = pc.terminalDc!.send.bind(pc.terminalDc);
    pc.terminalDc!.send = () => {
      throw new Error("dc send failure");
    };
    expect(client.openTerminal(80, 24)).toBe("");
    pc.terminalDc!.send = origSend;

    client.disconnect();
  });

  it("localizes rejected_by_host and host_busy session.end reasons and clears sessionPermissions on fallback/offline", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { client, ws, pc } = await setupDesktopSession();
      const sess1 = client.getState().sessionId!;

      // Set sessionPermissions and simulate WebRTC fallback -> sessionPermissions MUST clear
      ws.emitJson({
        type: "session.permissions",
        sessionId: sess1,
        deviceId: "pc-1",
        permissions: { keyboard: false, mouse: true },
      });
      expect(client.getState().sessionPermissions).toEqual({
        keyboard: false,
        mouse: true,
      });

      pc.iceConnectionState = "failed";
      pc.oniceconnectionstatechange?.();
      expect(client.getState().sessionStatus).toBe("fallback");
      expect(client.getState().sessionPermissions).toBeNull();

      // session.end rejected_by_host
      const fallbackSessId = client.getState().sessionId!;
      ws.emitJson({
        type: "session.end",
        sessionId: fallbackSessId,
        deviceId: "pc-1",
        reason: "rejected_by_host",
      });
      expect(client.getState().errorMessage).toBe("被控电脑拒绝了接入请求");

      // session.end host_busy
      client.startSession("pc-1", { preferredTransport: "webrtc" });
      const busySessId = client.getState().sessionId!;
      ws.emitJson({
        type: "session.end",
        sessionId: busySessId,
        deviceId: "pc-1",
        reason: "host_busy",
      });
      expect(client.getState().errorMessage).toBe("被控电脑当前已有活跃控制会话");

      // Offline reconnect branch clears sessionPermissions
      client.startSession("pc-1", { preferredTransport: "webrtc" });
      const offlineSessId = client.getState().sessionId!;
      ws.emitJson({
        type: "session.permissions",
        sessionId: offlineSessId,
        deviceId: "pc-1",
        permissions: { terminal: false },
      });
      ws.emitJson({
        type: "controller.authed",
        clientId: "ctrl-desktop-test",
        serverTime: Date.now(),
        mode: "relay",
        authType: "account",
        user: { userId: "u1", username: "alice", displayName: "Alice" },
        devices: [{ ...makeDesktopDevice("pc-1"), online: false }],
        iceServers: [],
      });
      expect(client.getState().sessionStatus).toBe("error");
      expect(client.getState().sessionPermissions).toBeNull();

      client.disconnect();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("gates sendWolRelay on connected socketStatus and resolves sendWolRelayWithAck on ACK/timeout/disconnect", async () => {
    vi.useFakeTimers();
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.RTCPeerConnection =
      FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;

    const client = new RemoteClient("ctrl-wol-ack");
    // Before connected -> rejected cleanly
    expect(client.sendWolRelay("pc-1", "AA:BB:CC:DD:EE:FF")).toBe(false);
    expect(
      await client.sendWolRelayWithAck("pc-1", "AA:BB:CC:DD:EE:FF"),
    ).toMatchObject({ ok: false });

    client.connectWithAccount({
      wsUrl: "wss://velodeck.example.com/ws",
      authToken: "jwt-valid",
      user: { userId: "u1", username: "alice", displayName: "Alice" },
      preferredTransport: "webrtc",
    });

    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    // Still authenticating (not connected) -> rejected cleanly
    expect(client.sendWolRelay("pc-1", "AA:BB:CC:DD:EE:FF")).toBe(false);

    ws.emitJson({
      type: "controller.authed",
      clientId: "ctrl-wol-ack",
      serverTime: Date.now(),
      mode: "relay",
      authType: "account",
      user: { userId: "u1", username: "alice", displayName: "Alice" },
      devices: [makeDesktopDevice("pc-1"), makeDesktopDevice("pc-2")],
      iceServers: [],
    });

    // 1. Peer 1 returns negative ACK -> resolves { ok: false } without spurious toast
    const ackPromise1 = client.sendWolRelayWithAck(
      "pc-1",
      "AA:BB:CC:DD:EE:FF",
      "192.168.1.255",
      2000,
    );
    const sent1 = parseSentMessages(ws).find(
      (m) => m.type === "control.cmd" && m.deviceId === "pc-1",
    );
    expect(sent1).toBeDefined();
    ws.emitJson({
      type: "control.ack",
      sessionId: "",
      deviceId: "pc-1",
      seq: sent1!.seq,
      ok: false,
      message: "subnet unreachable",
    });
    expect(await ackPromise1).toEqual({
      ok: false,
      message: "subnet unreachable",
    });
    expect(client.getState().lastNotice).toBeNull();

    // 2. Peer 2 returns positive ACK -> resolves { ok: true }
    const ackPromise2 = client.sendWolRelayWithAck(
      "pc-2",
      "AA:BB:CC:DD:EE:FF",
      "192.168.1.255",
      2000,
    );
    const sent2 = parseSentMessages(ws).find(
      (m) => m.type === "control.cmd" && m.deviceId === "pc-2",
    );
    ws.emitJson({
      type: "control.ack",
      sessionId: "",
      deviceId: "pc-2",
      seq: sent2!.seq,
      ok: true,
    });
    expect(await ackPromise2).toEqual({ ok: true, message: undefined });

    // 3. Timeout resolves { ok: false }
    const timeoutPromise = client.sendWolRelayWithAck(
      "pc-2",
      "AA:BB:CC:DD:EE:FF",
      undefined,
      1000,
    );
    vi.advanceTimersByTime(1000);
    expect(await timeoutPromise).toMatchObject({ ok: false });

    client.disconnect();
  });

  it("tears down peer connection, aborts pending FS requests, and detaches listeners on UNAUTHORIZED error and close 4001", async () => {
    const { client, ws, pc } = await setupDesktopSession();
    const sessId = client.getState().sessionId!;
    ws.emitJson({
      type: "session.permissions",
      sessionId: sessId,
      deviceId: "pc-1",
      permissions: { keyboard: true },
    });

    const fsPromise = client.listRemoteFsRoots();
    ws.emitJson({
      type: "error",
      code: "UNAUTHORIZED",
      message: "token expired",
    });

    await expect(fsPromise).rejects.toThrow();
    expect(pc.connectionState).toBe("closed");
    expect(client.getState().socketStatus).toBe("error");
    expect(client.getState().sessionPermissions).toBeNull();

    // Test terminal close code 4001 cleanup as well
    FakeWebSocket.instances = [];
    FakeRTCPeerConnection.instances = [];
    const setup2 = await setupDesktopSession();
    const sessId2 = setup2.client.getState().sessionId!;
    setup2.ws.emitJson({
      type: "session.permissions",
      sessionId: sessId2,
      deviceId: "pc-1",
      permissions: { mouse: true },
    });
    const fsPromise2 = setup2.client.listRemoteFsRoots();
    setup2.ws.onclose?.({ code: 4001, reason: "revoked" } as CloseEvent);

    await expect(fsPromise2).rejects.toThrow();
    expect(setup2.pc.connectionState).toBe("closed");
    expect(setup2.client.getState().socketStatus).toBe("error");
    expect(setup2.client.getState().errorCode).toBe("UNAUTHORIZED");
    expect(setup2.client.getState().sessionPermissions).toBeNull();
  });
});
