/**
 * VelaMind Icon Generator
 *
 * Reads assets/logo.svg (1536x1024), crops a centered 1024x1024 square,
 * then generates all required icons for web, docs, extension, and desktop.
 *
 * Usage: node scripts/generate-icons.mjs
 * Requires: sharp, png-to-ico  (installed via this script using pnpm dlx)
 */

import { createRequire } from "module";
import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── Helper: ensure directory exists ────────────────────────────────────────
function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── Helper: lazy-load sharp (may need install first) ────────────────────────
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

// ── SVG source ──────────────────────────────────────────────────────────────
// Original: 1536 x 1024  → crop center 1024x1024 (x=256, y=0)
// Shared source assets live in the repo root assets/ directory.
const SVG_PATH = join(ROOT, "assets/logo.svg");

// ── Output targets ──────────────────────────────────────────────────────────
const TARGETS = {
  // Web
  webPublic: join(ROOT, "apps/web/public"),
  webApp: join(ROOT, "apps/web/app"),
  // Docs
  docsPublic: join(ROOT, "apps/docs/public"),
  docsApp: join(ROOT, "apps/docs/app"),
  // Extension — WXT copies public/ verbatim to the build output root
  extPublic: join(ROOT, "apps/extension/public"),
  // Desktop
  tauriIcons: join(ROOT, "apps/desktop/src-tauri/icons"),
};

// ── Generate PNG at given size from cropped square ──────────────────────────
async function genPNG(sharp, size, outPath, opts = {}) {
  const { padding = 0, bg = { r: 255, g: 255, b: 255, alpha: 0 } } = opts;

  const inner = size - padding * 2;

  await sharp(SVG_PATH, { density: 300 })
    // Crop centered 1024x1024 from 1536x1024
    .extract({ left: 256, top: 0, width: 1024, height: 1024 })
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
    .toFile(outPath);

  console.log(`  ✓ ${outPath.replace(ROOT + "/", "")}`);
}

// ── Generate ICO from a PNG buffer ──────────────────────────────────────────
async function genICO(sharp, outPath) {
  // Generate 16, 32, 48 px PNGs as buffers — MUST be RGBA (no flatten)
  const sizes = [16, 32, 48];
  const pngBuffers = await Promise.all(
    sizes.map((sz) =>
      sharp(SVG_PATH, { density: 300 })
        .extract({ left: 256, top: 0, width: 1024, height: 1024 })
        .resize(sz, sz, {
          fit: "contain",
          background: { r: 255, g: 255, b: 255, alpha: 0 },
        })
        .ensureAlpha()
        .png()
        .toBuffer(),
    ),
  );

  // Build minimal ICO file manually (ICONDIR + ICONDIRENTRY per image)
  const ico = buildICO(pngBuffers, sizes);
  writeFileSync(outPath, ico);
  console.log(`  ✓ ${outPath.replace(ROOT + "/", "")}`);
}

// ── Minimal ICO builder ──────────────────────────────────────────────────────
// Format: https://en.wikipedia.org/wiki/ICO_(file_format)
function buildICO(pngBuffers, sizes) {
  const count = pngBuffers.length;
  const headerSize = 6; // ICONDIR
  const entrySize = 16; // ICONDIRENTRY per image
  const dataOffset = headerSize + entrySize * count;

  const offsets = [];
  let offset = dataOffset;
  for (const buf of pngBuffers) {
    offsets.push(offset);
    offset += buf.length;
  }

  const totalSize = offset;
  const result = Buffer.alloc(totalSize);

  // ICONDIR
  result.writeUInt16LE(0, 0); // Reserved
  result.writeUInt16LE(1, 2); // Type: 1 = ICO
  result.writeUInt16LE(count, 4); // Image count

  // ICONDIRENTRY for each image
  for (let i = 0; i < count; i++) {
    const base = headerSize + i * entrySize;
    const sz = sizes[i];
    result.writeUInt8(sz === 256 ? 0 : sz, base); // Width (0=256)
    result.writeUInt8(sz === 256 ? 0 : sz, base + 1); // Height
    result.writeUInt8(0, base + 2); // Color count (0 = more than 256)
    result.writeUInt8(0, base + 3); // Reserved
    result.writeUInt16LE(1, base + 4); // Color planes
    result.writeUInt16LE(32, base + 6); // Bits per pixel
    result.writeUInt32LE(pngBuffers[i].length, base + 8); // Image size
    result.writeUInt32LE(offsets[i], base + 12); // Image offset
  }

  // Image data
  let pos = dataOffset;
  for (const buf of pngBuffers) {
    buf.copy(result, pos);
    pos += buf.length;
  }

  return result;
}

