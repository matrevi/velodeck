import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  mapNormalizedPointToDisplay,
  translateControlCommandToNativeEvents,
  type DisplayBounds,
} from "./inputInjector.ts";
import {
  APP_ORIGIN,
  getMimeType,
  isAllowedRendererUrl,
  isSafeExternalUrl,
  resolveStaticAssetPath,
} from "./protocol.ts";
import {
  clampWindowBounds,
  computePresetBounds,
  ensureHostSettings,
  generateHostControlPassword,
  generateHostDeviceId,
  generateHostDeviceSecret,
  HOST_DEVICE_ID_REGEX,
  loadSettings,
  normalizeServerUrl,
  PRESET_SIZES,
  saveSettingsAtomic,
  upsertRecentServer,
  type DesktopSettings,
  type WorkArea,
} from "./settings.ts";

describe("protocol helpers", () => {
  const rootDir = path.resolve("/tmp/velodeck-renderer-dist");

  it("resolves root, SPA fallback routes, and nested static assets", () => {
    assert.equal(
      resolveStaticAssetPath(rootDir, "app://velodeck/"),
      path.join(rootDir, "index.html"),
    );
    assert.equal(
      resolveStaticAssetPath(rootDir, "app://velodeck"),
      path.join(rootDir, "index.html"),
    );
    assert.equal(
      resolveStaticAssetPath(rootDir, "app://velodeck/dashboard"),
      path.join(rootDir, "index.html"),
    );
    assert.equal(
      resolveStaticAssetPath(rootDir, "app://velodeck/devices/pixel-9?tab=video"),
      path.join(rootDir, "index.html"),
    );
    assert.equal(
      resolveStaticAssetPath(rootDir, "app://velodeck/assets/index.js"),
      path.join(rootDir, "assets", "index.js"),
    );
    assert.equal(
      resolveStaticAssetPath(rootDir, "app://velodeck/icon-512.png"),
      path.join(rootDir, "icon-512.png"),
    );
  });

  it("blocks path traversal, encoded traversal, backslashes, wrong hosts, and null bytes", () => {
    assert.equal(
      resolveStaticAssetPath(rootDir, "app://velodeck/../etc/passwd"),
      null,
    );
    assert.equal(
      resolveStaticAssetPath(rootDir, "app://velodeck/assets/../../etc/passwd"),
      null,
    );
    assert.equal(
      resolveStaticAssetPath(rootDir, "app://velodeck/%2e%2e/etc/passwd"),
      null,
    );
    assert.equal(
      resolveStaticAssetPath(rootDir, "app://velodeck/%2e%2e/"),
      null,
    );
    assert.equal(
      resolveStaticAssetPath(rootDir, "app://velodeck/assets%5c..%5csecret.txt"),
      null,
    );
    assert.equal(
      resolveStaticAssetPath(rootDir, "app://velodeck/assets\\index.js"),
      null,
    );
    assert.equal(
      resolveStaticAssetPath(rootDir, "app://evil/index.html"),
      null,
    );
    assert.equal(
      resolveStaticAssetPath(rootDir, "https://velodeck/index.html"),
      null,
    );
    assert.equal(
      resolveStaticAssetPath(rootDir, "app://velodeck/index.html%00.png"),
      null,
    );
    assert.equal(
      resolveStaticAssetPath(rootDir, "app://velodeck/index.html\0"),
      null,
    );
    assert.equal(resolveStaticAssetPath(rootDir, "not a valid url"), null);
  });

  it("returns accurate MIME types for bundled assets", () => {
    assert.equal(getMimeType("index.html"), "text/html; charset=utf-8");
    assert.equal(getMimeType("assets/app.js"), "text/javascript; charset=utf-8");
    assert.equal(getMimeType("assets/mod.mjs"), "text/javascript; charset=utf-8");
    assert.equal(getMimeType("assets/app.css"), "text/css; charset=utf-8");
    assert.equal(getMimeType("icon.svg"), "image/svg+xml");
    assert.equal(getMimeType("icon.png"), "image/png");
    assert.equal(getMimeType("photo.jpg"), "image/jpeg");
    assert.equal(getMimeType("photo.webp"), "image/webp");
    assert.equal(getMimeType("favicon.ico"), "image/x-icon");
    assert.equal(getMimeType("config.json"), "application/json; charset=utf-8");
    assert.equal(
      getMimeType("manifest.webmanifest"),
      "application/manifest+json; charset=utf-8",
    );
    assert.equal(getMimeType("font.woff2"), "font/woff2");
    assert.equal(getMimeType("decoder.wasm"), "application/wasm");
    assert.equal(getMimeType("archive.bin"), "application/octet-stream");
  });

  it("validates trusted renderer origins for both app:// and dev http:// URLs", () => {
    assert.equal(isAllowedRendererUrl("app://velodeck/", APP_ORIGIN), true);
    assert.equal(
      isAllowedRendererUrl("app://velodeck/dashboard?tab=1", APP_ORIGIN),
      true,
    );
    assert.equal(isAllowedRendererUrl("app://evil/index.html", APP_ORIGIN), false);
    assert.equal(isAllowedRendererUrl("https://velodeck.example.com/", APP_ORIGIN), false);
    assert.equal(isAllowedRendererUrl("file:///etc/passwd", APP_ORIGIN), false);
    assert.equal(
      isAllowedRendererUrl("http://localhost:5173/dashboard", "http://localhost:5173"),
      true,
    );
    assert.equal(
      isAllowedRendererUrl("http://localhost:9999/", "http://localhost:5173"),
      false,
    );
  });

  it("validates safe external URLs strictly", () => {
    assert.equal(isSafeExternalUrl("https://velodeck.example.com/docs"), true);
    assert.equal(isSafeExternalUrl("http://localhost:8080/health"), true);
    assert.equal(isSafeExternalUrl("file:///etc/passwd"), false);
    assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
    assert.equal(isSafeExternalUrl("smb://fileserver/share"), false);
    assert.equal(isSafeExternalUrl("data:text/html,<h1>hi</h1>"), false);
    assert.equal(isSafeExternalUrl("app://velodeck/index.html"), false);
    assert.equal(isSafeExternalUrl(""), false);
  });
});

