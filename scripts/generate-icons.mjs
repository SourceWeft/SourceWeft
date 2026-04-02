/**
 * SourceWeft Icon Generator
 *
 * Reads assets/logo.svg, trims outer whitespace, applies safe padding,
 * then generates all required icons for web, docs, extension, and desktop.
 *
 * Usage: node scripts/generate-icons.mjs
 * Requires: sharp
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

async function loadSharp() {
  try {
    const { default: sharp } = await import("sharp");
    return sharp;
  } catch {
    console.log("sharp not found, installing...");
    execSync("pnpm add -D sharp", { cwd: ROOT, stdio: "inherit" });
    const { default: sharp } = await import("sharp");
    return sharp;
  }
}

const SVG_PATH = join(ROOT, "assets/logo.svg");
const ICON_DENSITY = 300;
const SAFE_PADDING_RATIO = 0.1;
const SQUARE_ICON_SIZE = 1024;

const TARGETS = {
  webPublic: join(ROOT, "apps/web/public"),
  webApp: join(ROOT, "apps/web/app"),
  docsPublic: join(ROOT, "apps/docs/public"),
  docsApp: join(ROOT, "apps/docs/app"),
  extPublic: join(ROOT, "apps/extension/public"),
  tauriIcons: join(ROOT, "apps/desktop/src-tauri/icons"),
};

let trimmedSourcePromise = null;
let sourceGeometryPromise = null;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function extractInnerSVGMarkup(svgContent) {
  const stripped = svgContent
    .replace(/<\?xml[\s\S]*?\?>\s*/i, "")
    .replace(/<!DOCTYPE[\s\S]*?>\s*/i, "");

  const openTagMatch = stripped.match(/<svg\b[^>]*>/i);
  if (!openTagMatch || openTagMatch.index === undefined) {
    throw new Error("Invalid SVG: missing <svg> root element");
  }

  const start = openTagMatch.index + openTagMatch[0].length;
  const end = stripped.lastIndexOf("</svg>");
  if (end === -1 || end <= start) {
    throw new Error("Invalid SVG: missing </svg> closing tag");
  }

  return stripped.slice(start, end).trim();
}

async function getTrimmedSourcePNG(sharp) {
  if (!trimmedSourcePromise) {
    trimmedSourcePromise = sharp(SVG_PATH, { density: ICON_DENSITY })
      .ensureAlpha()
      .trim()
      .png()
      .toBuffer();
  }

  return trimmedSourcePromise;
}

async function getSourceGeometry(sharp) {
  if (!sourceGeometryPromise) {
    sourceGeometryPromise = (async () => {
      const metadata = await sharp(SVG_PATH).metadata();
      if (!metadata.width || !metadata.height) {
        throw new Error("Unable to read source SVG dimensions");
      }

      const { info } = await sharp(SVG_PATH)
        .ensureAlpha()
        .trim()
        .png()
        .toBuffer({ resolveWithObject: true });

      const rawLeft =
        typeof info.trimOffsetLeft === "number"
          ? Math.round(-info.trimOffsetLeft)
          : 0;
      const rawTop =
        typeof info.trimOffsetTop === "number"
          ? Math.round(-info.trimOffsetTop)
          : 0;
      const rawWidth =
        typeof info.width === "number" && info.width > 0
          ? Math.round(info.width)
          : metadata.width;
      const rawHeight =
        typeof info.height === "number" && info.height > 0
          ? Math.round(info.height)
          : metadata.height;

      const left = clamp(rawLeft, 0, metadata.width - 1);
      const top = clamp(rawTop, 0, metadata.height - 1);
      const width = clamp(rawWidth, 1, metadata.width - left);
      const height = clamp(rawHeight, 1, metadata.height - top);

      return { left, top, width, height };
    })();
  }

  return sourceGeometryPromise;
}

async function renderPngBuffer(sharp, size, opts = {}) {
  const { bg = { r: 255, g: 255, b: 255, alpha: 0 } } = opts;

  const padding = Math.max(0, Math.round(size * SAFE_PADDING_RATIO));
  const inner = Math.max(1, size - padding * 2);
  const trimmedSource = await getTrimmedSourcePNG(sharp);

  return sharp(trimmedSource)
    .resize(inner, inner, { fit: "contain", background: bg })
    .ensureAlpha()
    .extend({
      top: padding,
      bottom: padding,
      left: padding,
      right: padding,
      background: bg,
    })
    .png()
    .toBuffer();
}

async function genPNG(sharp, size, outPath, opts = {}) {
  const pngBuffer = await renderPngBuffer(sharp, size, opts);
  writeFileSync(outPath, pngBuffer);
  console.log(`  ✓ ${outPath.replace(ROOT + "/", "")}`);
}

async function genICO(sharp, outPath) {
  const sizes = [16, 32, 48];
  const pngBuffers = await Promise.all(
    sizes.map((sz) => renderPngBuffer(sharp, sz)),
  );

  const ico = buildICO(pngBuffers, sizes);
  writeFileSync(outPath, ico);
  console.log(`  ✓ ${outPath.replace(ROOT + "/", "")}`);
}

