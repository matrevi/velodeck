import { describe, expect, it, vi } from "vitest";
import {
  ACTIVE_PROFILE_STORAGE_KEY,
  CLIENT_ID_STORAGE_KEY,
  PROFILES_STORAGE_KEY,
  assessQuickConnectSecurity,
  deleteProfile,
  detectDefaultWsUrl,
  getOrCreateClientId,
  importQuickConnectProfile,
  isAllowedDirectUrl,
  isPrivateHost,
  isPrivateLanIp,
  isSameOriginWsUrl,
  normalizeWsUrl,
  parseQuickConnectParams,
  stripQuickConnectParamsFromUrl,
  upsertProfile,
} from "./profiles";

describe("profile storage keys", () => {
  it("uses velodeck.* storage keys", () => {
    expect(PROFILES_STORAGE_KEY).toBe("velodeck.controller.profiles.v1");
    expect(ACTIVE_PROFILE_STORAGE_KEY).toBe("velodeck.controller.activeProfileId.v1");
    expect(CLIENT_ID_STORAGE_KEY).toBe("velodeck.controller.clientId.v1");
  });
});

describe("detectDefaultWsUrl", () => {
  it("converts https locations to wss://host/ws", () => {
    expect(
      detectDefaultWsUrl({
        protocol: "https:",
        host: "velodeck.example.com",
      }),
    ).toBe("wss://velodeck.example.com/ws");
  });

  it("converts http locations (including custom ports) to ws://host:port/ws", () => {
    expect(
      detectDefaultWsUrl({
        protocol: "http:",
        host: "100.64.12.34:8765",
      }),
    ).toBe("ws://100.64.12.34:8765/ws");

    expect(
      detectDefaultWsUrl({
        protocol: "http:",
        host: "localhost:5173",
      }),
    ).toBe("ws://localhost:5173/ws");
  });

  it("returns empty string for non-http schemes like capacitor or file", () => {
    expect(
      detectDefaultWsUrl({
        protocol: "capacitor:",
        host: "localhost",
      }),
    ).toBe("");
    expect(
      detectDefaultWsUrl({
        protocol: "file:",
        host: "",
      }),
    ).toBe("");
  });
});

describe("normalizeWsUrl", () => {
  it("normalizes http/https and bare hosts into WebSocket endpoints", () => {
    expect(normalizeWsUrl("https://velodeck.example.com")).toBe(
      "wss://velodeck.example.com/ws",
    );
    expect(normalizeWsUrl("http://100.64.1.2:8765")).toBe(
      "ws://100.64.1.2:8765/ws",
    );
    expect(normalizeWsUrl("100.64.1.2:8765", "direct")).toBe(
      "ws://100.64.1.2:8765/ws",
    );
    expect(normalizeWsUrl("wss://velodeck.example.com/custom")).toBe(
      "wss://velodeck.example.com/custom",
    );
  });
});

