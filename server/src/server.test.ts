import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, type RawData } from "ws";
import {
  DESKTOP_QUALITY_PRESETS,
  FRAME_TYPE_JPEG,
  QUALITY_PRESETS,
  decodeMediaFrame,
  encodeMediaFrame,
  formatControlCode,
  type AgentRegisterMessage,
  type AgentRegisteredMessage,
  type ChatMessage,
  type ClipboardSyncMessage,
  type ControlAckMessage,
  type ControlCmdMessage,
  type ControllerAuthedMessage,
  type CursorUpdateMessage,
  type DeviceStatusMessage,
  type DisplayInfo,
  type ErrorMessage,
  type PongMessage,
  type RtcAnswerMessage,
  type RtcIceMessage,
  type RtcOfferMessage,
  type SessionEndMessage,
  type SessionPendingMessage,
  type SessionPermissionsMessage,
  type SessionReadyMessage,
  type SessionRequestMessage,
  type UserProfile,
  type WhiteboardStroke,
  type WireMessage,
} from "@velodeck/protocol";
import { AsyncSemaphore, verifyPassword } from "./auth.js";
import { DEFAULT_STUN_URLS, loadConfig, type ServerConfig } from "./config.js";
import { createVeloDeckServer, type VeloDeckServer } from "./httpServer.js";
import { cloneDeviceSummary, VeloDeckStore } from "./store.js";
import { buildIceServers } from "./turn.js";

class TestWsClient {
  public readonly ws: WebSocket;
  private readonly jsonQueue: WireMessage[] = [];
  private readonly jsonWaiters: Array<(msg: WireMessage) => void> = [];
  private readonly binQueue: Buffer[] = [];
  private readonly binWaiters: Array<(buf: Buffer) => void> = [];
  private closedInfo: { code: number; reason: string } | null = null;
  private readonly closeWaiters: Array<(info: { code: number; reason: string }) => void> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        const waiter = this.binWaiters.shift();
        if (waiter) {
          waiter(buf);
        } else {
          this.binQueue.push(buf);
        }
      } else {
        const text = Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : Buffer.from(data).toString("utf8");
        const parsed = JSON.parse(text) as WireMessage;
        const waiter = this.jsonWaiters.shift();
        if (waiter) {
          waiter(parsed);
        } else {
          this.jsonQueue.push(parsed);
        }
      }
    });

    ws.on("close", (code: number, reasonBuf: Buffer) => {
      this.closedInfo = { code, reason: reasonBuf.toString("utf8") };
      while (this.closeWaiters.length > 0) {
        const waiter = this.closeWaiters.shift();
        waiter?.(this.closedInfo);
      }
    });
  }

  public static connect(url: string, headers?: Record<string, string>): Promise<TestWsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, headers ? { headers } : undefined);
      const client = new TestWsClient(ws);
      ws.once("open", () => resolve(client));
      ws.once("error", (err) => reject(err));
    });
  }

  public sendJson(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  public sendRawText(text: string): void {
    this.ws.send(text);
  }

  public sendBinary(buf: Uint8Array | Buffer): void {
    this.ws.send(buf, { binary: true });
  }

  public nextJson<T extends WireMessage = WireMessage>(timeoutMs = 5000): Promise<T> {
    const queued = this.jsonQueue.shift();
    if (queued) {
      return Promise.resolve(queued as T);
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.jsonWaiters.indexOf(onMsg);
        if (idx >= 0) this.jsonWaiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for JSON message after ${timeoutMs}ms`));
      }, timeoutMs);

      const onMsg = (msg: WireMessage) => {
        clearTimeout(timer);
        resolve(msg as T);
      };
      this.jsonWaiters.push(onMsg);
    });
  }

  public nextBinary(timeoutMs = 5000): Promise<Buffer> {
    const queued = this.binQueue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.binWaiters.indexOf(onBin);
        if (idx >= 0) this.binWaiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for binary frame after ${timeoutMs}ms`));
      }, timeoutMs);

      const onBin = (buf: Buffer) => {
        clearTimeout(timer);
        resolve(buf);
      };
      this.binWaiters.push(onBin);
    });
  }

  public waitForClose(timeoutMs = 5000): Promise<{ code: number; reason: string }> {
    if (this.closedInfo) {
      return Promise.resolve(this.closedInfo);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.closeWaiters.indexOf(onClose);
        if (idx >= 0) this.closeWaiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for socket close after ${timeoutMs}ms`));
      }, timeoutMs);

      const onClose = (info: { code: number; reason: string }) => {
        clearTimeout(timer);
        resolve(info);
      };
      this.closeWaiters.push(onClose);
    });
  }

  public drainJson(): WireMessage[] {
    return this.jsonQueue.splice(0, this.jsonQueue.length);
  }

  public async close(): Promise<void> {
    if (
      this.ws.readyState === WebSocket.CLOSED ||
      this.ws.readyState === WebSocket.CLOSING
    ) {
      await this.waitForClose(1000).catch(() => {});
      return;
    }
    this.ws.close();
    await this.waitForClose(2000).catch(() => {});
  }
}

function makeTestConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    ...loadConfig({}),
    host: "127.0.0.1",
    port: 0,
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 120_000,
    staticDir: path.join(os.tmpdir(), "velodeck-nonexistent-static-dir"),
    dataDir: ":memory:",
    apkPath: path.join(os.tmpdir(), "velodeck-nonexistent-agent.apk"),
    ...overrides,
  };
}

function makeAgentRegister(
  overrides: Partial<AgentRegisterMessage> = {},
): AgentRegisterMessage {
  return {
    type: "agent.register",
    deviceId: "dev-pixel-9",
    deviceSecret: "super-secret-device-key",
    controlPassword: "unattended-pass-123",
    name: "Pixel 9 Pro",
    model: "Pixel 9 Pro",
    androidVersion: "15",
    screenWidth: 1080,
    screenHeight: 2400,
    rotation: 0,
    battery: 85,
    charging: false,
    locked: false,
    screenOn: true,
    capabilities: {
      webrtc: true,
      wsJpeg: true,
      wsH264: false,
      wake: true,
      unlock: false,
      accessibility: true,
      mediaProjection: true,
    },
    ...overrides,
  };
}

async function startServer(
  overrides: Partial<ServerConfig> = {},
): Promise<{ server: VeloDeckServer; baseUrl: string; wsUrl: string }> {
  const server = createVeloDeckServer(makeTestConfig(overrides));
  const { port } = await server.listen();
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
  };
}

test("buildIceServers prepends deduplicated co-located STUN from TURN_URLS, emits per-URL ordered TURN entries (UDP first, then TCP/TLS), HMAC-SHA1 credentials, static fallback, and rejects weak TURN_SECRET", () => {
  const nowMs = 1_750_000_000_000;
  const ttl = 1800;
  const secret = "coturn-shared-secret-xyz-strong-01";
  const clientId = "ctrl-alice-1";

  const ephemeral = buildIceServers(
    {
      stunUrls: ["stun:stun.example.com:3478"],
      turnUrls: [
        "turns:turn.example.com:5349",
        "turn:turn.example.com:3478?transport=tcp",
        "turn:turn.example.com:3478?transport=udp",
      ],
      turnSecret: secret,
      turnUsername: "ignored-static",
      turnPassword: "ignored-password",
      turnTtlSeconds: ttl,
    },
    clientId,
    nowMs,
  );

  assert.equal(ephemeral.length, 4);
  assert.deepEqual(ephemeral[0], {
    urls: [
      "stun:turn.example.com:3478",
      "stun:turn.example.com:5349",
      "stun:stun.example.com:3478",
    ],
  });

  const expectedExpiry = Math.floor(nowMs / 1000) + ttl;
  const expectedUsername = `${expectedExpiry}:${clientId}`;
  const expectedCredential = crypto
    .createHmac("sha1", secret)
    .update(expectedUsername, "utf8")
    .digest("base64");

  assert.deepEqual(ephemeral[1], {
    urls: ["turn:turn.example.com:3478?transport=udp"],
    username: expectedUsername,
    credential: expectedCredential,
  });
  assert.deepEqual(ephemeral[2], {
    urls: ["turn:turn.example.com:3478?transport=tcp"],
    username: expectedUsername,
    credential: expectedCredential,
  });
  assert.deepEqual(ephemeral[3], {
    urls: ["turns:turn.example.com:5349"],
    username: expectedUsername,
    credential: expectedCredential,
  });

  // Deduplication: co-located STUN already listed in stunUrls stays first and appears only once; IPv6 preserved
  const deduped = buildIceServers(
    {
      stunUrls: [
        "stun:stun.miwifi.com:3478",
        "stun:turn.example.com:3478",
        "stun:stun.miwifi.com:3478",
      ],
      turnUrls: [
        "turn:turn.example.com:3478?transport=udp",
        "turn:turn.example.com:3478?transport=tcp",
        "turn:[2001:db8::1]:3478?transport=udp",
      ],
      turnSecret: secret,
      turnTtlSeconds: ttl,
    },
    clientId,
    nowMs,
  );
  assert.deepEqual(deduped[0], {
    urls: [
      "stun:turn.example.com:3478",
      "stun:[2001:db8::1]:3478",
      "stun:stun.miwifi.com:3478",
    ],
  });

  // Even when stunUrls is empty, co-located STUN is still derived from turnUrls
  const turnOnlyStun = buildIceServers(
    {
      stunUrls: [],
      turnUrls: [
        "turn:203.0.113.10:3478?transport=udp",
        "turn:203.0.113.10:3478?transport=tcp",
      ],
      turnSecret: secret,
      turnTtlSeconds: ttl,
    },
    clientId,
    nowMs,
  );
  assert.deepEqual(turnOnlyStun[0], {
    urls: ["stun:203.0.113.10:3478"],
  });

  // Static fallback when turnSecret is omitted
  const staticIce = buildIceServers(
    {
      stunUrls: ["stun:stun.example.com:3478"],
      turnUrls: [
        "turn:turn.example.com:3478?transport=tcp",
        "turn:turn.example.com:3478?transport=udp",
      ],
      turnUsername: "static-user",
      turnPassword: "static-pass",
      turnTtlSeconds: ttl,
    },
    clientId,
    nowMs,
  );

  assert.equal(staticIce.length, 3);
  assert.deepEqual(staticIce[0], {
    urls: ["stun:turn.example.com:3478", "stun:stun.example.com:3478"],
  });
  assert.deepEqual(staticIce[1], {
    urls: ["turn:turn.example.com:3478?transport=udp"],
    username: "static-user",
    credential: "static-pass",
  });
  assert.deepEqual(staticIce[2], {
    urls: ["turn:turn.example.com:3478?transport=tcp"],
    username: "static-user",
    credential: "static-pass",
  });

  // P0-7: Known weak placeholder TURN_SECRET is refused in buildIceServers AND loadConfig
  const weakIce = buildIceServers(
    {
      stunUrls: ["stun:stun.example.com:3478"],
      turnUrls: ["turn:turn.example.com:3478"],
      turnSecret: "velodeck-change-me-turn-secret",
      turnTtlSeconds: ttl,
    },
    clientId,
    nowMs,
  );
  assert.equal(weakIce.length, 1);
  assert.deepEqual(weakIce[0], {
    urls: ["stun:turn.example.com:3478", "stun:stun.example.com:3478"],
  });

  assert.throws(
    () => loadConfig({ TURN_SECRET: "velodeck-change-me-turn-secret" }),
    /weak placeholder TURN_SECRET/i,
  );
});

test("HTTP minimal /health, protected /api/admin/stats, security headers, static serving, and path traversal protection", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "velodeck-static-test-"));
  const staticDir = path.join(tempRoot, "dist");
  await fsp.mkdir(path.join(staticDir, "assets"), { recursive: true });
  await fsp.writeFile(path.join(staticDir, "index.html"), "<!doctype html><h1>VeloDeck</h1>");
  await fsp.writeFile(path.join(staticDir, "sw.js"), "self.addEventListener('fetch', () => {});");
  await fsp.writeFile(
    path.join(staticDir, "manifest.webmanifest"),
    JSON.stringify({ name: "VeloDeck" }),
  );
  await fsp.writeFile(path.join(staticDir, "assets", "main.js"), "console.log('ok');");
  await fsp.writeFile(path.join(tempRoot, "secret.txt"), "TOP_SECRET_OUTSIDE_ROOT");

  const { server, baseUrl } = await startServer({
    staticDir,
    trustProxy: true,
    adminToken: "admin-super-secret-token",
  });
  t.after(async () => {
    await server.close();
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  // P2-2: Public /health returns ONLY { ok: true }
  const healthRes = await fetch(`${baseUrl}/health`);
  assert.equal(healthRes.status, 200);
  const healthJson = (await healthRes.json()) as Record<string, unknown>;
  assert.deepEqual(healthJson, { ok: true });
  assert.equal(healthRes.headers.get("x-content-type-options"), "nosniff");
  assert.equal(healthRes.headers.get("x-frame-options"), "DENY");
  assert.equal(healthRes.headers.get("referrer-policy"), "no-referrer");

  // Loopback GET /api/admin/stats succeeds
  const statsLoopback = await fetch(`${baseUrl}/api/admin/stats`);
  assert.equal(statsLoopback.status, 200);
  const statsJson = (await statsLoopback.json()) as Record<string, unknown>;
  assert.equal(statsJson.ok, true);
  assert.equal(typeof statsJson.uptimeSec, "number");
  assert.equal(statsJson.devicesOnline, 0);
  assert.equal(statsJson.devicesTotal, 0);
  assert.equal(statsJson.controllersConnected, 0);
  assert.equal(statsJson.activeSessions, 0);

  // Remote IP without X-Admin-Token gets 403 on /api/admin/stats
  const statsDenied = await fetch(`${baseUrl}/api/admin/stats`, {
    headers: { "x-forwarded-for": "203.0.113.5" },
  });
  assert.equal(statsDenied.status, 403);

  // Remote IP WITH valid X-Admin-Token gets 200
  const statsAdminToken = await fetch(`${baseUrl}/api/admin/stats`, {
    headers: {
      "x-forwarded-for": "203.0.113.5",
      "x-admin-token": "admin-super-secret-token",
    },
  });
  assert.equal(statsAdminToken.status, 200);

  // index.html strong no-store cache-control + strict CSP
  const indexRes = await fetch(`${baseUrl}/`);
  assert.equal(indexRes.status, 200);
  assert.match(indexRes.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(indexRes.headers.get("cache-control"), "no-cache, no-store, must-revalidate");
  assert.match(indexRes.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.match(await indexRes.text(), /VeloDeck/);

  // sw.js strong no-store cache-control
  const swRes = await fetch(`${baseUrl}/sw.js`);
  assert.equal(swRes.status, 200);
  assert.equal(swRes.headers.get("cache-control"), "no-cache, no-store, must-revalidate");

  // manifest.webmanifest no-cache
  const manifestRes = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.equal(manifestRes.status, 200);
  assert.equal(manifestRes.headers.get("cache-control"), "no-cache");

  // /assets/* immutable
  const assetRes = await fetch(`${baseUrl}/assets/main.js`);
  assert.equal(assetRes.status, 200);
  assert.match(assetRes.headers.get("content-type") ?? "", /application\/javascript/);
  assert.equal(assetRes.headers.get("cache-control"), "public, max-age=31536000, immutable");

  // SPA route falls back to index.html
  const spaRes = await fetch(`${baseUrl}/device/pixel-9`);
  assert.equal(spaRes.status, 200);
  assert.match(await spaRes.text(), /VeloDeck/);

  // Missing asset returns 404 (not index.html)
  const missingAssetRes = await fetch(`${baseUrl}/assets/does-not-exist.js`);
  assert.equal(missingAssetRes.status, 404);

  // Path traversal blocked (both percent-encoded slash and raw ../ over HTTP)
  const traversalRes = await fetch(`${baseUrl}/%2e%2e%2fsecret.txt`);
  assert.equal(traversalRes.status, 403);
  const traversalBody = await traversalRes.text();
  assert.doesNotMatch(traversalBody, /TOP_SECRET_OUTSIDE_ROOT/);

  const rawTraversalStatus = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(`${baseUrl}/../secret.txt`, { path: "/../secret.txt" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(rawTraversalStatus.status, 403);
  assert.doesNotMatch(rawTraversalStatus.body, /TOP_SECRET_OUTSIDE_ROOT/);
});

test("Legacy accessToken mode (when explicitly enabled): strict isolation and rejection of unknown tokens", async (t) => {
  const { server, baseUrl, wsUrl } = await startServer({
    enableLegacyTokenAuth: true,
    turnUrls: ["turn:turn.example.com:3478"],
    turnSecret: "test-strong-turn-secret-1234567890",
  });
  t.after(() => server.close());

  const agentA = await TestWsClient.connect(wsUrl);
  const agentB = await TestWsClient.connect(wsUrl);
  const ctrlSame = await TestWsClient.connect(wsUrl);
  const ctrlOther = await TestWsClient.connect(wsUrl);
  const ctrlUnknown = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([
      agentA.close(),
      agentB.close(),
      ctrlSame.close(),
      ctrlOther.close(),
      ctrlUnknown.close(),
    ]);
  });

  agentA.sendJson(
    makeAgentRegister({
      deviceId: "dev-alpha-01",
      controlPassword: undefined,
      accessToken: "token-alpha",
    }),
  );
  const registeredA = await agentA.nextJson<AgentRegisteredMessage>();
  assert.equal(registeredA.type, "agent.registered");
  assert.equal(registeredA.deviceId, "dev-alpha-01");
  assert.ok(registeredA.iceServers.length >= 2);

  agentB.sendJson(
    makeAgentRegister({
      deviceId: "dev-beta-02",
      deviceSecret: "secret-beta-02",
      controlPassword: undefined,
      accessToken: "token-beta",
    }),
  );
  await agentB.nextJson<AgentRegisteredMessage>();

  // Controller with matching token sees ONLY dev-alpha-01
  ctrlSame.sendJson({
    type: "controller.auth",
    accessToken: "token-alpha",
    clientId: "ctrl-alpha-1",
  });
  const authedSame = await ctrlSame.nextJson<ControllerAuthedMessage>();
  assert.equal(authedSame.type, "controller.authed");
  assert.equal(authedSame.mode, "relay");
  assert.equal(authedSame.devices.length, 1);
  assert.equal(authedSame.devices[0]?.deviceId, "dev-alpha-01");
  assert.equal(authedSame.devices[0]?.online, true);
  assert.ok(authedSame.iceServers.length >= 2);

  // Controller with token-beta sees ONLY dev-beta-02
  ctrlOther.sendJson({
    type: "controller.auth",
    accessToken: "token-beta",
    clientId: "ctrl-beta-2",
  });
  const authedOther = await ctrlOther.nextJson<ControllerAuthedMessage>();
  assert.equal(authedOther.type, "controller.authed");
  assert.equal(authedOther.devices.length, 1);
  assert.equal(authedOther.devices[0]?.deviceId, "dev-beta-02");

  // Cross-token session.request must fail with UNAUTHORIZED
  ctrlOther.sendJson({
    type: "session.request",
    sessionId: "sess-unauth-01",
    deviceId: "dev-alpha-01",
    preferredTransport: "ws-jpeg",
    quality: QUALITY_PRESETS.balanced,
  } satisfies SessionRequestMessage);

  const errMsg = await ctrlOther.nextJson<ErrorMessage>();
  assert.equal(errMsg.type, "error");
  assert.equal(errMsg.code, "UNAUTHORIZED");
  assert.equal(errMsg.sessionId, "sess-unauth-01");

  // P0-6: Unknown accessToken matching 0 devices is rejected (NEVER mints free TURN creds)
  ctrlUnknown.sendJson({
    type: "controller.auth",
    accessToken: "token-nonexistent-free-turn-probe",
    clientId: "ctrl-probe",
  });
  const probeErr = await ctrlUnknown.nextJson<ErrorMessage>();
  assert.equal(probeErr.type, "error");
  assert.equal(probeErr.code, "UNAUTHORIZED");
  const probeClose = await ctrlUnknown.waitForClose();
  assert.equal(probeClose.code, 4001);

  // Verify /api/admin/stats reflects current counts
  const stats = (await (await fetch(`${baseUrl}/api/admin/stats`)).json()) as Record<string, number>;
  assert.equal(stats.devicesOnline, 2);
  assert.equal(stats.devicesTotal, 2);
  assert.equal(stats.controllersConnected, 2);
  assert.equal(stats.activeSessions, 0);
});

test("DEVICE_SECRET_MISMATCH blocks hijacking an existing deviceId", async (t) => {
  const { server, wsUrl } = await startServer();
  t.after(() => server.close());

  const legitimate = await TestWsClient.connect(wsUrl);
  const attacker = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([legitimate.close(), attacker.close()]);
  });

  legitimate.sendJson(
    makeAgentRegister({
      deviceId: "dev-protected",
      deviceSecret: "real-secret-123",
      controlPassword: "strong-device-pass",
    }),
  );
  const regOk = await legitimate.nextJson<AgentRegisteredMessage>();
  assert.equal(regOk.type, "agent.registered");

  attacker.sendJson(
    makeAgentRegister({
      deviceId: "dev-protected",
      deviceSecret: "wrong-secret-999",
      controlPassword: "strong-device-pass",
    }),
  );
  const errMsg = await attacker.nextJson<ErrorMessage>();
  assert.equal(errMsg.type, "error");
  assert.equal(errMsg.code, "DEVICE_SECRET_MISMATCH");

  const closeInfo = await attacker.waitForClose();
  assert.equal(closeInfo.code, 4003);

  // Legitimate device remains online
  assert.equal(server.hub.getStats().devicesOnline, 1);
});

test("Agent reconnect cleanly replaces old socket without dropping online status and broadcasts device.status", async (t) => {
  const { server, baseUrl, wsUrl } = await startServer();
  t.after(() => server.close());

  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "reconn_user", password: "reconn-password-1" }),
  });
  const { token } = (await regRes.json()) as { token: string };

  const ctrl = await TestWsClient.connect(wsUrl);
  const agentOld = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([ctrl.close(), agentOld.close()]);
  });

  ctrl.sendJson({
    type: "controller.auth",
    authToken: token,
    clientId: "ctrl-watch",
  });
  await ctrl.nextJson<ControllerAuthedMessage>();

  agentOld.sendJson(
    makeAgentRegister({
      deviceId: "dev-reconn",
      deviceSecret: "secret-abc",
      authToken: token,
      battery: 62,
      charging: false,
    }),
  );
  await agentOld.nextJson<AgentRegisteredMessage>();

  const initialStatus = await ctrl.nextJson<DeviceStatusMessage>();
  assert.equal(initialStatus.type, "device.status");
  assert.equal(initialStatus.device.online, true);
  assert.equal(initialStatus.device.battery, 62);

  // Reconnect with same deviceId + valid deviceSecret on a new socket
  const agentNew = await TestWsClient.connect(wsUrl);
  t.after(() => agentNew.close());

  agentNew.sendJson(
    makeAgentRegister({
      deviceId: "dev-reconn",
      deviceSecret: "secret-abc",
      authToken: token,
      battery: 90,
      charging: true,
    }),
  );

  const [newReg, oldClose, updatedStatus] = await Promise.all([
    agentNew.nextJson<AgentRegisteredMessage>(),
    agentOld.waitForClose(),
    ctrl.nextJson<DeviceStatusMessage>(),
  ]);

  assert.equal(newReg.type, "agent.registered");
  assert.equal(oldClose.code, 4000);
  assert.equal(updatedStatus.type, "device.status");
  assert.equal(updatedStatus.device.online, true);
  assert.equal(updatedStatus.device.battery, 90);
  assert.equal(updatedStatus.device.charging, true);

  // Give event loop a tick to confirm old socket's close did NOT flip online=false
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(server.hub.getStats().devicesOnline, 1);
  assert.equal(ctrl.drainJson().length, 0);

  // Agent telemetry updates device state and broadcasts device.status
  agentNew.sendJson({
    type: "agent.telemetry",
    deviceId: "dev-reconn",
    battery: 95,
    locked: true,
    screenOn: false,
  });
  const telemetryStatus = await ctrl.nextJson<DeviceStatusMessage>();
  assert.equal(telemetryStatus.type, "device.status");
  assert.equal(telemetryStatus.device.battery, 95);
  assert.equal(telemetryStatus.device.locked, true);
  assert.equal(telemetryStatus.device.screenOn, false);
  assert.equal(telemetryStatus.device.online, true);

  // Start a session, then genuinely disconnect agentNew -> controller receives session.end + offline status
  ctrl.sendJson({
    type: "session.request",
    sessionId: "sess-drop-01",
    deviceId: "dev-reconn",
    preferredTransport: "ws-jpeg",
    quality: QUALITY_PRESETS.eco,
  } satisfies SessionRequestMessage);
  await agentNew.nextJson<SessionRequestMessage>();
  assert.equal(server.hub.getStats().activeSessions, 1);

  await agentNew.close();

  const msgA = await ctrl.nextJson();
  const msgB = await ctrl.nextJson();
  const byType = new Map([
    [msgA.type, msgA],
    [msgB.type, msgB],
  ]);

  const ended = byType.get("session.end") as SessionEndMessage | undefined;
  const offline = byType.get("device.status") as DeviceStatusMessage | undefined;
  assert.ok(ended, "expected session.end on agent disconnect");
  assert.equal(ended.sessionId, "sess-drop-01");
  assert.ok(offline, "expected device.status on agent disconnect");
  assert.equal(offline.device.online, false);
  assert.equal(server.hub.getStats().devicesOnline, 0);
  assert.equal(server.hub.getStats().activeSessions, 0);
});

test("Full session flow: signaling, WebRTC SDP/ICE, control, binary JPEG media relay, deviceId validation, and session.end", async (t) => {
  const { server, wsUrl } = await startServer();
  t.after(() => server.close());

  const agent = await TestWsClient.connect(wsUrl);
  const ctrl = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([agent.close(), ctrl.close()]);
  });

  agent.sendJson(
    makeAgentRegister({
      deviceId: "dev-stream",
      controlPassword: "stream-password-123",
    }),
  );
  const registered = await agent.nextJson<AgentRegisteredMessage>();
  assert.ok(registered.controlCode);

  ctrl.sendJson({
    type: "controller.auth",
    controlCode: registered.controlCode,
    controlPassword: "stream-password-123",
    clientId: "ctrl-stream",
  });
  await ctrl.nextJson<ControllerAuthedMessage>();

  // 1. session.request (Relay injects fresh per-session iceServers)
  const reqMsg: SessionRequestMessage = {
    type: "session.request",
    sessionId: "sess-e2e-1",
    deviceId: "dev-stream",
    preferredTransport: "webrtc",
    quality: QUALITY_PRESETS.hd,
  };
  ctrl.sendJson(reqMsg);
  const fwdReq = await agent.nextJson<SessionRequestMessage>();
  const { iceServers: reqIceServers, ...fwdReqRest } = fwdReq;
  assert.deepEqual(fwdReqRest, reqMsg);
  assert.ok(Array.isArray(reqIceServers) && reqIceServers.length >= 1);
  assert.equal(server.hub.getStats().activeSessions, 1);

  // 2. session.ready (Relay injects fresh per-session iceServers)
  const readyMsg: SessionReadyMessage = {
    type: "session.ready",
    sessionId: "sess-e2e-1",
    deviceId: "dev-stream",
    transport: "webrtc",
    screenWidth: 1080,
    screenHeight: 2400,
    rotation: 0,
  };
  agent.sendJson(readyMsg);
  const fwdReady = await ctrl.nextJson<SessionReadyMessage>();
  const { iceServers: readyIceServers, ...fwdReadyRest } = fwdReady;
  assert.deepEqual(fwdReadyRest, readyMsg);
  assert.ok(Array.isArray(readyIceServers) && readyIceServers.length >= 1);

  // 3. rtc.offer / rtc.answer / rtc.ice
  const offerMsg: RtcOfferMessage = {
    type: "rtc.offer",
    sessionId: "sess-e2e-1",
    deviceId: "dev-stream",
    sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n",
  };
  ctrl.sendJson(offerMsg);
  assert.deepEqual(await agent.nextJson<RtcOfferMessage>(), offerMsg);

  const answerMsg: RtcAnswerMessage = {
    type: "rtc.answer",
    sessionId: "sess-e2e-1",
    deviceId: "dev-stream",
    sdp: "v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\n",
  };
  agent.sendJson(answerMsg);
  assert.deepEqual(await ctrl.nextJson<RtcAnswerMessage>(), answerMsg);

  const iceToAgent: RtcIceMessage = {
    type: "rtc.ice",
    sessionId: "sess-e2e-1",
    deviceId: "dev-stream",
    candidate: { candidate: "candidate:1 1 udp 2122260223 10.0.0.2 50000 typ host", sdpMid: "0", sdpMLineIndex: 0 },
  };
  ctrl.sendJson(iceToAgent);
  assert.deepEqual(await agent.nextJson<RtcIceMessage>(), iceToAgent);

  const iceToCtrl: RtcIceMessage = {
    type: "rtc.ice",
    sessionId: "sess-e2e-1",
    deviceId: "dev-stream",
    candidate: { candidate: "candidate:2 1 udp 2122260223 10.0.0.3 50001 typ host", sdpMid: "0", sdpMLineIndex: 0 },
  };
  agent.sendJson(iceToCtrl);
  assert.deepEqual(await ctrl.nextJson<RtcIceMessage>(), iceToCtrl);

  // P2-5: Session message with mismatched deviceId is rejected cleanly
  ctrl.sendJson({
    type: "control.cmd",
    sessionId: "sess-e2e-1",
    deviceId: "dev-other-device",
    seq: 41,
    command: { action: "tap", x: 0.5, y: 0.25 },
  });
  const mismatchErr = await ctrl.nextJson<ErrorMessage>();
  assert.equal(mismatchErr.code, "INVALID_MESSAGE");

  // 4. control.cmd / control.ack
  const cmdMsg: ControlCmdMessage = {
    type: "control.cmd",
    sessionId: "sess-e2e-1",
    deviceId: "dev-stream",
    seq: 42,
    command: { action: "tap", x: 0.5, y: 0.25 },
  };
  ctrl.sendJson(cmdMsg);
  assert.deepEqual(await agent.nextJson<ControlCmdMessage>(), cmdMsg);

  const ackMsg: ControlAckMessage = {
    type: "control.ack",
    sessionId: "sess-e2e-1",
    deviceId: "dev-stream",
    seq: 42,
    ok: true,
  };
  agent.sendJson(ackMsg);
  assert.deepEqual(await ctrl.nextJson<ControlAckMessage>(), ackMsg);

  // 5. Binary JPEG frame forwarded untouched
  const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const encodedFrame = encodeMediaFrame({
    frameType: FRAME_TYPE_JPEG,
    width: 720,
    height: 1600,
    rotation: 1,
    keyframe: true,
    timestampMs: 1_750_000_123_456,
    sessionId: "sess-e2e-1",
    payload: jpegBytes,
  });

  agent.sendBinary(encodedFrame);
  const receivedBuf = await ctrl.nextBinary();
  assert.deepEqual(new Uint8Array(receivedBuf), encodedFrame);

  const decoded = decodeMediaFrame(receivedBuf);
  assert.equal(decoded.frameType, FRAME_TYPE_JPEG);
  assert.equal(decoded.width, 720);
  assert.equal(decoded.height, 1600);
  assert.equal(decoded.rotation, 1);
  assert.equal(decoded.keyframe, true);
  assert.equal(decoded.timestampMs, 1_750_000_123_456);
  assert.equal(decoded.sessionId, "sess-e2e-1");
  assert.deepEqual(new Uint8Array(decoded.payload), jpegBytes);

  // 6. session.end removes session
  const endMsg: SessionEndMessage = {
    type: "session.end",
    sessionId: "sess-e2e-1",
    deviceId: "dev-stream",
    reason: "user_closed",
  };
  ctrl.sendJson(endMsg);
  assert.deepEqual(await agent.nextJson<SessionEndMessage>(), endMsg);
  assert.equal(server.hub.getStats().activeSessions, 0);

  // Subsequent command on ended session fails with SESSION_NOT_FOUND
  ctrl.sendJson(cmdMsg);
  const notFound = await ctrl.nextJson<ErrorMessage>();
  assert.equal(notFound.type, "error");
  assert.equal(notFound.code, "SESSION_NOT_FOUND");
});

test("JSON ping/pong (post-auth only) and per-IP auth rate limiting with trustProxy=true", async (t) => {
  const { server, wsUrl } = await startServer({
    maxFailedAuthPerMin: 2,
    trustProxy: true,
  });
  t.after(() => server.close());

  // Unauthenticated ping is rejected with UNAUTHORIZED (P1-7!)
  const pingClient = await TestWsClient.connect(wsUrl);
  t.after(() => pingClient.close());
  pingClient.sendJson({ type: "ping", ts: 987654321 });
  const unauthPingErr = await pingClient.nextJson<ErrorMessage>();
  assert.equal(unauthPingErr.code, "UNAUTHORIZED");

  // Once authenticated, ping/pong works cleanly
  pingClient.sendJson(makeAgentRegister({ deviceId: "dev-ping-01" }));
  await pingClient.nextJson<AgentRegisteredMessage>();
  pingClient.sendJson({ type: "ping", ts: 987654321 });
  const pong = await pingClient.nextJson<PongMessage>();
  assert.equal(pong.type, "pong");
  assert.equal(pong.ts, 987654321);

  // Trigger 2 failed auth attempts from same forwarded IP
  const headers = { "x-forwarded-for": "203.0.113.42" };
  for (let i = 0; i < 2; i += 1) {
    const c = await TestWsClient.connect(wsUrl, headers);
    c.sendJson({ type: "controller.auth", accessToken: "", clientId: "" });
    const err = await c.nextJson<ErrorMessage>();
    assert.equal(err.code, "UNAUTHORIZED");
    await c.waitForClose();
  }

  // 3rd attempt hits RATE_LIMITED
  const limited = await TestWsClient.connect(wsUrl, headers);
  limited.sendJson({
    type: "controller.auth",
    controlCode: "123456789",
    controlPassword: "some-password",
    clientId: "ctrl-blocked",
  });
  const rateErr = await limited.nextJson<ErrorMessage>();
  assert.equal(rateErr.type, "error");
  assert.equal(rateErr.code, "RATE_LIMITED");
  const closeInfo = await limited.waitForClose();
  assert.equal(closeInfo.code, 4029);
});

test("Pre-session wake and unlock commands work with token authorization and return control.ack", async (t) => {
  const { server, wsUrl } = await startServer({ enableLegacyTokenAuth: true });
  t.after(() => server.close());

  const agent = await TestWsClient.connect(wsUrl);
  const agentOther = await TestWsClient.connect(wsUrl);
  const ctrlOk = await TestWsClient.connect(wsUrl);
  const ctrlWrong = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([agent.close(), agentOther.close(), ctrlOk.close(), ctrlWrong.close()]);
  });

  agent.sendJson(
    makeAgentRegister({
      deviceId: "dev-wake-01",
      controlPassword: undefined,
      accessToken: "token-wake",
    }),
  );
  await agent.nextJson<AgentRegisteredMessage>();

  agentOther.sendJson(
    makeAgentRegister({
      deviceId: "dev-other-02",
      deviceSecret: "secret-other-02",
      controlPassword: undefined,
      accessToken: "token-other",
    }),
  );
  await agentOther.nextJson<AgentRegisteredMessage>();

  ctrlOk.sendJson({ type: "controller.auth", accessToken: "token-wake", clientId: "c-ok" });
  await ctrlOk.nextJson<ControllerAuthedMessage>();

  ctrlWrong.sendJson({ type: "controller.auth", accessToken: "token-other", clientId: "c-bad" });
  await ctrlWrong.nextJson<ControllerAuthedMessage>();

  // Cross-token wake is rejected
  ctrlWrong.sendJson({
    type: "control.cmd",
    sessionId: "",
    deviceId: "dev-wake-01",
    seq: 1,
    command: { action: "wake" },
  });
  const unauthErr = await ctrlWrong.nextJson<ErrorMessage>();
  assert.equal(unauthErr.code, "UNAUTHORIZED");

  // Authorized sessionless wake is forwarded and ack routed back
  const wakeCmd: ControlCmdMessage = {
    type: "control.cmd",
    sessionId: "",
    deviceId: "dev-wake-01",
    seq: 7,
    command: { action: "wake" },
  };
  ctrlOk.sendJson(wakeCmd);
  assert.deepEqual(await agent.nextJson<ControlCmdMessage>(), wakeCmd);

  const wakeAck: ControlAckMessage = {
    type: "control.ack",
    sessionId: "",
    deviceId: "dev-wake-01",
    seq: 7,
    ok: true,
  };
  agent.sendJson(wakeAck);
  assert.deepEqual(await ctrlOk.nextJson<ControlAckMessage>(), wakeAck);
});

test("Default config uses Mainland-China-reachable STUN servers and hardened security defaults", () => {
  const cfg = loadConfig({});
  assert.deepEqual(cfg.stunUrls, DEFAULT_STUN_URLS);
  assert.deepEqual(cfg.stunUrls, [
    "stun:stun.miwifi.com:3478",
    "stun:stun.chat.bilibili.com:3478",
  ]);
  assert.equal(cfg.trustProxy, false);
  assert.equal(cfg.registrationMode, "first-user-then-invite");
  assert.equal(cfg.enableLegacyTokenAuth, false);
  assert.equal(cfg.turnTtlSeconds, 1800);
  assert.equal(cfg.maxUsers, 100);
  assert.equal(cfg.maxDevices, 100);
  assert.equal(cfg.maxWsConnections, 500);
  assert.equal(cfg.maxWsPerIp, 15);
  assert.equal(cfg.requireAuthForApk, false);
});

test("REST auth: register, duplicate 409, validation 400, login, /api/auth/me, strict CORS preflight, and rate limiting", async (t) => {
  const { server, baseUrl } = await startServer({
    maxFailedAuthPerMin: 2,
    trustProxy: true,
    registrationMode: "open",
    allowedOrigins: ["https://allowed.example.com"],
  });
  t.after(() => server.close());

  // Strict CORS preflight: allowlisted origin allowed, unknown origin rejected 403, NEVER wildcard *
  const allowedOpt = await fetch(`${baseUrl}/api/auth/register`, {
    method: "OPTIONS",
    headers: { Origin: "https://allowed.example.com" },
  });
  assert.equal(allowedOpt.status, 204);
  assert.equal(allowedOpt.headers.get("access-control-allow-origin"), "https://allowed.example.com");
  assert.match(allowedOpt.headers.get("access-control-allow-headers") ?? "", /Authorization/i);

  const evilOpt = await fetch(`${baseUrl}/api/auth/register`, {
    method: "OPTIONS",
    headers: { Origin: "https://evil.attacker.example" },
  });
  assert.equal(evilOpt.status, 403);
  assert.equal(evilOpt.headers.get("access-control-allow-origin"), null);

  // Invalid username / short password (< 8 chars) -> 400
  const badUserRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "ab", password: "password123" }),
  });
  assert.equal(badUserRes.status, 400);

  const shortPassRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "short77" }),
  });
  assert.equal(shortPassRes.status, 400);

  // Valid register -> 201 { token, user }
  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
    },
    body: JSON.stringify({
      username: "Alice_01",
      password: "strong-password-1",
      displayName: "Alice Lin",
    }),
  });
  assert.equal(regRes.status, 201);
  assert.equal(regRes.headers.get("access-control-allow-origin"), baseUrl);
  const regJson = (await regRes.json()) as { token: string; user: UserProfile };
  assert.ok(typeof regJson.token === "string" && regJson.token.split(".").length === 3);
  assert.equal(regJson.user.username, "alice_01");
  assert.equal(regJson.user.displayName, "Alice Lin");
  assert.ok(regJson.user.userId.length > 0);

  // Case-insensitive duplicate -> 409
  const dupRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "ALICE_01", password: "another-password" }),
  });
  assert.equal(dupRes.status, 409);

  // Login succeeds (case-insensitive username)
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "ALICE_01", password: "strong-password-1" }),
  });
  assert.equal(loginRes.status, 200);
  const loginJson = (await loginRes.json()) as { token: string; user: UserProfile };
  assert.equal(loginJson.user.userId, regJson.user.userId);
  assert.ok(loginJson.token.length > 20);

  // GET /api/auth/me without Bearer -> 401
  const meUnauth = await fetch(`${baseUrl}/api/auth/me`);
  assert.equal(meUnauth.status, 401);

  // GET /api/auth/me with Bearer -> 200 { user, devices }
  const meRes = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${loginJson.token}` },
  });
  assert.equal(meRes.status, 200);
  const meJson = (await meRes.json()) as { user: UserProfile; devices: unknown[] };
  assert.deepEqual(meJson.user, regJson.user);
  assert.deepEqual(meJson.devices, []);

  // Failed logins trigger 401 and then 429 rate limit
  const rateHeaders = {
    "Content-Type": "application/json",
    "x-forwarded-for": "198.51.100.77",
  };
  for (let i = 0; i < 2; i += 1) {
    const failRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: rateHeaders,
      body: JSON.stringify({ username: "alice_01", password: "wrong-password" }),
    });
    assert.equal(failRes.status, 401);
  }
  const blockedRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: rateHeaders,
    body: JSON.stringify({ username: "alice_01", password: "strong-password-1" }),
  });
  assert.equal(blockedRes.status, 429);
});

