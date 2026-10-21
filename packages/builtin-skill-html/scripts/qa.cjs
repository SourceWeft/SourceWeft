"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");

// Screenshot slicing duplicates packages/builtin-skill-report/scripts/qa-html.cjs
// (planSlices/captureSlices, same file naming and qa.json `images` shape):
// skills are staged into the sandbox independently, so neither can require the
// other's scripts. Each slice is at most SLICE_MAX_HEIGHT CSS px tall; at the
// runtime's deviceScaleFactor of 1 the narrowest viewport (390 px) yields
// slices of at most 390×2000 (≈5.1:1), inside review_html_visuals'
// MAX_IMAGE_ASPECT_RATIO (6) and MAX_IMAGE_LONG_EDGE (8000) in
// packages/builtin-tool-publish-artifact/src/html/visual-review.ts. Keep all
// three consistent.
const SLICE_MAX_HEIGHT = 2000;
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

async function main(file, directory, interactionScript) {
  const runtime = process.env.SOURCEWEFT_HTML_RUNTIME;
  if (!runtime) throw new Error("SOURCEWEFT_HTML_RUNTIME is required");
  const { openDocument, inspect } = require(path.join(runtime, "browser.cjs"));
  if (!file || !directory)
    throw new Error(
      "Usage: qa.cjs index.html qa-directory [interaction-checks.cjs]",
    );
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "qa.json"),
    JSON.stringify({ passed: false, status: "running" }),
  );
  const bytes = fs.readFileSync(file),
    digest =
      "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
  const checks = [],
    images = [];
  for (const viewport of VIEWPORTS) {
    const session = await openDocument(file, viewport, { bytes });
    try {
      const interactive = await session.page
        .locator("button,input,select,textarea,details")
        .count();
      if (interactive && !interactionScript)
        throw new Error(
          "HTML_INTERACTION_TEST_REQUIRED: provide a local module exporting async function(page) with assertions for the page controls",
        );
      if (interactionScript) {
        const result = await require(path.resolve(interactionScript))(
          session.page,
        );
        if (result !== true)
          throw new Error(
            "Interaction checks must complete their assertions and return true",
          );
      }
      await session.page.evaluate(async () => {
        for (
          let y = 0;
          y < Math.min(document.documentElement.scrollHeight, 12000);
          y += innerHeight
        ) {
          scrollTo(0, y);
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        scrollTo(0, 0);
        await Promise.all(
          [...document.images].map((image) => image.decode().catch(() => {})),
        );
      });
      const result = await inspect(session);
      if (result.height > 12_000)
        result.issues.push(
          "Page exceeds the bounded 12,000px screenshot budget; split the report into sections",
        );
      const slices =
        result.height <= 12_000
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
