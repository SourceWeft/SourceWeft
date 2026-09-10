/**
 * SourceWeft Icon Generator
 *
 * Usage: node scripts/generate-icons.mjs
 */

import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  rmSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

async function loadSharp() {
  const { default: sharp } = await import("sharp");
  return sharp;
}

const LOGO_PATH = join(ROOT, "assets/logo.svg");
const SVG_PATH = join(ROOT, "assets/app-icon.svg");
const ICON_DENSITY = 300;
const SQUARE_ICON_SIZE = 1024;

const TARGETS = {
  webPublic: join(ROOT, "apps/web/public"),
  webApp: join(ROOT, "apps/web/app"),
  docsPublic: join(ROOT, "apps/docs/public"),
  docsApp: join(ROOT, "apps/docs/app"),
  extPublic: join(ROOT, "apps/extension/public"),
  tauriIcons: join(ROOT, "apps/desktop/src-tauri/icons"),
  mobileIcons: join(ROOT, "apps/mobile/src-tauri/icons"),
  iosIcons: join(
    ROOT,
    "apps/mobile/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset",
  ),
};

async function getSourcePNG(sharp) {
  return sharp(SVG_PATH, { density: ICON_DENSITY })
    .ensureAlpha()
    .png()
    .toBuffer();
}

async function renderPngBuffer(sharp, size, opts = {}) {
  const { bg = { r: 255, g: 255, b: 255, alpha: 0 }, rgba = false } = opts;
  const source = await getSourcePNG(sharp);

  const pipeline = sharp(source)
    .resize(size, size, { fit: "contain", background: bg })
    .flatten({ background: "white" });
  // Tauri embeds desktop PNGs at compile time and requires an RGBA buffer.
  // Keep the white artwork opaque; iOS app icons continue to omit alpha.
  if (rgba) pipeline.ensureAlpha();
  return pipeline.png().toBuffer();
}

async function genPNG(sharp, size, outPath, opts = {}) {
  const pngBuffer = await renderPngBuffer(sharp, size, {
    rgba: outPath.startsWith(TARGETS.tauriIcons),
    ...opts,
  });
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

function formatSvgNumber(value) {
  return Number.parseFloat(value.toFixed(4)).toString();
}

function extractSvgBody(svg) {
  return svg
    .replace(/<\?xml[^>]*>\s*/i, "")
    .replace(/^\s*<svg\b[^>]*>/i, "")
    .replace(/<\/svg>\s*$/i, "")
    .trim();
}

function getSvgViewBox(svg) {
  const match = svg.match(/\bviewBox="([^"]+)"/);
  if (!match) {
    throw new Error(
      `${SVG_PATH} must include a viewBox to generate square icons`,
    );
  }

  const values = match[1]
    .trim()
    .split(/[,\s]+/)
    .map(Number);
  if (values.length !== 4 || values.some((value) => Number.isNaN(value))) {
    throw new Error(`Invalid SVG viewBox in ${SVG_PATH}: ${match[1]}`);
  }

  return values;
}

function renderSquareSvgIcon() {
  const source = readFileSync(SVG_PATH, "utf8");
  const [viewBoxX, viewBoxY, viewBoxWidth, viewBoxHeight] =
    getSvgViewBox(source);
  const scale = SQUARE_ICON_SIZE / Math.max(viewBoxWidth, viewBoxHeight);
  const translateX =
    (SQUARE_ICON_SIZE - viewBoxWidth * scale) / 2 - viewBoxX * scale;
  const translateY =
    (SQUARE_ICON_SIZE - viewBoxHeight * scale) / 2 - viewBoxY * scale;
  const body = extractSvgBody(source)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SQUARE_ICON_SIZE}" height="${SQUARE_ICON_SIZE}" viewBox="0 0 ${SQUARE_ICON_SIZE} ${SQUARE_ICON_SIZE}">
  <g transform="translate(${formatSvgNumber(translateX)} ${formatSvgNumber(translateY)}) scale(${formatSvgNumber(scale)})">
${body}
  </g>
