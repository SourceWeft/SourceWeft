const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SLICE_MAX_HEIGHT,
  VIEWPORTS,
  planSlices,
  captureSlices,
} = require("../scripts/qa-html.cjs");

test("tall pages are split into balanced consecutive slices no taller than the limit", () => {
  assert.equal(SLICE_MAX_HEIGHT, 2000);
  assert.deepEqual(planSlices(12000), [
    { y: 0, height: 2000 },
    { y: 2000, height: 2000 },
    { y: 4000, height: 2000 },
    { y: 6000, height: 2000 },
    { y: 8000, height: 2000 },
    { y: 10000, height: 2000 },
  ]);
  assert.deepEqual(planSlices(900), [{ y: 0, height: 900 }]);
  // No trailing 1px sliver: the remainder is spread across the slices.
  assert.deepEqual(planSlices(4000.4), [
    { y: 0, height: 1334 },
    { y: 1334, height: 1333 },
    { y: 2667, height: 1334 },
  ]);
  for (const height of [844, 2001, 5999, 11999, 12000]) {
    const slices = planSlices(height);
    assert.equal(slices.at(-1).y + slices.at(-1).height, Math.ceil(height));
    for (const slice of slices) {
      assert.ok(slice.height <= SLICE_MAX_HEIGHT);
      assert.ok(slice.height >= Math.min(height, SLICE_MAX_HEIGHT / 2));
    }
  }
  assert.throws(() => planSlices(0), /positive/);
});

test("every viewport slice stays within the visual review aspect-ratio limit", () => {
  // Mirrors MAX_IMAGE_ASPECT_RATIO in builtin-tool-publish-artifact's
  // html/visual-review.ts.
  for (const viewport of VIEWPORTS)
    assert.ok(SLICE_MAX_HEIGHT / viewport.width <= 6, `${viewport.width}px`);
});

test("captureSlices clips the full page and lists each slice with its size", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "report-qa-"));
  const shots = [];
  const page = {
    evaluate: async () => ({ width: 390, height: 4400 }),
    screenshot: async (options) => shots.push(options),
  };
  const images = await captureSlices(page, directory, {
    width: 390,
    height: 844,
  });
  assert.deepEqual(
    shots.map((shot) => [shot.fullPage, shot.type, shot.clip]),
    [
      [true, "jpeg", { x: 0, y: 0, width: 390, height: 1467 }],
      [true, "jpeg", { x: 0, y: 1467, width: 390, height: 1466 }],
      [true, "jpeg", { x: 0, y: 2933, width: 390, height: 1467 }],
    ],
  );
  assert.deepEqual(
    images.map(({ viewport, index, width, height, top }) => ({
      viewport,
      index,
      width,
      height,
      top,
    })),
    [
      { viewport: 390, index: 1, width: 390, height: 1467, top: 0 },
      { viewport: 390, index: 2, width: 390, height: 1466, top: 1467 },
      { viewport: 390, index: 3, width: 390, height: 1467, top: 2933 },
    ],
  );
  assert.deepEqual(
    images.map((image) => path.basename(image.path)),
    [
      "viewport-390-part-1-of-3.jpg",
      "viewport-390-part-2-of-3.jpg",
      "viewport-390-part-3-of-3.jpg",
    ],
  );
  assert.deepEqual(
    shots.map((shot) => shot.path),
    images.map((image) => image.path),
  );
});
