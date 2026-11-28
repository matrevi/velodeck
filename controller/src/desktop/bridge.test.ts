import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_RECENT_SERVERS_STORAGE_KEY,
  DESKTOP_SERVER_URL_STORAGE_KEY,
  deriveRelayWsUrlFromApiBase,
  formatServerHostLabel,
  getDesktopBridge,
  hasDesktopHostBridge,
  isDesktopApp,
  isMacDesktop,
  loadCachedDesktopServerUrl,
  loadCachedRecentDesktopServers,
  normalizeServerBaseUrl,
  saveCachedDesktopServerUrl,
  saveCachedRecentDesktopServers,
  type DesktopHostPermissions,
  type DesktopHostState,
  type VeloDeckDesktopBridge,
} from "./bridge";

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

describe("normalizeServerBaseUrl", () => {
  it("normalizes explicit HTTPS and HTTP domains and strips trailing slashes", () => {
    expect(normalizeServerBaseUrl("https://remote.example.com")).toBe(
      "https://remote.example.com",
    );
    expect(normalizeServerBaseUrl("  https://remote.example.com///  ")).toBe(
      "https://remote.example.com",
    );
    expect(normalizeServerBaseUrl("http://203.0.113.10:8080/")).toBe(
      "http://203.0.113.10:8080",
    );
    expect(normalizeServerBaseUrl("https://remote.example.com:8443/")).toBe(
      "https://remote.example.com:8443",
    );
  });

  it("auto-prepends https:// for bare domain names", () => {
    expect(normalizeServerBaseUrl("remote.example.com")).toBe(
      "https://remote.example.com",
    );
    expect(normalizeServerBaseUrl("remote.example.com:8443")).toBe(
      "https://remote.example.com:8443",
    );
    expect(normalizeServerBaseUrl("sub.remote.example.com/")).toBe(
      "https://sub.remote.example.com",
    );
  });

  it("auto-prepends http:// for bare IPv4, localhost, and private hosts", () => {
    expect(normalizeServerBaseUrl("203.0.113.10")).toBe("http://203.0.113.10");
    expect(normalizeServerBaseUrl("203.0.113.10:8080")).toBe(
      "http://203.0.113.10:8080",
    );
    expect(normalizeServerBaseUrl("192.168.1.50")).toBe("http://192.168.1.50");
    expect(normalizeServerBaseUrl("192.168.1.50:8080")).toBe(
      "http://192.168.1.50:8080",
    );
    expect(normalizeServerBaseUrl("10.0.0.8:9000")).toBe("http://10.0.0.8:9000");
    expect(normalizeServerBaseUrl("127.0.0.1")).toBe("http://127.0.0.1");
    expect(normalizeServerBaseUrl("localhost:8080")).toBe(
      "http://localhost:8080",
    );
    expect(normalizeServerBaseUrl("velodeck.local:8080")).toBe(
      "http://velodeck.local:8080",
    );
  });

  it("strips trailing /ws and /api/... paths while preserving reverse-proxy subpaths", () => {
    expect(normalizeServerBaseUrl("https://remote.example.com/ws")).toBe(
      "https://remote.example.com",
    );
    expect(normalizeServerBaseUrl("https://remote.example.com/ws/")).toBe(
      "https://remote.example.com",
    );
    expect(normalizeServerBaseUrl("http://192.168.1.10:8080/api/info")).toBe(
      "http://192.168.1.10:8080",
    );
    expect(
      normalizeServerBaseUrl("https://remote.example.com/api/auth/login"),
    ).toBe("https://remote.example.com");
    expect(normalizeServerBaseUrl("https://remote.example.com/api")).toBe(
      "https://remote.example.com",
    );
    expect(normalizeServerBaseUrl("https://remote.example.com/velodeck/ws")).toBe(
      "https://remote.example.com/velodeck",
    );
    expect(
      normalizeServerBaseUrl("https://remote.example.com/velodeck/api/info"),
    ).toBe("https://remote.example.com/velodeck");
    expect(normalizeServerBaseUrl("203.0.113.10:8080/ws")).toBe(
      "http://203.0.113.10:8080",
    );
  });

  it("rejects empty, dangerous, or malformed inputs", () => {
    expect(normalizeServerBaseUrl("")).toBe("");
    expect(normalizeServerBaseUrl("   ")).toBe("");
    expect(normalizeServerBaseUrl("javascript:alert(1)")).toBe("");
    expect(normalizeServerBaseUrl("JAVASCRIPT:alert(1)")).toBe("");
    expect(normalizeServerBaseUrl("data:text/html,<script>1</script>")).toBe("");
    expect(normalizeServerBaseUrl("file:///etc/passwd")).toBe("");
    expect(normalizeServerBaseUrl("ftp://example.com")).toBe("");
    expect(normalizeServerBaseUrl("ws://remote.example.com/ws")).toBe("");
    expect(normalizeServerBaseUrl("wss://remote.example.com/ws")).toBe("");
    expect(normalizeServerBaseUrl("http://")).toBe("");
    expect(normalizeServerBaseUrl("https://")).toBe("");
    expect(normalizeServerBaseUrl("://broken")).toBe("");
    expect(normalizeServerBaseUrl("not a valid url")).toBe("");
    expect(normalizeServerBaseUrl("http://user:pass@example.com")).toBe("");
  });
});