test("Permanent 9-digit controlCode, account binding, persistence across restart, file permissions, audit log, and unbind", async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "velodeck-store-test-"));
  // Start server #1 backed by disk dataDir
  const s1 = await startServer({ dataDir });
  let s1Closed = false;
  let s2Server: VeloDeckServer | null = null;
  t.after(async () => {
    if (!s1Closed) await s1.server.close();
    if (s2Server) await s2Server.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  const regRes = await fetch(`${s1.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "owner1", password: "owner1-password" }),
  });
  assert.equal(regRes.status, 201);
  const { token: ownerToken, user: ownerUser } = (await regRes.json()) as {
    token: string;
    user: UserProfile;
  };

  // Invalid JWT on agent.register is rejected with UNAUTHORIZED + close 4001
  const badAgent = await TestWsClient.connect(s1.wsUrl);
  badAgent.sendJson(
    makeAgentRegister({
      deviceId: "dev-bad-jwt",
      accessToken: undefined,
      authToken: "invalid.jwt.token",
      controlPassword: "unattended-pass",
    }),
  );
  const badErr = await badAgent.nextJson<ErrorMessage>();
  assert.equal(badErr.code, "UNAUTHORIZED");
  const badClose = await badAgent.waitForClose();
  assert.equal(badClose.code, 4001);

  // Register agent with authToken + controlPassword (no legacy accessToken!)
  const agent1 = await TestWsClient.connect(s1.wsUrl);
  agent1.sendJson(
    makeAgentRegister({
      deviceId: "dev-persist-1",
      deviceSecret: "persist-secret-xyz",
      accessToken: undefined,
      authToken: ownerToken,
      controlPassword: "unattended-999",
      name: "Xiaomi 15",
    }),
  );
  const registered1 = await agent1.nextJson<AgentRegisteredMessage>();
  assert.equal(registered1.type, "agent.registered");
  assert.equal(registered1.deviceId, "dev-persist-1");
  assert.match(registered1.controlCode ?? "", /^\d{9}$/);
  assert.equal(registered1.ownerUsername, "owner1");
  const permanentCode = registered1.controlCode!;

  // Flush async store/audit writers before inspecting on-disk permissions & contents
  await Promise.all([s1.server.store.flush(), s1.server.hub.audit.flush()]);

  // P2-3: Verify POSIX permissions on dataDir (0700) and sensitive files (0600)
  const dirMode = (await fsp.stat(dataDir)).mode & 0o777;
  const jwtMode = (await fsp.stat(path.join(dataDir, "jwt.secret"))).mode & 0o777;
  const storeMode = (await fsp.stat(path.join(dataDir, "store.json"))).mode & 0o777;
  const auditMode = (await fsp.stat(path.join(dataDir, "audit.jsonl"))).mode & 0o777;
  assert.equal(dirMode, 0o700);
  assert.equal(jwtMode, 0o600);
  assert.equal(storeMode, 0o600);
  assert.equal(auditMode, 0o600);

  // Verify audit.jsonl never leaks passwords, JWTs, or secrets
  const auditRaw = await fsp.readFile(path.join(dataDir, "audit.jsonl"), "utf8");
  assert.doesNotMatch(auditRaw, /owner1-password/);
  assert.doesNotMatch(auditRaw, /unattended-999/);
  assert.doesNotMatch(auditRaw, /persist-secret-xyz/);
  assert.equal(auditRaw.includes(ownerToken), false);

  // Reconnect on same server -> identical controlCode preserved
  const agent1Reconnect = await TestWsClient.connect(s1.wsUrl);
  agent1Reconnect.sendJson(
    makeAgentRegister({
      deviceId: "dev-persist-1",
      deviceSecret: "persist-secret-xyz",
      accessToken: undefined,
      authToken: ownerToken,
      controlPassword: "unattended-999",
      battery: 77,
    }),
  );
  const registered2 = await agent1Reconnect.nextJson<AgentRegisteredMessage>();
  assert.equal(registered2.controlCode, permanentCode);
  assert.equal(registered2.ownerUsername, "owner1");
  await agent1.waitForClose();

  // Close server #1 and start server #2 pointing at the SAME dataDir
  await agent1Reconnect.close();
  await s1.server.close();
  s1Closed = true;

  const s2 = await startServer({ dataDir });
  s2Server = s2.server;

  // Persisted jwt.secret allows the pre-restart JWT to keep working!
  const meAfterRestart = await fetch(`${s2.baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(meAfterRestart.status, 200);
  const meJson = (await meAfterRestart.json()) as {
    user: UserProfile;
    devices: Array<{ deviceId: string; controlCode?: string; online: boolean; ownerUsername?: string }>;
  };
  assert.equal(meJson.user.userId, ownerUser.userId);
  assert.equal(meJson.devices.length, 1);
  assert.equal(meJson.devices[0]?.deviceId, "dev-persist-1");
  assert.equal(meJson.devices[0]?.controlCode, permanentCode);
  assert.equal(meJson.devices[0]?.ownerUsername, "owner1");
  // Persisted online status MUST be reset to false on startup!
  assert.equal(meJson.devices[0]?.online, false);

  // Wrong deviceSecret is still blocked after restart
  const hijack = await TestWsClient.connect(s2.wsUrl);
  hijack.sendJson(
    makeAgentRegister({
      deviceId: "dev-persist-1",
      deviceSecret: "wrong-secret",
      accessToken: undefined,
      controlPassword: "unattended-999",
    }),
  );
  const hijackErr = await hijack.nextJson<ErrorMessage>();
  assert.equal(hijackErr.code, "DEVICE_SECRET_MISMATCH");
  await hijack.waitForClose();

  // Legitimate agent reconnects after restart -> gets exact same 9-digit controlCode
  const agentAfterRestart = await TestWsClient.connect(s2.wsUrl);
  t.after(() => agentAfterRestart.close());
  agentAfterRestart.sendJson(
    makeAgentRegister({
      deviceId: "dev-persist-1",
      deviceSecret: "persist-secret-xyz",
      accessToken: undefined,
      authToken: ownerToken,
      controlPassword: "unattended-999",
    }),
  );
  const registered3 = await agentAfterRestart.nextJson<AgentRegisteredMessage>();
  assert.equal(registered3.controlCode, permanentCode);
  assert.equal(registered3.ownerUsername, "owner1");

  // Account controller connects and starts a session, then unbinds via REST
  const ctrlOwner = await TestWsClient.connect(s2.wsUrl);
  t.after(() => ctrlOwner.close());
  ctrlOwner.sendJson({
    type: "controller.auth",
    authToken: ownerToken,
    clientId: "ctrl-owner",
  });
  const authedOwner = await ctrlOwner.nextJson<ControllerAuthedMessage>();
  assert.equal(authedOwner.authType, "account");
  assert.equal(authedOwner.devices.length, 1);
  assert.equal(authedOwner.devices[0]?.online, true);

  ctrlOwner.sendJson({
    type: "session.request",
    sessionId: "sess-before-unbind",
    deviceId: "dev-persist-1",
    preferredTransport: "ws-jpeg",
    quality: QUALITY_PRESETS.eco,
  } satisfies SessionRequestMessage);
  await agentAfterRestart.nextJson<SessionRequestMessage>();
  assert.equal(s2.server.hub.getStats().activeSessions, 1);

  const unbindRes = await fetch(`${s2.baseUrl}/api/devices/unbind`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ownerToken}`,
    },
    body: JSON.stringify({ deviceId: "dev-persist-1" }),
  });
  assert.equal(unbindRes.status, 200);
  assert.deepEqual(await unbindRes.json(), { ok: true });

  // Active session ended cleanly on unbind
  const endedOnCtrl = await ctrlOwner.nextJson();
  const endedOnAgent = await agentAfterRestart.nextJson<SessionEndMessage>();
  assert.equal(endedOnAgent.type, "session.end");
  assert.equal(endedOnAgent.reason, "device_unbound");
  assert.ok(endedOnCtrl.type === "session.end" || endedOnCtrl.type === "device.status");
  assert.equal(s2.server.hub.getStats().activeSessions, 0);

  // /api/auth/me no longer returns the unbound device
  const meAfterUnbind = (await (
    await fetch(`${s2.baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    })
  ).json()) as { devices: unknown[] };
  assert.equal(meAfterUnbind.devices.length, 0);
});

test("Account-mode and 9-digit controlCode+password controller auth with strict isolation", async (t) => {
  const { server, baseUrl, wsUrl } = await startServer({ registrationMode: "open" });
  t.after(() => server.close());

  // Register two separate accounts: alice and bob
  const aliceReg = (await (
    await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "alice-password" }),
    })
  ).json()) as { token: string; user: UserProfile };

  const bobReg = (await (
    await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "bob-password" }),
    })
  ).json()) as { token: string; user: UserProfile };

  // Connect two agents: alice's phone (with unattended password) and bob's phone
  const aliceAgent = await TestWsClient.connect(wsUrl);
  const bobAgent = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([aliceAgent.close(), bobAgent.close()]);
  });

  aliceAgent.sendJson(
    makeAgentRegister({
      deviceId: "dev-alice",
      deviceSecret: "sec-alice",
      accessToken: undefined,
      authToken: aliceReg.token,
      controlPassword: "alice-unattended-pass",
      name: "Alice Phone",
    }),
  );
  const aliceRegistered = await aliceAgent.nextJson<AgentRegisteredMessage>();
  assert.match(aliceRegistered.controlCode ?? "", /^\d{9}$/);
  const aliceCode = aliceRegistered.controlCode!;

  bobAgent.sendJson(
    makeAgentRegister({
      deviceId: "dev-bob-01",
      deviceSecret: "sec-bob",
      accessToken: undefined,
      authToken: bobReg.token,
      controlPassword: "bob-unattended-pass",
      name: "Bob Phone",
    }),
  );
  await bobAgent.nextJson<AgentRegisteredMessage>();

  // 1. Alice logs in via account JWT -> lists and controls dev-alice WITHOUT controlPassword
  const ctrlAlice = await TestWsClient.connect(wsUrl);
  const ctrlBob = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([ctrlAlice.close(), ctrlBob.close()]);
  });

  ctrlAlice.sendJson({
    type: "controller.auth",
    authToken: aliceReg.token,
    clientId: "ctrl-alice-web",
  });
  const aliceAuthed = await ctrlAlice.nextJson<ControllerAuthedMessage>();
  assert.equal(aliceAuthed.authType, "account");
  assert.equal(aliceAuthed.user?.username, "alice");
  assert.equal(aliceAuthed.devices.length, 1);
  assert.equal(aliceAuthed.devices[0]?.deviceId, "dev-alice");
  assert.equal(aliceAuthed.devices[0]?.controlCode, aliceCode);
  assert.equal(aliceAuthed.devices[0]?.ownerUsername, "alice");

  // Alice can start session on dev-alice
  ctrlAlice.sendJson({
    type: "session.request",
    sessionId: "sess-alice-acct",
    deviceId: "dev-alice",
    preferredTransport: "ws-jpeg",
    quality: QUALITY_PRESETS.balanced,
  } satisfies SessionRequestMessage);
  const aliceReq = await aliceAgent.nextJson<SessionRequestMessage>();
  assert.equal(aliceReq.sessionId, "sess-alice-acct");

  // Bob logs in via account JWT -> only sees dev-bob-01 and CANNOT control dev-alice
  ctrlBob.sendJson({
    type: "controller.auth",
    authToken: bobReg.token,
    clientId: "ctrl-bob-web",
  });
  const bobAuthed = await ctrlBob.nextJson<ControllerAuthedMessage>();
  assert.equal(bobAuthed.authType, "account");
  assert.equal(bobAuthed.devices.length, 1);
  assert.equal(bobAuthed.devices[0]?.deviceId, "dev-bob-01");

  ctrlBob.sendJson({
    type: "session.request",
    sessionId: "sess-bob-steal",
    deviceId: "dev-alice",
    preferredTransport: "ws-jpeg",
    quality: QUALITY_PRESETS.eco,
  } satisfies SessionRequestMessage);
  const bobErr = await ctrlBob.nextJson<ErrorMessage>();
  assert.equal(bobErr.code, "UNAUTHORIZED");

  ctrlBob.sendJson({
    type: "control.cmd",
    sessionId: "",
    deviceId: "dev-alice",
    seq: 9,
    command: { action: "wake" },
  });
  const bobWakeErr = await ctrlBob.nextJson<ErrorMessage>();
  assert.equal(bobWakeErr.code, "UNAUTHORIZED");

  // 2. Control-code mode with WRONG password -> UNAUTHORIZED + close 4001
  const ctrlWrongCodePass = await TestWsClient.connect(wsUrl);
  ctrlWrongCodePass.sendJson({
    type: "controller.auth",
    controlCode: formatControlCode(aliceCode),
    controlPassword: "wrong-password",
    clientId: "ctrl-wrong-code",
  });
  const wrongCodeErr = await ctrlWrongCodePass.nextJson<ErrorMessage>();
  assert.equal(wrongCodeErr.code, "UNAUTHORIZED");
  const wrongCodeClose = await ctrlWrongCodePass.waitForClose();
  assert.equal(wrongCodeClose.code, 4001);

  // 3. Control-code mode with formatted "123 456 789" + valid controlPassword -> controls dev-alice ONLY
  const ctrlCode = await TestWsClient.connect(wsUrl);
  t.after(() => ctrlCode.close());
  ctrlCode.sendJson({
    type: "controller.auth",
    controlCode: formatControlCode(aliceCode),
    controlPassword: "alice-unattended-pass",
    clientId: "ctrl-code-guest",
  });
  const codeAuthed = await ctrlCode.nextJson<ControllerAuthedMessage>();
  assert.equal(codeAuthed.authType, "code");
  assert.equal(codeAuthed.devices.length, 1);
  assert.equal(codeAuthed.devices[0]?.deviceId, "dev-alice");
  assert.equal(codeAuthed.devices[0]?.controlCode, aliceCode);

  // Control-code controller can control dev-alice (sessionless wake + session.request)
  ctrlCode.sendJson({
    type: "control.cmd",
    sessionId: "",
    deviceId: "dev-alice",
    seq: 11,
    command: { action: "wake" },
  });
  const forwardedWake = await aliceAgent.nextJson<ControlCmdMessage>();
  assert.equal(forwardedWake.command.action, "wake");
  assert.equal(forwardedWake.seq, 11);

  ctrlCode.sendJson({
    type: "session.request",
    sessionId: "sess-code-ok",
    deviceId: "dev-alice",
    preferredTransport: "ws-jpeg",
    quality: QUALITY_PRESETS.eco,
  } satisfies SessionRequestMessage);
  const codeSessReq = await aliceAgent.nextJson<SessionRequestMessage>();
  assert.equal(codeSessReq.sessionId, "sess-code-ok");

  // Control-code controller CANNOT access dev-bob-01
  ctrlCode.sendJson({
    type: "session.request",
    sessionId: "sess-code-other",
    deviceId: "dev-bob-01",
    preferredTransport: "ws-jpeg",
    quality: QUALITY_PRESETS.eco,
  } satisfies SessionRequestMessage);
  const codeOtherErr = await ctrlCode.nextJson<ErrorMessage>();
  assert.equal(codeOtherErr.code, "UNAUTHORIZED");
});

