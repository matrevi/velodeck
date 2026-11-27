import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_SESSION_STORAGE_KEY,
  DEFAULT_CLOUD_API_BASE,
  DEFAULT_CLOUD_WS_URL,
  IOS_PWA_BANNER_DISMISSED_KEY,
  MAX_RECENT_CODES,
  MIN_PASSWORD_LENGTH,
  RECENT_CODES_STORAGE_KEY,
  SESSION_PASSWORDS_STORAGE_KEY,
  changePasswordApi,
  clearAccountSession,
  deleteRecentCodeEntry,
  detectDefaultApiBase,
  detectDefaultRelayWsUrl,
  detectDefaultTransport,
  fetchServerInfo,
  formatControlCode,
  formatControlCodeInput,
  getAndroidApkDownloadUrl,
  getAndroidApkFileName,
  isValidControlCode,
  loadAccountSession,
  loadRecentCodes,
  loginAccount,
  logoutAllSessionsApi,
  normalizeControlCode,
  registerAccount,
  removeRecentCode,
  sanitizeControlCodeInput,
  saveAccountSession,
  saveRecentCodeEntry,
  saveRecentControlCode,
  unbindDeviceApi,
  updateRecentCodeDeviceName,
  upsertRecentCode,
  type SavedAccountSession,
} from "./auth";

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? (map.get(key) ?? null) : null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

describe("detectDefaultTransport", () => {
  it("selects webrtc on both https and http origins for hardware-accelerated low-latency video", () => {
    expect(detectDefaultTransport({ protocol: "https:" })).toBe("webrtc");
    expect(detectDefaultTransport({ protocol: "http:" })).toBe("webrtc");
  });

  it("falls back to ws-jpeg for non-http schemes when RTCPeerConnection is unavailable", () => {
    expect(detectDefaultTransport({ protocol: "capacitor:" })).toBe("ws-jpeg");
    expect(detectDefaultTransport({ protocol: "file:" })).toBe("ws-jpeg");
    expect(detectDefaultTransport(null)).toBe("ws-jpeg");
  });
});

describe("detectDefaultApiBase & detectDefaultRelayWsUrl", () => {
  it("returns empty same-origin apiBase for browser HTTP and HTTPS", () => {
    expect(
      detectDefaultApiBase({ protocol: "http:", host: "203.0.113.10" }),
    ).toBe("");
    expect(
      detectDefaultApiBase({ protocol: "https:", host: "velodeck.example.com" }),
    ).toBe("");
  });

  it("returns default cloud API base URL for Capacitor and file schemes", () => {
    expect(DEFAULT_CLOUD_API_BASE).toBe("http://localhost:8080");
    expect(DEFAULT_CLOUD_WS_URL).toBe("ws://localhost:8080/ws");
    expect(
      detectDefaultApiBase({ protocol: "capacitor:", host: "localhost" }),
    ).toBe(DEFAULT_CLOUD_API_BASE);
    expect(detectDefaultApiBase({ protocol: "file:", host: "" })).toBe(
      DEFAULT_CLOUD_API_BASE,
    );
    expect(detectDefaultApiBase(null)).toBe(DEFAULT_CLOUD_API_BASE);
  });

  it("resolves relay WebSocket URL from location or falls back to default cloud WS", () => {
    expect(
      detectDefaultRelayWsUrl({ protocol: "http:", host: "203.0.113.10" }),
    ).toBe("ws://203.0.113.10/ws");
    expect(
      detectDefaultRelayWsUrl({ protocol: "https:", host: "remote.example.com" }),
    ).toBe("wss://remote.example.com/ws");
    expect(
      detectDefaultRelayWsUrl({ protocol: "capacitor:", host: "localhost" }),
    ).toBe(DEFAULT_CLOUD_WS_URL);
  });

  it("builds versioned Android APK filenames and cache-busted download URLs cleanly", () => {
    expect(getAndroidApkFileName()).toBe("velodeck-agent.apk");
    expect(getAndroidApkFileName(null)).toBe("velodeck-agent.apk");
    expect(getAndroidApkFileName({})).toBe("velodeck-agent.apk");
    expect(getAndroidApkFileName({ version: "   " })).toBe("velodeck-agent.apk");
    expect(getAndroidApkFileName({ version: "v" })).toBe("velodeck-agent.apk");
    expect(getAndroidApkFileName({ version: "1.0.9" })).toBe("velodeck-agent-v1.0.9.apk");
    expect(getAndroidApkFileName({ version: "v1.0.9" })).toBe("velodeck-agent-v1.0.9.apk");
    expect(getAndroidApkFileName({ version: "  V1.0.9-rc.1 " })).toBe(
      "velodeck-agent-v1.0.9-rc.1.apk",
    );

    // Backward-compatible default when serverInfo is omitted or empty
    expect(getAndroidApkDownloadUrl("")).toBe("/api/download/velodeck-agent.apk");
    expect(getAndroidApkDownloadUrl("http://203.0.113.10/")).toBe(
      "http://203.0.113.10/api/download/velodeck-agent.apk",
    );
    expect(getAndroidApkDownloadUrl("", {})).toBe("/api/download/velodeck-agent.apk");

    // Versioned filename without SHA
    expect(getAndroidApkDownloadUrl("", { version: "1.0.9" })).toBe(
      "/api/download/velodeck-agent-v1.0.9.apk",
    );
    expect(getAndroidApkDownloadUrl("http://203.0.113.10/", { version: "v1.0.9" })).toBe(
      "http://203.0.113.10/api/download/velodeck-agent-v1.0.9.apk",
    );

    // Versioned filename + 12-char SHA query param
    expect(
      getAndroidApkDownloadUrl("", {
        version: "1.0.9",
        apkSha256: "abcdef0123456789fedcba9876543210",
      }),
    ).toBe("/api/download/velodeck-agent-v1.0.9.apk?sha=abcdef012345");
    expect(
      getAndroidApkDownloadUrl("http://203.0.113.10/", {
        version: "v1.0.9",
        apkSha256: "abcdef0123456789fedcba9876543210",
      }),
    ).toBe("http://203.0.113.10/api/download/velodeck-agent-v1.0.9.apk?sha=abcdef012345");

    // SHA-only without version falls back to default filename with ?sha=
    expect(
      getAndroidApkDownloadUrl("", {
        apkSha256: "abcdef0123456789fedcba9876543210",
      }),
    ).toBe("/api/download/velodeck-agent.apk?sha=abcdef012345");
  });
});

