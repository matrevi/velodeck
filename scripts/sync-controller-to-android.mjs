#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "controller", "dist");
const dstDir = path.join(root, "android-agent", "app", "src", "main", "assets", "web");

if (!existsSync(srcDir)) {
  console.error(`[sync-controller-to-android] Missing ${srcDir}. Run "pnpm build:controller" first.`);
  process.exit(1);
}

rmSync(dstDir, { recursive: true, force: true });
mkdirSync(dstDir, { recursive: true });
cpSync(srcDir, dstDir, { recursive: true });
console.log(`[sync-controller-to-android] Synced ${srcDir} -> ${dstDir}`);