// ── Generate ICNS (macOS) using iconutil if available ───────────────────────
async function genICNS(sharp, tauriIconsDir) {
  const iconsetDir = join(tauriIconsDir, "icon.iconset");
  ensureDir(iconsetDir);

  // iconutil required sizes
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
    // Clean up iconset dir
    execSync(`rm -rf "${iconsetDir}"`);
  } catch {
    console.warn("  ⚠ iconutil not available, skipping icon.icns generation");
    console.warn("    (Run on macOS with Xcode tools to generate icon.icns)");
  }
}

// ── Generate square SVG (crop viewBox to center 1024x1024, no white bg) ─────
function genSquareSVG(outPath) {
  // Original viewBox: 0 0 1536 1024 → center square: x=256 y=0 w=1024 h=1024
  const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="256 0 1024 1024">
  <path d="M 1063 272 L 1054 264 L 1044 259 L 1037 257 L 1022 256 L 497 257 L 485 261 L 476 267 L 467 278 L 463 286 L 460 299 L 461 358 L 470 358 L 470 299 L 473 288 L 478 280 L 487 272 L 492 269 L 504 266 L 1030 266 L 1042 269 L 1049 273 L 1059 284 L 1064 299 L 1064 378 L 1062 379 L 1054 375 L 1040 375 L 1033 377 L 1022 383 L 1010 394 L 919 493 L 851 383 L 843 375 L 827 369 L 815 369 L 803 372 L 793 377 L 774 394 L 654 539 L 646 547 L 522 377 L 518 375 L 447 376 L 570 541 L 612 600 L 622 610 L 627 613 L 638 616 L 649 615 L 659 611 L 674 597 L 839 398 L 845 396 L 850 400 L 912 502 L 916 505 L 921 505 L 937 490 L 1026 393 L 1042 385 L 1055 386 L 1060 390 L 1064 399 L 1064 716 L 1062 725 L 1058 733 L 1046 744 L 1032 749 L 503 749 L 492 746 L 485 742 L 478 735 L 474 729 L 470 715 L 471 438 L 460 425 L 460 717 L 463 729 L 468 739 L 475 747 L 483 753 L 500 759 L 1034 759 L 1045 756 L 1057 749 L 1068 736 L 1074 718 L 1074 297 L 1071 285 Z M 840 387 L 833 390 L 825 398 L 661 596 L 649 604 L 635 605 L 623 597 L 468 386 L 514 385 L 521 392 L 637 553 L 644 558 L 649 558 L 656 553 L 692 508 L 790 392 L 798 386 L 815 379 L 827 379 L 836 383 Z" fill="#222222" fill-rule="evenodd"/>
  <path d="M 1032 617 L 1032 430 L 1024 437 L 940 531 L 930 539 L 920 543 L 906 542 L 900 539 L 889 528 L 831 434 L 824 442 L 824 444 L 866 509 L 878 530 L 887 542 L 893 547 L 907 553 L 926 552 L 943 542 L 1020 458 L 1021 617 Z" fill="#222222"/>
</svg>`;
  writeFileSync(outPath, svgContent, "utf8");
  console.log(`  ✓ ${outPath.replace(ROOT + "/", "")}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n🎨 VelaMind Icon Generator\n");

  const sharp = await loadSharp();

  // Ensure all output dirs exist
  Object.values(TARGETS).forEach(ensureDir);

  // ── Web ──────────────────────────────────────────────────────────────────
  console.log("📱 Web (apps/web):");
  genSquareSVG(join(TARGETS.webApp, "icon.svg"));
  await genPNG(sharp, 180, join(TARGETS.webPublic, "apple-touch-icon.png"));
  await genPNG(sharp, 192, join(TARGETS.webPublic, "icon-192.png"));
  await genPNG(sharp, 512, join(TARGETS.webPublic, "icon-512.png"));
  await genICO(sharp, join(TARGETS.webApp, "favicon.ico"));

  // ── Docs ─────────────────────────────────────────────────────────────────
  console.log("\n📚 Docs (apps/docs):");
  genSquareSVG(join(TARGETS.docsApp, "icon.svg"));
  await genPNG(sharp, 180, join(TARGETS.docsPublic, "apple-touch-icon.png"));
  await genPNG(sharp, 192, join(TARGETS.docsPublic, "icon-192.png"));
  await genICO(sharp, join(TARGETS.docsApp, "favicon.ico"));

  // ── Extension ────────────────────────────────────────────────────────────
  console.log("\n🧩 Extension (apps/extension):");
  await genPNG(sharp, 16, join(TARGETS.extPublic, "icon-16.png"));
  await genPNG(sharp, 32, join(TARGETS.extPublic, "icon-32.png"));
  await genPNG(sharp, 48, join(TARGETS.extPublic, "icon-48.png"));
  await genPNG(sharp, 128, join(TARGETS.extPublic, "icon-128.png"));

  // ── Desktop (Tauri) ───────────────────────────────────────────────────────
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
