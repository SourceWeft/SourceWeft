import assert from "node:assert/strict";
import test from "node:test";

import { lintSceneLayout } from "../src/scene-lint";

const CANVAS = { width: 1920, height: 1080 };

function scene(body: string) {
  return `
export default function VideoScene() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: "#0b1020" }}>
      ${body}
    </AbsoluteFill>
  );
}
`.trim();
}

test("clean SafeArea scene produces no findings", () => {
  const result = lintSceneLayout(
    scene(`
      <SafeArea justify="center">
        <TitleBlock title="Hello" />
        <div style={{ fontSize: 34 }}>Short line</div>
      </SafeArea>
    `),
    CANVAS,
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test("text without SafeArea is an error", () => {
  const result = lintSceneLayout(
    scene(`<div style={{ fontSize: 40 }}>Floating text</div>`),
    CANVAS,
  );
  assert.ok(result.errors.some((error) => error.includes("no <SafeArea>")));
});

test("absolutely positioned text at a negative offset is an error", () => {
  const result = lintSceneLayout(
    scene(`
      <SafeArea><div>anchor</div></SafeArea>
      <div style={{ position: "absolute", top: -40 }}>Clipped</div>
    `),
    CANVAS,
  );
  assert.ok(
    result.errors.some((error) => error.includes("top: -40")),
    result.errors.join("; "),
  );
});

test("absolutely positioned decoration off-canvas is only a warning", () => {
  const result = lintSceneLayout(
    scene(`
      <SafeArea><div>anchor</div></SafeArea>
      <div style={{ position: "absolute", left: -200, width: 600, height: 600, borderRadius: 300 }} />
    `),
    CANVAS,
  );
  assert.ok(!result.errors.some((error) => error.includes("left: -200")));
  assert.ok(result.warnings.some((warning) => warning.includes("left: -200")));
});

test("fontSize severity is split into hard error and soft warning", () => {
  const hard = lintSceneLayout(
    scene(`<SafeArea><div style={{ fontSize: 200 }}>Big</div></SafeArea>`),
    CANVAS,
  );
  assert.ok(hard.errors.some((error) => error.includes("fontSize 200px")));

  const soft = lintSceneLayout(
    scene(`<SafeArea><div style={{ fontSize: 110 }}>Large</div></SafeArea>`),
    CANVAS,
  );
  assert.deepEqual(soft.errors, []);
  assert.ok(
    soft.warnings.some((warning) => warning.includes("fontSize 110px")),
  );
});

test("negative margins and oversize dimensions are errors", () => {
  const result = lintSceneLayout(
    scene(`
      <SafeArea>
        <div style={{ marginTop: -60 }}>Pulled up</div>
        <div style={{ width: 2400 }}>Too wide</div>
      </SafeArea>
    `),
    CANVAS,
  );
  assert.ok(result.errors.some((error) => error.includes("marginTop: -60")));
  assert.ok(result.errors.some((error) => error.includes("width: 2400px")));
});

test("interpolate settling off-canvas is a warning", () => {
  const result = lintSceneLayout(
    scene(`
      <SafeArea><div>anchor</div></SafeArea>
      <div style={{ position: "absolute", left: interpolate(frame, [0, 30], [0, -500]) }}>Slider</div>
    `),
    CANVAS,
  );
  assert.ok(
    result.warnings.some((warning) => warning.includes("settles at -500")),
    result.warnings.join("; "),
  );
});

test("text overload produces warnings", () => {
  const long = "word ".repeat(30).trim();
  const result = lintSceneLayout(
    scene(`
      <SafeArea>
        <div>${long}</div>
        <div>${long}</div>
      </SafeArea>
    `),
    CANVAS,
  );
  assert.ok(
    result.warnings.some((warning) => warning.includes("single text node")),
  );
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes("characters of on-screen text"),
    ),
  );
});

test("image src literals must come from the provided asset list", () => {
  const allowed = "/v1/workspaces/w/artifacts/a/assets/asset-img-1.png";
  const withAllowed = lintSceneLayout(
    scene(`
      <SafeArea>
        <AssetImage src="${allowed}" />
        <div>caption</div>
      </SafeArea>
    `),
    CANVAS,
    { allowedImageUrls: [allowed] },
  );
  assert.deepEqual(withAllowed.errors, []);

  const invented = lintSceneLayout(
    scene(`
      <SafeArea>
        <AssetImage src="https://example.com/fake.png" />
        <div>caption</div>
      </SafeArea>
    `),
    CANVAS,
    { allowedImageUrls: [allowed] },
  );
  assert.ok(
    invented.errors.some((error) => error.includes("not in the provided asset list")),
    invented.errors.join("; "),
  );

  const noListButRemote = lintSceneLayout(
    scene(`
      <SafeArea>
        <Img src="/v1/workspaces/w/artifacts/a/assets/whatever.png" />
        <div>caption</div>
      </SafeArea>
    `),
    CANVAS,
  );
  assert.ok(
    noListButRemote.errors.some((error) =>
      error.includes("not in the provided asset list"),
    ),
  );
});
