import type { DevicePlatform, KeyModifiers } from "@velodeck/protocol";
import { getDesktopBridge } from "./bridge";

export type DesktopOsPlatform = "darwin" | "win32" | "linux";
export type KeyboardMappingMode = "smart" | "raw";

export interface KeyboardEventInput {
  code: string;
  key: string;
  modifiers: KeyModifiers;
}

export interface MappedKeyCommand {
  phase: "down" | "up" | "press";
  code: string;
  key: string;
  modifiers: Required<KeyModifiers>;
}

const MODIFIER_CODES = new Set<string>([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

const ALL_FALSE_MODIFIERS: Required<KeyModifiers> = {
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
};

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

    // Common Cmd+<key> combos -> Ctrl+<key> (leaving explicit Ctrl+C SIGINT and Cmd+Opt+<key> untouched)
    if (mods.meta && !mods.ctrl && !mods.alt && MAC_TO_WIN_CTRL_CODES.has(input.code)) {
      if (input.code === "ArrowLeft") {
        return {
          code: "Home",
          key: "Home",
          modifiers: {
            ctrl: false,
            alt: false,
            shift: mods.shift,
            meta: false,
          },
        };
      }
      if (input.code === "ArrowRight") {
        return {
          code: "End",
          key: "End",
          modifiers: {
            ctrl: false,
            alt: false,
            shift: mods.shift,
            meta: false,
          },
        };
      }
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
  if (mods.ctrl && !mods.meta && !mods.alt && WIN_TO_MAC_META_CODES.has(input.code)) {
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

/**
 * Stateful cross-OS keyboard mapper that buffers standalone Meta (Mac -> Win/Linux)
 * or Control (Win/Linux -> Mac) presses until the combo key arrives so:
 * - Cmd+L on Mac NEVER holds VK_LWIN on Windows (preventing accidental Win+L lock)
 * - Cmd+ArrowLeft / Cmd+ArrowRight emit Home / End cleanly without ControlLeft
 * - Cmd+Space emits a single MetaLeft press with zero duplicates
 * - macOS Chromium's suppressed non-modifier keyup while Meta is held is cleanly flushed on Meta keyup
 * - Local Electron shortcuts can call cancelPendingModifier() so releasing Meta won't pop up the Start Menu
 */
export class CrossOsKeymapSession {
  private pendingMetaCode: "MetaLeft" | "MetaRight" | null = null;
  private pendingMetaModifiers: Required<KeyModifiers> = { ...ALL_FALSE_MODIFIERS };
  private pendingMetaConsumed = false;
  private pendingMetaOtherKeyPressed = false;

  private pendingCtrlCode: "ControlLeft" | "ControlRight" | null = null;
  private pendingCtrlModifiers: Required<KeyModifiers> = { ...ALL_FALSE_MODIFIERS };
  private pendingCtrlConsumed = false;
  private pendingCtrlOtherKeyPressed = false;

  private synthesizedCtrlDown = false;
  private synthesizedMetaDown = false;

  private readonly heldRemoteKeys = new Map<
    string,
    { code: string; key: string; isModifier: boolean }
  >();
  private readonly physicalToRemote = new Map<string, { code: string; key: string }>();
  private readonly suppressedPhysicalKeys = new Set<string>();

  handleKeyDown(
    input: KeyboardEventInput,
    localOs: DesktopOsPlatform,
    targetOs: DesktopOsPlatform | undefined,
    mode: KeyboardMappingMode,
    repeat = false,
  ): MappedKeyCommand[] {
    const mods = normalizeModifiers(input.modifiers);
    const out: MappedKeyCommand[] = [];
    const isSmartCrossOs =
      mode === "smart" && Boolean(targetOs) && (localOs === "darwin") !== (targetOs === "darwin");

    if (!isSmartCrossOs) {
      this.suppressedPhysicalKeys.delete(input.code);
      out.push({
        phase: "down",
        code: input.code,
        key: input.key,
        modifiers: mods,
      });
      this.recordDown(input.code, input.code, input.key);
      return out;
    }

    // Mac controlling Windows / Linux (smart mode)
    if (localOs === "darwin") {
      if (input.code === "MetaLeft" || input.code === "MetaRight") {
        if (
          repeat ||
          this.pendingMetaCode === input.code ||
          this.pendingMetaConsumed ||
          this.heldRemoteKeys.has(input.code)
        ) {
          return out;
        }
        this.pendingMetaCode = input.code;
        this.pendingMetaModifiers = { ...mods, meta: true };
        this.pendingMetaConsumed = false;
        this.pendingMetaOtherKeyPressed = false;
        return out;
      }

      // Secondary modifier pressed while Meta is still buffered (e.g. Cmd+Shift+Z or Cmd+Opt+I):
      // keep Meta buffered until the non-modifier key arrives.
      if (this.pendingMetaCode !== null && MODIFIER_CODES.has(input.code)) {
        this.pendingMetaOtherKeyPressed = true;
        this.suppressedPhysicalKeys.delete(input.code);
        const metaHeldOnRemote =
          this.heldRemoteKeys.has("MetaLeft") || this.heldRemoteKeys.has("MetaRight");
        const effectiveMods: Required<KeyModifiers> = {
          ...mods,
          ctrl: this.synthesizedCtrlDown || mods.ctrl,
          meta: metaHeldOnRemote,
        };
        out.push({
          phase: "down",
          code: input.code,
          key: input.key,
          modifiers: effectiveMods,
        });
        this.recordDown(input.code, input.code, input.key);
        return out;
      }

      // Cmd + Space -> single Win key press (Windows Search / Start)
      if (
        input.code === "Space" &&
        mods.meta &&
        !mods.ctrl &&
        !mods.alt &&
        !mods.shift
      ) {
        this.pendingMetaCode = null;
        this.pendingMetaConsumed = true;
        this.suppressedPhysicalKeys.add("Space");
        if (repeat) {
          return out;
        }
        if (this.synthesizedCtrlDown) {
          this.releaseSynthesizedCtrl(out, { ...ALL_FALSE_MODIFIERS });
        }
        out.push({
          phase: "press",
          code: "MetaLeft",
          key: "Meta",
          modifiers: { ...ALL_FALSE_MODIFIERS },
        });
        return out;
      }

      // Common Cmd+<key> -> Ctrl+<key> (or Home/End for ArrowLeft/ArrowRight), guarding !mods.alt
      if (mods.meta && !mods.ctrl && !mods.alt && MAC_TO_WIN_CTRL_CODES.has(input.code)) {
        this.pendingMetaCode = null;
        this.pendingMetaConsumed = true;
        this.suppressedPhysicalKeys.delete(input.code);

        if (input.code === "ArrowLeft" || input.code === "ArrowRight") {
          const navCode = input.code === "ArrowLeft" ? "Home" : "End";
          if (this.synthesizedCtrlDown) {
            this.releaseSynthesizedCtrl(out, {
              ctrl: false,
              alt: false,
              shift: mods.shift,
              meta: false,
            });
          }
          const navMods: Required<KeyModifiers> = {
            ctrl: false,
            alt: false,
            shift: mods.shift,
            meta: false,
          };
          out.push({
            phase: "down",
            code: navCode,
            key: navCode,
            modifiers: navMods,
          });
          this.recordDown(input.code, navCode, navCode);
          return out;
        }

        const ctrlMods: Required<KeyModifiers> = {
          ctrl: true,
          alt: false,
          shift: mods.shift,
          meta: false,
        };
        if (!this.synthesizedCtrlDown && !this.heldRemoteKeys.has("ControlLeft")) {
          out.push({
            phase: "down",
            code: "ControlLeft",
            key: "Control",
            modifiers: ctrlMods,
          });
          this.synthesizedCtrlDown = true;
          this.heldRemoteKeys.set("ControlLeft", {
            code: "ControlLeft",
            key: "Control",
            isModifier: true,
          });
        }
        out.push({
          phase: "down",
          code: input.code,
          key: input.key,
          modifiers: ctrlMods,
        });
        this.recordDown(input.code, input.code, input.key);
        return out;
      }

      // Other non-mapped keys with Cmd held (e.g. Cmd+D, Cmd+E, Cmd+Tab, Cmd+Opt+I):
      // flush buffered MetaLeft/MetaRight down first, then emit the key with original modifiers.
      if (mods.meta) {
        if (this.synthesizedCtrlDown) {
          this.releaseSynthesizedCtrl(out, { ...mods, ctrl: false });
        }
        this.flushPendingMeta(out, mods);
        this.suppressedPhysicalKeys.delete(input.code);
        out.push({
          phase: "down",
          code: input.code,
          key: input.key,
          modifiers: mods,
        });
        this.recordDown(input.code, input.code, input.key);
        return out;
      }

      // Regular key without Cmd (including explicit Ctrl+C SIGINT)
      if (this.pendingMetaCode !== null) {
        this.pendingMetaCode = null;
        this.pendingMetaConsumed = false;
        this.pendingMetaOtherKeyPressed = false;
      }
      if (this.synthesizedCtrlDown) {
        this.releaseSynthesizedCtrl(out, mods);
      }
      this.suppressedPhysicalKeys.delete(input.code);
      out.push({
        phase: "down",
        code: input.code,
        key: input.key,
        modifiers: mods,
      });
      this.recordDown(input.code, input.code, input.key);
      return out;
    }

    // Windows / Linux controlling Mac (smart mode)
    if (input.code === "ControlLeft" || input.code === "ControlRight") {
      if (
        repeat ||
        this.pendingCtrlCode === input.code ||
        this.pendingCtrlConsumed ||
        this.heldRemoteKeys.has(input.code)
      ) {
        return out;
      }
      this.pendingCtrlCode = input.code;
      this.pendingCtrlModifiers = { ...mods, ctrl: true };
      this.pendingCtrlConsumed = false;
      this.pendingCtrlOtherKeyPressed = false;
      return out;
    }

    // Secondary modifier pressed while Control is buffered (e.g. Ctrl+Shift+Z or Ctrl+Alt+Del)
    if (this.pendingCtrlCode !== null && MODIFIER_CODES.has(input.code)) {
      this.pendingCtrlOtherKeyPressed = true;
      this.suppressedPhysicalKeys.delete(input.code);
      const ctrlHeldOnRemote =
        this.heldRemoteKeys.has("ControlLeft") || this.heldRemoteKeys.has("ControlRight");
      const effectiveMods: Required<KeyModifiers> = {
        ...mods,
        ctrl: ctrlHeldOnRemote,
        meta: this.synthesizedMetaDown || mods.meta,
      };
      out.push({
        phase: "down",
        code: input.code,
        key: input.key,
        modifiers: effectiveMods,
      });
      this.recordDown(input.code, input.code, input.key);
      return out;
    }

    // Common Ctrl+<key> -> Cmd+<key> on macOS (guarding !mods.alt)
    if (mods.ctrl && !mods.meta && !mods.alt && WIN_TO_MAC_META_CODES.has(input.code)) {
      this.pendingCtrlCode = null;
      this.pendingCtrlConsumed = true;
      this.suppressedPhysicalKeys.delete(input.code);

      const metaMods: Required<KeyModifiers> = {
        ctrl: false,
        alt: false,
        shift: mods.shift,
        meta: true,
      };
      if (!this.synthesizedMetaDown && !this.heldRemoteKeys.has("MetaLeft")) {
        out.push({
          phase: "down",
          code: "MetaLeft",
          key: "Meta",
          modifiers: metaMods,
        });
        this.synthesizedMetaDown = true;
        this.heldRemoteKeys.set("MetaLeft", {
          code: "MetaLeft",
          key: "Meta",
          isModifier: true,
        });
      }
      out.push({
        phase: "down",
        code: input.code,
        key: input.key,
        modifiers: metaMods,
      });
      this.recordDown(input.code, input.code, input.key);
      return out;
    }

    // Non-mapped Ctrl combo (e.g. Ctrl+D EOF, Ctrl+Backslash, Ctrl+Alt+...):
    // flush buffered ControlLeft/ControlRight down first, then emit key.
    if (mods.ctrl) {
      if (this.synthesizedMetaDown) {
        this.releaseSynthesizedMeta(out, { ...mods, meta: false });
      }
      this.flushPendingCtrl(out, mods);
      this.suppressedPhysicalKeys.delete(input.code);
      out.push({
        phase: "down",
        code: input.code,
        key: input.key,
        modifiers: mods,
      });
      this.recordDown(input.code, input.code, input.key);
      return out;
    }

    // Regular key without Ctrl
    if (this.pendingCtrlCode !== null) {
      this.pendingCtrlCode = null;
      this.pendingCtrlConsumed = false;
      this.pendingCtrlOtherKeyPressed = false;
    }
    if (this.synthesizedMetaDown) {
      this.releaseSynthesizedMeta(out, mods);
    }
    this.suppressedPhysicalKeys.delete(input.code);
    out.push({
      phase: "down",
      code: input.code,
      key: input.key,
      modifiers: mods,
    });
    this.recordDown(input.code, input.code, input.key);
    return out;
  }

  handleKeyUp(
    input: KeyboardEventInput,
    localOs: DesktopOsPlatform,
    targetOs: DesktopOsPlatform | undefined,
    mode: KeyboardMappingMode,
  ): MappedKeyCommand[] {
    const mods = normalizeModifiers(input.modifiers);
    const out: MappedKeyCommand[] = [];

    if (this.suppressedPhysicalKeys.has(input.code)) {
      this.suppressedPhysicalKeys.delete(input.code);
      return out;
    }

    if (input.code === "MetaLeft" || input.code === "MetaRight") {
      // macOS Chromium suppresses non-modifier keyup events while Meta is held.
      // Always flush any remaining held non-modifier keys BEFORE releasing modifiers.
      if (localOs === "darwin") {
        const metaHeldOnRemote =
          this.heldRemoteKeys.has("MetaLeft") || this.heldRemoteKeys.has("MetaRight");
        this.flushHeldNonModifiers(out, {
          ctrl: this.synthesizedCtrlDown || mods.ctrl,
          alt: mods.alt,
          shift: mods.shift,
          meta: metaHeldOnRemote,
        });
      }

      if (this.synthesizedCtrlDown) {
        this.releaseSynthesizedCtrl(out, {
          ...mods,
          ctrl: false,
          meta: false,
        });
      }

      if (this.pendingMetaCode === input.code) {
        const shouldTap = !this.pendingMetaConsumed && !this.pendingMetaOtherKeyPressed;
        const tapCode = this.pendingMetaCode;
        this.pendingMetaCode = null;
        this.pendingMetaConsumed = false;
        this.pendingMetaOtherKeyPressed = false;
        if (shouldTap) {
          out.push({
            phase: "press",
            code: tapCode,
            key: "Meta",
            modifiers: { ...ALL_FALSE_MODIFIERS },
          });
        }
        return out;
      }

      this.pendingMetaConsumed = false;
      this.pendingMetaOtherKeyPressed = false;

      if (this.heldRemoteKeys.has(input.code)) {
        this.heldRemoteKeys.delete(input.code);
        this.physicalToRemote.delete(input.code);
        out.push({
          phase: "up",
          code: input.code,
          key: input.key,
          modifiers: { ...mods, meta: false },
        });
      }
      return out;
    }

    if (input.code === "ControlLeft" || input.code === "ControlRight") {
      if (this.synthesizedMetaDown) {
        this.releaseSynthesizedMeta(out, {
          ...mods,
          ctrl: false,
          meta: false,
        });
      }

      if (this.pendingCtrlCode === input.code) {
        const shouldTap = !this.pendingCtrlConsumed && !this.pendingCtrlOtherKeyPressed;
        const tapCode = this.pendingCtrlCode;
        this.pendingCtrlCode = null;
        this.pendingCtrlConsumed = false;
        this.pendingCtrlOtherKeyPressed = false;
        if (shouldTap) {
          out.push({
            phase: "press",
            code: tapCode,
            key: "Control",
            modifiers: { ...ALL_FALSE_MODIFIERS },
          });
        }
        return out;
      }

      this.pendingCtrlConsumed = false;
      this.pendingCtrlOtherKeyPressed = false;

      if (this.heldRemoteKeys.has(input.code)) {
        this.heldRemoteKeys.delete(input.code);
        this.physicalToRemote.delete(input.code);
        out.push({
          phase: "up",
          code: input.code,
          key: input.key,
          modifiers: { ...mods, ctrl: false },
        });
      }
      return out;
    }

    const mapped = this.physicalToRemote.get(input.code);
    if (mapped) {
      this.physicalToRemote.delete(input.code);
      this.heldRemoteKeys.delete(mapped.code);

      let effectiveMods: Required<KeyModifiers>;
      if (
        (mapped.code === "Home" || mapped.code === "End") &&
        input.code !== mapped.code
      ) {
        effectiveMods = {
          ctrl: false,
          alt: false,
          shift: mods.shift,
          meta: false,
        };
      } else if (this.synthesizedCtrlDown) {
        effectiveMods = {
          ...mods,
          ctrl: true,
          meta: false,
        };
      } else if (this.synthesizedMetaDown) {
        effectiveMods = {
          ...mods,
          ctrl: false,
          meta: true,
        };
      } else if (this.pendingMetaCode !== null) {
        effectiveMods = { ...mods, meta: false };
      } else if (this.pendingCtrlCode !== null) {
        effectiveMods = { ...mods, ctrl: false };
      } else {
        effectiveMods = mods;
      }

      out.push({
        phase: "up",
        code: mapped.code,
        key: mapped.key,
        modifiers: effectiveMods,
      });
      return out;
    }

    // Fallback for untracked keyup (e.g. pressed before viewport focused)
    const fallback = mapKeyboardEventForTarget(input, localOs, targetOs, mode);
    out.push({
      phase: "up",
      code: fallback.code,
      key: fallback.key,
      modifiers: normalizeModifiers(fallback.modifiers),
    });
    return out;
  }

  /**
   * Call when a local Electron shortcut consumes a combo (e.g. Cmd+1, Cmd+Shift+C)
   * so releasing Cmd/Ctrl won't emit a standalone Start Menu / modifier press.
   */
  cancelPendingModifier(): void {
    this.pendingMetaCode = null;
    this.pendingMetaConsumed = true;
    this.pendingMetaOtherKeyPressed = true;
    this.pendingCtrlCode = null;
    this.pendingCtrlConsumed = true;
    this.pendingCtrlOtherKeyPressed = true;
  }

  /**
   * Releases all held physical/virtual keys cleanly (call on window blur, tab switch,
   * viewOnly toggle, or keymap mode toggle).
   */
  releaseAll(): MappedKeyCommand[] {
    const out: MappedKeyCommand[] = [];
    this.pendingMetaCode = null;
    this.pendingMetaConsumed = false;
    this.pendingMetaOtherKeyPressed = false;
    this.pendingCtrlCode = null;
    this.pendingCtrlConsumed = false;
    this.pendingCtrlOtherKeyPressed = false;
    this.suppressedPhysicalKeys.clear();

    const nonModifiers: Array<{ code: string; key: string }> = [];
    const modifiers: Array<{ code: string; key: string }> = [];

    for (const entry of this.heldRemoteKeys.values()) {
      if (entry.isModifier) {
        modifiers.push({ code: entry.code, key: entry.key });
      } else {
        nonModifiers.push({ code: entry.code, key: entry.key });
      }
    }

    // Release non-modifier keys first, then modifiers (including synthesized ControlLeft/MetaLeft)
    for (const key of nonModifiers) {
      out.push({
        phase: "up",
        code: key.code,
        key: key.key,
        modifiers: { ...ALL_FALSE_MODIFIERS },
      });
    }
    for (const mod of modifiers) {
      out.push({
        phase: "up",
        code: mod.code,
        key: mod.key,
        modifiers: { ...ALL_FALSE_MODIFIERS },
      });
    }

    this.heldRemoteKeys.clear();
    this.physicalToRemote.clear();
    this.synthesizedCtrlDown = false;
    this.synthesizedMetaDown = false;
    return out;
  }

  private recordDown(physicalCode: string, remoteCode: string, remoteKey: string): void {
    this.heldRemoteKeys.set(remoteCode, {
      code: remoteCode,
      key: remoteKey,
      isModifier: MODIFIER_CODES.has(remoteCode),
    });
    this.physicalToRemote.set(physicalCode, { code: remoteCode, key: remoteKey });
  }

  private flushPendingMeta(
    out: MappedKeyCommand[],
    currentMods: Required<KeyModifiers>,
  ): void {
    if (!this.pendingMetaCode) return;
    const code = this.pendingMetaCode;
    this.pendingMetaCode = null;
    this.pendingMetaConsumed = true;
    if (!this.heldRemoteKeys.has(code)) {
      out.push({
        phase: "down",
        code,
        key: "Meta",
        modifiers: {
          ...this.pendingMetaModifiers,
          ctrl: currentMods.ctrl,
          alt: currentMods.alt,
          shift: currentMods.shift,
          meta: true,
        },
      });
      this.recordDown(code, code, "Meta");
    }
  }

  private flushPendingCtrl(
    out: MappedKeyCommand[],
    currentMods: Required<KeyModifiers>,
  ): void {
    if (!this.pendingCtrlCode) return;
    const code = this.pendingCtrlCode;
    this.pendingCtrlCode = null;
    this.pendingCtrlConsumed = true;
    if (!this.heldRemoteKeys.has(code)) {
      out.push({
        phase: "down",
        code,
        key: "Control",
        modifiers: {
          ...this.pendingCtrlModifiers,
          ctrl: true,
          alt: currentMods.alt,
          shift: currentMods.shift,
          meta: currentMods.meta,
        },
      });
      this.recordDown(code, code, "Control");
    }
  }

  private releaseSynthesizedCtrl(
    out: MappedKeyCommand[],
    baseMods: Required<KeyModifiers>,
  ): void {
    if (!this.synthesizedCtrlDown) return;
    this.synthesizedCtrlDown = false;
    this.heldRemoteKeys.delete("ControlLeft");
    out.push({
      phase: "up",
      code: "ControlLeft",
      key: "Control",
      modifiers: { ...baseMods, ctrl: false },
    });
  }

  private releaseSynthesizedMeta(
    out: MappedKeyCommand[],
    baseMods: Required<KeyModifiers>,
  ): void {
    if (!this.synthesizedMetaDown) return;
    this.synthesizedMetaDown = false;
    this.heldRemoteKeys.delete("MetaLeft");
    out.push({
      phase: "up",
      code: "MetaLeft",
      key: "Meta",
      modifiers: { ...baseMods, meta: false },
    });
  }

  private flushHeldNonModifiers(
    out: MappedKeyCommand[],
    mods: Required<KeyModifiers>,
  ): void {
    const flushedRemoteCodes = new Set<string>();
    for (const [remoteCode, info] of Array.from(this.heldRemoteKeys.entries())) {
      if (info.isModifier) continue;
      this.heldRemoteKeys.delete(remoteCode);
      flushedRemoteCodes.add(remoteCode);
      const effectiveMods =
        remoteCode === "Home" || remoteCode === "End"
          ? { ctrl: false, alt: false, shift: mods.shift, meta: false }
          : { ...mods };
      out.push({
        phase: "up",
        code: info.code,
        key: info.key,
        modifiers: effectiveMods,
      });
    }
    if (flushedRemoteCodes.size > 0) {
      for (const [physCode, mapped] of Array.from(this.physicalToRemote.entries())) {
        if (flushedRemoteCodes.has(mapped.code)) {
          this.physicalToRemote.delete(physCode);
          this.suppressedPhysicalKeys.add(physCode);
        }
      }
    }
  }
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