test("GET /api/info (APK SHA-256 + registration status) and GET /api/download/velodeck-agent.apk, versioned .apk & /api/download/android streaming & optional auth", async (t) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "velodeck-apk-test-"));
  const apkPath = path.join(tempDir, "velodeck-agent.apk");
  const { server, baseUrl } = await startServer({ apkPath });
  t.after(async () => {
    await server.close();
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  // Before APK exists
  const infoBefore = await fetch(`${baseUrl}/api/info`);
  assert.equal(infoBefore.status, 200);
  assert.deepEqual(await infoBefore.json(), {
    ok: true,
    version: "1.0.9",
    hasAndroidApk: false,
    apkSha256: null,
    registrationMode: "first-user-then-invite",
    registrationOpen: true,
    requiresInviteCode: false,
  });

  const missingApkRes = await fetch(`${baseUrl}/api/download/velodeck-agent.apk`);
  assert.equal(missingApkRes.status, 404);
  assert.deepEqual(await missingApkRes.json(), { error: "Android APK 尚未上传" });

  // After APK is placed on disk
  const fakeApkBytes = Buffer.from("PK\x03\x04VELODECK-TEST-APK-BINARY-PAYLOAD-0123456789");
  const expectedSha256 = crypto.createHash("sha256").update(fakeApkBytes).digest("hex");
  await fsp.writeFile(apkPath, fakeApkBytes);

  const infoAfter = await fetch(`${baseUrl}/api/info`);
  assert.equal(infoAfter.status, 200);
  assert.deepEqual(await infoAfter.json(), {
    ok: true,
    version: "1.0.9",
    hasAndroidApk: true,
    apkSha256: expectedSha256,
    registrationMode: "first-user-then-invite",
    registrationOpen: true,
    requiresInviteCode: false,
  });

  // Primary route, versioned .apk route, and /api/download/android all serve versioned APK headers and expose X-APK-SHA256 over CORS
  for (const dlRoute of [
    "/api/download/velodeck-agent.apk",
    "/api/download/velodeck-agent-v1.0.9.apk",
    "/api/download/android",
  ]) {
    const dlRes = await fetch(`${baseUrl}${dlRoute}`, {
      headers: { Origin: baseUrl },
    });
    assert.equal(dlRes.status, 200);
    assert.equal(dlRes.headers.get("content-type"), "application/vnd.android.package-archive");
    assert.equal(
      dlRes.headers.get("content-disposition"),
      'attachment; filename="velodeck-agent-v1.0.9.apk"',
    );
    assert.equal(
      dlRes.headers.get("cache-control"),
      "no-store, no-cache, must-revalidate",
    );
    assert.equal(dlRes.headers.get("pragma"), "no-cache");
    assert.equal(dlRes.headers.get("content-length"), String(fakeApkBytes.byteLength));
    assert.equal(dlRes.headers.get("x-apk-sha256"), expectedSha256);
    assert.equal(
      dlRes.headers.get("access-control-expose-headers"),
      "X-APK-SHA256, Content-Length, Content-Range, ETag",
    );
    const receivedBytes = Buffer.from(await dlRes.arrayBuffer());
    assert.deepEqual(receivedBytes, fakeApkBytes);
  }

  // Malformed versioned APK routes still 404
  const badVersionedRes = await fetch(`${baseUrl}/api/download/velodeck-agent-v.apk`);
  assert.equal(badVersionedRes.status, 404);

  // Verify requireAuthForApk=true enforces Bearer JWT
  const sAuth = await startServer({ apkPath, requireAuthForApk: true });
  t.after(() => sAuth.server.close());
  const unauthDl = await fetch(`${sAuth.baseUrl}/api/download/velodeck-agent.apk`);
  assert.equal(unauthDl.status, 401);

  const reg = (await (
    await fetch(`${sAuth.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "apkuser", password: "apk-password-1" }),
    })
  ).json()) as { token: string };
  const authDl = await fetch(`${sAuth.baseUrl}/api/download/velodeck-agent.apk`, {
    headers: { Authorization: `Bearer ${reg.token}` },
  });
  assert.equal(authDl.status, 200);
});

// =============================================================================
// RED-TEAM REGRESSION TESTS (P0 / P1 / P2)
// =============================================================================

test("[P0-3] Prototype keys (toString, __proto__, constructor) and invalid directUrl rejected cleanly without crashing server", async (t) => {
  const { server, wsUrl } = await startServer();
  t.after(() => server.close());

  for (const dangerousId of ["toString", "__proto__", "constructor", "prototype", "short"]) {
    const client = await TestWsClient.connect(wsUrl);
    client.sendJson(
      makeAgentRegister({
        deviceId: dangerousId,
        deviceSecret: "secret-probe-123",
        controlPassword: "strong-password-1",
      }),
    );
    const err = await client.nextJson<ErrorMessage>();
    assert.equal(err.type, "error");
    assert.equal(err.code, "INVALID_MESSAGE");
    const closeInfo = await client.waitForClose();
    assert.equal(closeInfo.code, 4001);
  }

  // Server remains completely healthy and rejects untrusted directUrl (SSRF protection) while accepting private RFC1918 directUrl
  const agent = await TestWsClient.connect(wsUrl);
  t.after(() => agent.close());
  agent.sendJson(
    makeAgentRegister({
      deviceId: "dev-ssrf-check",
      directUrl: "ws://169.254.169.254/latest/meta-data",
    }),
  );
  const reg1 = await agent.nextJson<AgentRegisteredMessage>();
  assert.equal(reg1.type, "agent.registered");
  assert.equal(server.store.getDevice("dev-ssrf-check")?.summary.directUrl, undefined);

  const agentLan = await TestWsClient.connect(wsUrl);
  t.after(() => agentLan.close());
  agentLan.sendJson(
    makeAgentRegister({
      deviceId: "dev-lan-check",
      directUrl: "ws://192.168.1.42:9090/ws",
    }),
  );
  await agentLan.nextJson<AgentRegisteredMessage>();
  assert.equal(
    server.store.getDevice("dev-lan-check")?.summary.directUrl,
    "ws://192.168.1.42:9090/ws",
  );
});

test("[P0-2] Spoofed X-Forwarded-For headers are ignored when trustProxy=false", async (t) => {
  const { server, wsUrl } = await startServer({
    trustProxy: false,
    maxFailedAuthPerMin: 2,
  });
  t.after(() => server.close());

  // 2 failed attempts with DIFFERENT spoofed X-Forwarded-For headers still share socket IP 127.0.0.1
  for (const fakeIp of ["198.51.100.1", "198.51.100.2"]) {
    const c = await TestWsClient.connect(wsUrl, { "x-forwarded-for": fakeIp });
    c.sendJson({ type: "controller.auth", clientId: "" });
    const err = await c.nextJson<ErrorMessage>();
    assert.equal(err.code, "UNAUTHORIZED");
    await c.waitForClose();
  }

  // 3rd attempt with yet another spoofed X-Forwarded-For STILL gets RATE_LIMITED!
  const c3 = await TestWsClient.connect(wsUrl, { "x-forwarded-for": "198.51.100.99" });
  c3.sendJson({
    type: "controller.auth",
    controlCode: "123456789",
    controlPassword: "some-password",
    clientId: "ctrl-bypass-attempt",
  });
  const err3 = await c3.nextJson<ErrorMessage>();
  assert.equal(err3.code, "RATE_LIMITED");
  const close3 = await c3.waitForClose();
  assert.equal(close3.code, 4029);
});

test("[P0-4] Changing controlPassword immediately closes (4001) existing code-authenticated controller socket", async (t) => {
  const { server, wsUrl } = await startServer();
  t.after(() => server.close());

  const agent1 = await TestWsClient.connect(wsUrl);
  t.after(() => agent1.close());
  agent1.sendJson(
    makeAgentRegister({
      deviceId: "dev-rotate-pass",
      deviceSecret: "rotate-secret-1",
      controlPassword: "initial-pass-111",
    }),
  );
  const reg1 = await agent1.nextJson<AgentRegisteredMessage>();
  const code = reg1.controlCode!;

  // Guest authenticates via controlCode + initial password and starts a session
  const guest = await TestWsClient.connect(wsUrl);
  t.after(() => guest.close());
  guest.sendJson({
    type: "controller.auth",
    controlCode: code,
    controlPassword: "initial-pass-111",
    clientId: "ctrl-guest-1",
  });
  await guest.nextJson<ControllerAuthedMessage>();

  guest.sendJson({
    type: "session.request",
    sessionId: "sess-rotate-1",
    deviceId: "dev-rotate-pass",
    preferredTransport: "ws-jpeg",
    quality: QUALITY_PRESETS.eco,
  } satisfies SessionRequestMessage);
  await agent1.nextJson<SessionRequestMessage>();
  assert.equal(server.hub.getStats().activeSessions, 1);

  // Agent reconnects and rotates controlPassword
  const agent2 = await TestWsClient.connect(wsUrl);
  t.after(() => agent2.close());
  agent2.sendJson(
    makeAgentRegister({
      deviceId: "dev-rotate-pass",
      deviceSecret: "rotate-secret-1",
      controlPassword: "rotated-pass-222",
    }),
  );

  const [reg2, guestSessionEnd, guestClose] = await Promise.all([
    agent2.nextJson<AgentRegisteredMessage>(),
    guest.nextJson<SessionEndMessage>(),
    guest.waitForClose(),
  ]);

  assert.equal(reg2.type, "agent.registered");
  assert.equal(guestSessionEnd.type, "session.end");
  assert.equal(guestSessionEnd.reason, "device_access_changed");
  assert.equal(guestClose.code, 4001);
  assert.equal(guestClose.reason, "CREDENTIALS_CHANGED");
  assert.equal(server.hub.getStats().controllersConnected, 0);
  assert.equal(server.hub.getStats().activeSessions, 0);

  // Old password now fails; new password succeeds
  const guestOldPass = await TestWsClient.connect(wsUrl);
  guestOldPass.sendJson({
    type: "controller.auth",
    controlCode: code,
    controlPassword: "initial-pass-111",
    clientId: "ctrl-guest-old",
  });
  assert.equal((await guestOldPass.nextJson<ErrorMessage>()).code, "UNAUTHORIZED");
  assert.equal((await guestOldPass.waitForClose()).code, 4001);

  const guestNewPass = await TestWsClient.connect(wsUrl);
  t.after(() => guestNewPass.close());
  guestNewPass.sendJson({
    type: "controller.auth",
    controlCode: code,
    controlPassword: "rotated-pass-222",
    clientId: "ctrl-guest-new",
  });
  const authedNew = await guestNewPass.nextJson<ControllerAuthedMessage>();
  assert.equal(authedNew.type, "controller.authed");
});

test("[P1-1] Agent unbindOwner=true clears owner, kicks ONLY that device's session & notifies offline, without killing other devices' sessions or closing the account socket", async (t) => {
  const { server, baseUrl, wsUrl } = await startServer();
  t.after(() => server.close());

  const reg = (await (
    await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "boundowner", password: "boundowner-pass" }),
    })
  ).json()) as { token: string };

  const agent1 = await TestWsClient.connect(wsUrl);
  const agentKeep = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([agent1.close(), agentKeep.close()]);
  });
  agent1.sendJson(
    makeAgentRegister({
      deviceId: "dev-unbind-me",
      deviceSecret: "unbind-secret-1",
      authToken: reg.token,
      controlPassword: "device-pass-123",
    }),
  );
  const reg1 = await agent1.nextJson<AgentRegisteredMessage>();
  assert.equal(reg1.ownerUsername, "boundowner");

  agentKeep.sendJson(
    makeAgentRegister({
      deviceId: "dev-keep-me",
      deviceSecret: "keep-secret-2",
      authToken: reg.token,
      controlPassword: "device-pass-456",
    }),
  );
  const regKeep = await agentKeep.nextJson<AgentRegisteredMessage>();
  assert.equal(regKeep.ownerUsername, "boundowner");

  const ownerCtrl = await TestWsClient.connect(wsUrl);
  t.after(() => ownerCtrl.close());
  ownerCtrl.sendJson({
    type: "controller.auth",
    authToken: reg.token,
    clientId: "ctrl-owner-1",
  });
  const ownerAuthed = await ownerCtrl.nextJson<ControllerAuthedMessage>();
  assert.equal(ownerAuthed.devices.length, 2);

  // Start sessions on BOTH devices
  ownerCtrl.sendJson({
    type: "session.request",
    sessionId: "sess-owner-1",
    deviceId: "dev-unbind-me",
    preferredTransport: "ws-jpeg",
    quality: QUALITY_PRESETS.eco,
  } satisfies SessionRequestMessage);
  await agent1.nextJson<SessionRequestMessage>();

  ownerCtrl.sendJson({
    type: "session.request",
    sessionId: "sess-owner-keep",
    deviceId: "dev-keep-me",
    preferredTransport: "ws-jpeg",
    quality: QUALITY_PRESETS.eco,
  } satisfies SessionRequestMessage);
  await agentKeep.nextJson<SessionRequestMessage>();
  assert.equal(server.hub.getStats().activeSessions, 2);

  // Agent 1 reconnects with unbindOwner: true (authenticated by deviceSecret)
  const agent2 = await TestWsClient.connect(wsUrl);
  t.after(() => agent2.close());
  agent2.sendJson(
    makeAgentRegister({
      deviceId: "dev-unbind-me",
      deviceSecret: "unbind-secret-1",
      authToken: undefined,
      unbindOwner: true,
      controlPassword: "device-pass-123",
    }),
  );

  const [reg2, ctrlMsg1, ctrlMsg2] = await Promise.all([
    agent2.nextJson<AgentRegisteredMessage>(),
    ownerCtrl.nextJson(),
    ownerCtrl.nextJson(),
  ]);

  assert.equal(reg2.type, "agent.registered");
  assert.equal(reg2.ownerUsername, undefined);

  const received = [ctrlMsg1, ctrlMsg2];
  const ended = received.find((m) => m.type === "session.end") as SessionEndMessage | undefined;
  const offline = received.find((m) => m.type === "device.status") as
    | DeviceStatusMessage
    | undefined;
  assert.ok(ended, "expected session.end for unbound device");
  assert.equal(ended.sessionId, "sess-owner-1");
  assert.equal(ended.deviceId, "dev-unbind-me");
  assert.equal(ended.reason, "device_unbound");
  assert.ok(offline, "expected offline device.status for unbound device");
  assert.equal(offline.device.deviceId, "dev-unbind-me");
  assert.equal(offline.device.online, false);

  // Only dev-unbind-me's session ended; account WS stays OPEN and dev-keep-me's session stays alive!
  assert.equal(server.hub.getStats().activeSessions, 1);
  assert.equal(server.hub.getStats().controllersConnected, 1);

  // Former owner can NO LONGER access dev-unbind-me (UNAUTHORIZED)
  ownerCtrl.sendJson({
    type: "session.request",
    sessionId: "sess-owner-retry",
    deviceId: "dev-unbind-me",
    preferredTransport: "ws-jpeg",
    quality: QUALITY_PRESETS.eco,
  } satisfies SessionRequestMessage);
  const deniedErr = await ownerCtrl.nextJson<ErrorMessage>();
  assert.equal(deniedErr.code, "UNAUTHORIZED");

  // Meanwhile, existing session on dev-keep-me continues working uninterrupted!
  ownerCtrl.sendJson({
    type: "control.cmd",
    sessionId: "sess-owner-keep",
    deviceId: "dev-keep-me",
    seq: 5,
    command: { action: "tap", x: 0.5, y: 0.5 },
  } satisfies ControlCmdMessage);
  const forwardedKeep = await agentKeep.nextJson<ControlCmdMessage>();
  assert.equal(forwardedKeep.sessionId, "sess-owner-keep");
  assert.equal(forwardedKeep.deviceId, "dev-keep-me");

  // Former owner's /api/auth/me shows ONLY dev-keep-me
  const meAfter = (await (
    await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${reg.token}` },
    })
  ).json()) as { devices: Array<{ deviceId: string }> };
  assert.equal(meAfter.devices.length, 1);
  assert.equal(meAfter.devices[0]?.deviceId, "dev-keep-me");
});

test("[P0-5] Per-controlCode progressive lockout blocks brute-force across different IPs and legacy scrypt hashes remain readable", async (t) => {
  // Verify legacy <saltHex>:<keyHex> (N=16384) backward compatibility
  const legacySalt = crypto.randomBytes(16).toString("hex");
  const legacyKey = crypto.scryptSync("legacy-pass-123", legacySalt, 64).toString("hex");
  const legacyHash = `${legacySalt}:${legacyKey}`;
  assert.equal(await verifyPassword("legacy-pass-123", legacyHash), true);
  assert.equal(await verifyPassword("wrong-pass-123", legacyHash), false);

  const { server, wsUrl } = await startServer({ trustProxy: true, maxFailedAuthPerMin: 50 });
  t.after(() => server.close());

  const agent = await TestWsClient.connect(wsUrl);
  t.after(() => agent.close());
  agent.sendJson(
    makeAgentRegister({
      deviceId: "dev-bruteforce",
      controlPassword: "correct-password-1",
    }),
  );
  const reg = await agent.nextJson<AgentRegisteredMessage>();
  const code = reg.controlCode!;

  // 5 wrong attempts from 5 DIFFERENT public IPs
  for (let i = 1; i <= 5; i += 1) {
    const attacker = await TestWsClient.connect(wsUrl, {
      "x-forwarded-for": `203.0.113.${i}`,
    });
    attacker.sendJson({
      type: "controller.auth",
      controlCode: code,
      controlPassword: `wrong-guess-${i}`,
      clientId: `ctrl-brute-${i}`,
    });
    const err = await attacker.nextJson<ErrorMessage>();
    assert.equal(err.code, "UNAUTHORIZED");
    await attacker.waitForClose();
  }

  // 6th attempt from a 6th IP — even with the CORRECT password — is locked out!
  const lockedAttempt = await TestWsClient.connect(wsUrl, {
    "x-forwarded-for": "203.0.113.99",
  });
  lockedAttempt.sendJson({
    type: "controller.auth",
    controlCode: code,
    controlPassword: "correct-password-1",
    clientId: "ctrl-after-lockout",
  });
  const lockErr = await lockedAttempt.nextJson<ErrorMessage>();
  assert.equal(lockErr.code, "RATE_LIMITED");
  const lockClose = await lockedAttempt.waitForClose();
  assert.equal(lockClose.code, 4029);

  // Also verify per-username HTTP login progressive lockout across different IPs
  const { server: sLogin, baseUrl } = await startServer({
    trustProxy: true,
    maxFailedAuthPerMin: 50,
  });
  t.after(() => sLogin.close());
  await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "locktarget", password: "correct-user-pass" }),
  });
  for (let i = 1; i <= 5; i += 1) {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": `198.51.100.${i}`,
      },
      body: JSON.stringify({ username: "locktarget", password: `wrong-pass-${i}` }),
    });
    assert.equal(res.status, 401);
  }
  const lockedLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "198.51.100.99",
    },
    body: JSON.stringify({ username: "locktarget", password: "correct-user-pass" }),
  });
  assert.equal(lockedLogin.status, 429);
});

