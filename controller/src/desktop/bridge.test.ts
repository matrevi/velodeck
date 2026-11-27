import { afterEach, describe, expect, it } from "vitest";
import {
  DESKTOP_RECENT_SERVERS_STORAGE_KEY,
  DESKTOP_SERVER_URL_STORAGE_KEY,
  deriveRelayWsUrlFromApiBase,
  formatServerHostLabel,
  getDesktopBridge,
  isDesktopApp,
  isMacDesktop,
  loadCachedDesktopServerUrl,
  loadCachedRecentDesktopServers,
  normalizeServerBaseUrl,
  saveCachedDesktopServerUrl,
  saveCachedRecentDesktopServers,
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
  });
});
