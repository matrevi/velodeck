#!/usr/bin/env node
/**
 * Generates native macOS (.icns + Menu Bar template PNGs) and Windows (.ico + tray PNG)
 * desktop icon assets from the shared VeloDeck controller brand icon.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const assetsDir = path.join(desktopRoot, "assets");
const sourcePng = path.join(repoRoot, "controller", "public", "icon-512.png");
const sourceSvg = path.join(repoRoot, "controller", "public", "icon.svg");

fs.mkdirSync(assetsDir, { recursive: true });

if (!fs.existsSync(sourcePng) && !fs.existsSync(sourceSvg)) {
  console.error(
    `[generate-icons] Missing source icons (${sourcePng} / ${sourceSvg}).`,
  );
  process.exit(1);
}

function hasCommand(cmd) {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasRsvgConvert = hasCommand("rsvg-convert");
const hasSips = hasCommand("sips");
const hasIconutil = hasCommand("iconutil");
const hasPython3 = hasCommand("python3");

function renderSvgToPng(svgPath, outPath, size) {
  if (hasRsvgConvert) {
    execFileSync("rsvg-convert", [
      "-w",
      String(size),
      "-h",
      String(size),
      svgPath,
      "-o",
      outPath,
    ]);
    return;
  }
  throw new Error("rsvg-convert not available for SVG rasterization");
}

function resizePng(inputPath, outPath, size) {
  if (hasSips) {
    execFileSync("sips", ["-z", String(size), String(size), inputPath, "--out", outPath], {
      stdio: "ignore",
    });
    return;
  }
  if (hasPython3) {
    execFileSync("python3", [
      "-c",
      `from PIL import Image; Image.open(${JSON.stringify(inputPath)}).convert("RGBA").resize((${size}, ${size}), Image.Resampling.LANCZOS).save(${JSON.stringify(outPath)})`,
    ]);
    return;
  }
  throw new Error("Neither sips nor python3/PIL available to resize PNG");
}

/**
 * Wraps the full-bleed squircle SVG with ~9% macOS HIG transparent outer margin
 * so the Dock icon aligns optically with native macOS Big Sur+ app icons.
 */
