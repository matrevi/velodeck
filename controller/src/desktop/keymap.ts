import type { DevicePlatform, KeyModifiers } from "@velodeck/protocol";
import { getDesktopBridge } from "./bridge";

export type DesktopOsPlatform = "darwin" | "win32" | "linux";
export type KeyboardMappingMode = "smart" | "raw";

export interface KeyboardEventInput {
  code: string;
  key: string;
  modifiers: KeyModifiers;
}

export const KEYMAP_MODE_STORAGE_KEY = "velodeck.desktop.keymapMode.v1";

/**
 * Common macOS Cmd+<key> shortcuts that map directly to Ctrl+<key> on Windows / Linux.
 * Intentionally excludes standalone Meta and system-level Win keys (e.g. Win+D, Win+E, Win+Tab).
 */
const MAC_TO_WIN_CTRL_CODES = new Set<string>([
  "KeyC",
  "KeyV",
  "KeyX",
  "KeyZ",
  "KeyY",
  "KeyA",
  "KeyS",
  "KeyF",
  "KeyP",
  "KeyR",
  "KeyT",
  "KeyW",
  "KeyN",
  "KeyL",
  "KeyK",
  "KeyO",
  "KeyB",
  "KeyI",
  "KeyU",
  "Slash",
  "Equal",
  "Minus",
  "Digit0",
  "Backspace",
  "Enter",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "BracketLeft",
  "BracketRight",
]);

/**
 * Common Windows / Linux Ctrl+<key> shortcuts that map natively to Cmd+<key> on macOS.
 */
const WIN_TO_MAC_META_CODES = new Set<string>([
  "KeyC",
  "KeyV",
  "KeyX",
  "KeyZ",
  "KeyY",
  "KeyA",
  "KeyS",
  "KeyF",
  "KeyW",
  "KeyT",
  "KeyN",
  "KeyR",
  "KeyL",
  "KeyO",
  "KeyP",
  "KeyK",
  "KeyB",
  "KeyI",
  "KeyU",
  "Space",
  "Slash",
  "Equal",
  "Minus",
  "Digit0",
  "BracketLeft",
  "BracketRight",
  "Enter",
  "Backspace",
]);

function normalizeModifiers(modifiers: KeyModifiers | undefined): Required<KeyModifiers> {
  return {
    ctrl: Boolean(modifiers?.ctrl),
    alt: Boolean(modifiers?.alt),
    shift: Boolean(modifiers?.shift),
    meta: Boolean(modifiers?.meta),
  };
}

function getSafeStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    return null;
  }
  return null;
}

export function toDesktopOsPlatform(
  platform: DevicePlatform | undefined,
): DesktopOsPlatform | undefined {
  if (platform === "darwin" || platform === "win32" || platform === "linux") {
    return platform;
  }
  return undefined;
}

export function isCrossOsDesktopPair(
  localOs: DesktopOsPlatform,
  targetOs: DesktopOsPlatform | undefined,
): boolean {
  if (!targetOs) return false;
  return (localOs === "darwin") !== (targetOs === "darwin");
}

export function formatDesktopOsShortLabel(os: DesktopOsPlatform | undefined): string {
  switch (os) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return "桌面";
  }
}

/**
 * Detects the local controller OS platform.
 * Checks `window.velodeckDesktop?.platform` first, then `navigator.platform` / `navigator.userAgent`.
 */
export function detectLocalOsPlatform(): DesktopOsPlatform {
  const bridgePlatform = getDesktopBridge()?.platform;
  if (
    bridgePlatform === "darwin" ||
    bridgePlatform === "win32" ||
    bridgePlatform === "linux"
  ) {
    return bridgePlatform;
  }

  if (typeof navigator !== "undefined") {
    const rawPlatform = (navigator.platform || "").toLowerCase();
    const rawUa = (navigator.userAgent || "").toLowerCase();
    const combined = `${rawPlatform} ${rawUa}`;

    if (
      rawPlatform.includes("mac") ||
      rawUa.includes("macintosh") ||
      rawUa.includes("mac os x")
    ) {
      return "darwin";
    }
    if (
      rawPlatform.includes("win") ||
      rawUa.includes("windows") ||
      combined.includes("win64") ||
      combined.includes("win32")
    ) {
      return "win32";
    }
  }

  return "linux";
}

/**
 * Remaps cross-OS desktop shortcut modifiers (Mac <-> Windows/Linux) in `"smart"` mode,
 * while passing same-OS pairs, raw mode, and terminal Ctrl combos through cleanly.
 */
export function mapKeyboardEventForTarget(
  input: KeyboardEventInput,
  localOs: DesktopOsPlatform,
  targetOs: DesktopOsPlatform | undefined,
  mode: KeyboardMappingMode,
): KeyboardEventInput {
  const mods = normalizeModifiers(input.modifiers);

  if (mode === "raw" || !targetOs || (localOs === "darwin") === (targetOs === "darwin")) {
    return {
      code: input.code,
      key: input.key,
      modifiers: mods,
    };
  }

  // Mac controlling Windows / Linux
  if (localOs === "darwin") {
    // Standalone MetaLeft / MetaRight remains Win key
    if (input.code === "MetaLeft" || input.code === "MetaRight") {
      return {
        code: input.code,
        key: input.key,
        modifiers: mods,
      };
    }

    // Cmd + Space -> Win search (MetaLeft)
    if (
      input.code === "Space" &&
      mods.meta &&
      !mods.ctrl &&
      !mods.alt &&
      !mods.shift
    ) {
      return {
        code: "MetaLeft",
        key: "Meta",
        modifiers: {
          ctrl: false,
          alt: false,
          shift: false,
          meta: false,
        },
      };
    }

    // Common Cmd+<key> combos -> Ctrl+<key> (leaving explicit Ctrl+C SIGINT untouched)
    if (mods.meta && !mods.ctrl && MAC_TO_WIN_CTRL_CODES.has(input.code)) {
      return {
        code: input.code,
        key: input.key,
        modifiers: {
          ...mods,
          ctrl: true,
          meta: false,
        },
      };
    }

    return {
      code: input.code,
      key: input.key,
      modifiers: mods,
    };
  }

  // Windows / Linux controlling Mac
  if (mods.ctrl && !mods.meta && WIN_TO_MAC_META_CODES.has(input.code)) {
    return {
      code: input.code,
      key: input.key,
      modifiers: {
        ...mods,
        ctrl: false,
        meta: true,
      },
    };
  }

  return {
    code: input.code,
    key: input.key,
    modifiers: mods,
  };
}

export function loadKeyboardMappingMode(storage?: Storage): KeyboardMappingMode {
  const store = getSafeStorage(storage);
  if (!store) return "smart";
  try {
    const raw = store.getItem(KEYMAP_MODE_STORAGE_KEY);
    return raw === "raw" ? "raw" : "smart";
  } catch {
    return "smart";
  }
}

export function saveKeyboardMappingMode(
  mode: KeyboardMappingMode,
  storage?: Storage,
): void {
  const store = getSafeStorage(storage);
  if (!store) return;
  try {
    store.setItem(KEYMAP_MODE_STORAGE_KEY, mode === "raw" ? "raw" : "smart");
  } catch {
    // Ignore storage quota errors
  }
}