describe("parseQuickConnectParams", () => {
  it("parses Android Agent direct QR deep-link query params", () => {
    const parsed = parseQuickConnectParams(
      "?url=ws%3A%2F%2F100.88.1.9%3A8765%2Fws&token=my-secret-token&mode=direct&label=Pixel+8+Pro",
    );

    expect(parsed).toEqual({
      wsUrl: "ws://100.88.1.9:8765/ws",
      accessToken: "my-secret-token",
      mode: "direct",
      label: "Pixel 8 Pro",
      preferredTransport: "webrtc",
      qualityPreset: "balanced",
    });
  });

  it("parses #fragment quick-connect params and prefers fragment over query string", () => {
    const fromHashOnly = parseQuickConnectParams(
      "",
      "#url=wss%3A%2F%2Frelay.velodeck.dev%2Fws&token=hash-secret&mode=relay&label=HashPhone&transport=ws-jpeg&quality=hd&deviceId=dev-7",
    );

    expect(fromHashOnly).toEqual({
      wsUrl: "wss://relay.velodeck.dev/ws",
      accessToken: "hash-secret",
      mode: "relay",
      label: "HashPhone",
      preferredTransport: "ws-jpeg",
      qualityPreset: "hd",
      deviceId: "dev-7",
    });

    const hashOverridesQuery = parseQuickConnectParams(
      "?url=ws://old.example.com/ws&token=query-token",
      "#url=wss://new.example.com/ws&token=hash-token",
    );
    expect(hashOverridesQuery?.wsUrl).toBe("wss://new.example.com/ws");
    expect(hashOverridesQuery?.accessToken).toBe("hash-token");
  });

  it("parses relay deep-link with custom transport and quality", () => {
    const parsed = parseQuickConnectParams(
      "?url=wss://relay.velodeck.dev/ws&token=relay-key&mode=relay&label=Office&transport=ws-jpeg&quality=hd&deviceId=dev-1",
    );

    expect(parsed).toEqual({
      wsUrl: "wss://relay.velodeck.dev/ws",
      accessToken: "relay-key",
      mode: "relay",
      label: "Office",
      preferredTransport: "ws-jpeg",
      qualityPreset: "hd",
      deviceId: "dev-1",
    });
  });

  it("infers direct vs relay mode when mode query param is omitted", () => {
    const direct = parseQuickConnectParams("?url=ws://192.168.1.20:8765/ws&token=t1");
    expect(direct?.mode).toBe("direct");

    const relay = parseQuickConnectParams("?url=wss://phone.example.com/ws&token=t2");
    expect(relay?.mode).toBe("relay");
  });

  it("derives wsUrl from window location when only token is passed on hosted page", () => {
    const parsed = parseQuickConnectParams("?token=embedded-secret&mode=direct", {
      protocol: "http:",
      host: "100.100.2.3:8765",
    });

    expect(parsed?.wsUrl).toBe("ws://100.100.2.3:8765/ws");
    expect(parsed?.accessToken).toBe("embedded-secret");
    expect(parsed?.mode).toBe("direct");

    const fromHashWithLoc = parseQuickConnectParams("", "#token=frag-only-secret", {
      protocol: "https:",
      host: "velodeck.example.com",
    });
    expect(fromHashWithLoc?.wsUrl).toBe("wss://velodeck.example.com/ws");
    expect(fromHashWithLoc?.accessToken).toBe("frag-only-secret");
  });

  it("returns null when no quick-connect parameters are present", () => {
    expect(parseQuickConnectParams("")).toBeNull();
    expect(parseQuickConnectParams("?foo=bar")).toBeNull();
    expect(parseQuickConnectParams("", "#top")).toBeNull();
  });
});

describe("stripQuickConnectParamsFromUrl", () => {
  it("removes sensitive token and connect params from query while keeping unrelated params and anchors", () => {
    const replaceState = vi.fn();
    const fakeWindow = {
      location: {
        href: "https://velodeck.example.com/?url=wss%3A%2F%2Fvelodeck.example.com%2Fws&token=secret&mode=relay&tab=devices#top",
      } as Location,
      history: {
        replaceState,
      } as unknown as History,
    };

    const stripped = stripQuickConnectParamsFromUrl(fakeWindow);
    expect(stripped).toBe(true);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?tab=devices#top");
  });

  it("removes sensitive token and connect params from #fragment via history.replaceState", () => {
    const replaceState = vi.fn();
    const fakeWindow = {
      location: {
        href: "https://velodeck.example.com/#url=wss%3A%2F%2Fvelodeck.example.com%2Fws&token=secret&mode=relay",
      } as Location,
      history: {
        replaceState,
      } as unknown as History,
    };

    const stripped = stripQuickConnectParamsFromUrl(fakeWindow);
    expect(stripped).toBe(true);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
  });
});

