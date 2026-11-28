import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  mapNormalizedPointToDisplay,
  normalizeCursorShape,
  translateControlCommandToNativeEvents,
  type DisplayBounds,
} from "./inputInjector.ts";
import {
  buildWolMagicPacket,
  collectLocalNetworkInfo,
  LanDiscoveryService,
  normalizeMacAddress,
} from "./lanDiscovery.ts";
import {
  executePowerAction,
  isPowerOperation,
  resolvePowerCommand,
} from "./powerAndPrivacy.ts";
import {
  APP_ORIGIN,
  getMimeType,
  isAllowedRendererUrl,
  isSafeExternalUrl,
  resolveStaticAssetPath,
} from "./protocol.ts";
import {
  createDirectory,
  getDefaultRoots,
  isProtectedDeletePath,
  listDirectory,
  openDownloadStream,
  REMOTE_DOWNLOAD_CHUNK_SIZE,
  resolveValidUploadTargetDir,
  sanitizeEntryName,
  trashPath,
} from "./remoteFileManager.ts";
import {
  RemoteTerminalManager,
  sanitizeTerminalSize,
  type RemoteTerminalEvent,
} from "./remoteTerminal.ts";
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
  sanitizeHostAccessMode,
  saveSettingsAtomic,
  upsertRecentServer,
  type DesktopSettings,
  type WorkArea,
} from "./settings.ts";
import { sanitizeWhiteboardStroke } from "./whiteboardOverlay.ts";

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

    // Pro host commands: power / privacy_screen / audio_toggle / extended desktop keys
    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "power", operation: "lock" },
        primaryDisplay,
        "darwin",
      ),
      [{ action: "lock" }],
    );
    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "power", operation: "sleep" },
        primaryDisplay,
        "darwin",
      ),
      [],
    );
    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "power", operation: "restart" },
        primaryDisplay,
        "win32",
      ),
      [],
    );
    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "power", operation: "shutdown" },
        primaryDisplay,
        "win32",
      ),
      [],
    );
    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "privacy_screen", enabled: true },
        primaryDisplay,
        "darwin",
      ),
      [],
    );
    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "audio_toggle", enabled: false },
        primaryDisplay,
        "darwin",
      ),
      [],
    );
    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "key", key: "volume_mute" },
        primaryDisplay,
        "darwin",
      ),
      [
        {
          action: "key_event",
          phase: "press",
          code: "AudioVolumeMute",
          key: "AudioVolumeMute",
          modifiers: { ctrl: false, alt: false, shift: false, meta: false },
        },
      ],
    );
    assert.deepEqual(
      translateControlCommandToNativeEvents(
        {
          action: "key_event",
          phase: "press",
          code: "F13",
          key: "F13",
          modifiers: { ctrl: true, alt: true, shift: false, meta: false },
        },
        primaryDisplay,
        "win32",
      ),
      [
        {
          action: "key_event",
          phase: "press",
          code: "F13",
          key: "F13",
          modifiers: { ctrl: true, alt: true, shift: false, meta: false },
        },
      ],
    );
  });
});

