"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");

// Each screenshot slice is at most this many CSS px tall. With the runtime's
// deviceScaleFactor of 1 the narrowest viewport (390 px) yields slices of at
// most 390×2000 (aspect ratio ≈5.1), inside review_html_visuals'
// MAX_IMAGE_ASPECT_RATIO (6) and MAX_IMAGE_LONG_EDGE (8000) in
// packages/builtin-tool-publish-artifact/src/html/visual-review.ts. Vision
// models downsample the long edge to roughly 2,000 px, so taller slices would
// only lose legibility. packages/builtin-skill-html/scripts/qa.cjs duplicates
// this slicing (skills are staged independently and cannot share scripts).
// Keep all three consistent.
const SLICE_MAX_HEIGHT = 2000;
const HEIGHT_BUDGET = 12000;
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];

/**
 * Split a full page of `height` CSS px into the fewest consecutive slices no
 * taller than `maxHeight`, balanced so no trailing sliver (whose extreme
 * aspect ratio the visual review would reject) is produced.
 */
function planSlices(height, maxHeight = SLICE_MAX_HEIGHT) {
  const total = Math.ceil(height);
  if (!Number.isFinite(total) || total <= 0)
    throw new Error("Page height must be positive");
  const count = Math.ceil(total / maxHeight);
  const slices = [];
  for (let index = 0, y = 0; index < count; index++) {
    const next = Math.round(((index + 1) * total) / count);
    slices.push({ y, height: next - y });
    y = next;
  }
  return slices;
}

async function captureSlices(page, directory, viewport) {
  const size = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));
  const width = Math.max(viewport.width, Math.ceil(size.width));
  const slices = planSlices(size.height);
  const images = [];
  for (const [index, slice] of slices.entries()) {
    const image = path.resolve(
      directory,
      `viewport-${viewport.width}-part-${index + 1}-of-${slices.length}.jpg`,
    );
    await page.screenshot({
      path: image,
      type: "jpeg",
      quality: 90,
      fullPage: true,
      clip: { x: 0, y: slice.y, width, height: slice.height },
    });
    images.push({
      viewport: viewport.width,
      index: index + 1,
      path: image,
      width,
      height: slice.height,
      top: slice.y,
    });
  }
  return images;
}

async function main(file, directory) {
  const runtime = process.env.SOURCEWEFT_HTML_RUNTIME;
  if (!runtime)
    throw new Error("Provisioned SOURCEWEFT_HTML_RUNTIME is required");
  const { openDocument, inspect } = require(path.join(runtime, "browser.cjs"));
  if (!file || !directory)
    throw new Error("Usage: node qa-html.cjs report.html qa-directory");
  fs.mkdirSync(directory, { recursive: false });
  fs.writeFileSync(
    path.join(directory, "qa.json"),
    JSON.stringify({ passed: false, status: "running" }),
  );
  const bytes = fs.readFileSync(file);
  const digest =
    "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
  const checks = [];
  const images = [];
  for (const viewport of VIEWPORTS) {
    const session = await openDocument(file, viewport, { bytes });
    try {
      const result = await inspect(session);
      if (result.width > viewport.width + 1)
        result.issues.push("Report overflows the viewport horizontally");
      if (result.height > HEIGHT_BUDGET)
        result.issues.push(
          "Report exceeds the existing 12,000px QA height budget",
        );
      if (
        await session.page
          .locator("button,input,select,textarea,details")
          .count()
      )
        result.issues.push("Report must be a static document");
      const slices =
        result.height <= HEIGHT_BUDGET
          ? await captureSlices(session.page, directory, viewport)
          : [];
      images.push(...slices);
      checks.push({
        viewport,
        images: slices.map((slice) => slice.path),
        ...result,
      });
    } finally {
      await session.close();
    }
  }
  const unchanged =
    digest ===
    "sha256:" +
      crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const report = {
    passed: unchanged && checks.every((c) => !c.issues.length),
    contentDigest: digest,
    unchanged,
    checks,
    // Every slice of every viewport, in review order: pass all of these
    // paths to review_html_visuals.
    images,
    visualReview: "not_run",
  };
  fs.writeFileSync(
    path.join(directory, "qa.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

module.exports = { SLICE_MAX_HEIGHT, VIEWPORTS, planSlices, captureSlices };

if (require.main === module)
  main(...process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
