import { afterEach, describe, expect, it, vi } from "vitest";
import { FRAME_TYPE_JPEG, encodeMediaFrame } from "@velodeck/protocol";
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
  channels = new Map<string, FakeDataChannel>();
  offerCalls: Array<RTCOfferOptions | undefined> = [];
  statsEntries: Array<Record<string, unknown>> = [];

  ontrack: ((ev: unknown) => void) | null = null;
  onicecandidate: ((ev: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;

  constructor(config?: RTCConfiguration) {
    this.config = config;
    FakeRTCPeerConnection.instances.push(this);
  }

  addTransceiver(): { setCodecPreferences: ReturnType<typeof vi.fn> } {
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

  async addIceCandidate(): Promise<void> {
    // No-op
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
        iceCandidatePoolSize: 2,
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

  it("sets ultra-low-latency receiver hints (16ms), polls rich WebRTC telemetry with deltas/ICE pair, supports requestKeyframe, and resets telemetry on stop/disconnect", async () => {
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

    // Trigger ontrack with playoutDelayHint / jitterBufferTarget receiver
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
    expect(fakeReceiver.playoutDelayHint).toBe(0.016);
    expect(fakeReceiver.jitterBufferTarget).toBe(16);

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

    // Sample 5: relay -> TURN Relay
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

  it("P1-3: uses unordered pointer DataChannel for touch_move with backpressure drop, control DC failover, and 180ms keepalive", async () => {
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
    expect(pc.pointerDc?.options).toEqual({ ordered: false, maxRetransmits: 0 });

    // touch_move routes over pointer DC
    const moveRes = client.sendCommand({ action: "touch_move", pointerId: 1, x: 0.5, y: 0.5 });
    expect(moveRes.sent).toBe(true);
    expect(moveRes.channel).toBe("datachannel");
    expect(pc.pointerDc?.sent).toHaveLength(1);
    expect(pc.dc?.sent).toHaveLength(0);

    // Backpressure > 4096 drops stale touch_move
    pc.pointerDc!.bufferedAmount = 5_000;
    const dropped = client.sendCommand({ action: "touch_move", pointerId: 1, x: 0.6, y: 0.6 });
    expect(dropped.sent).toBe(false);
    expect(dropped.channel).toBe("none");
    pc.pointerDc!.bufferedAmount = 0;

    // Non-move command routes over control DC, and fails over to WS if bufferedAmount > 65536
    const tapRes = client.sendCommand({ action: "tap", x: 0.2, y: 0.3 });
    expect(tapRes.channel).toBe("datachannel");
    expect(pc.dc?.sent).toHaveLength(1);

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
  it("selects coarse playout delay buckets for LAN P2P, moderate WAN, high RTT, and TURN", () => {
    // LAN / low-RTT P2P (< 25ms) -> 16ms
    expect(selectAdaptivePlayoutDelayMs("p2p", 1)).toBe(16);
    expect(selectAdaptivePlayoutDelayMs("p2p", 12)).toBe(16);
    expect(selectAdaptivePlayoutDelayMs("p2p", 24)).toBe(16);

    // Moderate WAN (25ms <= rtt < 60ms, non-TURN) -> 30ms
    expect(selectAdaptivePlayoutDelayMs("p2p", 25)).toBe(30);
    expect(selectAdaptivePlayoutDelayMs("p2p", 42)).toBe(30);
    expect(selectAdaptivePlayoutDelayMs("p2p", 59)).toBe(30);
    expect(selectAdaptivePlayoutDelayMs(null, 35)).toBe(30);

    // High RTT (>= 60ms) or TURN relay -> 45ms
    expect(selectAdaptivePlayoutDelayMs("p2p", 60)).toBe(45);
    expect(selectAdaptivePlayoutDelayMs("p2p", 110)).toBe(45);
    expect(selectAdaptivePlayoutDelayMs(null, 65)).toBe(45);
    expect(selectAdaptivePlayoutDelayMs("turn", 10)).toBe(45);
    expect(selectAdaptivePlayoutDelayMs("turn", 40)).toBe(45);
    expect(selectAdaptivePlayoutDelayMs("turn", 85)).toBe(45);
    expect(selectAdaptivePlayoutDelayMs("turn", null)).toBe(45);

    // Missing RTT on non-TURN route preserves fallback bucket without thrashing
    expect(selectAdaptivePlayoutDelayMs("p2p", null, 30)).toBe(30);
    expect(selectAdaptivePlayoutDelayMs(null, null, 16)).toBe(16);
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

  it("adapts playoutDelayHint and jitterBufferTarget across P2P/WAN/TURN buckets without thrashing", async () => {
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
    expect(playoutHistory).toEqual([0.016]);
    expect(jitterHistory).toEqual([16]);

    // Poll 1 & 2: P2P low RTT (12ms, 18ms) -> remains in 16ms bucket, NO extra writes
    pc.statsEntries = [
      {
        id: "pair-1",
        type: "candidate-pair",
        nominated: true,
        state: "succeeded",
        currentRoundTripTime: 0.012,
        localCandidateId: "loc-1",
        remoteCandidateId: "rem-1",
      },
      { id: "loc-1", type: "local-candidate", candidateType: "host", address: "192.168.1.2" },
      { id: "rem-1", type: "remote-candidate", candidateType: "host", address: "192.168.1.3" },
    ];
    pc.connectionState = "connected";
    pc.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(playoutHistory).toEqual([0.016]);
    expect(jitterHistory).toEqual([16]);

    // Poll 3 & 4: Moderate WAN P2P RTT (38ms) -> shifts once to 30ms (0.03s), no thrash on second poll
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
    await vi.advanceTimersByTimeAsync(2_000);
    expect(playoutHistory).toEqual([0.016, 0.03]);
    expect(jitterHistory).toEqual([16, 30]);

    // Poll 5: TURN relay (even with low RTT 18ms) -> shifts to 45ms (0.045s)
    pc.statsEntries = [
      {
        id: "pair-1",
        type: "candidate-pair",
        nominated: true,
        state: "succeeded",
        currentRoundTripTime: 0.018,
        localCandidateId: "loc-relay",
        remoteCandidateId: "rem-srflx",
      },
      { id: "loc-relay", type: "local-candidate", candidateType: "relay", address: "9.9.9.9" },
      { id: "rem-srflx", type: "remote-candidate", candidateType: "srflx", address: "5.6.7.8" },
    ];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(playoutHistory).toEqual([0.016, 0.03, 0.045]);
    expect(jitterHistory).toEqual([16, 30, 45]);

    // Poll 6: Back to low-RTT P2P (10ms) -> drops back down to 16ms (0.016s)
    pc.statsEntries = [
      {
        id: "pair-1",
        type: "candidate-pair",
        nominated: true,
        state: "succeeded",
        currentRoundTripTime: 0.01,
        localCandidateId: "loc-1",
        remoteCandidateId: "rem-1",
      },
      { id: "loc-1", type: "local-candidate", candidateType: "host", address: "192.168.1.2" },
      { id: "rem-1", type: "remote-candidate", candidateType: "host", address: "192.168.1.3" },
    ];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(playoutHistory).toEqual([0.016, 0.03, 0.045, 0.016]);
    expect(jitterHistory).toEqual([16, 30, 45, 16]);

    // Cleanup on stopSession/disconnect prevents further mutations
    client.stopSession();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(playoutHistory).toEqual([0.016, 0.03, 0.045, 0.016]);
    expect(jitterHistory).toEqual([16, 30, 45, 16]);

    client.disconnect();
  });
});
