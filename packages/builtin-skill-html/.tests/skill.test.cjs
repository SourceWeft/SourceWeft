const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
test("page skill uses the common publisher and has no slide engine dependency", () => {
  const m = JSON.parse(
    fs.readFileSync(path.join(root, "sourceweft.capability.json"), "utf8"),
  );
  assert.equal(m.skills[0].runtime.output.artifactType, "html");
  assert.equal(m.skills[0].runtime.output.publisherTool, "publish_artifact");
  const script = fs.readFileSync(path.join(root, "scripts/build.cjs"), "utf8");
  assert.doesNotMatch(script, /Reveal|html-slides/);
  assert.ok(m.skills[0].runtime.tools.includes("review_html_visuals"));
});
test("QA slices full-page screenshots into balanced parts the visual review accepts", async () => {
  const os = require("node:os");
  const { SLICE_MAX_HEIGHT, VIEWPORTS, planSlices, captureSlices } = require(
    path.join(root, "scripts/qa.cjs"),
  );
  assert.equal(SLICE_MAX_HEIGHT, 2000);
  // Mirrors MAX_IMAGE_ASPECT_RATIO in builtin-tool-publish-artifact's
  // html/visual-review.ts.
  for (const viewport of VIEWPORTS)
    assert.ok(SLICE_MAX_HEIGHT / viewport.width <= 6, `${viewport.width}px`);
  assert.deepEqual(planSlices(900), [{ y: 0, height: 900 }]);
  assert.deepEqual(planSlices(4000.4), [
    { y: 0, height: 1334 },
    { y: 1334, height: 1333 },
    { y: 2667, height: 1334 },
  ]);
  for (const height of [844, 2001, 5999, 12000]) {
    const slices = planSlices(height);
    assert.equal(slices.at(-1).y + slices.at(-1).height, Math.ceil(height));
    for (const slice of slices) assert.ok(slice.height <= SLICE_MAX_HEIGHT);
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "html-qa-"));
  const shots = [];
  const images = await captureSlices(
    {
      evaluate: async () => ({ width: 390, height: 4400 }),
      screenshot: async (options) => shots.push(options),
    },
    directory,
    { width: 390, height: 844 },
  );
  assert.deepEqual(
    shots.map((shot) => [shot.fullPage, shot.clip]),
    [
      [true, { x: 0, y: 0, width: 390, height: 1467 }],
      [true, { x: 0, y: 1467, width: 390, height: 1466 }],
      [true, { x: 0, y: 2933, width: 390, height: 1467 }],
    ],
  );
  assert.deepEqual(
    images.map((image) => [
      path.basename(image.path),
      image.viewport,
      image.index,
      image.width,
      image.height,
    ]),
    [
      ["viewport-390-part-1-of-3.jpg", 390, 1, 390, 1467],
      ["viewport-390-part-2-of-3.jpg", 390, 2, 390, 1466],
      ["viewport-390-part-3-of-3.jpg", 390, 3, 390, 1467],
    ],
  );
});