test("[P1-5] Registration modes: first-user-then-invite (with and without invite code) and closed", async (t) => {
  // 1. Default first-user-then-invite without invite code
  const sDefault = await startServer();
  t.after(() => sDefault.server.close());

  const firstRes = await fetch(`${sDefault.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "firstadmin", password: "admin-password-1" }),
  });
  assert.equal(firstRes.status, 201);

  const infoLocked = (await (await fetch(`${sDefault.baseUrl}/api/info`)).json()) as {
    registrationOpen: boolean;
    requiresInviteCode: boolean;
  };
  assert.equal(infoLocked.registrationOpen, false);
  assert.equal(infoLocked.requiresInviteCode, true);

  const secondBlocked = await fetch(`${sDefault.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "stranger1", password: "stranger-password-1" }),
  });
  assert.equal(secondBlocked.status, 403);

  // 2. first-user-then-invite WITH invite code configured
  const sInvite = await startServer({
    registrationMode: "first-user-then-invite",
    registrationInviteCode: "VELODECK-INVITE-2026",
  });
  t.after(() => sInvite.server.close());

  // 1st user succeeds without invite code
  const u1 = await fetch(`${sInvite.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "owner_first", password: "first-password-1" }),
  });
  assert.equal(u1.status, 201);

  // 2nd user without invite code -> 403
  const u2NoCode = await fetch(`${sInvite.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "second_user", password: "second-password-1" }),
  });
  assert.equal(u2NoCode.status, 403);

  // 2nd user with wrong invite code -> 403
  const u2WrongCode = await fetch(`${sInvite.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "second_user",
      password: "second-password-1",
      inviteCode: "WRONG-CODE",
    }),
  });
  assert.equal(u2WrongCode.status, 403);

  // 2nd user with valid invite code -> 201
  const u2Valid = await fetch(`${sInvite.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "second_user",
      password: "second-password-1",
      inviteCode: "VELODECK-INVITE-2026",
    }),
  });
  assert.equal(u2Valid.status, 201);

  // 3. closed mode blocks even the 1st user
  const sClosed = await startServer({ registrationMode: "closed" });
  t.after(() => sClosed.server.close());
  const closedReg = await fetch(`${sClosed.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "anyone", password: "anyone-password-1" }),
  });
  assert.equal(closedReg.status, 403);
});

test("[P1-6] POST /api/auth/logout-all and /api/auth/change-password immediately revoke JWTs and close WS sockets", async (t) => {
  const { server, baseUrl, wsUrl } = await startServer();
  t.after(() => server.close());

  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "tokenuser", password: "initial-password-1" }),
  });
  const { token: token1 } = (await regRes.json()) as { token: string };

  // Connect both a controller and an agent using token1
  const ctrl1 = await TestWsClient.connect(wsUrl);
  const agent1 = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([ctrl1.close(), agent1.close()]);
  });

  ctrl1.sendJson({ type: "controller.auth", authToken: token1, clientId: "ctrl-tv-1" });
  await ctrl1.nextJson<ControllerAuthedMessage>();

  agent1.sendJson(
    makeAgentRegister({
      deviceId: "dev-tv-agent",
      authToken: token1,
    }),
  );
  await agent1.nextJson<AgentRegisteredMessage>();

  // 1. Call POST /api/auth/logout-all -> invalidates token1 and closes BOTH WS sockets with 4001!
  const logoutRes = await fetch(`${baseUrl}/api/auth/logout-all`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token1}` },
  });
  assert.equal(logoutRes.status, 200);

  const [ctrl1Close, agent1Close] = await Promise.all([
    ctrl1.waitForClose(),
    agent1.waitForClose(),
  ]);
  assert.equal(ctrl1Close.code, 4001);
  assert.equal(agent1Close.code, 4001);

  // Old JWT fails HTTP /api/auth/me (401) and WS controller.auth (4001)
  const meOld = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token1}` },
  });
  assert.equal(meOld.status, 401);

  const ctrlStale = await TestWsClient.connect(wsUrl);
  ctrlStale.sendJson({ type: "controller.auth", authToken: token1, clientId: "ctrl-stale" });
  assert.equal((await ctrlStale.nextJson<ErrorMessage>()).code, "UNAUTHORIZED");
  assert.equal((await ctrlStale.waitForClose()).code, 4001);

  // 2. Log back in -> get token2, connect WS controller -> call POST /api/auth/change-password
  const login2 = (await (
    await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "tokenuser", password: "initial-password-1" }),
    })
  ).json()) as { token: string };
  const token2 = login2.token;

  const ctrl2 = await TestWsClient.connect(wsUrl);
  t.after(() => ctrl2.close());
  ctrl2.sendJson({ type: "controller.auth", authToken: token2, clientId: "ctrl-tv-2" });
  await ctrl2.nextJson<ControllerAuthedMessage>();

  // Wrong current password rejected with 401
  const badChange = await fetch(`${baseUrl}/api/auth/change-password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token2}`,
    },
    body: JSON.stringify({
      currentPassword: "wrong-current-password",
      newPassword: "new-strong-password-2",
    }),
  });
  assert.equal(badChange.status, 401);

  // Valid password change revokes token2, closes ctrl2 (4001), and returns fresh token3
  const goodChange = await fetch(`${baseUrl}/api/auth/change-password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token2}`,
    },
    body: JSON.stringify({
      currentPassword: "initial-password-1",
      newPassword: "new-strong-password-2",
    }),
  });
  assert.equal(goodChange.status, 200);
  const { token: token3 } = (await goodChange.json()) as { token: string };
  assert.ok(token3 && token3 !== token2);

  assert.equal((await ctrl2.waitForClose()).code, 4001);

  // token2 is rejected; token3 works; old password fails login; new password succeeds login
  assert.equal(
    (await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token2}` } }))
      .status,
    401,
  );
  assert.equal(
    (await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token3}` } }))
      .status,
    200,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "tokenuser", password: "initial-password-1" }),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "tokenuser", password: "new-strong-password-2" }),
      })
    ).status,
    200,
  );
});

test("[P0-6] Legacy accessToken disabled by default, repeat auth rejected, and TURN never minted to unverified clients", async (t) => {
  const { server, wsUrl } = await startServer({
    turnUrls: ["turn:turn.example.com:3478"],
    turnSecret: "strong-turn-secret-for-p06-test",
  });
  t.after(() => server.close());

  // Legacy token controller auth fails when enableLegacyTokenAuth=false (default)
  const ctrlLegacy = await TestWsClient.connect(wsUrl);
  ctrlLegacy.sendJson({
    type: "controller.auth",
    accessToken: "any-random-token",
    clientId: "ctrl-legacy-probe",
  });
  const err = await ctrlLegacy.nextJson<ErrorMessage>();
  assert.equal(err.code, "UNAUTHORIZED");
  assert.equal((await ctrlLegacy.waitForClose()).code, 4001);

  // Legacy-only agent registration also fails when enableLegacyTokenAuth=false
  const agentLegacy = await TestWsClient.connect(wsUrl);
  agentLegacy.sendJson(
    makeAgentRegister({
      deviceId: "dev-legacy-only",
      controlPassword: undefined,
      accessToken: "legacy-only-token",
    }),
  );
  assert.equal((await agentLegacy.nextJson<ErrorMessage>()).code, "UNAUTHORIZED");
  assert.equal((await agentLegacy.waitForClose()).code, 4001);

  // Repeat authentication on an already-authenticated socket is rejected
  const agentOk = await TestWsClient.connect(wsUrl);
  t.after(() => agentOk.close());
  agentOk.sendJson(makeAgentRegister({ deviceId: "dev-repeat-auth" }));
  await agentOk.nextJson<AgentRegisteredMessage>();

  agentOk.sendJson(makeAgentRegister({ deviceId: "dev-repeat-auth" }));
  const repeatErr = await agentOk.nextJson<ErrorMessage>();
  assert.equal(repeatErr.code, "INVALID_MESSAGE");
});

test("[P1-7 & P1-8] WS auth timeout, pre-auth size cap, per-IP connection cap, and cross-origin WS upgrade rejection (403)", async (t) => {
  const { server, baseUrl, wsUrl } = await startServer({
    authTimeoutMs: 150,
    maxWsPerIp: 2,
  });
  t.after(() => server.close());

  // 1. Cross-origin browser WS upgrade rejected with HTTP 403
  const wsRejectedStatus = await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: { Origin: "https://evil.attacker.example" },
    });
    ws.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once("open", () => {
      ws.close();
      reject(new Error("Expected cross-origin WS upgrade to be rejected"));
    });
    ws.once("error", () => {
      // Handled by unexpected-response
    });
  });
  assert.equal(wsRejectedStatus, 403);

  // Same-origin and Capacitor origins are allowed
  const sameOriginWs = await TestWsClient.connect(wsUrl, { Origin: baseUrl });
  await sameOriginWs.close();
  const capWs = await TestWsClient.connect(wsUrl, { Origin: "capacitor://localhost" });
  await capWs.close();

  // 2. Unauthenticated WS connection is closed with 4008 AUTH_TIMEOUT after authTimeoutMs
  const slowloris = await TestWsClient.connect(wsUrl);
  const timeoutErr = await slowloris.nextJson<ErrorMessage>(2000);
  assert.equal(timeoutErr.code, "UNAUTHORIZED");
  const timeoutClose = await slowloris.waitForClose(2000);
  assert.equal(timeoutClose.code, 4008);
  assert.equal(timeoutClose.reason, "AUTH_TIMEOUT");

  // 3. Pre-auth oversized text payload (> 8 KB) rejected and closed 1009
  const oversized = await TestWsClient.connect(wsUrl);
  oversized.sendRawText(JSON.stringify({ type: "controller.auth", pad: "A".repeat(10_000) }));
  const sizeErr = await oversized.nextJson<ErrorMessage>();
  assert.equal(sizeErr.code, "INVALID_MESSAGE");
  const sizeClose = await oversized.waitForClose();
  assert.equal(sizeClose.code, 1009);

  // 4. Per-IP concurrent WS connection cap (maxWsPerIp = 2)
  const c1 = await TestWsClient.connect(wsUrl);
  const c2 = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([c1.close(), c2.close()]);
  });
  c1.sendJson(makeAgentRegister({ deviceId: "dev-cap-conn-1" }));
  c2.sendJson(makeAgentRegister({ deviceId: "dev-cap-conn-2" }));
  await Promise.all([
    c1.nextJson<AgentRegisteredMessage>(),
    c2.nextJson<AgentRegisteredMessage>(),
  ]);

  const c3 = await TestWsClient.connect(wsUrl);
  const capErr = await c3.nextJson<ErrorMessage>();
  assert.equal(capErr.code, "RATE_LIMITED");
  const capClose = await c3.waitForClose();
  assert.equal(capClose.code, 4029);
});

test("Agent ErrorMessage is forwarded to matching controller, prunes stale session on terminal errors, and never echoes unsupported type back to agent", async (t) => {
  const { server, wsUrl } = await startServer();
  t.after(() => server.close());

  const agentA = await TestWsClient.connect(wsUrl);
  const agentB = await TestWsClient.connect(wsUrl);
  const ctrl = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([agentA.close(), agentB.close(), ctrl.close()]);
  });

  agentA.sendJson(
    makeAgentRegister({
      deviceId: "dev-err-alpha",
      deviceSecret: "secret-err-alpha",
      controlPassword: "err-password-alpha",
    }),
  );
  const regA = await agentA.nextJson<AgentRegisteredMessage>();
  assert.ok(regA.controlCode);

  agentB.sendJson(
    makeAgentRegister({
      deviceId: "dev-err-beta",
      deviceSecret: "secret-err-beta",
      controlPassword: "err-password-beta",
    }),
  );
  await agentB.nextJson<AgentRegisteredMessage>();

  ctrl.sendJson({
    type: "controller.auth",
    controlCode: regA.controlCode,
    controlPassword: "err-password-alpha",
    clientId: "ctrl-err-test",
  });
  await ctrl.nextJson<ControllerAuthedMessage>();

  // 1. Start session -> agentA replies with terminal INTERNAL_ERROR (e.g. MediaProjection not granted)
  ctrl.sendJson({
    type: "session.request",
    sessionId: "sess-err-001",
    deviceId: "dev-err-alpha",
    preferredTransport: "webrtc",
    quality: QUALITY_PRESETS.balanced,
  } satisfies SessionRequestMessage);
  const req1 = await agentA.nextJson<SessionRequestMessage>();
  assert.equal(req1.preferredTransport, "webrtc");
  assert.equal(server.hub.getStats().activeSessions, 1);

  // Cross-device spoofing from agentB referencing agentA's session is silently ignored
  agentB.sendJson({
    type: "error",
    code: "INTERNAL_ERROR",
    message: "spoofed by beta",
    sessionId: "sess-err-001",
    deviceId: "dev-err-alpha",
  } satisfies ErrorMessage);
  agentB.sendJson({
    type: "error",
    code: "INTERNAL_ERROR",
    message: "spoofed session id with own device",
    sessionId: "sess-err-001",
    deviceId: "dev-err-beta",
  } satisfies ErrorMessage);
  agentB.sendJson({ type: "ping", ts: 111 });
  const pongB = await agentB.nextJson<PongMessage>();
  assert.equal(pongB.type, "pong");
  assert.equal(server.hub.getStats().activeSessions, 1);
  assert.equal(ctrl.drainJson().length, 0);

  // Legitimate agentA sends INTERNAL_ERROR for sess-err-001
  agentA.sendJson({
    type: "error",
    code: "INTERNAL_ERROR",
    message: "MediaProjection not yet granted on Android device",
    sessionId: "sess-err-001",
    deviceId: "dev-err-alpha",
  } satisfies ErrorMessage);

  const fwdErr1 = await ctrl.nextJson<ErrorMessage>();
  assert.equal(fwdErr1.type, "error");
  assert.equal(fwdErr1.code, "INTERNAL_ERROR");
  assert.equal(fwdErr1.message, "MediaProjection not yet granted on Android device");
  assert.equal(fwdErr1.sessionId, "sess-err-001");
  assert.equal(fwdErr1.deviceId, "dev-err-alpha");

  // Stale pending session must have been removed from hub.sessions
  assert.equal(server.hub.getStats().activeSessions, 0);

  // AgentA must NEVER receive "Unsupported client message type: error"
  agentA.sendJson({ type: "ping", ts: 222 });
  const pongA = await agentA.nextJson<PongMessage>();
  assert.equal(pongA.type, "pong");
  assert.equal(pongA.ts, 222);

  // 2. AgentA sends SESSION_NOT_FOUND by deviceId only (without sessionId) -> forwarded & pruned
  ctrl.sendJson({
    type: "session.request",
    sessionId: "sess-err-002",
    deviceId: "dev-err-alpha",
    preferredTransport: "webrtc",
    quality: QUALITY_PRESETS.balanced,
  } satisfies SessionRequestMessage);
  await agentA.nextJson<SessionRequestMessage>();
  assert.equal(server.hub.getStats().activeSessions, 1);

  agentA.sendJson({
    type: "error",
    code: "SESSION_NOT_FOUND",
    message: "Session vanished on agent",
    deviceId: "dev-err-alpha",
  } satisfies ErrorMessage);

  const fwdErr2 = await ctrl.nextJson<ErrorMessage>();
  assert.equal(fwdErr2.type, "error");
  assert.equal(fwdErr2.code, "SESSION_NOT_FOUND");
  assert.equal(fwdErr2.sessionId, "sess-err-002");
  assert.equal(fwdErr2.deviceId, "dev-err-alpha");
  assert.equal(server.hub.getStats().activeSessions, 0);

  // 3. Agent attempting to forge UNAUTHORIZED is downgraded to INTERNAL_ERROR (cannot kill controller WS auth)
  ctrl.sendJson({
    type: "session.request",
    sessionId: "sess-err-003",
    deviceId: "dev-err-alpha",
    preferredTransport: "webrtc",
    quality: QUALITY_PRESETS.balanced,
  } satisfies SessionRequestMessage);
  await agentA.nextJson<SessionRequestMessage>();

  agentA.sendJson({
    type: "error",
    code: "UNAUTHORIZED",
    message: "Session is not owned by this connection",
    sessionId: "sess-err-003",
    deviceId: "dev-err-alpha",
  } satisfies ErrorMessage);

  const fwdErr3 = await ctrl.nextJson<ErrorMessage>();
  assert.equal(fwdErr3.type, "error");
  assert.equal(fwdErr3.code, "INTERNAL_ERROR");
  assert.equal(fwdErr3.sessionId, "sess-err-003");
  assert.equal(server.hub.getStats().activeSessions, 0);

  // 4. Controller sending error is still rejected as unsupported client message type
  ctrl.sendJson({
    type: "error",
    code: "INTERNAL_ERROR",
    message: "controller should not send errors",
  } satisfies ErrorMessage);
  const ctrlErr = await ctrl.nextJson<ErrorMessage>();
  assert.equal(ctrlErr.code, "INVALID_MESSAGE");
  assert.match(ctrlErr.message, /Unsupported client message type: error/);
});

// =============================================================================
// HARDENING REGRESSION TESTS (P0-1 through P2)
// =============================================================================

test("[P0-1] Per-session fresh TURN HMAC credentials injected into session.request and session.ready", async (t) => {
  const turnSecret = "strong-per-session-turn-secret-abcdef123456";
  const { server, wsUrl } = await startServer({
    turnUrls: [
      "turn:203.0.113.10:3478?transport=udp",
      "turn:203.0.113.10:3478?transport=tcp",
    ],
    turnSecret,
    turnTtlSeconds: 1800,
  });
  t.after(() => server.close());

  const agent = await TestWsClient.connect(wsUrl);
  const ctrl = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([agent.close(), ctrl.close()]);
  });

  agent.sendJson(
    makeAgentRegister({
      deviceId: "dev-fresh-turn",
      controlPassword: "fresh-turn-password",
    }),
  );
  const reg = await agent.nextJson<AgentRegisteredMessage>();
  assert.ok(reg.controlCode);

  ctrl.sendJson({
    type: "controller.auth",
    controlCode: reg.controlCode,
    controlPassword: "fresh-turn-password",
    clientId: "ctrl-fresh-01",
  });
  await ctrl.nextJson<ControllerAuthedMessage>();

  // session.request should carry fresh agent TURN credentials
  ctrl.sendJson({
    type: "session.request",
    sessionId: "sess-fresh-turn-1",
    deviceId: "dev-fresh-turn",
    preferredTransport: "webrtc",
    quality: QUALITY_PRESETS.balanced,
  } satisfies SessionRequestMessage);

  const fwdReq = await agent.nextJson<SessionRequestMessage>();
  assert.ok(Array.isArray(fwdReq.iceServers) && fwdReq.iceServers.length === 3);
  assert.deepEqual(fwdReq.iceServers[0]?.urls, [
    "stun:203.0.113.10:3478",
    ...DEFAULT_STUN_URLS,
  ]);
  const agentTurnUdp = fwdReq.iceServers[1];
  const agentTurnTcp = fwdReq.iceServers[2];
  assert.ok(agentTurnUdp?.username && agentTurnUdp.credential);
  assert.match(agentTurnUdp.username, /^\d+:agent-dev-fresh-turn$/);
  const expectedAgentCred = crypto
    .createHmac("sha1", turnSecret)
    .update(agentTurnUdp.username, "utf8")
    .digest("base64");
  assert.equal(agentTurnUdp.credential, expectedAgentCred);
  assert.deepEqual(agentTurnUdp.urls, ["turn:203.0.113.10:3478?transport=udp"]);
  assert.deepEqual(agentTurnTcp?.urls, ["turn:203.0.113.10:3478?transport=tcp"]);
  assert.equal(agentTurnTcp?.username, agentTurnUdp.username);
  assert.equal(agentTurnTcp?.credential, expectedAgentCred);

  // session.ready should carry fresh controller TURN credentials
  agent.sendJson({
    type: "session.ready",
    sessionId: "sess-fresh-turn-1",
    deviceId: "dev-fresh-turn",
    transport: "webrtc",
    screenWidth: 1080,
    screenHeight: 2400,
    rotation: 0,
  } satisfies SessionReadyMessage);

  const fwdReady = await ctrl.nextJson<SessionReadyMessage>();
  assert.ok(Array.isArray(fwdReady.iceServers) && fwdReady.iceServers.length === 3);
  const ctrlTurn = fwdReady.iceServers[1];
  assert.ok(ctrlTurn?.username && ctrlTurn.credential);
  assert.match(ctrlTurn.username, /^\d+:ctrl-ctrl-fresh-01$/);
  const expectedCtrlCred = crypto
    .createHmac("sha1", turnSecret)
    .update(ctrlTurn.username, "utf8")
    .digest("base64");
  assert.equal(ctrlTurn.credential, expectedCtrlCred);
  assert.deepEqual(ctrlTurn.urls, ["turn:203.0.113.10:3478?transport=udp"]);
  assert.deepEqual(fwdReady.iceServers[2]?.urls, ["turn:203.0.113.10:3478?transport=tcp"]);

  // Invalid session.request parameters are rejected before storing/forwarding
  ctrl.sendJson({
    type: "session.request",
    sessionId: "sess-bad-params-1",
    deviceId: "dev-fresh-turn",
    preferredTransport: "invalid-transport" as unknown as "webrtc",
    quality: QUALITY_PRESETS.eco,
  } satisfies SessionRequestMessage);
  const badTransportErr = await ctrl.nextJson<ErrorMessage>();
  assert.equal(badTransportErr.code, "INVALID_MESSAGE");

  ctrl.sendJson({
    type: "session.request",
    sessionId: "sess-bad-params-2",
    deviceId: "dev-fresh-turn",
    preferredTransport: "webrtc",
    quality: { maxWidth: Number.NaN, fps: 60, bitrateKbps: 1000, jpegQuality: 50 },
  } satisfies SessionRequestMessage);
  const badQualityErr = await ctrl.nextJson<ErrorMessage>();
  assert.equal(badQualityErr.code, "INVALID_MESSAGE");
  assert.equal(server.hub.getStats().activeSessions, 1);
});

test("[P0-3] Agent reconnect terminates active sessions with reason agent_reconnected and prevents MAX_SESSIONS_PER_DEVICE exhaustion", async (t) => {
  const { server, wsUrl } = await startServer();
  t.after(() => server.close());

  const agent1 = await TestWsClient.connect(wsUrl);
  const ctrlA = await TestWsClient.connect(wsUrl);
  const ctrlB = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([agent1.close(), ctrlA.close(), ctrlB.close()]);
  });

  agent1.sendJson(
    makeAgentRegister({
      deviceId: "dev-zombie-sess",
      deviceSecret: "zombie-secret-123",
      controlPassword: "zombie-password-123",
    }),
  );
  const reg1 = await agent1.nextJson<AgentRegisteredMessage>();
  const code = reg1.controlCode!;

  ctrlA.sendJson({
    type: "controller.auth",
    controlCode: code,
    controlPassword: "zombie-password-123",
    clientId: "ctrl-zombie-a",
  });
  ctrlB.sendJson({
    type: "controller.auth",
    controlCode: code,
    controlPassword: "zombie-password-123",
    clientId: "ctrl-zombie-b",
  });
  await Promise.all([
    ctrlA.nextJson<ControllerAuthedMessage>(),
    ctrlB.nextJson<ControllerAuthedMessage>(),
  ]);

  // Saturate MAX_SESSIONS_PER_DEVICE = 2
  ctrlA.sendJson({
    type: "session.request",
    sessionId: "sess-zombie-01",
    deviceId: "dev-zombie-sess",
    preferredTransport: "ws-jpeg",
    quality: QUALITY_PRESETS.eco,
  } satisfies SessionRequestMessage);
  ctrlB.sendJson({
    type: "session.request",
    sessionId: "sess-zombie-02",
    deviceId: "dev-zombie-sess",
    preferredTransport: "ws-jpeg",
    quality: QUALITY_PRESETS.eco,
  } satisfies SessionRequestMessage);
  await agent1.nextJson<SessionRequestMessage>();
  await agent1.nextJson<SessionRequestMessage>();
  assert.equal(server.hub.getStats().activeSessions, 2);

  // Agent reconnects on a new socket while agent1 is still live (simulating half-open reconnect)
  const agent2 = await TestWsClient.connect(wsUrl);
  t.after(() => agent2.close());
  agent2.sendJson(
    makeAgentRegister({
      deviceId: "dev-zombie-sess",
      deviceSecret: "zombie-secret-123",
      controlPassword: "zombie-password-123",
    }),
  );

  const [reg2, oldClose, endA, endB] = await Promise.all([
    agent2.nextJson<AgentRegisteredMessage>(),
    agent1.waitForClose(),
    ctrlA.nextJson<SessionEndMessage>(),
    ctrlB.nextJson<SessionEndMessage>(),
  ]);

  assert.equal(reg2.type, "agent.registered");
  assert.equal(oldClose.code, 4000);
  assert.equal(endA.type, "session.end");
  assert.equal(endA.sessionId, "sess-zombie-01");
  assert.equal(endA.reason, "agent_reconnected");
  assert.equal(endB.type, "session.end");
  assert.equal(endB.sessionId, "sess-zombie-02");
  assert.equal(endB.reason, "agent_reconnected");
  assert.equal(server.hub.getStats().activeSessions, 0);

  // Controllers can immediately open new sessions without hitting MAX_SESSIONS_PER_DEVICE
  ctrlA.sendJson({
    type: "session.request",
    sessionId: "sess-after-reconn",
    deviceId: "dev-zombie-sess",
    preferredTransport: "webrtc",
    quality: QUALITY_PRESETS.balanced,
  } satisfies SessionRequestMessage);
  const newReq = await agent2.nextJson<SessionRequestMessage>();
  assert.equal(newReq.sessionId, "sess-after-reconn");
  assert.equal(server.hub.getStats().activeSessions, 1);
});

test("[P0-4] Concurrent POST /api/auth/register in first-user-then-invite mode allows ONLY 1 account without invite code", async (t) => {
  const { server, baseUrl } = await startServer({
    registrationMode: "first-user-then-invite",
    trustProxy: true,
  });
  t.after(() => server.close());

  // Launch 6 simultaneous registration requests from distinct IPs on a fresh server
  const attempts = Array.from({ length: 6 }, (_, i) =>
    fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": `203.0.113.${10 + i}`,
      },
      body: JSON.stringify({
        username: `racer_${i}`,
        password: "strong-racer-password",
      }),
    }),
  );

  const responses = await Promise.all(attempts);
  const statuses = responses.map((r) => r.status);
  const createdCount = statuses.filter((s) => s === 201).length;
  const forbiddenCount = statuses.filter((s) => s === 403).length;

  assert.equal(createdCount, 1, `expected exactly 1 account created, got statuses: ${statuses.join(",")}`);
  assert.equal(forbiddenCount, 5, `expected 5 forbidden responses, got statuses: ${statuses.join(",")}`);
  assert.equal(server.store.getUserCount(), 1);
});

test("[P0-4] AsyncSemaphore strictly never exceeds maxConcurrent under concurrent bursts", async () => {
  const maxConcurrent = 3;
  const sem = new AsyncSemaphore(maxConcurrent);
  let active = 0;
  let peakActive = 0;
  let completed = 0;

  const runTask = async (idx: number): Promise<void> => {
    await sem.acquire();
    active += 1;
    if (active > peakActive) {
      peakActive = active;
    }
    assert.ok(
      active <= maxConcurrent,
      `semaphore overshoot detected on task ${idx}: active=${active} > max=${maxConcurrent}`,
    );
    // Mix microtask-only and timer-delayed work to exercise direct permit handoff under synchronous arrivals
    if (idx % 3 === 0) {
      await Promise.resolve();
    } else {
      await new Promise((r) => setTimeout(r, (idx % 4) + 1));
    }
    active -= 1;
    completed += 1;
    sem.release();
  };

  // Fire first wave, then fire a second synchronous wave right as permits start releasing
  const wave1 = Array.from({ length: 30 }, (_, i) => runTask(i));
  await new Promise((r) => setTimeout(r, 2));
  const wave2 = Array.from({ length: 30 }, (_, i) => runTask(i + 30));

  await Promise.all([...wave1, ...wave2]);
  assert.equal(completed, 60);
  assert.equal(active, 0);
  assert.equal(peakActive, maxConcurrent);
});

test("[P0-5] loadConfig auto-derives TURN_URLS from PUBLIC_IP + TURN_SECRET and clamps heartbeatTimeoutMs", () => {
  const strongSecret = "abcdef0123456789abcdef0123456789";

  // Auto-derives when TURN_URLS is unset
  const derivedUnset = loadConfig({
    PUBLIC_IP: "198.51.100.25",
    TURN_SECRET: strongSecret,
  });
  assert.deepEqual(derivedUnset.turnUrls, [
    "turn:198.51.100.25:3478?transport=udp",
    "turn:198.51.100.25:3478?transport=tcp",
  ]);

  // Auto-derives when TURN_URLS is empty string (e.g. docker-compose default)
  const derivedEmpty = loadConfig({
    PUBLIC_IP: "198.51.100.25",
    TURN_URLS: "   ",
    TURN_SECRET: strongSecret,
  });
  assert.deepEqual(derivedEmpty.turnUrls, [
    "turn:198.51.100.25:3478?transport=udp",
    "turn:198.51.100.25:3478?transport=tcp",
  ]);

  // Explicit TURN_URLS takes precedence
  const explicit = loadConfig({
    PUBLIC_IP: "198.51.100.25",
    TURN_URLS: "turn:custom.example.com:3478?transport=udp",
    TURN_SECRET: strongSecret,
  });
  assert.deepEqual(explicit.turnUrls, ["turn:custom.example.com:3478?transport=udp"]);

  // Does not derive without TURN_SECRET
  const noSecret = loadConfig({ PUBLIC_IP: "198.51.100.25" });
  assert.deepEqual(noSecret.turnUrls, []);

  // Clamps misconfigured heartbeatTimeoutMs <= heartbeatIntervalMs
  const clamped = loadConfig({
    HEARTBEAT_INTERVAL_MS: "10000",
    HEARTBEAT_TIMEOUT_MS: "5000",
  });
  assert.equal(clamped.heartbeatIntervalMs, 10_000);
  assert.equal(clamped.heartbeatTimeoutMs, 20_000);
});

test("[P1-2 & P2] Store recovers from corrupt store.json using .bak, cleans stale .tmp files, and scopes concurrent out-of-band wake acks", async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "velodeck-bak-test-"));
  t.after(async () => {
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  // Create store, write two snapshots so store.json.bak is populated, plus plant a stale .tmp file
  const store1 = new VeloDeckStore(dataDir);
  await store1.createUser("bakuser1", "bak-password-1");
  await store1.flush();
  await store1.createUser("bakuser2", "bak-password-2");
  await store1.flush();

  const staleTmp = path.join(dataDir, "store.json.tmp.99999.deadbeef");
  await fsp.writeFile(staleTmp, "{partial", "utf8");
  // Corrupt primary store.json
  await fsp.writeFile(path.join(dataDir, "store.json"), "{corrupted-json!!!", "utf8");

  // Reloading cleans stale .tmp and recovers from store.json.bak
  const store2 = new VeloDeckStore(dataDir);
  await store2.flush();
  assert.equal(store2.getUserCount(), 1);
  assert.ok(await store2.authenticateUser("bakuser1", "bak-password-1"));
  await assert.rejects(() => fsp.stat(staleTmp));

  // Verify two controllers sending concurrent sessionless wake with identical seq=1 both receive acks cleanly
  const { server, wsUrl } = await startServer();
  t.after(() => server.close());

  const agent = await TestWsClient.connect(wsUrl);
  const ctrl1 = await TestWsClient.connect(wsUrl);
  const ctrl2 = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([agent.close(), ctrl1.close(), ctrl2.close()]);
  });

  agent.sendJson(
    makeAgentRegister({
      deviceId: "dev-oob-race",
      controlPassword: "oob-password-123",
    }),
  );
  const reg = await agent.nextJson<AgentRegisteredMessage>();
  const code = reg.controlCode!;

  ctrl1.sendJson({
    type: "controller.auth",
    controlCode: code,
    controlPassword: "oob-password-123",
    clientId: "ctrl-oob-1",
  });
  ctrl2.sendJson({
    type: "controller.auth",
    controlCode: code,
    controlPassword: "oob-password-123",
    clientId: "ctrl-oob-2",
  });
  await Promise.all([
    ctrl1.nextJson<ControllerAuthedMessage>(),
    ctrl2.nextJson<ControllerAuthedMessage>(),
  ]);

  ctrl1.sendJson({
    type: "control.cmd",
    sessionId: "",
    deviceId: "dev-oob-race",
    seq: 1,
    command: { action: "wake" },
  });
  ctrl2.sendJson({
    type: "control.cmd",
    sessionId: "",
    deviceId: "dev-oob-race",
    seq: 1,
    command: { action: "wake" },
  });
  await agent.nextJson<ControlCmdMessage>();
  await agent.nextJson<ControlCmdMessage>();

  // Agent sends two acks for seq=1 -> first goes to ctrl1, second goes to ctrl2
  agent.sendJson({
    type: "control.ack",
    sessionId: "",
    deviceId: "dev-oob-race",
    seq: 1,
    ok: true,
    message: "ack-1",
  });
  agent.sendJson({
    type: "control.ack",
    sessionId: "",
    deviceId: "dev-oob-race",
    seq: 1,
    ok: true,
    message: "ack-2",
  });

  const [ack1, ack2] = await Promise.all([
    ctrl1.nextJson<ControlAckMessage>(),
    ctrl2.nextJson<ControlAckMessage>(),
  ]);
  assert.equal(ack1.message, "ack-1");
  assert.equal(ack2.message, "ack-2");
});

test("APK download supports .apk URL alias, Accept-Ranges, ETag, 206 Partial Content, If-Range, 304, and 416", async (t) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "velodeck-apk-range-test-"));
  const apkPath = path.join(tempDir, "velodeck-agent.apk");
  const payload = Buffer.from("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz");
  const expectedSha256 = crypto.createHash("sha256").update(payload).digest("hex");
  const expectedEtag = `"${expectedSha256}"`;
  await fsp.writeFile(apkPath, payload);

  const { server, baseUrl } = await startServer({ apkPath });
  t.after(async () => {
    await server.close();
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  // HEAD on primary .apk route exposes Accept-Ranges, ETag, and full Content-Length
  const headRes = await fetch(`${baseUrl}/api/download/velodeck-agent.apk`, { method: "HEAD" });
  assert.equal(headRes.status, 200);
  assert.equal(headRes.headers.get("accept-ranges"), "bytes");
  assert.equal(headRes.headers.get("etag"), expectedEtag);
  assert.equal(headRes.headers.get("content-length"), String(payload.byteLength));
  assert.equal(headRes.headers.get("content-type"), "application/vnd.android.package-archive");

  // Single bounded range -> 206 Partial Content
  const range1 = await fetch(`${baseUrl}/api/download/velodeck-agent.apk`, {
    headers: { Range: "bytes=0-9" },
  });
  assert.equal(range1.status, 206);
  assert.equal(range1.headers.get("accept-ranges"), "bytes");
  assert.equal(range1.headers.get("content-range"), `bytes 0-9/${payload.byteLength}`);
  assert.equal(range1.headers.get("content-length"), "10");
  assert.equal(
    range1.headers.get("content-disposition"),
    'attachment; filename="velodeck-agent-v1.0.9.apk"',
  );
  assert.equal(range1.headers.get("cache-control"), "no-store, no-cache, must-revalidate");
  assert.equal(range1.headers.get("pragma"), "no-cache");
  assert.equal(await range1.text(), "0123456789");

  // Open-ended resume range on /api/download/android -> 206 Partial Content
  const range2 = await fetch(`${baseUrl}/api/download/android`, {
    headers: { Range: "bytes=36-", "If-Range": expectedEtag },
  });
  assert.equal(range2.status, 206);
  assert.equal(
    range2.headers.get("content-range"),
    `bytes 36-${payload.byteLength - 1}/${payload.byteLength}`,
  );
  assert.equal(await range2.text(), "abcdefghijklmnopqrstuvwxyz");

  // Suffix range -> last 6 bytes
  const suffixRes = await fetch(`${baseUrl}/api/download/velodeck-agent.apk`, {
    headers: { Range: "bytes=-6" },
  });
  assert.equal(suffixRes.status, 206);
  assert.equal(await suffixRes.text(), "uvwxyz");

  // Mismatched If-Range falls back to full 200 OK
  const staleResume = await fetch(`${baseUrl}/api/download/velodeck-agent.apk`, {
    headers: { Range: "bytes=10-19", "If-Range": '"stale-etag"' },
  });
  assert.equal(staleResume.status, 200);
  assert.equal(staleResume.headers.get("content-length"), String(payload.byteLength));
  assert.equal(await staleResume.text(), payload.toString("utf8"));

  // Out-of-bounds range -> 416 Range Not Satisfiable
  const oobRes = await fetch(`${baseUrl}/api/download/velodeck-agent.apk`, {
    headers: { Range: "bytes=99999-" },
  });
  assert.equal(oobRes.status, 416);
  assert.equal(oobRes.headers.get("content-range"), `bytes */${payload.byteLength}`);

  // If-None-Match -> 304 Not Modified (with strict no-store headers)
  const notModRes = await fetch(`${baseUrl}/api/download/velodeck-agent.apk`, {
    headers: { "If-None-Match": expectedEtag },
  });
  assert.equal(notModRes.status, 304);
  assert.equal(notModRes.headers.get("etag"), expectedEtag);
  assert.equal(notModRes.headers.get("cache-control"), "no-store, no-cache, must-revalidate");
  assert.equal(notModRes.headers.get("pragma"), "no-cache");
});

test("coturn.conf avoids CIDR/wildcard denied-peer-ip, redundant lt-cred-mech, and invalid no-loopback-peers", async () => {
  const coturnConfPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../coturn.conf",
  );
  const raw = await fsp.readFile(coturnConfPath, "utf8");
  const activeLines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  assert.equal(
    activeLines.includes("lt-cred-mech"),
    false,
    "lt-cred-mech is redundant/conflicting with use-auth-secret",
  );
  assert.equal(
    activeLines.includes("no-loopback-peers"),
    false,
    "no-loopback-peers is invalid in coturn 4.6 config",
  );
  const deniedLines = activeLines
    .filter((line) => line.startsWith("denied-peer-ip="))
    .map((line) => line.slice("denied-peer-ip=".length).trim());

  assert.ok(deniedLines.length > 0, "coturn.conf should define SSRF denied-peer-ip rules");
  for (const rule of deniedLines) {
    assert.notEqual(
      rule,
      "::",
      "denied-peer-ip=:: is parsed by coturn as an all-IPs wildcard and blocks every public peer",
    );
    assert.notEqual(
      rule,
      "0.0.0.0",
      "denied-peer-ip=0.0.0.0 is parsed by coturn as an all-IPs wildcard",
    );
    assert.equal(
      rule.includes("/"),
      false,
      `coturn denied-peer-ip does not support CIDR notation: ${rule}`,
    );
  }
});

test("Agent p2pFileTransfer capability is preserved in controller.authed and across partial telemetry updates", async (t) => {
  const { server, baseUrl, wsUrl } = await startServer();
  t.after(() => server.close());

  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "p2p_cap_user", password: "p2p-password-123" }),
  });
  assert.equal(regRes.status, 201);
  const { token } = (await regRes.json()) as { token: string };

  const agent = await TestWsClient.connect(wsUrl);
  const ctrl1 = await TestWsClient.connect(wsUrl);
  const ctrl2 = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([agent.close(), ctrl1.close(), ctrl2.close()]);
  });

  agent.sendJson(
    makeAgentRegister({
      deviceId: "dev-p2p-file-01",
      deviceSecret: "p2p-secret-01",
      authToken: token,
      capabilities: {
        webrtc: true,
        wsJpeg: true,
        wsH264: false,
        wake: true,
        unlock: true,
        accessibility: true,
        mediaProjection: true,
        p2pFileTransfer: true,
      },
    }),
  );
  const agentReg = await agent.nextJson<AgentRegisteredMessage>();
  assert.equal(agentReg.type, "agent.registered");

  // Controller 1 authenticates -> devices list preserves p2pFileTransfer: true
  ctrl1.sendJson({
    type: "controller.auth",
    authToken: token,
    clientId: "ctrl-p2p-1",
  });
  const authed1 = await ctrl1.nextJson<ControllerAuthedMessage>();
  assert.equal(authed1.type, "controller.authed");
  assert.equal(authed1.devices.length, 1);
  assert.equal(authed1.devices[0]?.capabilities.p2pFileTransfer, true);

  // Agent sends partial telemetry updating another capability without specifying p2pFileTransfer
  // (exercises hub.ts cloneCapabilities inside mergeCapabilities)
  agent.sendJson({
    type: "agent.telemetry",
    deviceId: "dev-p2p-file-01",
    battery: 77,
    capabilities: {
      mediaProjection: false,
    },
  });
  const statusUpdate = await ctrl1.nextJson<DeviceStatusMessage>();
  assert.equal(statusUpdate.type, "device.status");
  assert.equal(statusUpdate.device.battery, 77);
  assert.equal(statusUpdate.device.capabilities.mediaProjection, false);
  assert.equal(statusUpdate.device.capabilities.p2pFileTransfer, true);

  // Newly connecting controller still receives p2pFileTransfer: true in controller.authed
  ctrl2.sendJson({
    type: "controller.auth",
    authToken: token,
    clientId: "ctrl-p2p-2",
  });
  const authed2 = await ctrl2.nextJson<ControllerAuthedMessage>();
  assert.equal(authed2.type, "controller.authed");
  assert.equal(authed2.devices[0]?.capabilities.p2pFileTransfer, true);
  assert.equal(authed2.devices[0]?.capabilities.mediaProjection, false);
});

test("forcePortraitActive propagates on register/telemetry/clone and force_portrait control.cmd forwards cleanly (sessionless & in-session)", async (t) => {
  const { server, baseUrl, wsUrl } = await startServer();
  t.after(() => server.close());

  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "portrait_user", password: "portrait-password-123" }),
  });
  assert.equal(regRes.status, 201);
  const { token } = (await regRes.json()) as { token: string };

  const agent = await TestWsClient.connect(wsUrl);
  const ctrl1 = await TestWsClient.connect(wsUrl);
  const ctrl2 = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([agent.close(), ctrl1.close(), ctrl2.close()]);
  });

  // 1. Agent registers with forcePortraitActive: true
  agent.sendJson(
    makeAgentRegister({
      deviceId: "dev-portrait-01",
      deviceSecret: "portrait-secret-01",
      authToken: token,
      forcePortraitActive: true,
    }),
  );
  const agentReg = await agent.nextJson<AgentRegisteredMessage>();
  assert.equal(agentReg.type, "agent.registered");

  // Controller 1 receives forcePortraitActive: true in controller.authed
  ctrl1.sendJson({
    type: "controller.auth",
    authToken: token,
    clientId: "ctrl-portrait-1",
  });
  const authed1 = await ctrl1.nextJson<ControllerAuthedMessage>();
  assert.equal(authed1.type, "controller.authed");
  assert.equal(authed1.devices.length, 1);
  assert.equal(authed1.devices[0]?.forcePortraitActive, true);

  // 2. Partial telemetry without forcePortraitActive preserves previous value,
  //    then explicit forcePortraitActive: false updates and broadcasts device.status
  agent.sendJson({
    type: "agent.telemetry",
    deviceId: "dev-portrait-01",
    battery: 82,
  });
  const status1 = await ctrl1.nextJson<DeviceStatusMessage>();
  assert.equal(status1.type, "device.status");
  assert.equal(status1.device.battery, 82);
  assert.equal(status1.device.forcePortraitActive, true);

  agent.sendJson({
    type: "agent.telemetry",
    deviceId: "dev-portrait-01",
    forcePortraitActive: false,
  });
  const status2 = await ctrl1.nextJson<DeviceStatusMessage>();
  assert.equal(status2.type, "device.status");
  assert.equal(status2.device.forcePortraitActive, false);

  // Newly connecting controller receives cloned summary with forcePortraitActive: false
  ctrl2.sendJson({
    type: "controller.auth",
    authToken: token,
    clientId: "ctrl-portrait-2",
  });
  const authed2 = await ctrl2.nextJson<ControllerAuthedMessage>();
  assert.equal(authed2.devices[0]?.forcePortraitActive, false);

  // 3. Invalid non-boolean enabled is rejected cleanly with INVALID_MESSAGE
  ctrl1.sendJson({
    type: "control.cmd",
    sessionId: "",
    deviceId: "dev-portrait-01",
    seq: 1,
    command: { action: "force_portrait", enabled: "yes" as unknown as boolean },
  } satisfies ControlCmdMessage);
  const badEnabledErr = await ctrl1.nextJson<ErrorMessage>();
  assert.equal(badEnabledErr.type, "error");
  assert.equal(badEnabledErr.code, "INVALID_MESSAGE");

  // 4. Sessionless (out-of-band) force_portrait command forwards to agent and routes control.ack back
  ctrl1.sendJson({
    type: "control.cmd",
    sessionId: "",
    deviceId: "dev-portrait-01",
    seq: 2,
    command: { action: "force_portrait", enabled: true },
  } satisfies ControlCmdMessage);
  const oobCmd = await agent.nextJson<ControlCmdMessage>();
  assert.equal(oobCmd.type, "control.cmd");
  assert.equal(oobCmd.sessionId, "");
  assert.equal(oobCmd.deviceId, "dev-portrait-01");
  assert.equal(oobCmd.seq, 2);
  assert.deepEqual(oobCmd.command, { action: "force_portrait", enabled: true });

  agent.sendJson({
    type: "control.ack",
    sessionId: "",
    deviceId: "dev-portrait-01",
    seq: 2,
    ok: true,
    message: "force_portrait_enabled",
  } satisfies ControlAckMessage);
  const oobAck = await ctrl1.nextJson<ControlAckMessage>();
  assert.equal(oobAck.type, "control.ack");
  assert.equal(oobAck.ok, true);
  assert.equal(oobAck.seq, 2);

  // 5. In-session force_portrait command also forwards cleanly
  ctrl1.sendJson({
    type: "session.request",
    sessionId: "sess-portrait-1",
    deviceId: "dev-portrait-01",
    preferredTransport: "ws-jpeg",
    quality: QUALITY_PRESETS.eco,
  } satisfies SessionRequestMessage);
  await agent.nextJson<SessionRequestMessage>();

  ctrl1.sendJson({
    type: "control.cmd",
    sessionId: "sess-portrait-1",
    deviceId: "dev-portrait-01",
    seq: 3,
    command: { action: "force_portrait", enabled: false },
  } satisfies ControlCmdMessage);
  const inSessionCmd = await agent.nextJson<ControlCmdMessage>();
  assert.equal(inSessionCmd.type, "control.cmd");
  assert.equal(inSessionCmd.sessionId, "sess-portrait-1");
  assert.deepEqual(inSessionCmd.command, { action: "force_portrait", enabled: false });
});

test("black_screen and force_portrait log distinct audit events (never control.unlock), quality commands are validated, and TURN_SECRET without TURN_URLS warns", async (t) => {
  // 1. loadConfig warns when TURN_SECRET is set with empty TURN_URLS and no PUBLIC_IP
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const cfg = loadConfig({ TURN_SECRET: "strong-turn-secret-without-urls-12345" });
    assert.deepEqual(cfg.turnUrls, []);
  } finally {
    console.warn = origWarn;
  }
  assert.ok(
    warnings.some((w) => w.includes("TURN_SECRET") && w.includes("TURN_URLS")),
    `expected startup warning for TURN_SECRET without TURN_URLS, got: ${warnings.join(" | ")}`,
  );

  // 2. Verify audit events for black_screen & force_portrait + quality validation
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "velodeck-audit-ctrl-test-"));
  const { server, baseUrl, wsUrl } = await startServer({ dataDir });
  t.after(async () => {
    await server.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "audit_ctrl_user", password: "audit-password-123" }),
  });
  const { token } = (await regRes.json()) as { token: string };

  const agent = await TestWsClient.connect(wsUrl);
  const ctrl = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([agent.close(), ctrl.close()]);
  });

  agent.sendJson(
    makeAgentRegister({
      deviceId: "dev-audit-01",
      deviceSecret: "audit-secret-01",
      authToken: token,
    }),
  );
  await agent.nextJson<AgentRegisteredMessage>();

  ctrl.sendJson({ type: "controller.auth", authToken: token, clientId: "ctrl-audit-1" });
  await ctrl.nextJson<ControllerAuthedMessage>();

  // Sessionless black_screen and force_portrait
  ctrl.sendJson({
    type: "control.cmd",
    sessionId: "",
    deviceId: "dev-audit-01",
    seq: 1,
    command: { action: "black_screen", enabled: true },
  } satisfies ControlCmdMessage);
  await agent.nextJson<ControlCmdMessage>();

  ctrl.sendJson({
    type: "control.cmd",
    sessionId: "",
    deviceId: "dev-audit-01",
    seq: 2,
    command: { action: "force_portrait", enabled: true },
  } satisfies ControlCmdMessage);
  await agent.nextJson<ControlCmdMessage>();

  // In-session quality validation (including auto: true preservation)
  ctrl.sendJson({
    type: "session.request",
    sessionId: "sess-quality-01",
    deviceId: "dev-audit-01",
    preferredTransport: "webrtc",
    quality: QUALITY_PRESETS.auto,
  } satisfies SessionRequestMessage);
  const fwdAutoReq = await agent.nextJson<SessionRequestMessage>();
  assert.deepEqual(fwdAutoReq.quality, QUALITY_PRESETS.auto);
  assert.equal(fwdAutoReq.quality.auto, true);

  // Invalid quality -> rejected with INVALID_MESSAGE
  ctrl.sendJson({
    type: "control.cmd",
    sessionId: "sess-quality-01",
    deviceId: "dev-audit-01",
    seq: 3,
    command: {
      action: "quality",
      quality: { maxWidth: 0, fps: -10, bitrateKbps: 1000, jpegQuality: 70 },
    },
  } satisfies ControlCmdMessage);
  const badQualityErr = await ctrl.nextJson<ErrorMessage>();
  assert.equal(badQualityErr.code, "INVALID_MESSAGE");

  // Invalid non-boolean quality.auto -> rejected with INVALID_MESSAGE
  ctrl.sendJson({
    type: "control.cmd",
    sessionId: "sess-quality-01",
    deviceId: "dev-audit-01",
    seq: 4,
    command: {
      action: "quality",
      quality: {
        maxWidth: 900,
        fps: 60,
        bitrateKbps: 4500,
        jpegQuality: 54,
        auto: "yes" as unknown as boolean,
      },
    },
  } satisfies ControlCmdMessage);
  const badAutoQualityErr = await ctrl.nextJson<ErrorMessage>();
  assert.equal(badAutoQualityErr.code, "INVALID_MESSAGE");

  // Valid quality (auto: true) -> forwarded cleanly preserving auto flag
  ctrl.sendJson({
    type: "control.cmd",
    sessionId: "sess-quality-01",
    deviceId: "dev-audit-01",
    seq: 5,
    command: { action: "quality", quality: QUALITY_PRESETS.auto },
  } satisfies ControlCmdMessage);
  const forwardedAutoQuality = await agent.nextJson<ControlCmdMessage>();
  assert.deepEqual(forwardedAutoQuality.command, {
    action: "quality",
    quality: QUALITY_PRESETS.auto,
  });

  // Valid quality (fixed preset) -> forwarded cleanly
  ctrl.sendJson({
    type: "control.cmd",
    sessionId: "sess-quality-01",
    deviceId: "dev-audit-01",
    seq: 6,
    command: { action: "quality", quality: QUALITY_PRESETS.hd },
  } satisfies ControlCmdMessage);
  const forwardedQuality = await agent.nextJson<ControlCmdMessage>();
  assert.deepEqual(forwardedQuality.command, {
    action: "quality",
    quality: QUALITY_PRESETS.hd,
  });

  // Verify audit.jsonl records exact control.black_screen & control.force_portrait (zero control.unlock!)
  await server.hub.audit.flush();
  const auditLines = (await fsp.readFile(path.join(dataDir, "audit.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event: string });
  const events = auditLines.map((e) => e.event);
  assert.ok(events.includes("control.black_screen"), `expected control.black_screen in ${events.join(",")}`);
  assert.ok(events.includes("control.force_portrait"), `expected control.force_portrait in ${events.join(",")}`);
  assert.equal(events.includes("control.unlock"), false, "black_screen/force_portrait must NEVER be logged as control.unlock");
});

test("Built-in Electron origin (app://velodeck) is natively trusted for HTTP CORS and WS upgrades while untrusted custom schemes are rejected", async (t) => {
  // No ALLOWED_ORIGINS configured
  const { server, baseUrl, wsUrl } = await startServer({ allowedOrigins: [] });
  t.after(() => server.close());

  // 1. GET /api/info with Origin: app://velodeck -> 200 with Access-Control-Allow-Origin
  const infoRes = await fetch(`${baseUrl}/api/info`, {
    headers: { Origin: "app://velodeck" },
  });
  assert.equal(infoRes.status, 200);
  assert.equal(infoRes.headers.get("access-control-allow-origin"), "app://velodeck");

  // Trailing slash normalizes cleanly to app://velodeck
  const infoSlashRes = await fetch(`${baseUrl}/api/info`, {
    headers: { Origin: "app://velodeck/" },
  });
  assert.equal(infoSlashRes.status, 200);
  assert.equal(infoSlashRes.headers.get("access-control-allow-origin"), "app://velodeck/");

  // 2. OPTIONS /api/auth/login with Origin: app://velodeck -> 204 with CORS headers
  const optRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "OPTIONS",
    headers: { Origin: "app://velodeck" },
  });
  assert.equal(optRes.status, 204);
  assert.equal(optRes.headers.get("access-control-allow-origin"), "app://velodeck");
  assert.match(optRes.headers.get("access-control-allow-methods") ?? "", /POST/);

  // 3. WebSocket /ws upgrade with Origin: app://velodeck and app://velodeck-host is accepted
  const electronWs = await TestWsClient.connect(wsUrl, { Origin: "app://velodeck" });
  await electronWs.close();
  const electronHostWs = await TestWsClient.connect(wsUrl, { Origin: "app://velodeck-host" });
  await electronHostWs.close();

  // 4. Untrusted custom scheme Origin: app://evil.example is rejected for HTTP CORS and WS upgrade
  const evilInfoRes = await fetch(`${baseUrl}/api/info`, {
    headers: { Origin: "app://evil.example" },
  });
  assert.equal(evilInfoRes.status, 200);
  assert.equal(evilInfoRes.headers.get("access-control-allow-origin"), null);

  const evilOptRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "OPTIONS",
    headers: { Origin: "app://evil.example" },
  });
  assert.equal(evilOptRes.status, 403);
  assert.equal(evilOptRes.headers.get("access-control-allow-origin"), null);

  const evilWsStatus = await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: { Origin: "app://evil.example" },
    });
    ws.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once("open", () => {
      ws.close();
      reject(new Error("Expected untrusted custom scheme WS upgrade to be rejected"));
    });
    ws.once("error", () => {
      // Handled by unexpected-response
    });
  });
  assert.equal(evilWsStatus, 403);
});

test("Desktop host registration, multi-monitor telemetry updates, deep-cloned displays, and Android backward compatibility", async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "velodeck-desktop-host-test-"));
  const { server, baseUrl, wsUrl } = await startServer({ dataDir });
  t.after(async () => {
    await server.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "desktop_owner", password: "desktop-password-123" }),
  });
  assert.equal(regRes.status, 201);
  const { token } = (await regRes.json()) as { token: string };

  const ctrlWatch = await TestWsClient.connect(wsUrl);
  const desktopAgent = await TestWsClient.connect(wsUrl);
  const androidAgent = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([ctrlWatch.close(), desktopAgent.close(), androidAgent.close()]);
  });

  // Account controller connects before devices register to observe live device.status broadcasts
  ctrlWatch.sendJson({
    type: "controller.auth",
    authToken: token,
    clientId: "ctrl-desktop-watch",
  });
  const watchAuthed = await ctrlWatch.nextJson<ControllerAuthedMessage>();
  assert.equal(watchAuthed.type, "controller.authed");
  assert.equal(watchAuthed.devices.length, 0);

  const displays: DisplayInfo[] = [
    { id: "disp-builtin-1", name: "Built-in Retina Display", width: 3024, height: 1964, primary: true },
    { id: "disp-ext-2", name: "Studio Display", width: 5120, height: 2880, primary: false },
  ];

  // 1. Desktop agent registers with deviceType, osPlatform, displays (2 monitors), activeDisplayId
  desktopAgent.sendJson(
    makeAgentRegister({
      deviceId: "desk-macbook-01",
      deviceSecret: "desktop-secret-01",
      authToken: token,
      controlPassword: "desktop-unattended-99",
      name: "MacBook Pro 14",
      model: "Mac15,6",
      androidVersion: "macOS 15.2",
      screenWidth: 3024,
      screenHeight: 1964,
      rotation: 0,
      battery: 100,
      charging: true,
      deviceType: "desktop",
      osPlatform: "darwin",
      displays,
      activeDisplayId: "disp-builtin-1",
    }),
  );

  const [deskReg, deskStatus] = await Promise.all([
    desktopAgent.nextJson<AgentRegisteredMessage>(),
    ctrlWatch.nextJson<DeviceStatusMessage>(),
  ]);

  assert.equal(deskReg.type, "agent.registered");
  assert.equal(deskReg.deviceId, "desk-macbook-01");
  assert.match(deskReg.controlCode ?? "", /^\d{9}$/);

  assert.equal(deskStatus.type, "device.status");
  assert.equal(deskStatus.device.deviceId, "desk-macbook-01");
  assert.equal(deskStatus.device.deviceType, "desktop");
  assert.equal(deskStatus.device.osPlatform, "darwin");
  assert.equal(deskStatus.device.activeDisplayId, "disp-builtin-1");
  assert.deepEqual(deskStatus.device.displays, displays);

  // 2. Existing Android agent registration (omitting deviceType/osPlatform/displays/activeDisplayId) works unchanged
  androidAgent.sendJson(
    makeAgentRegister({
      deviceId: "dev-android-legacy",
      deviceSecret: "android-secret-01",
      authToken: token,
      controlPassword: "android-unattended-99",
    }),
  );
  const [androidReg, androidStatus] = await Promise.all([
    androidAgent.nextJson<AgentRegisteredMessage>(),
    ctrlWatch.nextJson<DeviceStatusMessage>(),
  ]);
  assert.equal(androidReg.type, "agent.registered");
  assert.match(androidReg.controlCode ?? "", /^\d{9}$/);
  assert.equal(androidStatus.type, "device.status");
  assert.equal(androidStatus.device.deviceId, "dev-android-legacy");
  assert.equal(androidStatus.device.deviceType, undefined);
  assert.equal(androidStatus.device.osPlatform, undefined);
  assert.equal(androidStatus.device.displays, undefined);
  assert.equal(androidStatus.device.activeDisplayId, undefined);
  assert.equal(Object.hasOwn(androidStatus.device, "deviceType"), false);
  assert.equal(Object.hasOwn(androidStatus.device, "displays"), false);

  // 3. Newly connected account controller & control-code controller both receive exact desktop fields in controller.authed
  const ctrlAccount = await TestWsClient.connect(wsUrl);
  const ctrlCode = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([ctrlAccount.close(), ctrlCode.close()]);
  });

  ctrlAccount.sendJson({
    type: "controller.auth",
    authToken: token,
    clientId: "ctrl-desktop-acct",
  });
  const acctAuthed = await ctrlAccount.nextJson<ControllerAuthedMessage>();
  assert.equal(acctAuthed.devices.length, 2);
  const acctDesktop = acctAuthed.devices.find((d) => d.deviceId === "desk-macbook-01");
  const acctAndroid = acctAuthed.devices.find((d) => d.deviceId === "dev-android-legacy");
  assert.ok(acctDesktop);
  assert.equal(acctDesktop.deviceType, "desktop");
  assert.equal(acctDesktop.osPlatform, "darwin");
  assert.equal(acctDesktop.activeDisplayId, "disp-builtin-1");
  assert.deepEqual(acctDesktop.displays, displays);
  assert.ok(acctAndroid);
  assert.equal(acctAndroid.deviceType, undefined);
  assert.equal(acctAndroid.displays, undefined);

  ctrlCode.sendJson({
    type: "controller.auth",
    controlCode: deskReg.controlCode,
    controlPassword: "desktop-unattended-99",
    clientId: "ctrl-desktop-code",
  });
  const codeAuthed = await ctrlCode.nextJson<ControllerAuthedMessage>();
  assert.equal(codeAuthed.devices.length, 1);
  assert.equal(codeAuthed.devices[0]?.deviceType, "desktop");
  assert.equal(codeAuthed.devices[0]?.osPlatform, "darwin");
  assert.equal(codeAuthed.devices[0]?.activeDisplayId, "disp-builtin-1");
  assert.deepEqual(codeAuthed.devices[0]?.displays, displays);

  // 4. Desktop agent telemetry switches active monitor -> updates activeDisplayId + screenWidth/screenHeight live
  desktopAgent.sendJson({
    type: "agent.telemetry",
    deviceId: "desk-macbook-01",
    activeDisplayId: "disp-ext-2",
    screenWidth: 5120,
    screenHeight: 2880,
  });

  const [watchSwitch, codeSwitch] = await Promise.all([
    ctrlWatch.nextJson<DeviceStatusMessage>(),
    ctrlCode.nextJson<DeviceStatusMessage>(),
  ]);
  for (const status of [watchSwitch, codeSwitch]) {
    assert.equal(status.type, "device.status");
    assert.equal(status.device.deviceId, "desk-macbook-01");
    assert.equal(status.device.deviceType, "desktop");
    assert.equal(status.device.osPlatform, "darwin");
    assert.equal(status.device.activeDisplayId, "disp-ext-2");
    assert.equal(status.device.screenWidth, 5120);
    assert.equal(status.device.screenHeight, 2880);
    assert.deepEqual(status.device.displays, displays);
  }

  // 5. Desktop telemetry sanitizes displays list (clamps dimensions, caps at 8, strips control chars)
  const manyDisplays = Array.from({ length: 10 }, (_, idx) => ({
    id: `mon-${idx + 1}`,
    name: `Monitor \x07#${idx + 1}`,
    width: idx === 0 ? 99_999 : 1920,
    height: idx === 0 ? 0.4 : 1080,
    primary: idx === 0,
  }));
  desktopAgent.sendJson({
    type: "agent.telemetry",
    deviceId: "desk-macbook-01",
    displays: manyDisplays,
  });
  const sanitizedStatus = await ctrlWatch.nextJson<DeviceStatusMessage>();
  assert.equal(sanitizedStatus.device.displays?.length, 8);
  assert.deepEqual(sanitizedStatus.device.displays?.[0], {
    id: "mon-1",
    name: "Monitor #1",
    width: 16_384,
    height: 1,
    primary: true,
  });

  // 6. cloneDeviceSummary deep-clones displays array and display items
  const cloned = cloneDeviceSummary(sanitizedStatus.device);
  assert.notEqual(cloned.displays, sanitizedStatus.device.displays);
  assert.notEqual(cloned.displays?.[0], sanitizedStatus.device.displays?.[0]);
  cloned.displays![0]!.name = "Mutated";
  cloned.displays!.push({ id: "extra", name: "Extra", width: 800, height: 600 });
  assert.equal(sanitizedStatus.device.displays?.[0]?.name, "Monitor #1");
  assert.equal(sanitizedStatus.device.displays?.length, 8);

  // 7. Persisted store reloads desktop metadata cleanly from disk
  await server.hub.store.flush();
  const reloadedStore = new VeloDeckStore(dataDir);
  const persistedDesktop = reloadedStore.getDevice("desk-macbook-01");
  assert.ok(persistedDesktop);
  assert.equal(persistedDesktop.summary.deviceType, "desktop");
  assert.equal(persistedDesktop.summary.osPlatform, "darwin");
  assert.equal(persistedDesktop.summary.activeDisplayId, "disp-builtin-1");
  assert.deepEqual(persistedDesktop.summary.displays, displays);
});