describe("deriveRelayWsUrlFromApiBase", () => {
  it("converts https to wss and http to ws with /ws suffix", () => {
    expect(deriveRelayWsUrlFromApiBase("https://remote.example.com")).toBe(
      "wss://remote.example.com/ws",
    );
    expect(deriveRelayWsUrlFromApiBase("http://203.0.113.10:8080")).toBe(
      "ws://203.0.113.10:8080/ws",
    );
    expect(
      deriveRelayWsUrlFromApiBase("https://remote.example.com/velodeck/"),
    ).toBe("wss://remote.example.com/velodeck/ws");
    expect(deriveRelayWsUrlFromApiBase("remote.example.com")).toBe(
      "wss://remote.example.com/ws",
    );
    expect(deriveRelayWsUrlFromApiBase("192.168.1.9:8080")).toBe(
      "ws://192.168.1.9:8080/ws",
    );
  });

  it("returns empty string for invalid inputs", () => {
    expect(deriveRelayWsUrlFromApiBase("")).toBe("");
    expect(deriveRelayWsUrlFromApiBase("javascript:alert(1)")).toBe("");
  });
});

describe("formatServerHostLabel", () => {
  it("formats host with port and optional subpath", () => {
    expect(formatServerHostLabel("https://remote.example.com")).toBe(
      "remote.example.com",
    );
    expect(formatServerHostLabel("http://203.0.113.10:8080/api/info")).toBe(
      "203.0.113.10:8080",
    );
    expect(formatServerHostLabel("https://remote.example.com/deck/ws")).toBe(
      "remote.example.com/deck",
    );
    expect(formatServerHostLabel("")).toBe("");
  });
});

describe("desktop server URL localStorage cache", () => {
  it("saves, loads, normalizes, and clears cached desktop server URL", () => {
    const storage = createMemoryStorage();
    expect(loadCachedDesktopServerUrl(storage)).toBe("");

    saveCachedDesktopServerUrl("remote.example.com/ws", storage);
    expect(storage.getItem(DESKTOP_SERVER_URL_STORAGE_KEY)).toBe(
      "https://remote.example.com",
    );
    expect(loadCachedDesktopServerUrl(storage)).toBe(
      "https://remote.example.com",
    );

    saveCachedDesktopServerUrl("", storage);
    expect(storage.getItem(DESKTOP_SERVER_URL_STORAGE_KEY)).toBeNull();
    expect(loadCachedDesktopServerUrl(storage)).toBe("");
  });

  it("sanitizes corrupted or dangerous cached values on load", () => {
    const storage = createMemoryStorage();
    storage.setItem(DESKTOP_SERVER_URL_STORAGE_KEY, "javascript:alert(1)");
    expect(loadCachedDesktopServerUrl(storage)).toBe("");
  });

  it("caches and deduplicates recent desktop servers", () => {
    const storage = createMemoryStorage();
    saveCachedRecentDesktopServers(
      [
        "https://a.example.com/",
        "a.example.com/ws",
        "203.0.113.10:8080",
        "javascript:alert(1)",
      ],
      storage,
    );
    expect(storage.getItem(DESKTOP_RECENT_SERVERS_STORAGE_KEY)).not.toBeNull();
    expect(loadCachedRecentDesktopServers(storage)).toEqual([
      "https://a.example.com",
      "http://203.0.113.10:8080",
    ]);

    saveCachedRecentDesktopServers([], storage);
    expect(storage.getItem(DESKTOP_RECENT_SERVERS_STORAGE_KEY)).toBeNull();
  });
});