</svg>
`;
}

function genSquareSVG(outPath) {
  writeFileSync(outPath, renderSquareSvgIcon());
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

  execFileSync(
    "iconutil",
    ["-c", "icns", iconsetDir, "-o", join(tauriIconsDir, "icon.icns")],
    { stdio: "pipe" },
  );
  console.log(
    `  ✓ ${join(tauriIconsDir, "icon.icns").replace(ROOT + "/", "")}`,
  );
  rmSync(iconsetDir, { recursive: true });
}

async function genMobileIcons(sharp) {
  const sizes = {
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    "StoreLogo.png": 50,
  };
  for (const size of [30, 44, 71, 89, 107, 142, 150, 284, 310]) {
    sizes[`Square${size}x${size}Logo.png`] = size;
  }
  for (const [name, size] of Object.entries(sizes)) {
    await genPNG(sharp, size, join(TARGETS.mobileIcons, name));
  }
  await genICO(sharp, join(TARGETS.mobileIcons, "icon.ico"));
  await genICNS(sharp, TARGETS.mobileIcons);

  const catalog = JSON.parse(
    readFileSync(join(TARGETS.iosIcons, "Contents.json"), "utf8"),
  );
  for (const entry of catalog.images) {
    const size = Number.parseFloat(entry.size) * Number.parseFloat(entry.scale);
    await genPNG(sharp, size, join(TARGETS.iosIcons, entry.filename));
  }

  for (const [density, scale] of Object.entries({
    mdpi: 1,
    hdpi: 1.5,
    xhdpi: 2,
    xxhdpi: 3,
    xxxhdpi: 4,
  })) {
    const dir = join(TARGETS.mobileIcons, "android", `mipmap-${density}`);
    ensureDir(dir);
    await genPNG(sharp, 48 * scale, join(dir, "ic_launcher.png"));
    await genPNG(sharp, 48 * scale, join(dir, "ic_launcher_round.png"));
    // Keep the mark within Android's central 66/108 adaptive-icon safe area.
    const foreground = await renderPngBuffer(sharp, 66 * scale);
    await sharp({
      create: {
        width: 108 * scale,
        height: 108 * scale,
        channels: 4,
        background: "white",
      },
    })
      .composite([{ input: foreground, gravity: "centre" }])
      .png()
      .toFile(join(dir, "ic_launcher_foreground.png"));
  }
}

async function main() {
  console.log("\n🎨 SourceWeft Icon Generator\n");

  const sharp = await loadSharp();
  Object.values(TARGETS).forEach(ensureDir);
  const targets = new Set(process.argv.slice(2));
  const shouldGenerate = (target) => targets.size === 0 || targets.has(target);

  if (shouldGenerate("web")) {
    console.log("📱 Web (apps/web):");
    copyFileSync(LOGO_PATH, join(TARGETS.webPublic, "logo.svg"));
    console.log(`  ✓ apps/web/public/logo.svg`);
    await genPNG(sharp, 180, join(TARGETS.webPublic, "apple-touch-icon.png"));
    await genPNG(sharp, 192, join(TARGETS.webPublic, "icon-192.png"));
    await genPNG(sharp, 512, join(TARGETS.webPublic, "icon-512.png"));
    genSquareSVG(join(TARGETS.webPublic, "icon.svg"));
    genSquareSVG(join(TARGETS.webApp, "icon.svg"));
    await genICO(sharp, join(TARGETS.webApp, "favicon.ico"));
  }

  if (shouldGenerate("docs")) {
    console.log("\n📚 Docs (apps/docs):");
    copyFileSync(LOGO_PATH, join(TARGETS.docsPublic, "logo.svg"));
    console.log(`  ✓ apps/docs/public/logo.svg`);
    await genPNG(sharp, 180, join(TARGETS.docsPublic, "apple-touch-icon.png"));
    await genPNG(sharp, 192, join(TARGETS.docsPublic, "icon-192.png"));
    genSquareSVG(join(TARGETS.docsPublic, "icon.svg"));
    genSquareSVG(join(TARGETS.docsApp, "icon.svg"));
    await genICO(sharp, join(TARGETS.docsApp, "favicon.ico"));
  }

  if (shouldGenerate("extension")) {
    console.log("\n🧩 Extension (apps/extension):");
    await genPNG(sharp, 16, join(TARGETS.extPublic, "icon-16.png"));
    await genPNG(sharp, 32, join(TARGETS.extPublic, "icon-32.png"));
    await genPNG(sharp, 48, join(TARGETS.extPublic, "icon-48.png"));
    await genPNG(sharp, 128, join(TARGETS.extPublic, "icon-128.png"));
  }

  if (shouldGenerate("desktop")) {
    console.log("\n🖥️  Desktop (apps/desktop):");
    await genPNG(sharp, 32, join(TARGETS.tauriIcons, "32x32.png"));
    await genPNG(sharp, 128, join(TARGETS.tauriIcons, "128x128.png"));
    await genPNG(sharp, 256, join(TARGETS.tauriIcons, "128x128@2x.png"));
    await genPNG(sharp, 512, join(TARGETS.tauriIcons, "icon.png"));
    await genICO(sharp, join(TARGETS.tauriIcons, "icon.ico"));
    await genICNS(sharp, TARGETS.tauriIcons);
  }

  if (shouldGenerate("mobile")) {
    console.log("\n📱 Mobile (apps/mobile):");
    await genMobileIcons(sharp);
  }

  console.log("\n✅ All icons generated successfully!\n");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