test("Desktop control commands (mouse_move, mouse_down, mouse_up, mouse_wheel, key_event, select_display) validate and forward cleanly", async (t) => {
  const { server, wsUrl } = await startServer();
  t.after(() => server.close());

  const agent = await TestWsClient.connect(wsUrl);
  const ctrl = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([agent.close(), ctrl.close()]);
  });

  agent.sendJson(
    makeAgentRegister({
      deviceId: "desk-win11-01",
      deviceSecret: "win11-secret-01",
      controlPassword: "win11-password-123",
      deviceType: "desktop",
      osPlatform: "win32",
      screenWidth: 2560,
      screenHeight: 1440,
      displays: [
        { id: "win-disp-1", name: "Primary", width: 2560, height: 1440, primary: true },
        { id: "win-disp-2", name: "Secondary", width: 1920, height: 1080, primary: false },
      ],
      activeDisplayId: "win-disp-1",
    }),
  );
  const reg = await agent.nextJson<AgentRegisteredMessage>();
  assert.ok(reg.controlCode);

  ctrl.sendJson({
    type: "controller.auth",
    controlCode: reg.controlCode,
    controlPassword: "win11-password-123",
    clientId: "ctrl-win11-01",
  });
  await ctrl.nextJson<ControllerAuthedMessage>();

  // Sessionless desktop command must be rejected with SESSION_NOT_FOUND
  ctrl.sendJson({
    type: "control.cmd",
    sessionId: "",
    deviceId: "desk-win11-01",
    seq: 1,
    command: { action: "mouse_move", x: 100, y: 200 },
  } satisfies ControlCmdMessage);
  const sessionlessErr = await ctrl.nextJson<ErrorMessage>();
  assert.equal(sessionlessErr.type, "error");
  assert.equal(sessionlessErr.code, "SESSION_NOT_FOUND");

  // Establish active session
  ctrl.sendJson({
    type: "session.request",
    sessionId: "sess-desktop-01",
    deviceId: "desk-win11-01",
    preferredTransport: "webrtc",
    quality: QUALITY_PRESETS.hd,
  } satisfies SessionRequestMessage);
  await agent.nextJson<SessionRequestMessage>();

  agent.sendJson({
    type: "session.ready",
    sessionId: "sess-desktop-01",
    deviceId: "desk-win11-01",
    transport: "webrtc",
    screenWidth: 2560,
    screenHeight: 1440,
    rotation: 0,
  } satisfies SessionReadyMessage);
  await ctrl.nextJson<SessionReadyMessage>();

  // 1. Valid desktop commands forward cleanly
  const validCommands: ControlCmdMessage["command"][] = [
    { action: "mouse_move", x: 0.5, y: 0.25 },
    { action: "mouse_down", x: 0.5, y: 0.25, button: "left", clickCount: 2 },
    { action: "mouse_up", x: 0.5, y: 0.25, button: "left" },
    { action: "mouse_down", x: 0.8, y: 0.1, button: "right" },
    { action: "mouse_up", x: 0.8, y: 0.1, button: "middle" },
    { action: "mouse_wheel", x: 0.5, y: 0.5, deltaX: -12, deltaY: 120 },
    {
      action: "key_event",
      phase: "down",
      code: "KeyC",
      key: "c",
      modifiers: { ctrl: true, shift: false, alt: false, meta: false },
    },
    { action: "key_event", phase: "up", code: "KeyC", key: "c" },
    { action: "key_event", phase: "press", code: "Enter", key: "Enter" },
    { action: "select_display", displayId: "win-disp-2" },
  ];

  let seq = 10;
  for (const command of validCommands) {
    seq += 1;
    ctrl.sendJson({
      type: "control.cmd",
      sessionId: "sess-desktop-01",
      deviceId: "desk-win11-01",
      seq,
      command,
    } satisfies ControlCmdMessage);
    const forwarded = await agent.nextJson<ControlCmdMessage>();
    assert.equal(forwarded.type, "control.cmd");
    assert.equal(forwarded.sessionId, "sess-desktop-01");
    assert.equal(forwarded.deviceId, "desk-win11-01");
    assert.equal(forwarded.seq, seq);
    assert.deepEqual(forwarded.command, command);
  }

  // Verify control.ack routes back for desktop command
  agent.sendJson({
    type: "control.ack",
    sessionId: "sess-desktop-01",
    deviceId: "desk-win11-01",
    seq,
    ok: true,
    message: "display_selected",
  } satisfies ControlAckMessage);
  const ack = await ctrl.nextJson<ControlAckMessage>();
  assert.equal(ack.type, "control.ack");
  assert.equal(ack.seq, seq);
  assert.equal(ack.ok, true);

  // 2. Malformed desktop commands are rejected with INVALID_MESSAGE and never forwarded
  const invalidCommands: unknown[] = [
    { action: "mouse_move", x: Number.NaN, y: 0.5 },
    { action: "mouse_move", x: "100", y: 200 },
    { action: "mouse_down", x: 0.5, y: 0.5, button: "side" },
    { action: "mouse_down", x: 0.5, y: 0.5, button: "left", clickCount: 0 },
    { action: "mouse_down", x: 0.5, y: 0.5, button: "left", clickCount: 6 },
    { action: "mouse_down", x: 0.5, y: 0.5, button: "left", clickCount: 1.5 },
    { action: "mouse_up", x: Number.NaN, y: 0.5, button: "right" },
    { action: "mouse_up", x: 0.5, y: 0.5, button: "invalid" },
    { action: "mouse_wheel", x: 0.5, y: 0.5, deltaX: 0, deltaY: Number.NaN },
    { action: "mouse_wheel", x: 0.5, y: 0.5, deltaX: "up", deltaY: 10 },
    { action: "key_event", phase: "hold", code: "KeyA", key: "a" },
    { action: "key_event", phase: "down", code: "A".repeat(65), key: "a" },
    { action: "key_event", phase: "down", code: "KeyA", key: "k".repeat(65) },
    { action: "key_event", phase: "down", code: "KeyA", key: "a", modifiers: { ctrl: "yes" } },
    { action: "select_display", displayId: "" },
    { action: "select_display", displayId: "   " },
    { action: "select_display", displayId: "d".repeat(65) },
  ];

  for (const badCmd of invalidCommands) {
    seq += 1;
    ctrl.sendJson({
      type: "control.cmd",
      sessionId: "sess-desktop-01",
      deviceId: "desk-win11-01",
      seq,
      command: badCmd,
    });
    const err = await ctrl.nextJson<ErrorMessage>();
    assert.equal(err.type, "error");
    assert.equal(err.code, "INVALID_MESSAGE");
    assert.equal(err.sessionId, "sess-desktop-01");
    assert.equal(err.deviceId, "desk-win11-01");
  }

  // Confirm none of the malformed commands were forwarded to the desktop agent
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(agent.drainJson().length, 0);
});

