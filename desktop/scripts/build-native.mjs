#!/usr/bin/env node
/**
 * Builds native desktop host helper binaries for the current OS.
 * - macOS (darwin): compiles `native/macos-input-helper.swift` -> `native/bin/velodeck-input-helper-darwin`
 * - Windows/Linux: ensures `native/bin` exists for electron-builder extraResources packaging
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const nativeDir = path.join(desktopRoot, "native");
const binDir = path.join(nativeDir, "bin");
const swiftSource = path.join(nativeDir, "macos-input-helper.swift");
const darwinBinary = path.join(binDir, "velodeck-input-helper-darwin");

fs.mkdirSync(binDir, { recursive: true });

const forceRebuild = process.argv.includes("--force");

if (process.platform === "darwin") {
  if (!fs.existsSync(swiftSource)) {
    console.error(`[build-native] Missing Swift source: ${swiftSource}`);
    process.exit(1);
  }

  let needsBuild = forceRebuild || !fs.existsSync(darwinBinary);
  if (!needsBuild) {
    const srcMtime = fs.statSync(swiftSource).mtimeMs;
    const binMtime = fs.statSync(darwinBinary).mtimeMs;
    if (srcMtime > binMtime) {
      needsBuild = true;
    }
  }

  if (needsBuild) {
    console.log(`[build-native] Compiling ${path.basename(swiftSource)} -> ${path.relative(desktopRoot, darwinBinary)} ...`);
    execFileSync(
      "swiftc",
      [
        "-O",
        "-framework",
        "ApplicationServices",
        "-framework",
        "CoreGraphics",
        "-framework",
        "AppKit",
        swiftSource,
        "-o",
        darwinBinary,
      ],
      { stdio: "inherit" },
    );
    fs.chmodSync(darwinBinary, 0o755);
    const sizeKb = Math.round(fs.statSync(darwinBinary).size / 1024);
    console.log(`[build-native] Built ${path.relative(desktopRoot, darwinBinary)} (${sizeKb} KB)`);
  } else {
    console.log(`[build-native] Up-to-date: ${path.relative(desktopRoot, darwinBinary)}`);
  }
} else {
  const placeholder = path.join(binDir, ".keep");
  if (!fs.existsSync(placeholder)) {
    fs.writeFileSync(placeholder, "", "utf8");
  }
  console.log(`[build-native] Platform=${process.platform}: skipped macOS Swift helper build (Windows uses win-input-helper.ps1).`);
}