describe("9-digit control code formatting & normalization", () => {
  it("normalizes spaces and dashes and formats 9-digit codes", () => {
    expect(normalizeControlCode("683 291 405")).toBe("683291405");
    expect(normalizeControlCode("683-291-405")).toBe("683291405");
    expect(formatControlCode("683291405")).toBe("683 291 405");
    expect(isValidControlCode("683 291 405")).toBe(true);
    expect(isValidControlCode("683 291 40")).toBe(false);
    expect(isValidControlCode("683 29a 405")).toBe(false);
  });

  it("strips non-digits and auto-formats partial and full inputs", () => {
    expect(sanitizeControlCodeInput("68a3-291 40599")).toBe("683291405");
    expect(formatControlCodeInput("68")).toBe("68");
    expect(formatControlCodeInput("6832")).toBe("683 2");
    expect(formatControlCodeInput("6832914")).toBe("683 291 4");
    expect(formatControlCodeInput("683-291-405")).toBe("683 291 405");
  });
});

describe("recent control codes secure storage", () => {
  it("never writes controlPassword to localStorage, stores optional passwords in sessionStorage only, and deduplicates cleanly", () => {
    const local = createMemoryStorage();
    const session = createMemoryStorage();

    saveRecentControlCode(
      {
        controlCode: "683 291 405",
        controlPassword: "secret-password-1",
        rememberPassword: true,
        lastUsedAt: 1000,
      },
      local,
      session,
    );

    saveRecentCodeEntry(
      {
        controlCode: "111-222-333",
        controlPassword: "secret-password-2",
        deviceName: "Pixel 8 Pro",
        rememberPassword: true,
        lastUsedAt: 2000,
      },
      local,
      session,
    );

    // Re-save first code with different formatting -> deduplicated & moved to top
    const afterDedupe = saveRecentCodeEntry(
      {
        controlCode: "683-291-405",
        controlPassword: "secret-password-1-updated",
        rememberPassword: true,
        lastUsedAt: 3000,
      },
      local,
      session,
    );

    expect(afterDedupe).toHaveLength(2);
    expect(afterDedupe[0]).toEqual({
      controlCode: "683291405",
      controlPassword: "secret-password-1-updated",
      lastUsedAt: 3000,
    });
    expect(afterDedupe[1]?.controlCode).toBe("111222333");

    // Verify localStorage NEVER contains any plaintext controlPassword
    const rawLocal = local.getItem(RECENT_CODES_STORAGE_KEY) ?? "";
    expect(rawLocal).not.toContain("controlPassword");
    expect(rawLocal).not.toContain("secret-password");
    expect(JSON.parse(rawLocal)).toEqual([
      { controlCode: "683291405", lastUsedAt: 3000 },
      { controlCode: "111222333", deviceName: "Pixel 8 Pro", lastUsedAt: 2000 },
    ]);

    // Verify sessionStorage holds the session-only passwords
    const rawSession = session.getItem(SESSION_PASSWORDS_STORAGE_KEY) ?? "";
    expect(JSON.parse(rawSession)).toEqual({
      "683291405": "secret-password-1-updated",
      "111222333": "secret-password-2",
    });

    // Simulating a brand-new tab/app session (empty sessionStorage) returns NO passwords
    const freshSession = createMemoryStorage();
    const afterTabClose = loadRecentCodes(local, freshSession);
    expect(afterTabClose).toEqual([
      { controlCode: "683291405", lastUsedAt: 3000 },
      { controlCode: "111222333", deviceName: "Pixel 8 Pro", lastUsedAt: 2000 },
    ]);

    // Update device name without losing session password or leaking into localStorage
    const afterName = updateRecentCodeDeviceName(
      "683 291 405",
      "Xiaomi 14",
      local,
      session,
    );
    expect(afterName[0]).toEqual({
      controlCode: "683291405",
      controlPassword: "secret-password-1-updated",
      deviceName: "Xiaomi 14",
      lastUsedAt: 3000,
    });
    expect(local.getItem(RECENT_CODES_STORAGE_KEY)).not.toContain("controlPassword");

    // Re-save with rememberPassword: false strips stored password from sessionStorage while preserving deviceName
    const afterForgetPwd = saveRecentCodeEntry(
      {
        controlCode: "683291405",
        controlPassword: "temp-password",
        rememberPassword: false,
        lastUsedAt: 4000,
      },
      local,
      session,
    );
    expect(afterForgetPwd[0]?.controlPassword).toBeUndefined();
    expect(afterForgetPwd[0]?.deviceName).toBe("Xiaomi 14");
    expect(JSON.parse(session.getItem(SESSION_PASSWORDS_STORAGE_KEY) ?? "{}")).toEqual({
      "111222333": "secret-password-2",
    });

    // Delete entry by formatted code
    const afterDelete = deleteRecentCodeEntry("683 291 405", local, session);
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0]?.controlCode).toBe("111222333");
    expect(removeRecentCode(afterDelete, "111-222-333")).toEqual([]);
  });

  it("purges legacy plaintext controlPassword fields from existing localStorage entries on load", () => {
    const local = createMemoryStorage();
    const session = createMemoryStorage();

    // Seed legacy localStorage entry containing plaintext controlPassword
    local.setItem(
      RECENT_CODES_STORAGE_KEY,
      JSON.stringify([
        {
          controlCode: "683291405",
          controlPassword: "legacy-plaintext-secret",
          deviceName: "Legacy Pixel",
          lastUsedAt: 123456,
        },
      ]),
    );

    const loaded = loadRecentCodes(local, session);
    expect(loaded).toEqual([
      {
        controlCode: "683291405",
        deviceName: "Legacy Pixel",
        lastUsedAt: 123456,
      },
    ]);
    expect(loaded[0]?.controlPassword).toBeUndefined();

    // Verify localStorage itself was immediately scrubbed
    const scrubbedRaw = local.getItem(RECENT_CODES_STORAGE_KEY) ?? "";
    expect(scrubbedRaw).not.toContain("legacy-plaintext-secret");
    expect(scrubbedRaw).not.toContain("controlPassword");
    expect(JSON.parse(scrubbedRaw)).toEqual([
      {
        controlCode: "683291405",
        deviceName: "Legacy Pixel",
        lastUsedAt: 123456,
      },
    ]);
  });

  it("caps recent codes at MAX_RECENT_CODES (10) entries", () => {
    let list = upsertRecentCode([], {
      controlCode: "100000000",
      lastUsedAt: 1,
    });
    for (let i = 1; i <= 14; i++) {
      list = upsertRecentCode(list, {
        controlCode: String(100000000 + i),
        lastUsedAt: i + 1,
      });
    }
    expect(list).toHaveLength(MAX_RECENT_CODES);
    expect(list[0]?.controlCode).toBe("100000014");
    expect(list[MAX_RECENT_CODES - 1]?.controlCode).toBe("100000005");
  });
});