test("Pro desktop host capabilities, privacyScreenActive, and audioEnabled propagate on register, telemetry, clone, and persistence", async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "velodeck-pro-desktop-caps-test-"));
  const { server, baseUrl, wsUrl } = await startServer({ dataDir });
  t.after(async () => {
    await server.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "pro_desk_owner", password: "pro-desk-password-123" }),
  });
  assert.equal(regRes.status, 201);
  const { token } = (await regRes.json()) as { token: string };

  const desktopAgent = await TestWsClient.connect(wsUrl);
  const androidAgent = await TestWsClient.connect(wsUrl);
  const ctrl1 = await TestWsClient.connect(wsUrl);
  const ctrl2 = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([desktopAgent.close(), androidAgent.close(), ctrl1.close(), ctrl2.close()]);
  });

  // 1. Desktop host registers with all new capability flags + privacyScreenActive + audioEnabled
  desktopAgent.sendJson(
    makeAgentRegister({
      deviceId: "desk-pro-01",
      deviceSecret: "desk-pro-secret-01",
      authToken: token,
      controlPassword: "desk-pro-password-99",
      deviceType: "desktop",
      osPlatform: "darwin",
      screenWidth: 3840,
      screenHeight: 2160,
      privacyScreenActive: true,
      audioEnabled: true,
      capabilities: {
        webrtc: true,
        wsJpeg: true,
        wsH264: false,
        wake: false,
        unlock: false,
        accessibility: true,
        mediaProjection: true,
        desktopAudio: true,
        privacyScreen: true,
        fileManager: true,
        powerControl: true,
        highRefresh: true,
      },
    }),
  );
  await desktopAgent.nextJson<AgentRegisteredMessage>();

  // Legacy Android agent registers without any desktop flags
  androidAgent.sendJson(
    makeAgentRegister({
      deviceId: "dev-android-compat",
      deviceSecret: "android-compat-secret",
      authToken: token,
    }),
  );
  await androidAgent.nextJson<AgentRegisteredMessage>();

  // 2. Controller 1 receives all desktop flags in controller.authed; Android omits them
  ctrl1.sendJson({
    type: "controller.auth",
    authToken: token,
    clientId: "ctrl-pro-1",
  });
  const authed1 = await ctrl1.nextJson<ControllerAuthedMessage>();
  assert.equal(authed1.devices.length, 2);
  const desk1 = authed1.devices.find((d) => d.deviceId === "desk-pro-01");
  const android1 = authed1.devices.find((d) => d.deviceId === "dev-android-compat");
  assert.ok(desk1);
  assert.equal(desk1.privacyScreenActive, true);
  assert.equal(desk1.audioEnabled, true);
  assert.equal(desk1.capabilities.desktopAudio, true);
  assert.equal(desk1.capabilities.privacyScreen, true);
  assert.equal(desk1.capabilities.fileManager, true);
  assert.equal(desk1.capabilities.powerControl, true);
  assert.equal(desk1.capabilities.highRefresh, true);

  assert.ok(android1);
  assert.equal(Object.hasOwn(android1, "privacyScreenActive"), false);
  assert.equal(Object.hasOwn(android1, "audioEnabled"), false);
  assert.equal(Object.hasOwn(android1.capabilities, "desktopAudio"), false);
  assert.equal(Object.hasOwn(android1.capabilities, "privacyScreen"), false);
  assert.equal(Object.hasOwn(android1.capabilities, "fileManager"), false);
  assert.equal(Object.hasOwn(android1.capabilities, "powerControl"), false);
  assert.equal(Object.hasOwn(android1.capabilities, "highRefresh"), false);

  // 3. Partial telemetry preserves existing desktop capability flags and state fields
  desktopAgent.sendJson({
    type: "agent.telemetry",
    deviceId: "desk-pro-01",
    battery: 99,
    capabilities: {
      mediaProjection: false,
    },
  });
  const partialStatus = await ctrl1.nextJson<DeviceStatusMessage>();
  assert.equal(partialStatus.device.battery, 99);
  assert.equal(partialStatus.device.privacyScreenActive, true);
  assert.equal(partialStatus.device.audioEnabled, true);
  assert.equal(partialStatus.device.capabilities.mediaProjection, false);
  assert.equal(partialStatus.device.capabilities.desktopAudio, true);
  assert.equal(partialStatus.device.capabilities.privacyScreen, true);
  assert.equal(partialStatus.device.capabilities.fileManager, true);
  assert.equal(partialStatus.device.capabilities.powerControl, true);
  assert.equal(partialStatus.device.capabilities.highRefresh, true);

  // 4. Explicit telemetry updates toggle privacyScreenActive, audioEnabled, and individual capability flags
  desktopAgent.sendJson({
    type: "agent.telemetry",
    deviceId: "desk-pro-01",
    privacyScreenActive: false,
    audioEnabled: false,
    capabilities: {
      desktopAudio: false,
      highRefresh: false,
    },
  });
  const updatedStatus = await ctrl1.nextJson<DeviceStatusMessage>();
  assert.equal(updatedStatus.device.privacyScreenActive, false);
  assert.equal(updatedStatus.device.audioEnabled, false);
  assert.equal(updatedStatus.device.capabilities.desktopAudio, false);
  assert.equal(updatedStatus.device.capabilities.highRefresh, false);
  assert.equal(updatedStatus.device.capabilities.privacyScreen, true);
  assert.equal(updatedStatus.device.capabilities.fileManager, true);
  assert.equal(updatedStatus.device.capabilities.powerControl, true);

  // 5. Newly connecting controller & cloneDeviceSummary preserve updated flags
  ctrl2.sendJson({
    type: "controller.auth",
    authToken: token,
    clientId: "ctrl-pro-2",
  });
  const authed2 = await ctrl2.nextJson<ControllerAuthedMessage>();
  const desk2 = authed2.devices.find((d) => d.deviceId === "desk-pro-01");
  assert.ok(desk2);
  assert.equal(desk2.privacyScreenActive, false);
  assert.equal(desk2.audioEnabled, false);
  assert.equal(desk2.capabilities.desktopAudio, false);
  assert.equal(desk2.capabilities.privacyScreen, true);
  assert.equal(desk2.capabilities.fileManager, true);
  assert.equal(desk2.capabilities.powerControl, true);
  assert.equal(desk2.capabilities.highRefresh, false);

  const cloned = cloneDeviceSummary(desk2);
  assert.deepEqual(cloned.capabilities, desk2.capabilities);
  assert.notEqual(cloned.capabilities, desk2.capabilities);
  assert.equal(cloned.privacyScreenActive, false);
  assert.equal(cloned.audioEnabled, false);

  // 6. Persisted store preserves registered desktop capability flags and state on disk reload
  await server.hub.store.flush();
  const reloadedStore = new VeloDeckStore(dataDir);
  const persisted = reloadedStore.getDevice("desk-pro-01");
  assert.ok(persisted);
  assert.equal(persisted.summary.privacyScreenActive, true);
  assert.equal(persisted.summary.audioEnabled, true);
  assert.equal(persisted.summary.capabilities.desktopAudio, true);
  assert.equal(persisted.summary.capabilities.privacyScreen, true);
  assert.equal(persisted.summary.capabilities.fileManager, true);
  assert.equal(persisted.summary.capabilities.powerControl, true);
  assert.equal(persisted.summary.capabilities.highRefresh, true);
});

test("Pro desktop StreamQuality (4K/120fps, codec, audioEnabled) validates and forwards cleanly while invalid codec/bounds are rejected", async (t) => {
  const { server, wsUrl } = await startServer();
  t.after(() => server.close());

  const agent = await TestWsClient.connect(wsUrl);
  const ctrl = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([agent.close(), ctrl.close()]);
  });

  agent.sendJson(
    makeAgentRegister({
      deviceId: "desk-4k-stream",
      deviceSecret: "desk-4k-secret",
      controlPassword: "desk-4k-password-123",
      deviceType: "desktop",
      osPlatform: "win32",
    }),
  );
  const reg = await agent.nextJson<AgentRegisteredMessage>();
  assert.ok(reg.controlCode);

  ctrl.sendJson({
    type: "controller.auth",
    controlCode: reg.controlCode,
    controlPassword: "desk-4k-password-123",
    clientId: "ctrl-4k-stream",
  });
  await ctrl.nextJson<ControllerAuthedMessage>();

  // Verify DESKTOP_QUALITY_PRESETS.ultra & QUALITY_PRESETS intact
  assert.equal(DESKTOP_QUALITY_PRESETS.ultra.maxWidth, 3840);
  assert.equal(DESKTOP_QUALITY_PRESETS.ultra.fps, 120);
  assert.equal(DESKTOP_QUALITY_PRESETS.ultra.bitrateKbps, 30000);
  assert.equal(DESKTOP_QUALITY_PRESETS.ultra.codec, "auto");
  assert.equal(QUALITY_PRESETS.hd.maxWidth, 1080);

  // 1. session.request with 4K/120fps/hevc/audioEnabled forwards all quality fields cleanly
  const hevcUltraQuality = {
    maxWidth: 3840,
    fps: 120,
    bitrateKbps: 30000,
    jpegQuality: 74,
    codec: "hevc" as const,
    audioEnabled: true,
  };
  ctrl.sendJson({
    type: "session.request",
    sessionId: "sess-4k-ultra-1",
    deviceId: "desk-4k-stream",
    preferredTransport: "webrtc",
    quality: hevcUltraQuality,
  } satisfies SessionRequestMessage);
  const fwdReq = await agent.nextJson<SessionRequestMessage>();
  assert.deepEqual(fwdReq.quality, hevcUltraQuality);

  agent.sendJson({
    type: "session.ready",
    sessionId: "sess-4k-ultra-1",
    deviceId: "desk-4k-stream",
    transport: "webrtc",
    screenWidth: 3840,
    screenHeight: 2160,
    rotation: 0,
  } satisfies SessionReadyMessage);
  await ctrl.nextJson<SessionReadyMessage>();

  // 2. Valid in-session quality commands across codecs, audioEnabled, and upper bounds
  const validQualities = [
    hevcUltraQuality,
    DESKTOP_QUALITY_PRESETS.auto,
    DESKTOP_QUALITY_PRESETS.hd,
    DESKTOP_QUALITY_PRESETS.ultra,
    { maxWidth: 7680, fps: 240, bitrateKbps: 50000, jpegQuality: 100, codec: "av1" as const, audioEnabled: false },
    { maxWidth: 2560, fps: 90, bitrateKbps: 16000, jpegQuality: 68, codec: "vp9" as const },
    { maxWidth: 1920, fps: 60, bitrateKbps: 8000, jpegQuality: 60, codec: "h264" as const },
  ];

  let seq = 1;
  for (const quality of validQualities) {
    seq += 1;
    ctrl.sendJson({
      type: "control.cmd",
      sessionId: "sess-4k-ultra-1",
      deviceId: "desk-4k-stream",
      seq,
      command: { action: "quality", quality },
    } satisfies ControlCmdMessage);
    const forwarded = await agent.nextJson<ControlCmdMessage>();
    assert.deepEqual(forwarded.command, { action: "quality", quality });
  }

  // 3. Invalid codec ("mpeg2"), invalid audioEnabled, and out-of-range bounds are rejected
  const invalidQualities: unknown[] = [
    { maxWidth: 3840, fps: 120, bitrateKbps: 30000, jpegQuality: 74, codec: "mpeg2" },
    { maxWidth: 3840, fps: 120, bitrateKbps: 30000, jpegQuality: 74, codec: "hevc", audioEnabled: "yes" },
    { maxWidth: 7681, fps: 120, bitrateKbps: 30000, jpegQuality: 74, codec: "hevc" },
    { maxWidth: 3840, fps: 241, bitrateKbps: 30000, jpegQuality: 74, codec: "hevc" },
    { maxWidth: 3840, fps: 120, bitrateKbps: 50001, jpegQuality: 74, codec: "hevc" },
    { maxWidth: 3840, fps: 120, bitrateKbps: 30000, jpegQuality: 101, codec: "hevc" },
  ];

  for (const badQuality of invalidQualities) {
    seq += 1;
    ctrl.sendJson({
      type: "control.cmd",
      sessionId: "sess-4k-ultra-1",
      deviceId: "desk-4k-stream",
      seq,
      command: { action: "quality", quality: badQuality },
    });
    const err = await ctrl.nextJson<ErrorMessage>();
    assert.equal(err.type, "error");
    assert.equal(err.code, "INVALID_MESSAGE");
  }

  // Invalid codec on session.request is also rejected
  ctrl.sendJson({
    type: "session.request",
    sessionId: "sess-4k-bad-codec",
    deviceId: "desk-4k-stream",
    preferredTransport: "webrtc",
    quality: {
      maxWidth: 3840,
      fps: 120,
      bitrateKbps: 30000,
      jpegQuality: 74,
      codec: "mpeg2",
    },
  });
  const reqErr = await ctrl.nextJson<ErrorMessage>();
  assert.equal(reqErr.type, "error");
  assert.equal(reqErr.code, "INVALID_MESSAGE");

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(agent.drainJson().length, 0);
});

test("privacy_screen, audio_toggle, and power commands validate, require active sessions, forward cleanly, and emit audit logs", async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "velodeck-pro-desk-cmd-audit-"));
  const { server, baseUrl, wsUrl } = await startServer({ dataDir });
  t.after(async () => {
    await server.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "pro_power_user", password: "pro-power-password-123" }),
  });
  assert.equal(regRes.status, 201);
  const { token } = (await regRes.json()) as { token: string };

  const agent = await TestWsClient.connect(wsUrl);
  const ctrl = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([agent.close(), ctrl.close()]);
  });

  agent.sendJson(
    makeAgentRegister({
      deviceId: "desk-power-01",
      deviceSecret: "desk-power-secret",
      authToken: token,
      deviceType: "desktop",
      osPlatform: "linux",
    }),
  );
  await agent.nextJson<AgentRegisteredMessage>();

  ctrl.sendJson({
    type: "controller.auth",
    authToken: token,
    clientId: "ctrl-power-01",
  });
  await ctrl.nextJson<ControllerAuthedMessage>();

  // 1. Sessionless power, privacy_screen, and audio_toggle MUST be rejected with SESSION_NOT_FOUND
  for (const sessionlessCmd of [
    { action: "power", operation: "lock" },
    { action: "power", operation: "shutdown" },
    { action: "privacy_screen", enabled: true },
    { action: "audio_toggle", enabled: true },
  ] as const) {
    ctrl.sendJson({
      type: "control.cmd",
      sessionId: "",
      deviceId: "desk-power-01",
      seq: 1,
      command: sessionlessCmd,
    } satisfies ControlCmdMessage);
    const err = await ctrl.nextJson<ErrorMessage>();
    assert.equal(err.type, "error");
    assert.equal(err.code, "SESSION_NOT_FOUND");
  }

  // 2. Establish an active authenticated session
  ctrl.sendJson({
    type: "session.request",
    sessionId: "sess-power-01",
    deviceId: "desk-power-01",
    preferredTransport: "webrtc",
    quality: DESKTOP_QUALITY_PRESETS.balanced,
  } satisfies SessionRequestMessage);
  await agent.nextJson<SessionRequestMessage>();

  agent.sendJson({
    type: "session.ready",
    sessionId: "sess-power-01",
    deviceId: "desk-power-01",
    transport: "webrtc",
    screenWidth: 1920,
    screenHeight: 1080,
    rotation: 0,
  } satisfies SessionReadyMessage);
  await ctrl.nextJson<SessionReadyMessage>();

  // 3. Valid in-session privacy_screen, audio_toggle, and power operations forward cleanly
  const validCommands: ControlCmdMessage["command"][] = [
    { action: "privacy_screen", enabled: true },
    { action: "privacy_screen", enabled: false },
    { action: "audio_toggle", enabled: true },
    { action: "audio_toggle", enabled: false },
    { action: "power", operation: "lock" },
    { action: "power", operation: "sleep" },
    { action: "power", operation: "restart" },
    { action: "power", operation: "shutdown" },
  ];

  let seq = 10;
  for (const command of validCommands) {
    seq += 1;
    ctrl.sendJson({
      type: "control.cmd",
      sessionId: "sess-power-01",
      deviceId: "desk-power-01",
      seq,
      command,
    } satisfies ControlCmdMessage);
    const forwarded = await agent.nextJson<ControlCmdMessage>();
    assert.equal(forwarded.type, "control.cmd");
    assert.equal(forwarded.sessionId, "sess-power-01");
    assert.equal(forwarded.deviceId, "desk-power-01");
    assert.equal(forwarded.seq, seq);
    assert.deepEqual(forwarded.command, command);
  }

  // 4. Invalid payloads are rejected with INVALID_MESSAGE and never forwarded
  const invalidCommands: unknown[] = [
    { action: "privacy_screen", enabled: "on" },
    { action: "audio_toggle", enabled: 1 },
    { action: "power", operation: "hibernate" },
    { action: "power", operation: "" },
    { action: "power" },
  ];

  for (const badCmd of invalidCommands) {
    seq += 1;
    ctrl.sendJson({
      type: "control.cmd",
      sessionId: "sess-power-01",
      deviceId: "desk-power-01",
      seq,
      command: badCmd,
    });
    const err = await ctrl.nextJson<ErrorMessage>();
    assert.equal(err.type, "error");
    assert.equal(err.code, "INVALID_MESSAGE");
    assert.equal(err.sessionId, "sess-power-01");
    assert.equal(err.deviceId, "desk-power-01");
  }

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(agent.drainJson().length, 0);

  // 5. Verify explicit audit log entries for privacy_screen (on/off) and power (lock/sleep/restart/shutdown)
  await server.hub.audit.flush();
  const auditEntries = (await fsp.readFile(path.join(dataDir, "audit.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event: string; detail?: string; deviceId?: string; sessionId?: string });

  const privacyAudit = auditEntries.filter((e) => e.event === "control.privacy_screen");
  assert.deepEqual(
    privacyAudit.map((e) => e.detail),
    ["on", "off"],
  );
  assert.ok(privacyAudit.every((e) => e.deviceId === "desk-power-01" && e.sessionId === "sess-power-01"));

  const powerAudit = auditEntries.filter((e) => e.event === "control.power");
  assert.deepEqual(
    powerAudit.map((e) => e.detail),
    ["lock", "sleep", "restart", "shutdown"],
  );
  assert.ok(powerAudit.every((e) => e.deviceId === "desk-power-01" && e.sessionId === "sess-power-01"));
});

test("Wave 2+3 metadata (macAddresses, lanIp, accessMode, blockInputActive) and capabilities sanitize, propagate on register/telemetry/clone, and persist on reload", async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "velodeck-wave23-meta-test-"));
  const { server, baseUrl, wsUrl } = await startServer({ dataDir });
  t.after(async () => {
    await server.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "wave23_owner", password: "wave23-password-123" }),
  });
  assert.equal(regRes.status, 201);
  const { token } = (await regRes.json()) as { token: string };

  const desktopAgent = await TestWsClient.connect(wsUrl);
  const badMetaAgent = await TestWsClient.connect(wsUrl);
  const androidAgent = await TestWsClient.connect(wsUrl);
  const ctrl = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([desktopAgent.close(), badMetaAgent.close(), androidAgent.close(), ctrl.close()]);
  });

  // 1. Register desktop host with Wave 2+3 capabilities + mixed/deduped/capped MACs + valid LAN IP + accessMode + blockInputActive
  desktopAgent.sendJson(
    makeAgentRegister({
      deviceId: "desk-wave23-01",
      deviceSecret: "desk-wave23-secret-01",
      authToken: token,
      deviceType: "desktop",
      osPlatform: "win32",
      blockInputActive: true,
      accessMode: "confirm",
      macAddresses: [
        "aa-bb-cc-dd-ee-01",
        "AA:BB:CC:DD:EE:01", // duplicate after normalization
        "not-a-mac",
        "11:22:33:44:55:02",
        "11:22:33:44:55:03",
        "11:22:33:44:55:04",
        "11:22:33:44:55:05",
        "11:22:33:44:55:06",
        "11:22:33:44:55:07",
        "11:22:33:44:55:08",
        "11:22:33:44:55:09", // 9th valid unique MAC -> capped at 8
      ],
      lanIp: "192.168.10.42",
      capabilities: {
        webrtc: true,
        wsJpeg: true,
        wsH264: false,
        wake: false,
        unlock: false,
        accessibility: true,
        mediaProjection: true,
        remoteTerminal: true,
        relativeMouse: true,
        cursorSync: true,
        blockInput: true,
        wolRelay: true,
        whiteboard: true,
        chat: true,
      },
    }),
  );
  await desktopAgent.nextJson<AgentRegisteredMessage>();

  // 2. Register agent with invalid MACs, public lanIp, and invalid accessMode -> all sanitized out
  badMetaAgent.sendJson({
    ...makeAgentRegister({
      deviceId: "desk-badmeta-02",
      deviceSecret: "desk-badmeta-secret-02",
      authToken: token,
      deviceType: "desktop",
      osPlatform: "linux",
    }),
    accessMode: "always-allow",
    macAddresses: ["ZZZZ", "12:34:56", "aa:bb:cc:dd:ee:gg", 12345],
    lanIp: "8.8.8.8",
  });
  await badMetaAgent.nextJson<AgentRegisteredMessage>();

  // 3. Legacy Android agent registers without any Wave 2+3 fields
  androidAgent.sendJson(
    makeAgentRegister({
      deviceId: "dev-android-w23",
      deviceSecret: "android-w23-secret",
      authToken: token,
    }),
  );
  await androidAgent.nextJson<AgentRegisteredMessage>();

  ctrl.sendJson({
    type: "controller.auth",
    authToken: token,
    clientId: "ctrl-wave23-1",
  });
  const authed = await ctrl.nextJson<ControllerAuthedMessage>();
  assert.equal(authed.devices.length, 3);

  const desk = authed.devices.find((d) => d.deviceId === "desk-wave23-01");
  const badMeta = authed.devices.find((d) => d.deviceId === "desk-badmeta-02");
  const legacyAndroid = authed.devices.find((d) => d.deviceId === "dev-android-w23");

  assert.ok(desk);
  assert.equal(desk.blockInputActive, true);
  assert.equal(desk.accessMode, "confirm");
  assert.equal(desk.lanIp, "192.168.10.42");
  assert.deepEqual(desk.macAddresses, [
    "AA:BB:CC:DD:EE:01",
    "11:22:33:44:55:02",
    "11:22:33:44:55:03",
    "11:22:33:44:55:04",
    "11:22:33:44:55:05",
    "11:22:33:44:55:06",
    "11:22:33:44:55:07",
    "11:22:33:44:55:08",
  ]);
  assert.equal(desk.capabilities.remoteTerminal, true);
  assert.equal(desk.capabilities.relativeMouse, true);
  assert.equal(desk.capabilities.cursorSync, true);
  assert.equal(desk.capabilities.blockInput, true);
  assert.equal(desk.capabilities.wolRelay, true);
  assert.equal(desk.capabilities.whiteboard, true);
  assert.equal(desk.capabilities.chat, true);

  assert.ok(badMeta);
  assert.equal(Object.hasOwn(badMeta, "accessMode"), false);
  assert.equal(Object.hasOwn(badMeta, "macAddresses"), false);
  assert.equal(Object.hasOwn(badMeta, "lanIp"), false);

  assert.ok(legacyAndroid);
  assert.equal(Object.hasOwn(legacyAndroid, "blockInputActive"), false);
  assert.equal(Object.hasOwn(legacyAndroid, "accessMode"), false);
  assert.equal(Object.hasOwn(legacyAndroid, "macAddresses"), false);
  assert.equal(Object.hasOwn(legacyAndroid, "lanIp"), false);
  assert.equal(Object.hasOwn(legacyAndroid.capabilities, "remoteTerminal"), false);
  assert.equal(Object.hasOwn(legacyAndroid.capabilities, "relativeMouse"), false);
  assert.equal(Object.hasOwn(legacyAndroid.capabilities, "cursorSync"), false);
  assert.equal(Object.hasOwn(legacyAndroid.capabilities, "blockInput"), false);
  assert.equal(Object.hasOwn(legacyAndroid.capabilities, "wolRelay"), false);
  assert.equal(Object.hasOwn(legacyAndroid.capabilities, "whiteboard"), false);
  assert.equal(Object.hasOwn(legacyAndroid.capabilities, "chat"), false);

  // 4. Telemetry updates propagate valid Wave 2+3 fields and ignore public lanIp / invalid MACs
  desktopAgent.sendJson({
    type: "agent.telemetry",
    deviceId: "desk-wave23-01",
    blockInputActive: false,
    accessMode: "auto",
    macAddresses: ["de-ad-be-ef-00-01", "bad-mac"],
    lanIp: "100.64.12.34", // CGNAT / Tailscale allowed
    capabilities: {
      remoteTerminal: false,
      chat: false,
    },
  });
  const telemetry1 = await ctrl.nextJson<DeviceStatusMessage>();
  assert.equal(telemetry1.device.blockInputActive, false);
  assert.equal(telemetry1.device.accessMode, "auto");
  assert.deepEqual(telemetry1.device.macAddresses, ["DE:AD:BE:EF:00:01"]);
  assert.equal(telemetry1.device.lanIp, "100.64.12.34");
  assert.equal(telemetry1.device.capabilities.remoteTerminal, false);
  assert.equal(telemetry1.device.capabilities.chat, false);
  assert.equal(telemetry1.device.capabilities.wolRelay, true);
  assert.equal(telemetry1.device.capabilities.whiteboard, true);

  // Public IP & invalid MAC in telemetry must NOT overwrite valid sanitized fields
  desktopAgent.sendJson({
    type: "agent.telemetry",
    deviceId: "desk-wave23-01",
    lanIp: "203.0.113.9",
    macAddresses: ["invalid-only"],
  });
  const telemetry2 = await ctrl.nextJson<DeviceStatusMessage>();
  assert.equal(telemetry2.device.lanIp, "100.64.12.34");
  assert.deepEqual(telemetry2.device.macAddresses, ["DE:AD:BE:EF:00:01"]);

  // 5. cloneDeviceSummary deep-clones macAddresses & preserves all new fields
  const cloned = cloneDeviceSummary(telemetry2.device);
  assert.deepEqual(cloned.macAddresses, ["DE:AD:BE:EF:00:01"]);
  assert.notEqual(cloned.macAddresses, telemetry2.device.macAddresses);
  cloned.macAddresses?.push("00:11:22:33:44:55");
  assert.deepEqual(telemetry2.device.macAddresses, ["DE:AD:BE:EF:00:01"]);
  assert.equal(cloned.lanIp, "100.64.12.34");
  assert.equal(cloned.accessMode, "auto");
  assert.equal(cloned.blockInputActive, false);

  // 6. Persisted disk reload preserves durable telemetry updates (macAddresses, lanIp, accessMode)
  //    while keeping high-frequency transient telemetry in-memory only and resetting blockInputActive.
  await server.hub.store.flush();
  desktopAgent.sendJson({
    type: "agent.telemetry",
    deviceId: "desk-wave23-01",
    battery: 42,
    blockInputActive: true,
  });
  const telemetry3 = await ctrl.nextJson<DeviceStatusMessage>();
  assert.equal(telemetry3.device.battery, 42);
  assert.equal(telemetry3.device.blockInputActive, true);

  await server.hub.store.flush();
  const reloadedStore = new VeloDeckStore(dataDir);
  const persisted = reloadedStore.getDevice("desk-wave23-01");
  assert.ok(persisted);
  assert.equal(persisted.summary.online, false);
  assert.equal(persisted.summary.blockInputActive, false);
  assert.equal(persisted.summary.accessMode, "auto");
  assert.equal(persisted.summary.lanIp, "100.64.12.34");
  assert.deepEqual(persisted.summary.macAddresses, ["DE:AD:BE:EF:00:01"]);
  // Transient battery-only telemetry did NOT overwrite disk snapshot
  assert.notEqual(persisted.summary.battery, 42);
  assert.equal(persisted.summary.capabilities.remoteTerminal, false);
  assert.equal(persisted.summary.capabilities.chat, false);
  assert.equal(persisted.summary.capabilities.wolRelay, true);
  assert.equal(persisted.summary.capabilities.whiteboard, true);

  // Also verify loadFromDisk resets persisted blockInputActive: true -> false
  const persistedWithBlock = cloneDeviceSummary(persisted.summary);
  persistedWithBlock.blockInputActive = true;
  server.hub.store.updateDeviceSummary("desk-wave23-01", persistedWithBlock, true);
  await server.hub.store.flush();
  const reloadedAfterBlock = new VeloDeckStore(dataDir);
  assert.equal(reloadedAfterBlock.getDevice("desk-wave23-01")?.summary.blockInputActive, false);

  const persistedBad = reloadedStore.getDevice("desk-badmeta-02");
  assert.ok(persistedBad);
  assert.equal(Object.hasOwn(persistedBad.summary, "lanIp"), false);
  assert.equal(Object.hasOwn(persistedBad.summary, "macAddresses"), false);
  assert.equal(Object.hasOwn(persistedBad.summary, "accessMode"), false);

  // 7. Disconnect resets blockInputActive to false, and reconnecting with transient empty macAddresses: []
  //    preserves previously persisted WOL MACs and does NOT inherit blockInputActive.
  await desktopAgent.close();
  const offlineStatus = await ctrl.nextJson<DeviceStatusMessage>();
  assert.equal(offlineStatus.device.deviceId, "desk-wave23-01");
  assert.equal(offlineStatus.device.online, false);
  assert.equal(offlineStatus.device.blockInputActive, false);
  assert.deepEqual(offlineStatus.device.macAddresses, ["DE:AD:BE:EF:00:01"]);

  const reconnectedAgent = await TestWsClient.connect(wsUrl);
  t.after(() => reconnectedAgent.close());
  reconnectedAgent.sendJson(
    makeAgentRegister({
      deviceId: "desk-wave23-01",
      deviceSecret: "desk-wave23-secret-01",
      authToken: token,
      deviceType: "desktop",
      osPlatform: "win32",
      macAddresses: [],
    }),
  );
  await reconnectedAgent.nextJson<AgentRegisteredMessage>();
  const onlineAgain = await ctrl.nextJson<DeviceStatusMessage>();
  assert.equal(onlineAgain.device.deviceId, "desk-wave23-01");
  assert.equal(onlineAgain.device.online, true);
  assert.deepEqual(onlineAgain.device.macAddresses, ["DE:AD:BE:EF:00:01"]);
  assert.equal(onlineAgain.device.lanIp, "100.64.12.34");
  assert.equal(onlineAgain.device.accessMode, "auto");
  assert.equal(Object.hasOwn(onlineAgain.device, "blockInputActive"), false);
});

