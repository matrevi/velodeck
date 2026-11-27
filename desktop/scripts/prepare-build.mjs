#!/usr/bin/env node
/**
 * Prepares the bundled renderer assets (`desktop/renderer-dist`) from `controller/dist`
 * and emits an optional `desktop/build-config.json` with `defaultServerUrl` from
 * `process.env.VELODECK_DEFAULT_API_BASE` or gitignored `desktop/.env.local`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const controllerDist = path.join(repoRoot, "controller", "dist");
const controllerIndex = path.join(controllerDist, "index.html");
const rendererDist = path.join(desktopRoot, "renderer-dist");
const envLocalPath = path.join(desktopRoot, ".env.local");
const buildConfigPath = path.join(desktopRoot, "build-config.json");

if (!fs.existsSync(controllerIndex)) {
  console.error(
    `[prepare-build] Missing ${controllerIndex}. Run "pnpm build:controller" first.`,
  );
  process.exit(1);
}

fs.rmSync(rendererDist, { recursive: true, force: true });
fs.mkdirSync(rendererDist, { recursive: true });
fs.cpSync(controllerDist, rendererDist, { recursive: true });

function readEnvLocalValue(filePath, key) {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) {
      continue;
    }
    const k = line.slice(0, eqIdx).trim();
    if (k !== key) {
      continue;
    }
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1).trim();
    }
    return val;
  }
  return "";
}

const defaultServerUrl = (
  process.env.VELODECK_DEFAULT_API_BASE?.trim() ||
  readEnvLocalValue(envLocalPath, "VELODECK_DEFAULT_API_BASE") ||
  ""
).trim();

fs.writeFileSync(
  buildConfigPath,
  `${JSON.stringify({ defaultServerUrl }, null, 2)}\n`,
  "utf8",
);

console.log(`[prepare-build] Copied ${controllerDist} -> ${rendererDist}`);
console.log(
  `[prepare-build] Wrote ${buildConfigPath} (defaultServerUrl=${defaultServerUrl ? "<configured>" : "<empty>"})`,
);

// Ensure host worker HTML is staged alongside compiled JS if dist already exists
const hostWorkerSrc = path.join(desktopRoot, "src", "hostWorker.html");
const distDir = path.join(desktopRoot, "dist");
if (fs.existsSync(hostWorkerSrc) && fs.existsSync(distDir)) {
  fs.copyFileSync(hostWorkerSrc, path.join(distDir, "hostWorker.html"));
}