describe("account session persistence", () => {
  it("saves, loads, and clears saved account session under velodeck.account.v1", () => {
    expect(ACCOUNT_SESSION_STORAGE_KEY).toBe("velodeck.account.v1");
    expect(RECENT_CODES_STORAGE_KEY).toBe("velodeck.recentCodes.v1");
    expect(SESSION_PASSWORDS_STORAGE_KEY).toBe("velodeck.sessionPasswords.v1");
    expect(IOS_PWA_BANNER_DISMISSED_KEY).toBe("velodeck.controller.iosPwaTipDismissed.v1");

    const storage = createMemoryStorage();
    const session: SavedAccountSession = {
      authToken: "jwt-token-abc",
      user: {
        userId: "u-1",
        username: "alice",
        displayName: "Alice",
      },
      wsUrl: "ws://203.0.113.10/ws",
      apiBase: "",
    };

    expect(loadAccountSession(storage)).toBeNull();
    saveAccountSession(session, storage);
    expect(storage.getItem(ACCOUNT_SESSION_STORAGE_KEY)).toBeTruthy();
    expect(loadAccountSession(storage)).toEqual(session);

    clearAccountSession(storage);
    expect(loadAccountSession(storage)).toBeNull();
  });
});

describe("REST API clients", () => {
  it("fetchServerInfo parses APK SHA-256 and registration policy fields and fails gracefully", async () => {
    const basicFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.cache).toBe("no-store");
      return new Response(JSON.stringify({ hasAndroidApk: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    await expect(fetchServerInfo("", basicFetch as unknown as typeof fetch)).resolves.toEqual({
      hasAndroidApk: true,
    });

    const fullFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          hasAndroidApk: true,
          apkSha256: "abcdef0123456789fedcba9876543210",
          registrationMode: "first-user-then-invite",
          registrationOpen: true,
          requiresInviteCode: true,
          version: "0.3.0",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(fetchServerInfo("", fullFetch as unknown as typeof fetch)).resolves.toEqual({
      hasAndroidApk: true,
      apkSha256: "abcdef0123456789fedcba9876543210",
      registrationMode: "first-user-then-invite",
      registrationOpen: true,
      requiresInviteCode: true,
      version: "0.3.0",
    });

    const failingFetch = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      fetchServerInfo("http://203.0.113.10", failingFetch as unknown as typeof fetch),
    ).resolves.toEqual({ hasAndroidApk: false });
  });

  it("registerAccount sends inviteCode, enforces MIN_PASSWORD_LENGTH (8), and supports login/unbind", async () => {
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/register") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
        expect(body.inviteCode).toBe("INVITE-2026");
        return new Response(
          JSON.stringify({
            token: "tok-123",
            user: { userId: "u1", username: "bob", displayName: "Bob" },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/api/auth/login") {
        return new Response(
          JSON.stringify({
            token: "tok-123",
            user: { userId: "u1", username: "bob", displayName: "Bob" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/api/devices/unbind") {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer tok-123" });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    });

    await expect(
      registerAccount(
        "",
        { username: "bob", password: "short77" },
        mockFetch as unknown as typeof fetch,
      ),
    ).rejects.toThrow(String(MIN_PASSWORD_LENGTH));

    const reg = await registerAccount(
      "",
      {
        username: "bob",
        password: "password123",
        displayName: "Bob",
        inviteCode: "INVITE-2026",
      },
      mockFetch as unknown as typeof fetch,
    );
    expect(reg.token).toBe("tok-123");
    expect(reg.user.username).toBe("bob");

    const login = await loginAccount(
      "",
      { username: "bob", password: "password123" },
      mockFetch as unknown as typeof fetch,
    );
    expect(login.token).toBe("tok-123");

    await expect(
      unbindDeviceApi("", "tok-123", "dev-9", mockFetch as unknown as typeof fetch),
    ).resolves.toBeUndefined();
  });

  it("changePasswordApi and logoutAllSessionsApi call authenticated security endpoints", async () => {
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/change-password") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({ Authorization: "Bearer old-jwt" });
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
        expect(body).toEqual({
          currentPassword: "old-password",
          newPassword: "new-secure-password",
        });
        return new Response(JSON.stringify({ ok: true, token: "rotated-jwt" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/auth/logout-all") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({ Authorization: "Bearer rotated-jwt" });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    });

    await expect(
      changePasswordApi(
        "",
        "old-jwt",
        { currentPassword: "old-password", newPassword: "short" },
        mockFetch as unknown as typeof fetch,
      ),
    ).rejects.toThrow(String(MIN_PASSWORD_LENGTH));

    const changed = await changePasswordApi(
      "",
      "old-jwt",
      {
        currentPassword: "old-password",
        newPassword: "new-secure-password",
      },
      mockFetch as unknown as typeof fetch,
    );
    expect(changed).toEqual({ ok: true, token: "rotated-jwt" });

    await expect(
      logoutAllSessionsApi("", "rotated-jwt", mockFetch as unknown as typeof fetch),
    ).resolves.toBeUndefined();
  });
});