describe("pro host settings defaults & persistence", () => {
  it("applies default pro host flags and round-trips custom overrides atomically", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velodeck-pro-settings-"));
    const settingsPath = path.join(tmpDir, "desktop-settings.json");

    try {
      const base = loadSettings(settingsPath);
      const ensured = ensureHostSettings(base, "Pro-Studio-Mac");
      assert.equal(ensured.changed, true);
      assert.equal(ensured.settings.hostAutoLaunch, false);
      assert.equal(ensured.settings.hostPreventSleep, true);
      assert.equal(ensured.settings.hostAudioEnabled, true);
      assert.equal(ensured.settings.hostClipboardAutoSync, true);

      const customized: DesktopSettings = {
        ...ensured.settings,
        hostEnabled: true,
        hostAutoLaunch: true,
        hostPreventSleep: false,
        hostAudioEnabled: false,
        hostClipboardAutoSync: false,
      };
      saveSettingsAtomic(settingsPath, customized);

      const loaded = loadSettings(settingsPath);
      assert.equal(loaded.hostAutoLaunch, true);
      assert.equal(loaded.hostPreventSleep, false);
      assert.equal(loaded.hostAudioEnabled, false);
      assert.equal(loaded.hostClipboardAutoSync, false);
      assert.deepEqual(loaded, customized);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("remote power action validation & resolution", () => {
  it("allowlists only lock/sleep/restart/shutdown and builds safe execFile specs", async () => {
    assert.equal(isPowerOperation("lock"), true);
    assert.equal(isPowerOperation("sleep"), true);
    assert.equal(isPowerOperation("restart"), true);
    assert.equal(isPowerOperation("shutdown"), true);
    assert.equal(isPowerOperation("reboot; rm -rf /"), false);
    assert.equal(isPowerOperation(""), false);

    assert.deepEqual(resolvePowerCommand("sleep", "darwin"), {
      file: "pmset",
      args: ["sleepnow"],
    });
    assert.deepEqual(resolvePowerCommand("sleep", "win32"), {
      file: "rundll32.exe",
      args: ["powrprof.dll,SetSuspendState", "0,1,0"],
    });
    assert.deepEqual(resolvePowerCommand("restart", "win32"), {
      file: "shutdown",
      args: ["/r", "/t", "5"],
    });
    assert.deepEqual(resolvePowerCommand("shutdown", "darwin"), {
      file: "osascript",
      args: ["-e", 'tell application "System Events" to shut down'],
    });

    // Lock prefers native lockFallbackFn first
    let execCalled = false;
    const lockOk = await executePowerAction(
      "lock",
      "darwin",
      () => true,
      async () => {
        execCalled = true;
        return { ok: true };
      },
    );
    assert.equal(lockOk.ok, true);
    assert.equal(execCalled, false);

    // Falls back to OS CLI if lockFallbackFn returns false
    let capturedFile = "";
    const lockFallback = await executePowerAction(
      "lock",
      "darwin",
      () => false,
      async (spec) => {
        capturedFile = spec.file;
        return { ok: true };
      },
    );
    assert.equal(lockFallback.ok, true);
    assert.equal(capturedFile, "pmset");
  });
});

describe("remote file manager", () => {
  it("sanitizes entry names strictly and blocks traversal, separators, NUL, and long names", () => {
    assert.equal(sanitizeEntryName("Projects 2026"), "Projects 2026");
    assert.equal(sanitizeEntryName("测试目录_01"), "测试目录_01");
    assert.equal(sanitizeEntryName("  spaced  "), "spaced");

    assert.equal(sanitizeEntryName(""), null);
    assert.equal(sanitizeEntryName("   "), null);
    assert.equal(sanitizeEntryName("."), null);
    assert.equal(sanitizeEntryName(".."), null);
    assert.equal(sanitizeEntryName("foo/bar"), null);
    assert.equal(sanitizeEntryName("foo\\bar"), null);
    assert.equal(sanitizeEntryName("bad\0name"), null);
    assert.equal(sanitizeEntryName("bad\nname"), null);
    assert.equal(sanitizeEntryName("a".repeat(121)), null);
    assert.equal(sanitizeEntryName("a".repeat(120)), "a".repeat(120));
  });

  it("enumerates roots, lists sorted directories, creates folders, and validates upload targetDir", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "velodeck-rfm-home-"));
    try {
      fs.mkdirSync(path.join(tmpHome, "Desktop"));
      fs.mkdirSync(path.join(tmpHome, "Downloads"));

      const roots = getDefaultRoots("linux", tmpHome);
      assert.ok(roots.some((r) => r.kind === "home" && r.path === tmpHome));
      assert.ok(roots.some((r) => r.kind === "desktop"));
      assert.ok(roots.some((r) => r.kind === "downloads"));
      assert.equal(roots.some((r) => r.kind === "documents"), false);

      // Create mixed files & folders and verify dirs-first alphabetical sort
      fs.writeFileSync(path.join(tmpHome, "b.txt"), "hello");
      fs.writeFileSync(path.join(tmpHome, "a.txt"), "world!");
      fs.mkdirSync(path.join(tmpHome, "ZetaDir"));
      fs.mkdirSync(path.join(tmpHome, "AlphaDir"));

      const listed = listDirectory(tmpHome);
      assert.equal(listed.path, tmpHome);
      assert.equal(listed.parentPath, path.dirname(tmpHome));
      assert.deepEqual(
        listed.entries.map((e) => `${e.isDir ? "D" : "F"}:${e.name}`),
        ["D:AlphaDir", "D:Desktop", "D:Downloads", "D:ZetaDir", "F:a.txt", "F:b.txt"],
      );
      const aEntry = listed.entries.find((e) => e.name === "a.txt");
      assert.equal(aEntry?.size, 6);

      // Safe mkdir
      const created = createDirectory(tmpHome, "New Folder");
      assert.equal(created.ok, true);
      assert.equal(created.createdPath, path.join(tmpHome, "New Folder"));
      assert.equal(fs.statSync(created.createdPath!).isDirectory(), true);

      // Reject duplicate & traversal names
      assert.equal(createDirectory(tmpHome, "New Folder").ok, false);
      assert.equal(createDirectory(tmpHome, "../escape").ok, false);

      // Upload targetDir validation
      assert.equal(resolveValidUploadTargetDir(tmpHome), tmpHome);
      assert.equal(resolveValidUploadTargetDir(path.join(tmpHome, "a.txt")), null);
      assert.equal(resolveValidUploadTargetDir(path.join(tmpHome, "does-not-exist")), null);
      assert.equal(resolveValidUploadTargetDir(`${tmpHome}\0evil`), null);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("protects filesystem roots and homeDir from deletion and safely trashes regular items", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "velodeck-rfm-del-"));
    const fakeHome = path.join(tmpRoot, "home-user");
    const sampleFile = path.join(fakeHome, "report.pdf");
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.writeFileSync(sampleFile, "pdf-bytes");

    try {
      const trashed: string[] = [];
      const mockTrash = async (p: string): Promise<void> => {
        trashed.push(p);
      };

      assert.equal(isProtectedDeletePath("/", fakeHome, "darwin"), true);
      assert.equal(isProtectedDeletePath("C:\\", fakeHome, "win32"), true);
      assert.equal(isProtectedDeletePath("D:/", fakeHome, "win32"), true);
      assert.equal(isProtectedDeletePath(fakeHome, fakeHome, "darwin"), true);

      const rootRes = await trashPath("/", mockTrash, fakeHome, "darwin");
      assert.equal(rootRes.ok, false);

      const winRootRes = await trashPath("C:\\", mockTrash, fakeHome, "win32");
      assert.equal(winRootRes.ok, false);

      const homeRes = await trashPath(fakeHome, mockTrash, fakeHome, "darwin");
      assert.equal(homeRes.ok, false);
      assert.equal(trashed.length, 0);

      const fileRes = await trashPath(sampleFile, mockTrash, fakeHome, "darwin");
      assert.equal(fileRes.ok, true);
      assert.deepEqual(trashed, [sampleFile]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("streams files in 64KB chunks with exact SHA-256 verification and rejects directories/NUL paths", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velodeck-rfm-dl-"));
    const bigFile = path.join(tmpDir, "payload.bin");
    const emptyFile = path.join(tmpDir, "empty.txt");
    const subDir = path.join(tmpDir, "subdir");

    try {
      // 160 KB random payload -> expects 3 chunks (64KB + 64KB + 32KB)
      const payload = crypto.randomBytes(REMOTE_DOWNLOAD_CHUNK_SIZE * 2 + 32 * 1024);
      const expectedSha = crypto.createHash("sha256").update(payload).digest("hex");
      fs.writeFileSync(bigFile, payload);
      fs.writeFileSync(emptyFile, "");
      fs.mkdirSync(subDir);

      const reader = openDownloadStream(bigFile);
      assert.equal(reader.meta.fileName, "payload.bin");
      assert.equal(reader.meta.size, payload.byteLength);
      assert.equal(reader.meta.mimeType, "application/octet-stream");

      const chunks: Uint8Array[] = [];
      for await (const chunk of reader) {
        assert.ok(chunk.byteLength > 0);
        assert.ok(chunk.byteLength <= REMOTE_DOWNLOAD_CHUNK_SIZE);
        chunks.push(chunk);
      }

      assert.equal(chunks.length, 3);
      const reassembled = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      assert.equal(reassembled.byteLength, payload.byteLength);
      assert.equal(reassembled.equals(payload), true);
      assert.equal(reader.totalBytesRead, payload.byteLength);
      assert.equal(reader.sha256, expectedSha);

      // 0-byte file round-trip
      const emptyReader = openDownloadStream(emptyFile);
      const emptyStep = emptyReader.readNextChunk();
      assert.equal(emptyStep.done, true);
      assert.equal(emptyStep.size, 0);
      assert.equal(
        emptyStep.sha256,
        crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
      );

      // Directories and NUL-byte paths are rejected
      assert.throws(() => openDownloadStream(subDir));
      assert.throws(() => openDownloadStream(`${bigFile}\0.txt`));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Wave 2+3: LAN discovery & Wake-on-LAN", () => {
  it("builds exact 102-byte WoL magic packets for colon and dash MACs and rejects invalid MACs", () => {
    const colonPacket = buildWolMagicPacket("aa:bb:cc:11:22:33");
    assert.equal(colonPacket.length, 102);
    // First 6 bytes are 0xFF
    assert.deepEqual(
      Array.from(colonPacket.subarray(0, 6)),
      [0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    );
    // Followed by 16 repetitions of the 6-byte MAC
    const expectedMac = [0xaa, 0xbb, 0xcc, 0x11, 0x22, 0x33];
    for (let i = 0; i < 16; i += 1) {
      assert.deepEqual(
        Array.from(colonPacket.subarray(6 + i * 6, 12 + i * 6)),
        expectedMac,
      );
    }

    // Dash-separated MAC builds byte-identical packet
    const dashPacket = buildWolMagicPacket("AA-BB-CC-11-22-33");
    assert.equal(dashPacket.length, 102);
    assert.equal(dashPacket.equals(colonPacket), true);

    assert.equal(normalizeMacAddress("de-ad-be-ef-00-01"), "DE:AD:BE:EF:00:01");
    assert.equal(normalizeMacAddress("00:00:00:00:00:00"), null);

    // Invalid MAC addresses throw
    assert.throws(() => buildWolMagicPacket(""));
    assert.throws(() => buildWolMagicPacket("not-a-mac"));
    assert.throws(() => buildWolMagicPacket("AA:BB:CC:DD:EE"));
    assert.throws(() => buildWolMagicPacket("AA:BB:CC:DD:EE:GG"));
    assert.throws(() => buildWolMagicPacket("AA:BB-CC:DD:EE:FF"));
    assert.throws(() => buildWolMagicPacket("00:00:00:00:00:00"));
  });

  it("collects RFC1918/CGNAT LAN IPs, normalized MACs, and subnet broadcasts while filtering loopback & zero MACs", () => {
    const mockIfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
      lo0: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
      utun0: [
        {
          address: "100.64.12.34",
          netmask: "255.192.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "100.64.12.34/10",
        },
      ],
      en0: [
        {
          address: "fe80::1",
          netmask: "ffff:ffff:ffff:ffff::",
          family: "IPv6",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "fe80::1/64",
          scopeid: 4,
        },
        {
          address: "192.168.10.42",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "192.168.10.42/24",
        },
      ],
      en1: [
        {
          address: "8.8.8.8",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "11:22:33:44:55:66",
          internal: false,
          cidr: "8.8.8.8/24",
        },
        {
          address: "10.0.2.15",
          netmask: "255.255.0.0",
          family: "IPv4",
          mac: "de-ad-be-ef-00-01",
          internal: false,
          cidr: "10.0.2.15/16",
        },
      ],
    };

    const info = collectLocalNetworkInfo(mockIfaces);
    // Prefers RFC1918 over CGNAT
    assert.equal(info.lanIp, "192.168.10.42");
    assert.deepEqual(info.macAddresses, ["AA:BB:CC:DD:EE:FF", "DE:AD:BE:EF:00:01"]);
    assert.ok(info.broadcastAddresses.includes("192.168.10.255"));
    assert.ok(info.broadcastAddresses.includes("10.0.255.255"));
    assert.ok(info.broadcastAddresses.includes("100.127.255.255"));
    assert.equal(info.broadcastAddresses.includes("8.8.8.255"), false);

    // Live OS probe never throws and returns structured arrays
    const live = collectLocalNetworkInfo();
    assert.equal(typeof live.lanIp, "string");
    assert.ok(Array.isArray(live.macAddresses));
    assert.ok(Array.isArray(live.broadcastAddresses));
  });
});

describe("Wave 2+3: Remote terminal, relative mouse, block input, whiteboard, and accessMode", () => {
  const primaryDisplay: DisplayBounds = { x: 0, y: 0, width: 1920, height: 1080 };

  it("clamps terminal dimensions cleanly to 20..300 x 5..120 with 100x30 defaults", () => {
    assert.deepEqual(sanitizeTerminalSize(), { cols: 100, rows: 30 });
    assert.deepEqual(sanitizeTerminalSize(undefined, undefined), { cols: 100, rows: 30 });
    assert.deepEqual(sanitizeTerminalSize(Number.NaN, Number.POSITIVE_INFINITY), {
      cols: 100,
      rows: 30,
    });
    assert.deepEqual(sanitizeTerminalSize(5, 1), { cols: 20, rows: 5 });
    assert.deepEqual(sanitizeTerminalSize(999, 500), { cols: 300, rows: 120 });
    assert.deepEqual(sanitizeTerminalSize(132.4, 42.6), { cols: 132, rows: 43 });
  });

  it("translates mouse_move_relative, block_input, wol, whiteboard, and validates cursor shapes", () => {
    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "mouse_move_relative", dx: 12, dy: -8 },
        primaryDisplay,
        "darwin",
      ),
      [{ action: "mouse_move_relative", dx: 12, dy: -8 }],
    );

    // Clamps extreme relative deltas to [-2000, 2000]
    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "mouse_move_relative", dx: 9500, dy: -4200 },
        primaryDisplay,
        "win32",
      ),
      [{ action: "mouse_move_relative", dx: 2000, dy: -2000 }],
    );

    // Zero relative move produces no HID event
    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "mouse_move_relative", dx: 0, dy: 0 },
        primaryDisplay,
        "darwin",
      ),
      [],
    );

    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "block_input", enabled: true },
        primaryDisplay,
        "darwin",
      ),
      [{ action: "block_input", enabled: true }],
    );
    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "block_input", enabled: false },
        primaryDisplay,
        "win32",
      ),
      [{ action: "block_input", enabled: false }],
    );

    // WoL & whiteboard are host-level actions and never emit raw HID events
    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "wol", macAddress: "AA:BB:CC:DD:EE:FF" },
        primaryDisplay,
        "darwin",
      ),
      [],
    );
    assert.deepEqual(
      translateControlCommandToNativeEvents(
        { action: "whiteboard", op: "clear" },
        primaryDisplay,
        "darwin",
      ),
      [],
    );

    assert.equal(normalizeCursorShape("text"), "text");
    assert.equal(normalizeCursorShape("ew-resize"), "ew-resize");
    assert.equal(normalizeCursorShape("unknown-custom"), "default");

    const stroke = sanitizeWhiteboardStroke({
      id: "s-1",
      color: "#00ff88",
      width: 6,
      points: [
        { x: -0.2, y: 0.5 },
        { x: 1.4, y: 0.25 },
      ],
    });
    assert.ok(stroke);
    assert.equal(stroke.id, "s-1");
    assert.equal(stroke.color, "#00ff88");
    assert.equal(stroke.width, 6);
    assert.deepEqual(stroke.points, [
      { x: 0, y: 0.5 },
      { x: 1, y: 0.25 },
    ]);
    assert.equal(sanitizeWhiteboardStroke({ points: [] }), null);
  });

  it("defaults hostAccessMode to 'auto' and persists 'confirm' atomically while sanitizing invalid values", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velodeck-access-mode-"));
    const settingsPath = path.join(tmpDir, "desktop-settings.json");

    try {
      assert.equal(sanitizeHostAccessMode("auto"), "auto");
      assert.equal(sanitizeHostAccessMode("confirm"), "confirm");
      assert.equal(sanitizeHostAccessMode("always-allow"), undefined);

      const initial = loadSettings(settingsPath);
      const ensured = ensureHostSettings(initial, "Approval-Mac");
      assert.equal(ensured.settings.hostAccessMode, "auto");

      const confirmSettings: DesktopSettings = {
        ...ensured.settings,
        hostAccessMode: "confirm",
      };
      saveSettingsAtomic(settingsPath, confirmSettings);

      const loaded = loadSettings(settingsPath);
      assert.equal(loaded.hostAccessMode, "confirm");
      assert.deepEqual(loaded, confirmSettings);

      // Invalid persisted value is sanitized away and re-defaulted by ensureHostSettings
      const rawJson = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<
        string,
        unknown
      >;
      rawJson.hostAccessMode = "bogus-mode";
      fs.writeFileSync(settingsPath, JSON.stringify(rawJson), "utf8");

      const loadedInvalid = loadSettings(settingsPath);
      assert.equal(loadedInvalid.hostAccessMode, undefined);
      const reEnsured = ensureHostSettings(loadedInvalid);
      assert.equal(reEnsured.changed, true);
      assert.equal(reEnsured.settings.hostAccessMode, "auto");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("spawns an interactive remote terminal session, streams output, enforces max 4 concurrent shells, and cleans up", async () => {
    const events: RemoteTerminalEvent[] = [];
    const manager = new RemoteTerminalManager({
      onEvent: (ev) => {
        events.push(ev);
      },
    });

    try {
      const opened = manager.open("t-1", 80, 24);
      assert.equal(opened, true);
      assert.equal(manager.activeCount, 1);
      assert.equal(events[0]?.type, "term_ready");

      assert.equal(manager.resize("t-1", 120, 40), true);
      assert.equal(manager.write("t-1", "echo VELODECK_PTY_OK\n"), true);

      // Wait briefly for shell output to arrive
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const combined = events
          .filter((e): e is Extract<RemoteTerminalEvent, { type: "term_data" }> => e.type === "term_data")
          .map((e) => e.data)
          .join("");
        if (combined.includes("VELODECK_PTY_OK")) {
          break;
        }
        await new Promise((r) => setTimeout(r, 40));
      }

      const output = events
        .filter((e): e is Extract<RemoteTerminalEvent, { type: "term_data" }> => e.type === "term_data")
        .map((e) => e.data)
        .join("");
      assert.ok(output.includes("VELODECK_PTY_OK"));

      // Open 3 more sessions (total 4) and verify 5th is rejected
      assert.equal(manager.open("t-2"), true);
      assert.equal(manager.open("t-3"), true);
      assert.equal(manager.open("t-4"), true);
      assert.equal(manager.activeCount, 4);
      assert.equal(manager.open("t-5"), false);
      assert.ok(events.some((e) => e.type === "term_error" && e.termId === "t-5"));
    } finally {
      manager.closeAll();
      assert.equal(manager.activeCount, 0);
    }
  });

  it("announces public LAN discovery metadata without leaking secrets on UDP probe", async () => {
    const dgram = await import("node:dgram");
    const testPort = 21129 + Math.floor(Math.random() * 500);
    const service = new LanDiscoveryService({
      port: testPort,
      getAnnouncement: () => ({
        deviceId: "desktop-lan-peer-1",
        name: "Studio Mac",
        osPlatform: "darwin",
        controlCode: "123456789",
      }),
    });

    service.start();
    await new Promise((r) => setTimeout(r, 60));

    const client = dgram.createSocket("udp4");
    try {
      const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("UDP announce timeout")), 1500);
        client.once("message", (buf) => {
          clearTimeout(timer);
          resolve(JSON.parse(buf.toString("utf8")) as Record<string, unknown>);
        });
        client.bind(0, () => {
          const probe = Buffer.from(JSON.stringify({ v: 1, cmd: "discover" }), "utf8");
          client.send(probe, 0, probe.length, testPort, "127.0.0.1");
        });
      });

      assert.equal(reply.v, 1);
      assert.equal(reply.cmd, "announce");
      assert.equal(reply.deviceId, "desktop-lan-peer-1");
      assert.equal(reply.name, "Studio Mac");
      assert.equal(reply.osPlatform, "darwin");
      assert.equal(reply.controlCode, "123456789");
      assert.equal("deviceSecret" in reply, false);
      assert.equal("controlPassword" in reply, false);
      assert.equal("authToken" in reply, false);
    } finally {
      client.close();
      service.stop();
    }
  });
});