test("Wave 2+3 control commands: mouse_move_relative, block_input (session-only + audit), whiteboard validation, and sessionless wol auth + audit", async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "velodeck-wave23-ctrl-test-"));
  const { server, baseUrl, wsUrl } = await startServer({
    dataDir,
    registrationInviteCode: "WAVE23-TEST-INVITE",
  });
  t.after(async () => {
    await server.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  // Register two separate users to test ownership enforcement on sessionless WOL
  const regAlice = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "wave23_alice",
      password: "alice-password-123",
      inviteCode: "WAVE23-TEST-INVITE",
    }),
  });
  assert.equal(regAlice.status, 201);
  const { token: aliceToken } = (await regAlice.json()) as { token: string };

  const regBob = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "wave23_bob",
      password: "bob-password-123",
      inviteCode: "WAVE23-TEST-INVITE",
    }),
  });
  assert.equal(regBob.status, 201);
  const { token: bobToken } = (await regBob.json()) as { token: string };

  const alicePeer = await TestWsClient.connect(wsUrl);
  const aliceCtrl = await TestWsClient.connect(wsUrl);
  const bobCtrl = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([alicePeer.close(), aliceCtrl.close(), bobCtrl.close()]);
  });

  alicePeer.sendJson(
    makeAgentRegister({
      deviceId: "alice-mac-relay",
      deviceSecret: "alice-mac-secret",
      authToken: aliceToken,
      deviceType: "desktop",
      osPlatform: "darwin",
      capabilities: {
        webrtc: true,
        wsJpeg: true,
        wsH264: false,
        wake: true,
        unlock: false,
        accessibility: true,
        mediaProjection: true,
        wolRelay: true,
        blockInput: true,
        relativeMouse: true,
        whiteboard: true,
      },
    }),
  );
  await alicePeer.nextJson<AgentRegisteredMessage>();

  aliceCtrl.sendJson({
    type: "controller.auth",
    authToken: aliceToken,
    clientId: "ctrl-alice-w23",
  });
  await aliceCtrl.nextJson<ControllerAuthedMessage>();

  bobCtrl.sendJson({
    type: "controller.auth",
    authToken: bobToken,
    clientId: "ctrl-bob-w23",
  });
  await bobCtrl.nextJson<ControllerAuthedMessage>();

  // 1. Sessionless block_input, mouse_move_relative, and whiteboard MUST be rejected with SESSION_NOT_FOUND
  for (const sessionlessDenied of [
    { action: "block_input", enabled: true },
    { action: "mouse_move_relative", dx: 10, dy: -5 },
    { action: "whiteboard", op: "clear" },
  ] as const) {
    aliceCtrl.sendJson({
      type: "control.cmd",
      sessionId: "",
      deviceId: "alice-mac-relay",
      seq: 1,
      command: sessionlessDenied,
    } satisfies ControlCmdMessage);
    const err = await aliceCtrl.nextJson<ErrorMessage>();
    assert.equal(err.type, "error");
    assert.equal(err.code, "SESSION_NOT_FOUND");
  }

  // 2. Sessionless WOL from authorized owner (Alice) succeeds & routes out-of-band control.ack back
  aliceCtrl.sendJson({
    type: "control.cmd",
    sessionId: "",
    deviceId: "alice-mac-relay",
    seq: 42,
    command: {
      action: "wol",
      macAddress: "AA:BB:CC:DD:EE:FF",
      broadcastIp: "192.168.1.255",
    },
  } satisfies ControlCmdMessage);
  const wolForwarded = await alicePeer.nextJson<ControlCmdMessage>();
  assert.equal(wolForwarded.type, "control.cmd");
  assert.equal(wolForwarded.sessionId, "");
  assert.equal(wolForwarded.deviceId, "alice-mac-relay");
  assert.equal(wolForwarded.seq, 42);
  assert.deepEqual(wolForwarded.command, {
    action: "wol",
    macAddress: "AA:BB:CC:DD:EE:FF",
    broadcastIp: "192.168.1.255",
  });

  // Also allow 255.255.255.255 and omitted broadcastIp
  aliceCtrl.sendJson({
    type: "control.cmd",
    sessionId: "",
    deviceId: "alice-mac-relay",
    seq: 43,
    command: {
      action: "wol",
      macAddress: "aa-bb-cc-dd-ee-00",
      broadcastIp: "255.255.255.255",
    },
  } satisfies ControlCmdMessage);
  const wolBroadcast255 = await alicePeer.nextJson<ControlCmdMessage>();
  assert.deepEqual(wolBroadcast255.command, {
    action: "wol",
    macAddress: "AA:BB:CC:DD:EE:00",
    broadcastIp: "255.255.255.255",
  });

  alicePeer.sendJson({
    type: "control.ack",
    sessionId: "",
    deviceId: "alice-mac-relay",
    seq: 42,
    ok: true,
    message: "wol_sent",
  } satisfies ControlAckMessage);
  const wolAck = await aliceCtrl.nextJson<ControlAckMessage>();
  assert.equal(wolAck.type, "control.ack");
  assert.equal(wolAck.seq, 42);
  assert.equal(wolAck.ok, true);

  // 3. Unauthorized user (Bob) sending sessionless WOL to Alice's peer device MUST be rejected
  bobCtrl.sendJson({
    type: "control.cmd",
    sessionId: "",
    deviceId: "alice-mac-relay",
    seq: 99,
    command: {
      action: "wol",
      macAddress: "AA:BB:CC:DD:EE:FF",
    },
  } satisfies ControlCmdMessage);
  const bobErr = await bobCtrl.nextJson<ErrorMessage>();
  assert.equal(bobErr.type, "error");
  assert.equal(bobErr.code, "UNAUTHORIZED");

  // 4. Invalid WOL payloads rejected with INVALID_MESSAGE
  for (const badWol of [
    { action: "wol", macAddress: "not-a-mac" },
    { action: "wol", macAddress: "AA:BB:CC:DD:EE:GG" },
    { action: "wol", macAddress: "AA:BB:CC:DD:EE:FF", broadcastIp: "8.8.8.8" },
    { action: "wol", macAddress: "AA:BB:CC:DD:EE:FF", broadcastIp: "127.0.0.1" },
    { action: "wol", macAddress: "AA:BB:CC:DD:EE:FF", broadcastIp: "" },
  ]) {
    aliceCtrl.sendJson({
      type: "control.cmd",
      sessionId: "",
      deviceId: "alice-mac-relay",
      seq: 50,
      command: badWol,
    });
    const err = await aliceCtrl.nextJson<ErrorMessage>();
    assert.equal(err.type, "error");
    assert.equal(err.code, "INVALID_MESSAGE");
  }

  // 5. Establish active session for in-session commands
  aliceCtrl.sendJson({
    type: "session.request",
    sessionId: "sess-wave23-01",
    deviceId: "alice-mac-relay",
    preferredTransport: "webrtc",
    quality: DESKTOP_QUALITY_PRESETS.balanced,
  } satisfies SessionRequestMessage);
  await alicePeer.nextJson<SessionRequestMessage>();

  alicePeer.sendJson({
    type: "session.ready",
    sessionId: "sess-wave23-01",
    deviceId: "alice-mac-relay",
    transport: "webrtc",
    screenWidth: 1920,
    screenHeight: 1080,
    rotation: 0,
  } satisfies SessionReadyMessage);
  await aliceCtrl.nextJson<SessionReadyMessage>();

  const validStroke: WhiteboardStroke = {
    id: "stroke-01",
    color: "#ff3b30",
    width: 4,
    points: [
      { x: 0.1, y: 0.2 },
      { x: 0.5, y: 0.6 },
    ],
  };

  const validInSessionCommands: ControlCmdMessage["command"][] = [
    { action: "mouse_move_relative", dx: -14.5, dy: 22 },
    { action: "block_input", enabled: true },
    { action: "block_input", enabled: false },
    { action: "whiteboard", op: "stroke", stroke: validStroke },
    { action: "whiteboard", op: "clear" },
  ];

  let seq = 100;
  for (const command of validInSessionCommands) {
    seq += 1;
    aliceCtrl.sendJson({
      type: "control.cmd",
      sessionId: "sess-wave23-01",
      deviceId: "alice-mac-relay",
      seq,
      command,
    } satisfies ControlCmdMessage);
    const forwarded = await alicePeer.nextJson<ControlCmdMessage>();
    assert.deepEqual(forwarded.command, command);
  }

  // 6. Malformed in-session mouse_move_relative, block_input, and whiteboard (including >256 points) rejected
  const oversizedPoints = Array.from({ length: 257 }, (_, i) => ({ x: i * 0.001, y: 0.5 }));
  const invalidInSessionCommands: unknown[] = [
    { action: "mouse_move_relative", dx: Number.NaN, dy: 5 },
    { action: "mouse_move_relative", dx: "10", dy: 5 },
    { action: "block_input", enabled: "yes" },
    { action: "whiteboard", op: "erase" },
    { action: "whiteboard", op: "stroke" },
    { action: "whiteboard", op: "clear", stroke: validStroke },
    {
      action: "whiteboard",
      op: "stroke",
      stroke: { id: "s-big", color: "#fff", width: 3, points: oversizedPoints },
    },
    {
      action: "whiteboard",
      op: "stroke",
      stroke: { id: "s-empty", color: "#fff", width: 3, points: [] },
    },
    {
      action: "whiteboard",
      op: "stroke",
      stroke: { id: "s-color", color: "c".repeat(25), width: 3, points: [{ x: 1, y: 2 }] },
    },
    {
      action: "whiteboard",
      op: "stroke",
      stroke: { id: "s-w0", color: "#fff", width: 0, points: [{ x: 1, y: 2 }] },
    },
    {
      action: "whiteboard",
      op: "stroke",
      stroke: { id: "s-w33", color: "#fff", width: 33, points: [{ x: 1, y: 2 }] },
    },
    {
      action: "whiteboard",
      op: "stroke",
      stroke: { id: "s-nan", color: "#fff", width: 4, points: [{ x: Number.NaN, y: 2 }] },
    },
  ];

  for (const badCmd of invalidInSessionCommands) {
    seq += 1;
    aliceCtrl.sendJson({
      type: "control.cmd",
      sessionId: "sess-wave23-01",
      deviceId: "alice-mac-relay",
      seq,
      command: badCmd,
    });
    const err = await aliceCtrl.nextJson<ErrorMessage>();
    assert.equal(err.type, "error");
    assert.equal(err.code, "INVALID_MESSAGE");
  }

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(alicePeer.drainJson().length, 0);

  // 7. Verify audit log entries for control.block_input and control.wol
  await server.hub.audit.flush();
  const auditEntries = (await fsp.readFile(path.join(dataDir, "audit.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event: string; detail?: string; deviceId?: string; sessionId?: string });

  const blockAudit = auditEntries.filter((e) => e.event === "control.block_input");
  assert.deepEqual(
    blockAudit.map((e) => e.detail),
    ["on", "off"],
  );
  assert.ok(blockAudit.every((e) => e.deviceId === "alice-mac-relay" && e.sessionId === "sess-wave23-01"));

  const wolAudit = auditEntries.filter((e) => e.event === "control.wol");
  assert.equal(wolAudit.length, 2);
  assert.ok(wolAudit.every((e) => e.deviceId === "alice-mac-relay"));
  assert.deepEqual(
    wolAudit.map((e) => e.detail),
    [
      "sessionless:AA:BB:CC:DD:EE:FF@192.168.1.255",
      "sessionless:AA:BB:CC:DD:EE:00@255.255.255.255",
    ],
  );
});

test("Wave 2+3 in-session wire messages: cursor.update, chat.msg (bidirectional + sender role enforcement + >4KB rejection), session.pending, and session.permissions", async (t) => {
  const { server, baseUrl, wsUrl } = await startServer({
    registrationInviteCode: "WAVE23-WIRE-INVITE",
  });
  t.after(() => server.close());

  const regOwner = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "wire_owner",
      password: "wire-owner-password-1",
      inviteCode: "WAVE23-WIRE-INVITE",
    }),
  });
  assert.equal(regOwner.status, 201);
  const { token: ownerToken } = (await regOwner.json()) as { token: string };

  const regOther = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "wire_intruder",
      password: "wire-intruder-pass-1",
      inviteCode: "WAVE23-WIRE-INVITE",
    }),
  });
  assert.equal(regOther.status, 201);
  const { token: intruderToken } = (await regOther.json()) as { token: string };

  const agent = await TestWsClient.connect(wsUrl);
  const ctrl = await TestWsClient.connect(wsUrl);
  const intruder = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([agent.close(), ctrl.close(), intruder.close()]);
  });

  agent.sendJson(
    makeAgentRegister({
      deviceId: "desk-wire-01",
      deviceSecret: "desk-wire-secret-01",
      authToken: ownerToken,
      deviceType: "desktop",
      osPlatform: "darwin",
      accessMode: "confirm",
    }),
  );
  await agent.nextJson<AgentRegisteredMessage>();

  ctrl.sendJson({
    type: "controller.auth",
    authToken: ownerToken,
    clientId: "ctrl-wire-01",
  });
  await ctrl.nextJson<ControllerAuthedMessage>();

  intruder.sendJson({
    type: "controller.auth",
    authToken: intruderToken,
    clientId: "ctrl-intruder-01",
  });
  await intruder.nextJson<ControllerAuthedMessage>();

  // Request session -> agent sends session.pending -> then session.permissions -> then session.ready
  ctrl.sendJson({
    type: "session.request",
    sessionId: "sess-wire-01",
    deviceId: "desk-wire-01",
    preferredTransport: "webrtc",
    quality: DESKTOP_QUALITY_PRESETS.balanced,
  } satisfies SessionRequestMessage);
  await agent.nextJson<SessionRequestMessage>();

  // 1. session.pending (agent -> controller)
  agent.sendJson({
    type: "session.pending",
    sessionId: "sess-wire-01",
    deviceId: "desk-wire-01",
    message: "Waiting for host user approval",
  } satisfies SessionPendingMessage);
  const pending = await ctrl.nextJson<SessionPendingMessage>();
  assert.deepEqual(pending, {
    type: "session.pending",
    sessionId: "sess-wire-01",
    deviceId: "desk-wire-01",
    message: "Waiting for host user approval",
  });

  // Controller must not be allowed to send session.pending
  ctrl.sendJson({
    type: "session.pending",
    sessionId: "sess-wire-01",
    deviceId: "desk-wire-01",
  });
  const ctrlPendingErr = await ctrl.nextJson<ErrorMessage>();
  assert.equal(ctrlPendingErr.code, "UNAUTHORIZED");

  // 2. session.permissions (agent -> controller)
  agent.sendJson({
    type: "session.permissions",
    sessionId: "sess-wire-01",
    deviceId: "desk-wire-01",
    permissions: {
      keyboard: true,
      mouse: true,
      clipboard: true,
      fileTransfer: false,
      audio: true,
      terminal: false,
    },
  } satisfies SessionPermissionsMessage);
  const perms = await ctrl.nextJson<SessionPermissionsMessage>();
  assert.deepEqual(perms, {
    type: "session.permissions",
    sessionId: "sess-wire-01",
    deviceId: "desk-wire-01",
    permissions: {
      keyboard: true,
      mouse: true,
      clipboard: true,
      fileTransfer: false,
      audio: true,
      terminal: false,
    },
  });

  // Invalid permissions field type rejected
  agent.sendJson({
    type: "session.permissions",
    sessionId: "sess-wire-01",
    deviceId: "desk-wire-01",
    permissions: { keyboard: "yes" },
  });
  const badPermErr = await agent.nextJson<ErrorMessage>();
  assert.equal(badPermErr.code, "INVALID_MESSAGE");

  // Controller cannot send session.permissions
  ctrl.sendJson({
    type: "session.permissions",
    sessionId: "sess-wire-01",
    deviceId: "desk-wire-01",
    permissions: { terminal: true },
  });
  const ctrlPermErr = await ctrl.nextJson<ErrorMessage>();
  assert.equal(ctrlPermErr.code, "UNAUTHORIZED");

  // Complete session handshake
  agent.sendJson({
    type: "session.ready",
    sessionId: "sess-wire-01",
    deviceId: "desk-wire-01",
    transport: "webrtc",
    screenWidth: 2560,
    screenHeight: 1440,
    rotation: 0,
  } satisfies SessionReadyMessage);
  await ctrl.nextJson<SessionReadyMessage>();

  // 3. cursor.update (agent -> controller, validated CursorShape)
  agent.sendJson({
    type: "cursor.update",
    sessionId: "sess-wire-01",
    deviceId: "desk-wire-01",
    shape: "ew-resize",
    visible: true,
  } satisfies CursorUpdateMessage);
  const cursorMsg = await ctrl.nextJson<CursorUpdateMessage>();
  assert.deepEqual(cursorMsg, {
    type: "cursor.update",
    sessionId: "sess-wire-01",
    deviceId: "desk-wire-01",
    shape: "ew-resize",
    visible: true,
  });

  // Invalid cursor shape rejected
  agent.sendJson({
    type: "cursor.update",
    sessionId: "sess-wire-01",
    deviceId: "desk-wire-01",
    shape: "custom-svg-cursor",
  });
  const badCursorErr = await agent.nextJson<ErrorMessage>();
  assert.equal(badCursorErr.code, "INVALID_MESSAGE");

  // Controller cannot send cursor.update
  ctrl.sendJson({
    type: "cursor.update",
    sessionId: "sess-wire-01",
    deviceId: "desk-wire-01",
    shape: "pointer",
  });
  const ctrlCursorErr = await ctrl.nextJson<ErrorMessage>();
  assert.equal(ctrlCursorErr.code, "UNAUTHORIZED");

  // 4. chat.msg bidirectional + strict sender role enforcement + >4KB rejection
  // Controller tries to spoof sender="host" -> Hub forces sender="controller"
  ctrl.sendJson({
    type: "chat.msg",
    sessionId: "sess-wire-01",
    deviceId: "desk-wire-01",
    id: "chat-01",
    sender: "host",
    senderName: "Alice",
    text: "Hello host!",
    ts: 1700000001000,
  } satisfies ChatMessage);
  const chatToAgent = await agent.nextJson<ChatMessage>();
  assert.deepEqual(chatToAgent, {
    type: "chat.msg",
    sessionId: "sess-wire-01",
    deviceId: "desk-wire-01",
    id: "chat-01",
    sender: "controller",
    senderName: "Alice",
    text: "Hello host!",
    ts: 1700000001000,
  });

  // Agent tries to spoof sender="controller" -> Hub forces sender="host"
  agent.sendJson({
    type: "chat.msg",
    sessionId: "sess-wire-01",
    deviceId: "desk-wire-01",
    id: "chat-02",
    sender: "controller",
    senderName: "Mac Studio",
    text: "Hello controller!",
    ts: 1700000002000,
  } satisfies ChatMessage);
  const chatToCtrl = await ctrl.nextJson<ChatMessage>();
  assert.deepEqual(chatToCtrl, {
    type: "chat.msg",
    sessionId: "sess-wire-01",
    deviceId: "desk-wire-01",
    id: "chat-02",
    sender: "host",
    senderName: "Mac Studio",
    text: "Hello controller!",
    ts: 1700000002000,
  });

  // Exact 4096-byte message succeeds
  ctrl.sendJson({
    type: "chat.msg",
    sessionId: "sess-wire-01",
    deviceId: "desk-wire-01",
    id: "chat-4k-ok",
    sender: "controller",
    text: "a".repeat(4096),
    ts: 1700000003000,
  } satisfies ChatMessage);
  const chat4k = await agent.nextJson<ChatMessage>();
  assert.equal(chat4k.id, "chat-4k-ok");
  assert.equal(chat4k.text.length, 4096);
  assert.equal(chat4k.sender, "controller");

  // >4096-byte ASCII and multi-byte UTF-8 messages rejected with INVALID_MESSAGE
  for (const oversizedText of ["a".repeat(4097), "中".repeat(1366)]) {
    ctrl.sendJson({
      type: "chat.msg",
      sessionId: "sess-wire-01",
      deviceId: "desk-wire-01",
      id: "chat-too-big",
      sender: "controller",
      text: oversizedText,
      ts: 1700000004000,
    });
    const tooBigErr = await ctrl.nextJson<ErrorMessage>();
    assert.equal(tooBigErr.code, "INVALID_MESSAGE");
  }

  // Intruder cannot inject chat.msg into another user's session
  intruder.sendJson({
    type: "chat.msg",
    sessionId: "sess-wire-01",
    deviceId: "desk-wire-01",
    id: "chat-intruder",
    sender: "controller",
    text: "spoofed",
    ts: 1700000005000,
  });
  const intruderErr = await intruder.nextJson<ErrorMessage>();
  assert.equal(intruderErr.code, "UNAUTHORIZED");

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(agent.drainJson().length, 0);
  assert.equal(ctrl.drainJson().length, 0);
});

test("[P0-1 & P1-3 & P1-4] Pre-approval gating blocks controller session traffic, deduplicates session.pending, rejects duplicate session.request and post-ready session.pending, and preserves Android v1.0.9 compatibility", async (t) => {
  const { server, baseUrl, wsUrl } = await startServer({
    registrationInviteCode: "HARDEN-P01-INVITE",
  });
  t.after(() => server.close());

  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "harden_p01",
      password: "harden-p01-password",
      inviteCode: "HARDEN-P01-INVITE",
    }),
  });
  assert.equal(regRes.status, 201);
  const { token } = (await regRes.json()) as { token: string };

  const desktopAgent = await TestWsClient.connect(wsUrl);
  const androidAgent = await TestWsClient.connect(wsUrl);
  const ctrl = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([desktopAgent.close(), androidAgent.close(), ctrl.close()]);
  });

  desktopAgent.sendJson(
    makeAgentRegister({
      deviceId: "desk-approval-01",
      deviceSecret: "desk-approval-secret-01",
      authToken: token,
      deviceType: "desktop",
      osPlatform: "darwin",
      accessMode: "confirm",
    }),
  );
  await desktopAgent.nextJson<AgentRegisteredMessage>();

  androidAgent.sendJson(
    makeAgentRegister({
      deviceId: "android-legacy-01",
      deviceSecret: "android-legacy-secret-01",
      authToken: token,
    }),
  );
  await androidAgent.nextJson<AgentRegisteredMessage>();

  ctrl.sendJson({
    type: "controller.auth",
    authToken: token,
    clientId: "ctrl-approval-01",
  });
  await ctrl.nextJson<ControllerAuthedMessage>();

  // 1. Desktop session enters approvalPending via session.pending
  ctrl.sendJson({
    type: "session.request",
    sessionId: "sess-approve-01",
    deviceId: "desk-approval-01",
    preferredTransport: "webrtc",
    quality: DESKTOP_QUALITY_PRESETS.balanced,
  } satisfies SessionRequestMessage);
  await desktopAgent.nextJson<SessionRequestMessage>();

  desktopAgent.sendJson({
    type: "session.pending",
    sessionId: "sess-approve-01",
    deviceId: "desk-approval-01",
    message: "Awaiting local host confirmation",
  } satisfies SessionPendingMessage);
  const pending1 = await ctrl.nextJson<SessionPendingMessage>();
  assert.equal(pending1.type, "session.pending");
  assert.equal(pending1.sessionId, "sess-approve-01");

  // 2. Repeated session.pending while already pending is ignored/deduplicated (no controller spam)
  desktopAgent.sendJson({
    type: "session.pending",
    sessionId: "sess-approve-01",
    deviceId: "desk-approval-01",
    message: "Awaiting local host confirmation",
  } satisfies SessionPendingMessage);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ctrl.drainJson().length, 0);

  // 3. Duplicate session.request for the same sessionId MUST be rejected with INVALID_MESSAGE
  //    and MUST NOT reset approvalPending!
  ctrl.sendJson({
    type: "session.request",
    sessionId: "sess-approve-01",
    deviceId: "desk-approval-01",
    preferredTransport: "webrtc",
    quality: DESKTOP_QUALITY_PRESETS.balanced,
  } satisfies SessionRequestMessage);
  const dupReqErr = await ctrl.nextJson<ErrorMessage>();
  assert.equal(dupReqErr.type, "error");
  assert.equal(dupReqErr.code, "INVALID_MESSAGE");
  assert.equal(dupReqErr.message, "Session ID already active");

  // 4. While approvalPending && !ready, controller control.cmd, clipboard.sync, rtc.*, and chat.msg are ALL blocked
  const blockedMessages: WireMessage[] = [
    {
      type: "control.cmd",
      sessionId: "sess-approve-01",
      deviceId: "desk-approval-01",
      seq: 1,
      command: { action: "mouse_move", x: 0.5, y: 0.5 },
    },
    {
      type: "clipboard.sync",
      sessionId: "sess-approve-01",
      deviceId: "desk-approval-01",
      text: "injected before approval",
    },
    {
      type: "rtc.offer",
      sessionId: "sess-approve-01",
      deviceId: "desk-approval-01",
      sdp: "v=0...",
    },
    {
      type: "rtc.answer",
      sessionId: "sess-approve-01",
      deviceId: "desk-approval-01",
      sdp: "v=0...",
    },
    {
      type: "rtc.ice",
      sessionId: "sess-approve-01",
      deviceId: "desk-approval-01",
      candidate: { candidate: "candidate:1 1 udp 1 127.0.0.1 1234 typ host" },
    },
    {
      type: "chat.msg",
      sessionId: "sess-approve-01",
      deviceId: "desk-approval-01",
      id: "chat-pre-approve",
      sender: "controller",
      text: "hello before approval",
      ts: Date.now(),
    },
  ];

  for (const msg of blockedMessages) {
    ctrl.sendJson(msg);
    const err = await ctrl.nextJson<ErrorMessage>();
    assert.equal(err.type, "error");
    assert.equal(err.code, "UNAUTHORIZED");
    assert.equal(err.message, "Session is awaiting host approval");
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(desktopAgent.drainJson().length, 0);

  // 5. Once agent sends session.ready, approvalPending clears and controller traffic flows normally
  desktopAgent.sendJson({
    type: "session.ready",
    sessionId: "sess-approve-01",
    deviceId: "desk-approval-01",
    transport: "webrtc",
    screenWidth: 1920,
    screenHeight: 1080,
    rotation: 0,
  } satisfies SessionReadyMessage);
  await ctrl.nextJson<SessionReadyMessage>();

  // session.pending AFTER session.ready MUST be rejected with INVALID_MESSAGE
  desktopAgent.sendJson({
    type: "session.pending",
    sessionId: "sess-approve-01",
    deviceId: "desk-approval-01",
    message: "Too late",
  } satisfies SessionPendingMessage);
  const latePendingErr = await desktopAgent.nextJson<ErrorMessage>();
  assert.equal(latePendingErr.type, "error");
  assert.equal(latePendingErr.code, "INVALID_MESSAGE");

  // Controller control.cmd and chat.msg now succeed
  ctrl.sendJson({
    type: "control.cmd",
    sessionId: "sess-approve-01",
    deviceId: "desk-approval-01",
    seq: 2,
    command: { action: "mouse_move", x: 0.25, y: 0.75 },
  } satisfies ControlCmdMessage);
  const okMove = await desktopAgent.nextJson<ControlCmdMessage>();
  assert.equal(okMove.command.action, "mouse_move");

  // 6. Legacy Android v1.0.9 compatibility: without session.pending, controller can send rtc.offer before session.ready
  ctrl.sendJson({
    type: "session.request",
    sessionId: "sess-android-01",
    deviceId: "android-legacy-01",
    preferredTransport: "webrtc",
    quality: QUALITY_PRESETS.balanced,
  } satisfies SessionRequestMessage);
  await androidAgent.nextJson<SessionRequestMessage>();

  ctrl.sendJson({
    type: "rtc.offer",
    sessionId: "sess-android-01",
    deviceId: "android-legacy-01",
    sdp: "v=0-legacy-android",
  } satisfies RtcOfferMessage);
  const forwardedOffer = await androidAgent.nextJson<RtcOfferMessage>();
  assert.equal(forwardedOffer.type, "rtc.offer");
  assert.equal(forwardedOffer.sdp, "v=0-legacy-android");
});

