import { afterEach, describe, expect, it } from "vitest";
import {
  KEYMAP_MODE_STORAGE_KEY,
  detectLocalOsPlatform,
  isCrossOsDesktopPair,
  loadKeyboardMappingMode,
  mapKeyboardEventForTarget,
  saveKeyboardMappingMode,
  toDesktopOsPlatform,
} from "./keymap";
import type { VeloDeckDesktopBridge } from "./bridge";

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

describe("detectLocalOsPlatform", () => {
  const originalWindow = globalThis.window;
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
    if (originalNavigator === undefined) {
      delete (globalThis as { navigator?: unknown }).navigator;
    } else {
      Object.defineProperty(globalThis, "navigator", {
        value: originalNavigator,
        configurable: true,
      });
    }
  });

  it("prefers window.velodeckDesktop.platform over navigator hints", () => {
    (globalThis as { window?: unknown }).window = {
      velodeckDesktop: {
        platform: "darwin",
      } as unknown as VeloDeckDesktopBridge,
    };
    Object.defineProperty(globalThis, "navigator", {
      value: { platform: "Win32", userAgent: "Windows NT 10.0" },
      configurable: true,
    });
    expect(detectLocalOsPlatform()).toBe("darwin");

    (globalThis as { window?: unknown }).window = {
      velodeckDesktop: {
        platform: "win32",
      } as unknown as VeloDeckDesktopBridge,
    };
    expect(detectLocalOsPlatform()).toBe("win32");
  });

  it("falls back to navigator.platform and navigator.userAgent cleanly", () => {
    delete (globalThis as { window?: unknown }).window;

    Object.defineProperty(globalThis, "navigator", {
      value: { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)" },
      configurable: true,
    });
    expect(detectLocalOsPlatform()).toBe("darwin");

    Object.defineProperty(globalThis, "navigator", {
      value: { platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      configurable: true,
    });
    expect(detectLocalOsPlatform()).toBe("win32");

    Object.defineProperty(globalThis, "navigator", {
      value: { platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" },
      configurable: true,
    });
    expect(detectLocalOsPlatform()).toBe("linux");
  });
});