describe("settings helpers", () => {
  it("normalizes server URLs across domains, IPv4, ports, and suffixes", () => {
    assert.equal(
      normalizeServerUrl("velodeck.example.com"),
      "https://velodeck.example.com",
    );
    assert.equal(
      normalizeServerUrl("https://velodeck.example.com/"),
      "https://velodeck.example.com",
    );
    assert.equal(
      normalizeServerUrl("https://velodeck.example.com/ws"),
      "https://velodeck.example.com",
    );
    assert.equal(
      normalizeServerUrl("https://velodeck.example.com/ws/"),
      "https://velodeck.example.com",
    );
    assert.equal(
      normalizeServerUrl("https://velodeck.example.com/api/info"),
      "https://velodeck.example.com",
    );
    assert.equal(
      normalizeServerUrl("https://velodeck.example.com/sub/api/info/"),
      "https://velodeck.example.com/sub",
    );
    assert.equal(normalizeServerUrl("192.168.1.50"), "http://192.168.1.50");
    assert.equal(
      normalizeServerUrl("192.168.1.50:8080"),
      "http://192.168.1.50:8080",
    );
    assert.equal(
      normalizeServerUrl("localhost:8080/ws"),
      "http://localhost:8080",
    );
    assert.equal(
      normalizeServerUrl("http://127.0.0.1:8080/api/info?foo=1#bar"),
      "http://127.0.0.1:8080",
    );
  });

  it("rejects malformed or non-http server URLs", () => {
    assert.equal(normalizeServerUrl(""), "");
    assert.equal(normalizeServerUrl("   "), "");
    assert.equal(normalizeServerUrl("not a url"), "");
    assert.equal(normalizeServerUrl("singleword"), "");
    assert.equal(normalizeServerUrl("ftp://example.com"), "");
    assert.equal(normalizeServerUrl("ws://example.com/ws"), "");
    assert.equal(normalizeServerUrl("file:///etc/passwd"), "");
    assert.equal(normalizeServerUrl("javascript:alert(1)"), "");
    assert.equal(normalizeServerUrl("http://user:pass@example.com"), "");
    assert.equal(normalizeServerUrl("999.999.999.999"), "");
    assert.equal(
      normalizeServerUrl(`https://example.com/${"a".repeat(600)}`),
      "",
    );
  });

  it("deduplicates, moves to front, and caps recent servers", () => {
    const initial = [
      "https://a.example.com",
      "https://b.example.com",
      "https://c.example.com",
    ];
    const promoted = upsertRecentServer(initial, "b.example.com/ws", 3);
    assert.deepEqual(promoted, [
      "https://b.example.com",
      "https://a.example.com",
      "https://c.example.com",
    ]);

    const capped = upsertRecentServer(
      [
        "https://1.example.com",
        "https://2.example.com",
        "https://3.example.com",
        "https://4.example.com",
      ],
      "https://5.example.com",
      3,
    );
    assert.deepEqual(capped, [
      "https://5.example.com",
      "https://1.example.com",
      "https://2.example.com",
    ]);
  });

  it("clamps window bounds into visible workAreas and rescues off-screen windows", () => {
    const laptopArea: WorkArea = { x: 0, y: 25, width: 1440, height: 875 };

    // On-screen window partially sticking past right/bottom edges
    const partiallyOff = clampWindowBounds(
      { x: 1200, y: 700, width: 500, height: 600 },
      [laptopArea],
    );
    assert.ok(partiallyOff.x >= laptopArea.x);
    assert.ok(partiallyOff.y >= laptopArea.y);
    assert.ok(partiallyOff.x + partiallyOff.width <= laptopArea.x + laptopArea.width);
    assert.ok(partiallyOff.y + partiallyOff.height <= laptopArea.y + laptopArea.height);

    // Completely off-screen window from an unplugged external monitor at x=2560
    const rescued = clampWindowBounds(
      { x: 2600, y: 120, width: 1100, height: 760 },
      [laptopArea],
    );
    assert.equal(rescued.width, 1100);
    assert.equal(rescued.height, 760);
    assert.equal(rescued.x, Math.round((1440 - 1100) / 2));
    assert.equal(rescued.y, Math.round(25 + (875 - 760) / 2));
  });

  it("computes preset bounds and shrinks phone height cleanly on short laptop displays", () => {
    // 13" MacBook Air usable workArea (height 775 < 880 phone preset)
    const shortMacBook: WorkArea = { x: 0, y: 25, width: 1280, height: 775 };
    const phoneBounds = computePresetBounds("phone", null, shortMacBook);

    assert.equal(phoneBounds.height, 775 - 24);
    assert.ok(phoneBounds.width >= 340);
    assert.ok(phoneBounds.width <= PRESET_SIZES.phone.width);
    assert.ok(phoneBounds.x >= shortMacBook.x);
    assert.ok(phoneBounds.y >= shortMacBook.y);
    assert.ok(phoneBounds.y + phoneBounds.height <= shortMacBook.y + shortMacBook.height);

    // Large desktop display keeps full preset dimensions
    const largeDisplay: WorkArea = { x: 0, y: 25, width: 2560, height: 1415 };
    const fullPhone = computePresetBounds(
      "phone",
      { x: 600, y: 200, width: 1100, height: 760 },
      largeDisplay,
    );
    assert.equal(fullPhone.width, PRESET_SIZES.phone.width);
    assert.equal(fullPhone.height, PRESET_SIZES.phone.height);

    const dashboardBounds = computePresetBounds("dashboard", null, largeDisplay);
    assert.equal(dashboardBounds.width, PRESET_SIZES.dashboard.width);
    assert.equal(dashboardBounds.height, PRESET_SIZES.dashboard.height);
  });

  it("round-trips settings atomically and falls back cleanly on corrupt JSON", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velodeck-settings-"));
    const settingsPath = path.join(tmpDir, "desktop-settings.json");

    try {
      // Missing file returns clean defaults
      const initial = loadSettings(settingsPath);
      assert.deepEqual(initial, {
        serverUrl: "",
        recentServers: [],
        alwaysOnTop: false,
        lastPreset: "dashboard",
      });

      const toSave: DesktopSettings = {
        serverUrl: "https://ctrl.example.com",
        recentServers: ["https://ctrl.example.com", "http://192.168.1.20:8080"],
        alwaysOnTop: true,
        lastPreset: "phone",
        windowBounds: { x: 120, y: 80, width: 430, height: 880 },
      };
      saveSettingsAtomic(settingsPath, toSave);

      const loaded = loadSettings(settingsPath);
      assert.deepEqual(loaded, toSave);

      // Verify restrictive 0o600 permissions on POSIX
      if (process.platform !== "win32") {
        const mode = fs.statSync(settingsPath).mode & 0o777;
        assert.equal(mode, 0o600);
      }

      // Corrupt JSON falls back cleanly without throwing
      fs.writeFileSync(settingsPath, "{not-valid-json", "utf8");
      const recovered = loadSettings(settingsPath);
      assert.deepEqual(recovered, {
        serverUrl: "",
        recentServers: [],
        alwaysOnTop: false,
        lastPreset: "dashboard",
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("generates and atomically round-trips desktop host identity and credentials", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velodeck-host-settings-"));
    const settingsPath = path.join(tmpDir, "desktop-settings.json");

    try {
      const generatedId = generateHostDeviceId();
      assert.match(generatedId, HOST_DEVICE_ID_REGEX);

      const generatedSecret = generateHostDeviceSecret();
      assert.ok(generatedSecret.length >= 24);

      const generatedPass = generateHostControlPassword(8);
      assert.equal(generatedPass.length, 8);
      assert.match(generatedPass, /[A-Z]/);
      assert.match(generatedPass, /[a-z]/);
      assert.match(generatedPass, /[0-9]/);

      const base = loadSettings(settingsPath);
      const ensured = ensureHostSettings(base, "Workstation-Mac");
      assert.equal(ensured.changed, true);
      assert.match(ensured.settings.hostDeviceId ?? "", HOST_DEVICE_ID_REGEX);
      assert.ok((ensured.settings.hostDeviceSecret ?? "").length >= 24);
      assert.equal(ensured.settings.hostDeviceName, "Workstation-Mac");
      assert.equal((ensured.settings.hostControlPassword ?? "").length, 8);

      // Re-running ensureHostSettings is idempotent and preserves generated values
      const ensuredAgain = ensureHostSettings(ensured.settings, "Other-Name");
      assert.equal(ensuredAgain.changed, false);
      assert.deepEqual(ensuredAgain.settings, ensured.settings);

      const fullSettings: DesktopSettings = {
        ...ensured.settings,
        serverUrl: "https://relay.example.com",
        hostEnabled: true,
        hostDisplayId: "69733248",
        hostAuthToken: "jwt.payload.signature",
      };
      saveSettingsAtomic(settingsPath, fullSettings);

      const loaded = loadSettings(settingsPath);
      assert.deepEqual(loaded, fullSettings);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("desktop host input mapping & command translation", () => {
  const primaryDisplay: DisplayBounds = { x: 0, y: 0, width: 1920, height: 1080 };
  const leftSecondaryDisplay: DisplayBounds = {
    x: -1920,
    y: 0,
    width: 1920,
    height: 1080,
  };
  const retinaLogicalDisplay: DisplayBounds = {
    x: 0,
    y: 0,
    width: 1728,
    height: 1117,
  };

  it("maps normalized points across primary, negative-offset secondary, Retina logical bounds, and clamps out-of-range inputs", () => {
    assert.deepEqual(mapNormalizedPointToDisplay(0, 0, primaryDisplay), { x: 0, y: 0 });
    assert.deepEqual(mapNormalizedPointToDisplay(0.5, 0.5, primaryDisplay), {
      x: 960,
      y: 540,
    });
    assert.deepEqual(mapNormalizedPointToDisplay(1, 1, primaryDisplay), {
      x: 1919,
      y: 1079,
    });

    // Secondary monitor placed to the left of primary (negative X offset)
    assert.deepEqual(mapNormalizedPointToDisplay(0, 0.5, leftSecondaryDisplay), {
      x: -1920,
      y: 540,
    });
    assert.deepEqual(mapNormalizedPointToDisplay(1, 1, leftSecondaryDisplay), {
      x: -1,
      y: 1079,
    });

    // Retina MacBook Pro logical display coords
    assert.deepEqual(mapNormalizedPointToDisplay(0.5, 0.5, retinaLogicalDisplay), {
      x: 864,
      y: 558,
    });

    // Out-of-bounds and non-finite clamping
    assert.deepEqual(mapNormalizedPointToDisplay(-0.4, 1.9, primaryDisplay), {
      x: 0,
      y: 1079,
    });
    assert.deepEqual(mapNormalizedPointToDisplay(Number.NaN, Number.POSITIVE_INFINITY, primaryDisplay), {
      x: 0,
      y: 0,
    });
  });

  it("translates native desktop mouse, wheel, and keyboard events cleanly", () => {
    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "mouse_move", x: 0.5, y: 0.5 },
        primaryDisplay,
        "darwin",
      ),
      [{ action: "mouse_move", x: 960, y: 540 }],
    );

    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "mouse_down", x: 0.25, y: 0.5, button: "right", clickCount: 2 },
        primaryDisplay,
        "darwin",
      ),
      [{ action: "mouse_down", x: 480, y: 540, button: "right", clickCount: 2 }],
    );

    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "mouse_up", x: 0.25, y: 0.5, button: "right" },
        primaryDisplay,
        "darwin",
      ),
      [{ action: "mouse_up", x: 480, y: 540, button: "right", clickCount: 1 }],
    );

    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "mouse_wheel", x: 0.5, y: 0.5, deltaX: 0, deltaY: -120 },
        primaryDisplay,
        "darwin",
      ),
      [{ action: "mouse_wheel", x: 960, y: 540, deltaX: 0, deltaY: -120 }],
    );

    assert.deepEqual(
      translateControlCommandToNativeEvents(
        {
          action: "key_event",
          phase: "press",
          code: "KeyC",
          key: "c",
          modifiers: { ctrl: false, alt: false, shift: false, meta: true },
        },
        primaryDisplay,
        "darwin",
      ),
      [
        {
          action: "key_event",
          phase: "press",
          code: "KeyC",
          key: "c",
          modifiers: { ctrl: false, alt: false, shift: false, meta: true },
        },
      ],
    );
  });

  it("translates legacy mobile touch, long_press, swipe, remote keys, and Unicode text commands", () => {
    // tap -> left click
    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "tap", x: 0.5, y: 0.5 },
        leftSecondaryDisplay,
        "darwin",
      ),
      [{ action: "tap", x: -960, y: 540, clickCount: 1 }],
    );

    // long_press -> right click (context menu)
    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "long_press", x: 0.5, y: 0.5 },
        primaryDisplay,
        "darwin",
      ),
      [{ action: "long_press", x: 960, y: 540 }],
    );

    // swipe upward on mobile touch (y1=0.7 -> y2=0.3) -> positive DOM deltaY wheel scroll down
    const swipeEvents = translateControlCommandToNativeEvents(
      { action: "swipe", x1: 0.5, y1: 0.7, x2: 0.5, y2: 0.3 },
      primaryDisplay,
      "darwin",
    );
    assert.equal(swipeEvents.length, 1);
    assert.equal(swipeEvents[0]?.action, "mouse_wheel");
    assert.equal(swipeEvents[0]?.x, 960);
    assert.ok((swipeEvents[0]?.deltaY ?? 0) > 0);

    // touch_down -> touch_move -> touch_up -> left mouse drag
    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "touch_down", pointerId: 1, x: 0.1, y: 0.2 },
        primaryDisplay,
        "darwin",
      ),
      [{ action: "mouse_down", x: 192, y: 216, button: "left", clickCount: 1 }],
    );
    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "touch_move", pointerId: 1, x: 0.2, y: 0.2 },
        primaryDisplay,
        "darwin",
      ),
      [{ action: "mouse_move", x: 384, y: 216 }],
    );
    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "touch_up", pointerId: 1, x: 0.2, y: 0.2 },
        primaryDisplay,
        "darwin",
      ),
      [{ action: "mouse_up", x: 384, y: 216, button: "left", clickCount: 1 }],
    );

    // OS-specific legacy remote key mappings
    assert.deepEqual(
      translateControlCommandToNativeEvents({ action: "key", key: "back" }, primaryDisplay, "darwin"),
      [
        {
          action: "key_event",
          phase: "press",
          code: "Escape",
          key: "Escape",
          modifiers: { ctrl: false, alt: false, shift: false, meta: false },
        },
      ],
    );
    assert.deepEqual(
      translateControlCommandToNativeEvents({ action: "key", key: "home" }, primaryDisplay, "darwin"),
      [
        {
          action: "key_event",
          phase: "press",
          code: "KeyH",
          key: "h",
          modifiers: { ctrl: false, alt: false, shift: false, meta: true },
        },
      ],
    );
    assert.deepEqual(
      translateControlCommandToNativeEvents({ action: "key", key: "home" }, primaryDisplay, "win32"),
      [
        {
          action: "key_event",
          phase: "press",
          code: "KeyD",
          key: "d",
          modifiers: { ctrl: false, alt: false, shift: false, meta: true },
        },
      ],
    );
    assert.deepEqual(
      translateControlCommandToNativeEvents({ action: "key", key: "recents" }, primaryDisplay, "darwin"),
      [
        {
          action: "key_event",
          phase: "press",
          code: "ArrowUp",
          key: "ArrowUp",
          modifiers: { ctrl: true, alt: false, shift: false, meta: false },
        },
      ],
    );
    assert.deepEqual(
      translateControlCommandToNativeEvents({ action: "key", key: "recents" }, primaryDisplay, "win32"),
      [
        {
          action: "key_event",
          phase: "press",
          code: "Tab",
          key: "Tab",
          modifiers: { ctrl: false, alt: true, shift: false, meta: false },
        },
      ],
    );
    assert.deepEqual(
      translateControlCommandToNativeEvents({ action: "key", key: "lock" }, primaryDisplay, "darwin"),
      [{ action: "lock" }],
    );

    // Unicode text injection
    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "text", text: "你好 VeloDeck 🚀", submit: true },
        primaryDisplay,
        "darwin",
      ),
      [{ action: "text", text: "你好 VeloDeck 🚀", submit: true }],
    );
  });
});