describe("host and URL security guards", () => {
  it("identifies private hosts and private LAN/Tailscale IPs accurately", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("::1")).toBe(true);
    expect(isPrivateHost("10.0.0.5")).toBe(true);
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("172.31.255.254")).toBe(true);
    expect(isPrivateHost("192.168.1.42")).toBe(true);
    expect(isPrivateHost("100.64.0.1")).toBe(true);
    expect(isPrivateHost("100.127.255.254")).toBe(true);
    expect(isPrivateHost("phone.ts.net")).toBe(true);
    expect(isPrivateHost("phone.local")).toBe(true);

    expect(isPrivateHost("203.0.113.10")).toBe(false);
    expect(isPrivateHost("172.32.0.1")).toBe(false);
    expect(isPrivateHost("100.63.255.255")).toBe(false);
    expect(isPrivateHost("100.128.0.1")).toBe(false);
    expect(isPrivateHost("evil.example.com")).toBe(false);

    // isPrivateLanIp strictly excludes loopback so directUrl cannot target localhost
    expect(isPrivateLanIp("192.168.1.42")).toBe(true);
    expect(isPrivateLanIp("100.88.1.9")).toBe(true);
    expect(isPrivateLanIp("127.0.0.1")).toBe(false);
    expect(isPrivateLanIp("localhost")).toBe(false);
    expect(isPrivateLanIp("203.0.113.10")).toBe(false);
  });

  it("validates advertised device directUrl strictly to private LAN/Tailscale IPs", () => {
    expect(isAllowedDirectUrl("ws://192.168.1.25:8765/ws")).toBe(true);
    expect(isAllowedDirectUrl("ws://10.0.0.8:8765/ws")).toBe(true);
    expect(isAllowedDirectUrl("ws://172.20.10.2:8765/ws")).toBe(true);
    expect(isAllowedDirectUrl("ws://100.88.1.9:8765/ws")).toBe(true);

    expect(isAllowedDirectUrl("wss://evil.example.com/ws")).toBe(false);
    expect(isAllowedDirectUrl("ws://203.0.113.10:8765/ws")).toBe(false);
    expect(isAllowedDirectUrl("ws://127.0.0.1:8765/ws")).toBe(false);
    expect(isAllowedDirectUrl("http://192.168.1.25:8765/ws")).toBe(false);
  });

  it("checks same-origin WS URLs and flags cross-origin or public cleartext ws:// targets", () => {
    const httpsLoc = { protocol: "https:", host: "velodeck.example.com" };
    const lanLoc = { protocol: "http:", host: "192.168.1.50:8765" };
    const publicHttpLoc = { protocol: "http:", host: "203.0.113.10" };

    expect(isSameOriginWsUrl("wss://velodeck.example.com/ws", httpsLoc)).toBe(true);
    expect(isSameOriginWsUrl("wss://velodeck.example.com:443/ws", httpsLoc)).toBe(true);
    expect(isSameOriginWsUrl("wss://attacker.example.com/ws", httpsLoc)).toBe(false);
    expect(isSameOriginWsUrl("wss://velodeck.example.com:8443/ws", httpsLoc)).toBe(false);

    // Same-origin HTTPS -> trusted
    expect(
      assessQuickConnectSecurity("wss://velodeck.example.com/ws", httpsLoc),
    ).toMatchObject({
      requiresConfirmation: false,
      isExternalHost: false,
      isInsecurePublicWs: false,
    });

    // Same-origin private LAN -> trusted
    expect(
      assessQuickConnectSecurity("ws://192.168.1.50:8765/ws", lanLoc),
    ).toMatchObject({
      requiresConfirmation: false,
      isExternalHost: false,
      isInsecurePublicWs: false,
    });

    // External host -> requires confirmation
    expect(
      assessQuickConnectSecurity("wss://attacker.example.com/ws", httpsLoc),
    ).toMatchObject({
      requiresConfirmation: true,
      isExternalHost: true,
      isInsecurePublicWs: false,
    });

    // Public cleartext ws:// -> requires confirmation even if same host
    expect(
      assessQuickConnectSecurity("ws://203.0.113.10/ws", publicHttpLoc),
    ).toMatchObject({
      requiresConfirmation: true,
      isExternalHost: false,
      isInsecurePublicWs: true,
    });
  });
});