describe("mapKeyboardEventForTarget", () => {
  it("passes through unchanged in raw mode, missing targetOs, or same-family OS pairs", () => {
    const cmdC = {
      code: "KeyC",
      key: "c",
      modifiers: { ctrl: false, alt: false, shift: false, meta: true },
    };

    expect(mapKeyboardEventForTarget(cmdC, "darwin", "win32", "raw")).toEqual(cmdC);
    expect(mapKeyboardEventForTarget(cmdC, "darwin", undefined, "smart")).toEqual(cmdC);
    expect(mapKeyboardEventForTarget(cmdC, "darwin", "darwin", "smart")).toEqual(cmdC);

    const ctrlC = {
      code: "KeyC",
      key: "c",
      modifiers: { ctrl: true, alt: false, shift: false, meta: false },
    };
    expect(mapKeyboardEventForTarget(ctrlC, "win32", "linux", "smart")).toEqual(ctrlC);
    expect(mapKeyboardEventForTarget(ctrlC, "linux", "win32", "smart")).toEqual(ctrlC);
    expect(mapKeyboardEventForTarget(ctrlC, "win32", "win32", "smart")).toEqual(ctrlC);
  });

  it("remaps Mac Cmd+<shortcut> to Ctrl+<shortcut> when controlling Windows or Linux", () => {
    const shortcutCodes = [
      ["KeyC", "c"],
      ["KeyV", "v"],
      ["KeyX", "x"],
      ["KeyZ", "z"],
      ["KeyY", "y"],
      ["KeyA", "a"],
      ["KeyS", "s"],
      ["KeyF", "f"],
      ["KeyP", "p"],
      ["KeyR", "r"],
      ["KeyT", "t"],
      ["KeyW", "w"],
      ["KeyN", "n"],
      ["KeyL", "l"],
      ["KeyK", "k"],
      ["KeyO", "o"],
      ["Slash", "/"],
      ["Equal", "="],
      ["Minus", "-"],
      ["Digit0", "0"],
      ["Backspace", "Backspace"],
      ["Enter", "Enter"],
      ["ArrowLeft", "ArrowLeft"],
      ["ArrowRight", "ArrowRight"],
      ["ArrowUp", "ArrowUp"],
      ["ArrowDown", "ArrowDown"],
      ["BracketLeft", "["],
      ["BracketRight", "]"],
    ] as const;

    for (const targetOs of ["win32", "linux"] as const) {
      for (const [code, key] of shortcutCodes) {
        const res = mapKeyboardEventForTarget(
          { code, key, modifiers: { meta: true } },
          "darwin",
          targetOs,
          "smart",
        );
        expect(res).toEqual({
          code,
          key,
          modifiers: { ctrl: true, alt: false, shift: false, meta: false },
        });
      }
    }
  });

  it("preserves Shift/Alt alongside remapped Cmd -> Ctrl (e.g. Cmd+Shift+Z -> Ctrl+Shift+Z)", () => {
    const res = mapKeyboardEventForTarget(
      { code: "KeyZ", key: "Z", modifiers: { meta: true, shift: true } },
      "darwin",
      "win32",
      "smart",
    );
    expect(res).toEqual({
      code: "KeyZ",
      key: "Z",
      modifiers: { ctrl: true, alt: false, shift: true, meta: false },
    });
  });

  it("keeps explicit Ctrl+C untouched on Mac -> Windows/Linux (for terminal SIGINT)", () => {
    const res = mapKeyboardEventForTarget(
      { code: "KeyC", key: "c", modifiers: { ctrl: true, meta: false } },
      "darwin",
      "linux",
      "smart",
    );
    expect(res).toEqual({
      code: "KeyC",
      key: "c",
      modifiers: { ctrl: true, alt: false, shift: false, meta: false },
    });
  });

  it("keeps standalone MetaLeft/MetaRight as Meta and maps Cmd+Space to MetaLeft (Win search)", () => {
    expect(
      mapKeyboardEventForTarget(
        { code: "MetaLeft", key: "Meta", modifiers: { meta: true } },
        "darwin",
        "win32",
        "smart",
      ),
    ).toEqual({
      code: "MetaLeft",
      key: "Meta",
      modifiers: { ctrl: false, alt: false, shift: false, meta: true },
    });

    expect(
      mapKeyboardEventForTarget(
        { code: "MetaRight", key: "Meta", modifiers: { meta: true } },
        "darwin",
        "win32",
        "smart",
      ),
    ).toEqual({
      code: "MetaRight",
      key: "Meta",
      modifiers: { ctrl: false, alt: false, shift: false, meta: true },
    });

    expect(
      mapKeyboardEventForTarget(
        { code: "Space", key: " ", modifiers: { meta: true } },
        "darwin",
        "win32",
        "smart",
      ),
    ).toEqual({
      code: "MetaLeft",
      key: "Meta",
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    });
  });

  it("remaps Windows/Linux Ctrl+<shortcut> to Mac Cmd+<shortcut>", () => {
    const codes = [
      ["KeyC", "c"],
      ["KeyV", "v"],
      ["KeyX", "x"],
      ["KeyZ", "z"],
      ["KeyA", "a"],
      ["KeyS", "s"],
      ["KeyF", "f"],
      ["KeyW", "w"],
      ["KeyT", "t"],
      ["KeyN", "n"],
      ["KeyR", "r"],
      ["KeyL", "l"],
      ["KeyO", "o"],
      ["KeyP", "p"],
      ["Space", " "],
    ] as const;

    for (const localOs of ["win32", "linux"] as const) {
      for (const [code, key] of codes) {
        const res = mapKeyboardEventForTarget(
          { code, key, modifiers: { ctrl: true } },
          localOs,
          "darwin",
          "smart",
        );
        expect(res).toEqual({
          code,
          key,
          modifiers: { ctrl: false, alt: false, shift: false, meta: true },
        });
      }
    }
  });

  it("leaves Meta combos and non-shortcut keys untouched when Windows/Linux controls Mac", () => {
    const winKey = {
      code: "KeyL",
      key: "l",
      modifiers: { meta: true, ctrl: false, alt: false, shift: false },
    };
    expect(mapKeyboardEventForTarget(winKey, "win32", "darwin", "smart")).toEqual(winKey);

    const plainKey = {
      code: "KeyC",
      key: "c",
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    };
    expect(mapKeyboardEventForTarget(plainKey, "win32", "darwin", "smart")).toEqual(plainKey);
  });

  it("does not mutate the caller's modifiers object", () => {
    const originalMods = { meta: true, ctrl: false, alt: false, shift: false };
    mapKeyboardEventForTarget(
      { code: "KeyC", key: "c", modifiers: originalMods },
      "darwin",
      "win32",
      "smart",
    );
    expect(originalMods).toEqual({ meta: true, ctrl: false, alt: false, shift: false });
  });
});

describe("keymap helpers & persistence", () => {
  it("persists and restores keyboard mapping mode with 'smart' default", () => {
    const storage = createMemoryStorage();
    expect(loadKeyboardMappingMode(storage)).toBe("smart");

    saveKeyboardMappingMode("raw", storage);
    expect(storage.getItem(KEYMAP_MODE_STORAGE_KEY)).toBe("raw");
    expect(loadKeyboardMappingMode(storage)).toBe("raw");

    saveKeyboardMappingMode("smart", storage);
    expect(loadKeyboardMappingMode(storage)).toBe("smart");

    storage.setItem(KEYMAP_MODE_STORAGE_KEY, "invalid-value");
    expect(loadKeyboardMappingMode(storage)).toBe("smart");
  });

  it("identifies cross-OS desktop pairs and filters non-desktop platforms", () => {
    expect(toDesktopOsPlatform("darwin")).toBe("darwin");
    expect(toDesktopOsPlatform("win32")).toBe("win32");
    expect(toDesktopOsPlatform("linux")).toBe("linux");
    expect(toDesktopOsPlatform("android")).toBeUndefined();
    expect(toDesktopOsPlatform(undefined)).toBeUndefined();

    expect(isCrossOsDesktopPair("darwin", "win32")).toBe(true);
    expect(isCrossOsDesktopPair("darwin", "linux")).toBe(true);
    expect(isCrossOsDesktopPair("win32", "darwin")).toBe(true);
    expect(isCrossOsDesktopPair("linux", "darwin")).toBe(true);
    expect(isCrossOsDesktopPair("darwin", "darwin")).toBe(false);
    expect(isCrossOsDesktopPair("win32", "linux")).toBe(false);
    expect(isCrossOsDesktopPair("darwin", undefined)).toBe(false);
  });
});