test("[P0-1 & P2-2] Server-side session.permissions enforcement blocks disallowed mouse/keyboard/clipboard/audio/privileged commands and audits in-session WOL target", async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "velodeck-perms-test-"));
  const { server, baseUrl, wsUrl } = await startServer({
    dataDir,
    registrationInviteCode: "HARDEN-PERMS-INVITE",
  });
  t.after(async () => {
    await server.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "harden_perms",
      password: "harden-perms-password",
      inviteCode: "HARDEN-PERMS-INVITE",
    }),
  });
  assert.equal(regRes.status, 201);
  const { token } = (await regRes.json()) as { token: string };

  const agent = await TestWsClient.connect(wsUrl);
  const ctrl = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([agent.close(), ctrl.close()]);
  });

  agent.sendJson(
    makeAgentRegister({
      deviceId: "desk-perms-01",
      deviceSecret: "desk-perms-secret-01",
      authToken: token,
      deviceType: "desktop",
      osPlatform: "win32",
    }),
  );
  await agent.nextJson<AgentRegisteredMessage>();

  ctrl.sendJson({
    type: "controller.auth",
    authToken: token,
    clientId: "ctrl-perms-01",
  });
  await ctrl.nextJson<ControllerAuthedMessage>();

  ctrl.sendJson({
    type: "session.request",
    sessionId: "sess-perms-01",
    deviceId: "desk-perms-01",
    preferredTransport: "webrtc",
    quality: DESKTOP_QUALITY_PRESETS.balanced,
  } satisfies SessionRequestMessage);
  await agent.nextJson<SessionRequestMessage>();

  // 1. Disable mouse only -> blocks all mouse/touch actions AND power/block_input/privacy_screen/wol
  agent.sendJson({
    type: "session.permissions",
    sessionId: "sess-perms-01",
    deviceId: "desk-perms-01",
    permissions: {
      mouse: false,
      keyboard: true,
      clipboard: true,
      audio: true,
    },
  } satisfies SessionPermissionsMessage);
  await ctrl.nextJson<SessionPermissionsMessage>();

  agent.sendJson({
    type: "session.ready",
    sessionId: "sess-perms-01",
    deviceId: "desk-perms-01",
    transport: "webrtc",
    screenWidth: 1920,
    screenHeight: 1080,
    rotation: 0,
  } satisfies SessionReadyMessage);
  await ctrl.nextJson<SessionReadyMessage>();

  const mouseDeniedCmds: ControlCmdMessage["command"][] = [
    { action: "mouse_move", x: 0.5, y: 0.5 },
    { action: "mouse_move_relative", dx: 4, dy: -2 },
    { action: "mouse_down", button: "left" },
    { action: "mouse_up", button: "left" },
    { action: "mouse_wheel", deltaX: 0, deltaY: -120 },
    { action: "tap", x: 0.5, y: 0.5 },
    { action: "long_press", x: 0.5, y: 0.5 },
    { action: "swipe", x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 },
    { action: "touch_down", pointerId: 1, x: 0.2, y: 0.2 },
    { action: "touch_move", pointerId: 1, x: 0.3, y: 0.3 },
    { action: "touch_up", pointerId: 1, x: 0.3, y: 0.3 },
    { action: "pinch", cx: 0.5, cy: 0.5, startDist: 0.1, endDist: 0.2 },
    { action: "power", operation: "lock" },
    { action: "block_input", enabled: true },
    { action: "privacy_screen", enabled: true },
    { action: "wol", macAddress: "AA:BB:CC:DD:EE:11", broadcastIp: "192.168.1.255" },
  ];

  for (const command of mouseDeniedCmds) {
    ctrl.sendJson({
      type: "control.cmd",
      sessionId: "sess-perms-01",
      deviceId: "desk-perms-01",
      command,
    } satisfies ControlCmdMessage);
    const err = await ctrl.nextJson<ErrorMessage>();
    assert.equal(err.type, "error");
    assert.equal(err.code, "UNAUTHORIZED");
  }

  // Keyboard still works while mouse is disabled
  ctrl.sendJson({
    type: "control.cmd",
    sessionId: "sess-perms-01",
    deviceId: "desk-perms-01",
    command: { action: "key_event", phase: "press", code: "KeyA", key: "a" },
  } satisfies ControlCmdMessage);
  const okKey = await agent.nextJson<ControlCmdMessage>();
  assert.equal(okKey.command.action, "key_event");

  // 2. Disable keyboard, clipboard, audio (re-enable mouse)
  agent.sendJson({
    type: "session.permissions",
    sessionId: "sess-perms-01",
    deviceId: "desk-perms-01",
    permissions: {
      mouse: true,
      keyboard: false,
      clipboard: false,
      audio: false,
    },
  } satisfies SessionPermissionsMessage);
  await ctrl.nextJson<SessionPermissionsMessage>();

  const kbClipAudioDenied: ControlCmdMessage["command"][] = [
    { action: "key_event", phase: "down", code: "KeyB", key: "b" },
    { action: "key", key: "enter" },
    { action: "text", text: "blocked" },
    { action: "clipboard_set", text: "blocked clip" },
    { action: "audio_toggle", enabled: true },
    { action: "power", operation: "sleep" },
    { action: "block_input", enabled: true },
    { action: "privacy_screen", enabled: true },
    { action: "wol", macAddress: "AA:BB:CC:DD:EE:11" },
  ];

  for (const command of kbClipAudioDenied) {
    ctrl.sendJson({
      type: "control.cmd",
      sessionId: "sess-perms-01",
      deviceId: "desk-perms-01",
      command,
    } satisfies ControlCmdMessage);
    const err = await ctrl.nextJson<ErrorMessage>();
    assert.equal(err.code, "UNAUTHORIZED");
  }

  // Controller->agent clipboard.sync blocked when clipboard === false
  ctrl.sendJson({
    type: "clipboard.sync",
    sessionId: "sess-perms-01",
    deviceId: "desk-perms-01",
    text: "blocked sync",
  } satisfies ClipboardSyncMessage);
  const clipSyncErr = await ctrl.nextJson<ErrorMessage>();
  assert.equal(clipSyncErr.code, "UNAUTHORIZED");

  // audio_toggle with enabled: false is still allowed (muting)
  ctrl.sendJson({
    type: "control.cmd",
    sessionId: "sess-perms-01",
    deviceId: "desk-perms-01",
    command: { action: "audio_toggle", enabled: false },
  } satisfies ControlCmdMessage);
  const okAudioOff = await agent.nextJson<ControlCmdMessage>();
  assert.deepEqual(okAudioOff.command, { action: "audio_toggle", enabled: false });

  // Agent->controller clipboard.sync is still permitted even when controller clipboard === false
  agent.sendJson({
    type: "clipboard.sync",
    sessionId: "sess-perms-01",
    deviceId: "desk-perms-01",
    text: "from host",
  } satisfies ClipboardSyncMessage);
  const hostClip = await ctrl.nextJson<ClipboardSyncMessage>();
  assert.equal(hostClip.text, "from host");

  // 3. Re-enable all permissions -> in-session WOL succeeds and logs MAC@broadcastIp + MAC in audit
  agent.sendJson({
    type: "session.permissions",
    sessionId: "sess-perms-01",
    deviceId: "desk-perms-01",
    permissions: {
      mouse: true,
      keyboard: true,
      clipboard: true,
      audio: true,
    },
  } satisfies SessionPermissionsMessage);
  await ctrl.nextJson<SessionPermissionsMessage>();

  ctrl.sendJson({
    type: "control.cmd",
    sessionId: "sess-perms-01",
    deviceId: "desk-perms-01",
    command: {
      action: "wol",
      macAddress: "12-34-56-78-9a-bc",
      broadcastIp: "10.0.0.255",
      extraInjected: "drop-me",
    } as unknown as ControlCmdMessage["command"],
  });
  const wol1 = await agent.nextJson<ControlCmdMessage>();
  assert.deepEqual(wol1.command, {
    action: "wol",
    macAddress: "12:34:56:78:9A:BC",
    broadcastIp: "10.0.0.255",
  });

  ctrl.sendJson({
    type: "control.cmd",
    sessionId: "sess-perms-01",
    deviceId: "desk-perms-01",
    command: {
      action: "wol",
      macAddress: "12:34:56:78:9a:bd",
    },
  } satisfies ControlCmdMessage);
  const wol2 = await agent.nextJson<ControlCmdMessage>();
  assert.deepEqual(wol2.command, {
    action: "wol",
    macAddress: "12:34:56:78:9A:BD",
  });

  await server.hub.audit.flush();
  const auditEntries = (await fsp.readFile(path.join(dataDir, "audit.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event: string; detail?: string; sessionId?: string });
  const wolAudit = auditEntries.filter((e) => e.event === "control.wol");
  assert.deepEqual(
    wolAudit.map((e) => e.detail),
    ["12:34:56:78:9A:BC@10.0.0.255", "12:34:56:78:9A:BD"],
  );
  assert.ok(wolAudit.every((e) => e.sessionId === "sess-perms-01"));
});

test("[P0-2 & P0-3] Rejects octal/leading-zero IPv4, CGNAT WOL broadcastIp, zero/broadcast MAC, and enforces WOL + sessionless rate limits without seq", async (t) => {
  const { server, baseUrl, wsUrl } = await startServer({
    registrationInviteCode: "HARDEN-RATE-INVITE",
  });
  t.after(() => server.close());

  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "harden_rate",
      password: "harden-rate-password",
      inviteCode: "HARDEN-RATE-INVITE",
    }),
  });
  assert.equal(regRes.status, 201);
  const { token } = (await regRes.json()) as { token: string };

  const agent = await TestWsClient.connect(wsUrl);
  const ctrl1 = await TestWsClient.connect(wsUrl);
  const ctrl2 = await TestWsClient.connect(wsUrl);
  const ctrl3 = await TestWsClient.connect(wsUrl);
  const ctrlWake = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([agent.close(), ctrl1.close(), ctrl2.close(), ctrl3.close(), ctrlWake.close()]);
  });

  // Octal/leading-zero lanIp and zero/broadcast MACs sanitized out on register
  agent.sendJson(
    makeAgentRegister({
      deviceId: "desk-octal-01",
      deviceSecret: "desk-octal-secret-01",
      authToken: token,
      lanIp: "010.8.8.8",
      macAddresses: ["00:00:00:00:00:00", "FF:FF:FF:FF:FF:FF", "ff-ff-ff-ff-ff-ff"],
    }),
  );
  await agent.nextJson<AgentRegisteredMessage>();

  for (const [client, id] of [
    [ctrl1, "ctrl-wol-1"],
    [ctrl2, "ctrl-wol-2"],
    [ctrl3, "ctrl-wol-3"],
    [ctrlWake, "ctrl-wake-1"],
  ] as const) {
    client.sendJson({ type: "controller.auth", authToken: token, clientId: id });
  }
  const authed1 = await ctrl1.nextJson<ControllerAuthedMessage>();
  await Promise.all([
    ctrl2.nextJson<ControllerAuthedMessage>(),
    ctrl3.nextJson<ControllerAuthedMessage>(),
    ctrlWake.nextJson<ControllerAuthedMessage>(),
  ]);

  const dev = authed1.devices.find((d) => d.deviceId === "desk-octal-01");
  assert.ok(dev);
  assert.equal(Object.hasOwn(dev, "lanIp"), false);
  assert.equal(Object.hasOwn(dev, "macAddresses"), false);

  // Octal lanIp in telemetry also rejected
  agent.sendJson({
    type: "agent.telemetry",
    deviceId: "desk-octal-01",
    lanIp: "172.016.0.1",
  });
  const telStatus = await ctrl1.nextJson<DeviceStatusMessage>();
  assert.equal(Object.hasOwn(telStatus.device, "lanIp"), false);
  await Promise.all([
    ctrl2.nextJson<DeviceStatusMessage>(),
    ctrl3.nextJson<DeviceStatusMessage>(),
    ctrlWake.nextJson<DeviceStatusMessage>(),
  ]);

  // Reject octal/leading-zero broadcastIp, CGNAT broadcastIp, and zero/broadcast MACs in WOL
  const rejectedWolCmds = [
    { action: "wol", macAddress: "AA:BB:CC:DD:EE:01", broadcastIp: "010.8.8.8" },
    { action: "wol", macAddress: "AA:BB:CC:DD:EE:01", broadcastIp: "172.016.0.1" },
    { action: "wol", macAddress: "AA:BB:CC:DD:EE:01", broadcastIp: "192.168.01.255" },
    { action: "wol", macAddress: "AA:BB:CC:DD:EE:01", broadcastIp: "100.64.1.255" },
    { action: "wol", macAddress: "00:00:00:00:00:00", broadcastIp: "192.168.1.255" },
    { action: "wol", macAddress: "FF:FF:FF:FF:FF:FF", broadcastIp: "192.168.1.255" },
    { action: "wol", macAddress: "ff-ff-ff-ff-ff-ff" },
  ] as const;

  for (const command of rejectedWolCmds) {
    ctrl1.sendJson({
      type: "control.cmd",
      sessionId: "",
      deviceId: "desk-octal-01",
      command,
    });
    const err = await ctrl1.nextJson<ErrorMessage>();
    assert.equal(err.code, "INVALID_MESSAGE");
  }

  // Per-controller WOL rate limit: 10 allowed WITHOUT seq, 11th returns RATE_LIMITED
  for (let i = 0; i < 10; i += 1) {
    ctrl1.sendJson({
      type: "control.cmd",
      sessionId: "",
      deviceId: "desk-octal-01",
      command: { action: "wol", macAddress: "AA:BB:CC:DD:EE:01", broadcastIp: "192.168.1.255" },
    });
    const fwd = await agent.nextJson<ControlCmdMessage>();
    assert.equal(fwd.command.action, "wol");
  }
  ctrl1.sendJson({
    type: "control.cmd",
    sessionId: "",
    deviceId: "desk-octal-01",
    command: { action: "wol", macAddress: "AA:BB:CC:DD:EE:01", broadcastIp: "192.168.1.255" },
  });
  const wolCtrlRateErr = await ctrl1.nextJson<ErrorMessage>();
  assert.equal(wolCtrlRateErr.code, "RATE_LIMITED");

  // Second controller from same IP can send 10 more (total 20 per IP), then 3rd controller hits IP limit (20/60s)
  for (let i = 0; i < 10; i += 1) {
    ctrl2.sendJson({
      type: "control.cmd",
      sessionId: "",
      deviceId: "desk-octal-01",
      command: { action: "wol", macAddress: "AA:BB:CC:DD:EE:02", broadcastIp: "10.0.0.255" },
    });
    await agent.nextJson<ControlCmdMessage>();
  }
  ctrl3.sendJson({
    type: "control.cmd",
    sessionId: "",
    deviceId: "desk-octal-01",
    command: { action: "wol", macAddress: "AA:BB:CC:DD:EE:03" },
  });
  const wolIpRateErr = await ctrl3.nextJson<ErrorMessage>();
  assert.equal(wolIpRateErr.code, "RATE_LIMITED");

  // Sessionless control command rate limit (without seq): 20 allowed, 21st rejected with RATE_LIMITED
  for (let i = 0; i < 20; i += 1) {
    ctrlWake.sendJson({
      type: "control.cmd",
      sessionId: "",
      deviceId: "desk-octal-01",
      command: { action: "wake" },
    });
    const fwd = await agent.nextJson<ControlCmdMessage>();
    assert.equal(fwd.command.action, "wake");
    assert.equal(fwd.sessionId, "");
  }
  ctrlWake.sendJson({
    type: "control.cmd",
    sessionId: "",
    deviceId: "desk-octal-01",
    command: { action: "wake" },
  });
  const wakeRateErr = await ctrlWake.nextJson<ErrorMessage>();
  assert.equal(wakeRateErr.code, "RATE_LIMITED");
});

test("[P1-5 & P3-2 & P2-3..P3-1] Hardened whiteboard, coordinate-less mouse commands, mouse_move_relative bounds, chat sanitization, non-string sessionId, and OOB ACK routing/unbind cleanup", async (t) => {
  const { server, baseUrl, wsUrl } = await startServer({
    registrationInviteCode: "HARDEN-INPUT-INVITE",
  });
  t.after(() => server.close());

  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "harden_input",
      password: "harden-input-password",
      inviteCode: "HARDEN-INPUT-INVITE",
    }),
  });
  assert.equal(regRes.status, 201);
  const { token, user } = (await regRes.json()) as { token: string; user: UserProfile };

  const agent = await TestWsClient.connect(wsUrl);
  const ctrl1 = await TestWsClient.connect(wsUrl);
  const ctrl2 = await TestWsClient.connect(wsUrl);
  t.after(async () => {
    await Promise.all([agent.close(), ctrl1.close(), ctrl2.close()]);
  });

  agent.sendJson(
    makeAgentRegister({
      deviceId: "desk-input-01",
      deviceSecret: "desk-input-secret-01",
      authToken: token,
      deviceType: "desktop",
      osPlatform: "linux",
      blockInputActive: true,
    }),
  );
  await agent.nextJson<AgentRegisteredMessage>();

  ctrl1.sendJson({ type: "controller.auth", authToken: token, clientId: "ctrl-in-1" });
  ctrl2.sendJson({ type: "controller.auth", authToken: token, clientId: "ctrl-in-2" });
  await Promise.all([
    ctrl1.nextJson<ControllerAuthedMessage>(),
    ctrl2.nextJson<ControllerAuthedMessage>(),
  ]);

  // 1. Non-string sessionId rejected cleanly (and sendError omits non-string sessionId/deviceId)
  ctrl1.sendJson({
    type: "control.cmd",
    sessionId: { bad: true },
    deviceId: 12345,
    command: { action: "wake" },
  });
  const nonStrErr = await ctrl1.nextJson<ErrorMessage>();
  assert.equal(nonStrErr.code, "INVALID_MESSAGE");
  assert.equal(Object.hasOwn(nonStrErr, "sessionId"), false);
  assert.equal(Object.hasOwn(nonStrErr, "deviceId"), false);

  // Whitespace-only sessionId on sessionless command is normalized to ""
  ctrl1.sendJson({
    type: "control.cmd",
    sessionId: "   ",
    deviceId: "desk-input-01",
    command: { action: "wake" },
  });
  const normWake = await agent.nextJson<ControlCmdMessage>();
  assert.equal(normWake.sessionId, "");

  // 2. Duplicate in-flight (conn, deviceId, seq) from ctrl1 does NOT misroute ctrl1's 2nd ACK to ctrl2
  ctrl1.sendJson({
    type: "control.cmd",
    sessionId: "",
    deviceId: "desk-input-01",
    seq: 7,
    command: { action: "wake" },
  });
  ctrl1.sendJson({
    type: "control.cmd",
    sessionId: "",
    deviceId: "desk-input-01",
    seq: 7,
    command: { action: "wake" },
  });
  ctrl2.sendJson({
    type: "control.cmd",
    sessionId: "",
    deviceId: "desk-input-01",
    seq: 7,
    command: { action: "wake" },
  });
  await agent.nextJson<ControlCmdMessage>();
  await agent.nextJson<ControlCmdMessage>();
  await agent.nextJson<ControlCmdMessage>();

  agent.sendJson({ type: "control.ack", sessionId: "", deviceId: "desk-input-01", seq: 7, ok: true, message: "ack-c1-1" });
  agent.sendJson({ type: "control.ack", sessionId: "", deviceId: "desk-input-01", seq: 7, ok: true, message: "ack-c1-2" });
  agent.sendJson({ type: "control.ack", sessionId: "", deviceId: "desk-input-01", seq: 7, ok: true, message: "ack-c2-1" });

  const ackC1First = await ctrl1.nextJson<ControlAckMessage>();
  const ackC1Second = await ctrl1.nextJson<ControlAckMessage>();
  const ackC2First = await ctrl2.nextJson<ControlAckMessage>();
  assert.equal(ackC1First.message, "ack-c1-1");
  assert.equal(ackC1Second.message, "ack-c1-2");
  assert.equal(ackC2First.message, "ack-c2-1");

  // 3. Open session to test whiteboard, coordinate-less mouse_down/up/wheel, mouse_move_relative, and chat.msg
  ctrl1.sendJson({
    type: "session.request",
    sessionId: "sess-input-01",
    deviceId: "desk-input-01",
    preferredTransport: "webrtc",
    quality: DESKTOP_QUALITY_PRESETS.balanced,
  } satisfies SessionRequestMessage);
  await agent.nextJson<SessionRequestMessage>();
  agent.sendJson({
    type: "session.ready",
    sessionId: "sess-input-01",
    deviceId: "desk-input-01",
    transport: "webrtc",
    screenWidth: 1920,
    screenHeight: 1080,
    rotation: 0,
  } satisfies SessionReadyMessage);
  await ctrl1.nextJson<SessionReadyMessage>();

  // Coordinate-less mouse_down / mouse_up / mouse_wheel (Pointer Lock) succeed & forward cleanly
  const pointerLockCmds: ControlCmdMessage["command"][] = [
    { action: "mouse_down", button: "left", clickCount: 1 },
    { action: "mouse_up", button: "left" },
    { action: "mouse_wheel", deltaX: 0, deltaY: -120 },
    { action: "mouse_move_relative", dx: 32768, dy: -32768 },
  ];
  for (const command of pointerLockCmds) {
    ctrl1.sendJson({
      type: "control.cmd",
      sessionId: "sess-input-01",
      deviceId: "desk-input-01",
      command,
    } satisfies ControlCmdMessage);
    const fwd = await agent.nextJson<ControlCmdMessage>();
    assert.deepEqual(fwd.command, command);
  }

  // Valid whiteboard with rgb/rgba and extra injected fields -> extra fields stripped!
  ctrl1.sendJson({
    type: "control.cmd",
    sessionId: "sess-input-01",
    deviceId: "desk-input-01",
    command: {
      action: "whiteboard",
      op: "stroke",
      evilTop: true,
      stroke: {
        id: "stroke_ok-1",
        color: "rgba(255, 59, 48, 0.75)",
        width: 5,
        evilStroke: "xss",
        points: [
          { x: 0.1, y: 0.2, evilPt: 1 },
          { x: 1.0, y: 1.5 },
        ],
      },
    } as unknown as ControlCmdMessage["command"],
  });
  const wbFwd = await agent.nextJson<ControlCmdMessage>();
  assert.deepEqual(wbFwd.command, {
    action: "whiteboard",
    op: "stroke",
    stroke: {
      id: "stroke_ok-1",
      color: "rgba(255, 59, 48, 0.75)",
      width: 5,
      points: [
        { x: 0.1, y: 0.2 },
        { x: 1.0, y: 1.5 },
      ],
    },
  });

  // Invalid whiteboard (CSS color injection, bad stroke id, out-of-range coords), mismatched x/y, and oversized relative mouse
  const invalidHardenedCmds: unknown[] = [
    {
      action: "whiteboard",
      op: "stroke",
      stroke: { id: "s1", color: "red; background:url(evil)", width: 4, points: [{ x: 0.5, y: 0.5 }] },
    },
    {
      action: "whiteboard",
      op: "stroke",
      stroke: { id: "s2", color: "rgb(300, 0, 0)", width: 4, points: [{ x: 0.5, y: 0.5 }] },
    },
    {
      action: "whiteboard",
      op: "stroke",
      stroke: { id: "s3", color: "rgba(1, 2, 3, 1.5)", width: 4, points: [{ x: 0.5, y: 0.5 }] },
    },
    {
      action: "whiteboard",
      op: "stroke",
      stroke: { id: "s4", color: "#12345", width: 4, points: [{ x: 0.5, y: 0.5 }] },
    },
    {
      action: "whiteboard",
      op: "stroke",
      stroke: { id: "bad id!", color: "#fff", width: 4, points: [{ x: 0.5, y: 0.5 }] },
    },
    {
      action: "whiteboard",
      op: "stroke",
      stroke: { id: "s5", color: "#fff", width: 4, points: [{ x: 5, y: 0.5 }] },
    },
    { action: "mouse_down", x: 0.5, button: "left" },
    { action: "mouse_up", y: 0.5, button: "left" },
    { action: "mouse_wheel", x: 0.5, deltaX: 0, deltaY: 10 },
    { action: "mouse_move_relative", dx: 32769, dy: 0 },
    { action: "mouse_move_relative", dx: 0, dy: -40000 },
  ];
  for (const badCmd of invalidHardenedCmds) {
    ctrl1.sendJson({
      type: "control.cmd",
      sessionId: "sess-input-01",
      deviceId: "desk-input-01",
      command: badCmd,
    });
    const err = await ctrl1.nextJson<ErrorMessage>();
    assert.equal(err.code, "INVALID_MESSAGE");
  }

  // 4. chat.msg timestamp clamping and C0 control char stripping (keeping \t, \n, \r)
  const beforeChat = Date.now();
  ctrl1.sendJson({
    type: "chat.msg",
    sessionId: "sess-input-01",
    deviceId: "desk-input-01",
    id: "chat-clean-1",
    sender: "controller",
    text: "Line1\n\tLine2\r\n\x00\x07\x1b[31mSafe\x7f",
    ts: 42, // out-of-range past epoch -> replaced with Date.now()
  } satisfies ChatMessage);
  const cleanChat1 = await agent.nextJson<ChatMessage>();
  assert.equal(cleanChat1.text, "Line1\n\tLine2\r\n[31mSafe");
  assert.ok(cleanChat1.ts >= beforeChat && cleanChat1.ts <= Date.now() + 1000);

  ctrl1.sendJson({
    type: "chat.msg",
    sessionId: "sess-input-01",
    deviceId: "desk-input-01",
    id: "chat-clean-2",
    sender: "controller",
    text: "Future ts test",
    ts: Date.now() + 365 * 86_400_000, // far future -> replaced with Date.now()
  } satisfies ChatMessage);
  const cleanChat2 = await agent.nextJson<ChatMessage>();
  assert.ok(cleanChat2.ts >= beforeChat && cleanChat2.ts <= Date.now() + 1000);

  // Text containing only stripped control chars is rejected
  ctrl1.sendJson({
    type: "chat.msg",
    sessionId: "sess-input-01",
    deviceId: "desk-input-01",
    id: "chat-only-ctrl",
    sender: "controller",
    text: "\x00\x01\x07\x1b\x7f",
    ts: Date.now(),
  } satisfies ChatMessage);
  const ctrlCharErr = await ctrl1.nextJson<ErrorMessage>();
  assert.equal(ctrlCharErr.code, "INVALID_MESSAGE");

  // 5. unbindDevice cleans outOfBandCmds so former owner never receives late ACK
  ctrl1.sendJson({
    type: "control.cmd",
    sessionId: "",
    deviceId: "desk-input-01",
    seq: 88,
    command: { action: "wake" },
  });
  await agent.nextJson<ControlCmdMessage>();

  assert.equal(server.hub.unbindDevice(user.userId, "desk-input-01"), true);
  // Drain session.end and offline device.status sent to ctrl1 during unbind
  await ctrl1.nextJson<SessionEndMessage>();
  const unboundStatus = await ctrl1.nextJson<DeviceStatusMessage>();
  assert.equal(unboundStatus.device.online, false);
  assert.equal(unboundStatus.device.blockInputActive, false);

  agent.sendJson({
    type: "control.ack",
    sessionId: "",
    deviceId: "desk-input-01",
    seq: 88,
    ok: true,
    message: "late-after-unbind",
  } satisfies ControlAckMessage);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ctrl1.drainJson().length, 0);
});