describe("profile CRUD and quick-connect upsert", () => {
  it("deduplicates quick-connect imports for matching wsUrl and mode", () => {
    const first = importQuickConnectProfile([], {
      wsUrl: "ws://100.64.0.9:8765/ws",
      accessToken: "old-token",
      mode: "direct",
      label: "Spare Phone",
      preferredTransport: "webrtc",
      qualityPreset: "balanced",
    });
    expect(first.profiles).toHaveLength(1);

    const second = importQuickConnectProfile(first.profiles, {
      wsUrl: "ws://100.64.0.9:8765/ws",
      accessToken: "new-token",
      mode: "direct",
      label: "Spare Phone Updated",
      preferredTransport: "ws-jpeg",
      qualityPreset: "hd",
    });

    expect(second.profiles).toHaveLength(1);
    expect(second.profile.id).toBe(first.profile.id);
    expect(second.profile.accessToken).toBe("new-token");
    expect(second.profile.label).toBe("Spare Phone Updated");
    expect(second.profile.preferredTransport).toBe("ws-jpeg");
    expect(second.profile.qualityPreset).toBe("hd");
  });

  it("creates, updates, and deletes connection profiles", () => {
    const created = upsertProfile([], {
      label: "Cloud Relay",
      mode: "relay",
      wsUrl: "https://relay.example.com",
      accessToken: "abc",
      preferredTransport: "webrtc",
      qualityPreset: "balanced",
    });
    expect(created.saved.wsUrl).toBe("wss://relay.example.com/ws");

    const updated = upsertProfile(created.profiles, {
      id: created.saved.id,
      label: "Cloud Relay Pro",
      mode: "relay",
      wsUrl: "wss://relay.example.com/ws",
      accessToken: "xyz",
      preferredTransport: "webrtc",
      qualityPreset: "hd",
    });
    expect(updated.profiles).toHaveLength(1);
    expect(updated.saved.label).toBe("Cloud Relay Pro");

    const afterDelete = deleteProfile(updated.profiles, created.saved.id);
    expect(afterDelete).toEqual([]);
  });

  it("persists per-tab clientId in sessionStorage (not localStorage) to prevent multi-tab kick storms", () => {
    const makeStore = () => {
      const data = new Map<string, string>();
      return {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => {
          data.set(k, v);
        },
        removeItem: (k: string) => {
          data.delete(k);
        },
        clear: () => {
          data.clear();
        },
        key: (index: number) => Array.from(data.keys())[index] ?? null,
        get length() {
          return data.size;
        },
      } as Storage;
    };

    const sessionStore = makeStore();
    const localStore = makeStore();
    localStore.setItem(CLIENT_ID_STORAGE_KEY, "ctrl-from-local");

    vi.stubGlobal("window", {
      sessionStorage: sessionStore,
      localStorage: localStore,
    });
    try {
      const id1 = getOrCreateClientId();
      const id2 = getOrCreateClientId();
      expect(id1).toMatch(/^ctrl-/);
      expect(id1).toBe(id2);
      expect(id1).not.toBe("ctrl-from-local");
      expect(sessionStore.getItem(CLIENT_ID_STORAGE_KEY)).toBe(id1);
    } finally {
      vi.unstubAllGlobals();
    }

    // Explicit storage arg continues to work in isolation
    const customTabA = makeStore();
    const customTabB = makeStore();
    const tabAId = getOrCreateClientId(customTabA);
    const tabBId = getOrCreateClientId(customTabB);
    expect(tabAId).not.toBe(tabBId);
    expect(getOrCreateClientId(customTabA)).toBe(tabAId);
  });
});
