/**
 * SourceWeft Icon Generator
 *
 * Usage: node scripts/generate-icons.mjs
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "fs";
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
const SQUARE_ICON_SIZE = 1024;

const TARGETS = {
  webPublic: join(ROOT, "apps/web/public"),
  webApp: join(ROOT, "apps/web/app"),
  docsPublic: join(ROOT, "apps/docs/public"),
  docsApp: join(ROOT, "apps/docs/app"),
  extPublic: join(ROOT, "apps/extension/public"),
  tauriIcons: join(ROOT, "apps/desktop/src-tauri/icons"),
};

async function getSourcePNG(sharp) {
  return sharp(SVG_PATH, { density: ICON_DENSITY })
    .ensureAlpha()
    .png()
    .toBuffer();
}

async function renderPngBuffer(sharp, size, opts = {}) {
  const { bg = { r: 255, g: 255, b: 255, alpha: 0 } } = opts;
  const source = await getSourcePNG(sharp);

  return sharp(source)
    .resize(size, size, { fit: "contain", background: bg })
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
  const pngBuffers = await Promise.all(sizes.map((sz) => renderPngBuffer(sharp, sz)));

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
  }
}

async function main() {
  console.log("\n🎨 SourceWeft Icon Generator\n");

  const sharp = await loadSharp();
  Object.values(TARGETS).forEach(ensureDir);

  console.log("📱 Web (apps/web):");
  copyFileSync(SVG_PATH, join(TARGETS.webPublic, "logo.svg"));
  console.log(`  ✓ apps/web/public/logo.svg`);
  await genPNG(sharp, 180, join(TARGETS.webPublic, "apple-touch-icon.png"));
  await genPNG(sharp, 192, join(TARGETS.webPublic, "icon-192.png"));
  await genPNG(sharp, 512, join(TARGETS.webPublic, "icon-512.png"));
  copyFileSync(SVG_PATH, join(TARGETS.webPublic, "icon.svg"));
  console.log(`  ✓ apps/web/public/icon.svg`);
  await genICO(sharp, join(TARGETS.webApp, "favicon.ico"));

  console.log("\n📚 Docs (apps/docs):");
  copyFileSync(SVG_PATH, join(TARGETS.docsPublic, "logo.svg"));
  console.log(`  ✓ apps/docs/public/logo.svg`);
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