function buildICO(pngBuffers, sizes) {
  const count = pngBuffers.length;
  const headerSize = 6;
  const entrySize = 16;
  const dataOffset = headerSize + entrySize * count;

  const offsets = [];
  let offset = dataOffset;
  for (const buf of pngBuffers) {
    offsets.push(offset);
    offset += buf.length;
  }

  const totalSize = offset;
  const result = Buffer.alloc(totalSize);

  result.writeUInt16LE(0, 0);
  result.writeUInt16LE(1, 2);
  result.writeUInt16LE(count, 4);

  for (let i = 0; i < count; i++) {
    const base = headerSize + i * entrySize;
    const sz = sizes[i];
    result.writeUInt8(sz === 256 ? 0 : sz, base);
    result.writeUInt8(sz === 256 ? 0 : sz, base + 1);
    result.writeUInt8(0, base + 2);
    result.writeUInt8(0, base + 3);
    result.writeUInt16LE(1, base + 4);
    result.writeUInt16LE(32, base + 6);
    result.writeUInt32LE(pngBuffers[i].length, base + 8);
    result.writeUInt32LE(offsets[i], base + 12);
  }

  let pos = dataOffset;
  for (const buf of pngBuffers) {
    buf.copy(result, pos);
    pos += buf.length;
  }

  return result;
}

async function genICNS(sharp, tauriIconsDir) {
  const iconsetDir = join(tauriIconsDir, "icon.iconset");
  ensureDir(iconsetDir);

  const iconsetFiles = [
    { name: "icon_16x16.png", size: 16 },
    { name: "icon_16x16@2x.png", size: 32 },
    { name: "icon_32x32.png", size: 32 },
    { name: "icon_32x32@2x.png", size: 64 },
    { name: "icon_128x128.png", size: 128 },
    { name: "icon_128x128@2x.png", size: 256 },
    { name: "icon_256x256.png", size: 256 },
    { name: "icon_256x256@2x.png", size: 512 },
    { name: "icon_512x512.png", size: 512 },
    { name: "icon_512x512@2x.png", size: 1024 },
  ];

  console.log("  Generating iconset PNGs for ICNS...");
  for (const { name, size } of iconsetFiles) {
    await genPNG(sharp, size, join(iconsetDir, name));
  }

  try {
    execSync(
      `iconutil -c icns "${iconsetDir}" -o "${join(tauriIconsDir, "icon.icns")}"`,
      { stdio: "pipe" },
    );
    console.log(`  ✓ apps/desktop/src-tauri/icons/icon.icns`);
    execSync(`rm -rf "${iconsetDir}"`);
  } catch {
    console.warn("  ⚠ iconutil not available, skipping icon.icns generation");
    console.warn("    (Run on macOS with Xcode tools to generate icon.icns)");
  }
}

async function genSquareSVG(sharp, outPath) {
  const sourceSVG = readFileSync(SVG_PATH, "utf8");
  const innerMarkup = extractInnerSVGMarkup(sourceSVG);
  const geometry = await getSourceGeometry(sharp);

  const padding = Math.round(SQUARE_ICON_SIZE * SAFE_PADDING_RATIO);
  const innerSize = SQUARE_ICON_SIZE - padding * 2;
  const indentedInner = innerMarkup
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");

  const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SQUARE_ICON_SIZE}" height="${SQUARE_ICON_SIZE}" viewBox="0 0 ${SQUARE_ICON_SIZE} ${SQUARE_ICON_SIZE}">
  <svg x="${padding}" y="${padding}" width="${innerSize}" height="${innerSize}" viewBox="${geometry.left} ${geometry.top} ${geometry.width} ${geometry.height}" preserveAspectRatio="xMidYMid meet">
${indentedInner}
  </svg>
</svg>`;

  writeFileSync(outPath, svgContent, "utf8");
  console.log(`  ✓ ${outPath.replace(ROOT + "/", "")}`);
}

async function main() {
  console.log("\n🎨 SourceWeft Icon Generator\n");

  const sharp = await loadSharp();
  Object.values(TARGETS).forEach(ensureDir);

  console.log("📱 Web (apps/web):");
  await genSquareSVG(sharp, join(TARGETS.webApp, "icon.svg"));
  await genPNG(sharp, 180, join(TARGETS.webPublic, "apple-touch-icon.png"));
  await genPNG(sharp, 192, join(TARGETS.webPublic, "icon-192.png"));
  await genPNG(sharp, 512, join(TARGETS.webPublic, "icon-512.png"));
  await genICO(sharp, join(TARGETS.webApp, "favicon.ico"));

  console.log("\n📚 Docs (apps/docs):");
  await genSquareSVG(sharp, join(TARGETS.docsApp, "icon.svg"));
  await genPNG(sharp, 180, join(TARGETS.docsPublic, "apple-touch-icon.png"));
  await genPNG(sharp, 192, join(TARGETS.docsPublic, "icon-192.png"));
  await genICO(sharp, join(TARGETS.docsApp, "favicon.ico"));

  console.log("\n🧩 Extension (apps/extension):");
  await genPNG(sharp, 16, join(TARGETS.extPublic, "icon-16.png"));
  await genPNG(sharp, 32, join(TARGETS.extPublic, "icon-32.png"));
  await genPNG(sharp, 48, join(TARGETS.extPublic, "icon-48.png"));
  await genPNG(sharp, 128, join(TARGETS.extPublic, "icon-128.png"));

  console.log("\n🖥️  Desktop (apps/desktop):");
  await genPNG(sharp, 32, join(TARGETS.tauriIcons, "32x32.png"));
  await genPNG(sharp, 128, join(TARGETS.tauriIcons, "128x128.png"));
  await genPNG(sharp, 256, join(TARGETS.tauriIcons, "128x128@2x.png"));
  await genPNG(sharp, 512, join(TARGETS.tauriIcons, "icon.png"));
  await genICO(sharp, join(TARGETS.tauriIcons, "icon.ico"));
  await genICNS(sharp, TARGETS.tauriIcons);

  console.log("\n✅ All icons generated successfully!\n");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