describe("desktop bridge detection", () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it("returns null / false safely when velodeckDesktop is absent", () => {
    expect(getDesktopBridge()).toBeNull();
    expect(isDesktopApp()).toBe(false);
    expect(isMacDesktop()).toBe(false);
  });

  it("detects bridge and macOS platform when window.velodeckDesktop is injected", () => {
    const mockBridge = {
      platform: "darwin",
      appVersion: "1.0.9",
      defaultServerUrl: "",
    } as unknown as VeloDeckDesktopBridge;
    (globalThis as { window?: unknown }).window = {
      velodeckDesktop: mockBridge,
    };

    expect(getDesktopBridge()).toBe(mockBridge);
    expect(isDesktopApp()).toBe(true);
    expect(isMacDesktop()).toBe(true);

    (globalThis as { window?: unknown }).window = {
      velodeckDesktop: { ...mockBridge, platform: "win32" },
    };
    expect(isDesktopApp()).toBe(true);
    expect(isMacDesktop()).toBe(false);
    expect(hasDesktopHostBridge()).toBe(false);
  });

  it("detects full desktop host bridge support and invokes all 12 host IPC methods cleanly", async () => {
    const basePermissions: DesktopHostPermissions = {
      accessibility: true,
      screenCapture: true,
      platform: "darwin",
    };
    const baseHostState: DesktopHostState = {
      enabled: true,
      status: "online",
      deviceId: "mac-host-1",
      deviceName: "MacBook Pro",
      controlCode: "683291405",
      controlPassword: "secret-password",
      ownerUsername: "alice",
      activeSessionId: null,
      activeTransport: null,
      activeDisplayId: "disp-1",
      displays: [
        {
          id: "disp-1",
          name: "Built-in Retina Display",
          width: 2560,
          height: 1600,
          primary: true,
        },
        {
          id: "disp-2",
          name: "Studio Display",
          width: 5120,
          height: 2880,
          primary: false,
        },
      ],
      permissions: basePermissions,
      lastError: null,
      lastReceivedFile: null,
      autoLaunch: false,
      preventSleep: true,
      audioCaptureEnabled: true,
      clipboardAutoSync: true,
      privacyScreenActive: false,
    };

    const unsubSpy = vi.fn();
    const subscribedListeners: Array<(state: DesktopHostState) => void> = [];

    const fullBridge = {
      platform: "darwin" as const,
      appVersion: "1.1.0",
      defaultServerUrl: "https://remote.example.com",
      getHostState: vi.fn(async () => baseHostState),
      onHostStateChange: vi.fn((cb: (state: DesktopHostState) => void) => {
        subscribedListeners.push(cb);
        return unsubSpy;
      }),
      startHost: vi.fn(async (_authToken?: string | null) => baseHostState),
      stopHost: vi.fn(async () => ({
        ...baseHostState,
        enabled: false,
        status: "stopped" as const,
      })),
      updateHostConfig: vi.fn(async (patch) => ({
        ...baseHostState,
        ...patch,
      })),
      regenerateHostPassword: vi.fn(async () => ({
        ...baseHostState,
        controlPassword: "new-password-123",
      })),
      bindHostAccount: vi.fn(async (_authToken: string) => baseHostState),
      unbindHostAccount: vi.fn(async () => ({
        ...baseHostState,
        ownerUsername: "",
      })),
      selectHostDisplay: vi.fn(async (displayId: string) => ({
        ...baseHostState,
        activeDisplayId: displayId,
      })),
      disconnectHostSession: vi.fn(async () => ({
        ...baseHostState,
        activeSessionId: null,
        activeTransport: null,
      })),
      refreshHostPermissions: vi.fn(async () => basePermissions),
      openPermissionSettings: vi.fn(async () => undefined),
      setHostPrivacyScreen: vi.fn(async (enabled: boolean) => ({
        ...baseHostState,
        privacyScreenActive: enabled,
      })),
      writeClipboardText: vi.fn(async (_text: string) => true),
      readClipboardText: vi.fn(async () => "copied from host"),
    } as unknown as VeloDeckDesktopBridge;

    (globalThis as { window?: unknown }).window = {
      velodeckDesktop: fullBridge,
    };

    expect(hasDesktopHostBridge()).toBe(true);

    const bridge = getDesktopBridge()!;
    expect(await bridge.getHostState?.()).toEqual(baseHostState);

    const listener = vi.fn();
    const unsub = bridge.onHostStateChange?.(listener);
    expect(subscribedListeners).toHaveLength(1);
    subscribedListeners[0]?.(baseHostState);
    expect(listener).toHaveBeenCalledWith(baseHostState);
    unsub?.();
    expect(unsubSpy).toHaveBeenCalledTimes(1);

    await bridge.startHost?.("jwt-token");
    expect(fullBridge.startHost).toHaveBeenCalledWith("jwt-token");

    const stopped = await bridge.stopHost?.();
    expect(stopped?.status).toBe("stopped");

    const updated = await bridge.updateHostConfig?.({
      deviceName: "Work Mac",
      controlPassword: "new-password-999",
      autoLaunch: true,
      preventSleep: true,
      audioCaptureEnabled: false,
      clipboardAutoSync: true,
    });
    expect(updated?.deviceName).toBe("Work Mac");
    expect(updated?.autoLaunch).toBe(true);
    expect(updated?.preventSleep).toBe(true);
    expect(updated?.audioCaptureEnabled).toBe(false);
    expect(updated?.clipboardAutoSync).toBe(true);

    const privacyOn = await bridge.setHostPrivacyScreen?.(true);
    expect(privacyOn?.privacyScreenActive).toBe(true);
    expect(await bridge.writeClipboardText?.("hello")).toBe(true);
    expect(await bridge.readClipboardText?.()).toBe("copied from host");

    const regen = await bridge.regenerateHostPassword?.();
    expect(regen?.controlPassword).toBe("new-password-123");

    await bridge.bindHostAccount?.("jwt-token");
    expect(fullBridge.bindHostAccount).toHaveBeenCalledWith("jwt-token");

    const unbound = await bridge.unbindHostAccount?.();
    expect(unbound?.ownerUsername).toBe("");

    const switched = await bridge.selectHostDisplay?.("disp-2");
    expect(switched?.activeDisplayId).toBe("disp-2");

    await bridge.disconnectHostSession?.();
    expect(fullBridge.disconnectHostSession).toHaveBeenCalledTimes(1);

    expect(await bridge.refreshHostPermissions?.()).toEqual(basePermissions);

    await bridge.openPermissionSettings?.("screen");
    await bridge.openPermissionSettings?.("accessibility");
    expect(fullBridge.openPermissionSettings).toHaveBeenCalledWith("screen");
    expect(fullBridge.openPermissionSettings).toHaveBeenCalledWith("accessibility");

    // Partial preload bridge (missing even one host method) must return false
    const { openPermissionSettings: _omitted, ...partialBridge } = fullBridge;
    expect(
      hasDesktopHostBridge(partialBridge as unknown as VeloDeckDesktopBridge),
    ).toBe(false);
  });
});