function buildMacPaddedSvg(svgText) {
  const inner = svgText
    .replace(/^<\?xml[^>]*>\s*/i, "")
    .replace(/^<svg[^>]*>/i, "")
    .replace(/<\/svg>\s*$/i, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" fill="none">
  <g transform="translate(100, 100) scale(1.609375)">
${inner}
  </g>
</svg>
`;
}

/**
 * Monochrome black-on-transparent VD monogram SVG for macOS Menu Bar Template icons.
 * macOS automatically adapts template icons for Light/Dark Menu Bar appearances.
 */
const TRAY_TEMPLATE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none">
  <!-- Bold optical V -> D ribbon silhouette scaled for 22pt Menu Bar crispness -->
  <g transform="translate(-52, -52) scale(1.205)">
    <path
      d="M 102 154 L 180 356 L 258 154 L 314 154 A 101 101 0 0 1 314 356 L 248 356"
      stroke="#000000"
      stroke-width="46"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M 227 356 L 227 308 L 269 212 L 269 356 Z"
      fill="#000000"
    />
    <circle cx="248" cy="356" r="23" fill="#000000" />
    <circle cx="328" cy="255" r="28" fill="#000000" />
  </g>
</svg>
`;

/**
 * Encodes multiple PNG buffers into a standard Windows multi-resolution .ico file
 * (PNG-in-ICO format supported natively on Windows Vista through Windows 11).
 */
function buildIcoBuffer(entries) {
  const count = entries.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  let offset = headerSize + count * dirEntrySize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  const dataChunks = [];

  for (const { size, png } of entries) {
    const entry = Buffer.alloc(dirEntrySize);
    const dim = size >= 256 ? 0 : size;
    entry.writeUInt8(dim, 0); // width
    entry.writeUInt8(dim, 1); // height
    entry.writeUInt8(0, 2); // color palette count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8); // size of PNG data
    entry.writeUInt32LE(offset, 12); // offset of PNG data
    dirEntries.push(entry);
    dataChunks.push(png);
    offset += png.length;
  }

  return Buffer.concat([header, ...dirEntries, ...dataChunks]);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velodeck-icons-"));

try {
  // 1. Copy / generate 512x512 desktop/assets/icon.png
  const iconPngPath = path.join(assetsDir, "icon.png");
  if (fs.existsSync(sourcePng)) {
    fs.copyFileSync(sourcePng, iconPngPath);
  } else {
    renderSvgToPng(sourceSvg, iconPngPath, 512);
  }

  // Prepare crisp 1024x1024 master for macOS (.icns) with HIG squircle margin
  const macMaster1024 = path.join(tmpDir, "mac-master-1024.png");
  if (fs.existsSync(sourceSvg) && hasRsvgConvert) {
    const paddedSvgPath = path.join(tmpDir, "icon-mac-padded.svg");
    fs.writeFileSync(
      paddedSvgPath,
      buildMacPaddedSvg(fs.readFileSync(sourceSvg, "utf8")),
      "utf8",
    );
    renderSvgToPng(paddedSvgPath, macMaster1024, 1024);
  } else {
    resizePng(iconPngPath, macMaster1024, 1024);
  }

  // 2. Generate macOS desktop/assets/icon.icns via iconutil
  const iconsetDir = path.join(tmpDir, "VeloDeck.iconset");
  fs.mkdirSync(iconsetDir, { recursive: true });
  const icnsSpecs = [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ];
  for (const [fileName, size] of icnsSpecs) {
    const outPath = path.join(iconsetDir, fileName);
    if (size === 1024) {
      fs.copyFileSync(macMaster1024, outPath);
    } else {
      resizePng(macMaster1024, outPath, size);
    }
  }

  const icnsPath = path.join(assetsDir, "icon.icns");
  if (hasIconutil) {
    execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", icnsPath]);
  } else {
    console.warn("[generate-icons] Skipping icon.icns (iconutil unavailable on this OS).");
  }

  // 3. Generate Windows multi-resolution desktop/assets/icon.ico
  const icoSizes = [16, 32, 48, 64, 128, 256];
  const icoEntries = icoSizes.map((size) => {
    const pngPath = path.join(tmpDir, `ico-${size}.png`);
    if (fs.existsSync(sourceSvg) && hasRsvgConvert) {
      renderSvgToPng(sourceSvg, pngPath, size);
    } else {
      resizePng(iconPngPath, pngPath, size);
    }
    return { size, png: fs.readFileSync(pngPath) };
  });
  fs.writeFileSync(path.join(assetsDir, "icon.ico"), buildIcoBuffer(icoEntries));

  // 4. Generate macOS Menu Bar template icons (22x22 & 44x44)
  const traySvgPath = path.join(tmpDir, "tray-template.svg");
  fs.writeFileSync(traySvgPath, TRAY_TEMPLATE_SVG, "utf8");
  const tray1xPath = path.join(assetsDir, "trayTemplate.png");
  const tray2xPath = path.join(assetsDir, "trayTemplate@2x.png");
  if (hasRsvgConvert) {
    renderSvgToPng(traySvgPath, tray1xPath, 22);
    renderSvgToPng(traySvgPath, tray2xPath, 44);
  } else {
    resizePng(iconPngPath, tray1xPath, 22);
    resizePng(iconPngPath, tray2xPath, 44);
  }

  // 5. Generate Windows/Linux color tray icon (32x32)
  const trayWinPath = path.join(assetsDir, "tray-win.png");
  if (fs.existsSync(sourceSvg) && hasRsvgConvert) {
    renderSvgToPng(sourceSvg, trayWinPath, 32);
  } else {
    resizePng(iconPngPath, trayWinPath, 32);
  }

  const outputs = [
    "icon.png",
    "icon.icns",
    "icon.ico",
    "trayTemplate.png",
    "trayTemplate@2x.png",
    "tray-win.png",
  ];
  for (const name of outputs) {
    const full = path.join(assetsDir, name);
    if (fs.existsSync(full)) {
      const stat = fs.statSync(full);
      console.log(`[generate-icons] ${name} (${stat.size} bytes)`);
    }
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
