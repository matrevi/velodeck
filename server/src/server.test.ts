import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, type RawData } from "ws";
import {
  FRAME_TYPE_JPEG,
  QUALITY_PRESETS,
  decodeMediaFrame,
  encodeMediaFrame,
  formatControlCode,
  type AgentRegisterMessage,
  type AgentRegisteredMessage,
  type ControlAckMessage,
  type ControlCmdMessage,
  type ControllerAuthedMessage,
  type DeviceStatusMessage,
  type ErrorMessage,
  type PongMessage,
  type RtcAnswerMessage,
  type RtcIceMessage,
  type RtcOfferMessage,
  type SessionEndMessage,
  type SessionReadyMessage,
  type SessionRequestMessage,
  type UserProfile,
  type WireMessage,
} from "@velodeck/protocol";
import { AsyncSemaphore, verifyPassword } from "./auth.js";
import { DEFAULT_STUN_URLS, loadConfig, type ServerConfig } from "./config.js";
import { createVeloDeckServer, type VeloDeckServer } from "./httpServer.js";
import { VeloDeckStore } from "./store.js";
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

test("GET /api/info (APK SHA-256 + registration status) and GET /api/download/velodeck-agent.apk & /api/download/android streaming & optional auth", async (t) => {
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
    version: "1.0.7",
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
    version: "1.0.7",
    hasAndroidApk: true,
    apkSha256: expectedSha256,
    registrationMode: "first-user-then-invite",
    registrationOpen: true,
    requiresInviteCode: false,
  });

  // Primary route + /api/download/android both serve velodeck-agent.apk and expose X-APK-SHA256 over CORS
  for (const dlRoute of [
    "/api/download/velodeck-agent.apk",
    "/api/download/android",
  ]) {
    const dlRes = await fetch(`${baseUrl}${dlRoute}`, {
      headers: { Origin: baseUrl },
    });
    assert.equal(dlRes.status, 200);
    assert.equal(dlRes.headers.get("content-type"), "application/vnd.android.package-archive");
    assert.equal(
      dlRes.headers.get("content-disposition"),
      'attachment; filename="velodeck-agent.apk"',
    );
    assert.equal(dlRes.headers.get("content-length"), String(fakeApkBytes.byteLength));
    assert.equal(dlRes.headers.get("x-apk-sha256"), expectedSha256);
    assert.equal(
      dlRes.headers.get("access-control-expose-headers"),
      "X-APK-SHA256, Content-Length, Content-Range, ETag",
    );
    const receivedBytes = Buffer.from(await dlRes.arrayBuffer());
    assert.deepEqual(receivedBytes, fakeApkBytes);
  }

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

  // If-None-Match -> 304 Not Modified
  const notModRes = await fetch(`${baseUrl}/api/download/velodeck-agent.apk`, {
    headers: { "If-None-Match": expectedEtag },
  });
  assert.equal(notModRes.status, 304);
  assert.equal(notModRes.headers.get("etag"), expectedEtag);
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
