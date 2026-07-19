import assert from "node:assert/strict";
import { test } from "vitest";
import * as layout from "./layout";
import { VIDEO_LAYOUT_PRIMITIVES_TSX } from "./layout-source";
import { compileSceneModuleOnBrowser } from "./compiler";

test("sandbox layout source exports the same primitives as the runtime module", async () => {
  const babelPackageName = "@babel/standalone";
  const babel = (await import(babelPackageName)) as {
    transform: (
      code: string,
      options: {
        filename?: string;
        presets?: Array<string | [string, Record<string, unknown>]>;
      },
    ) => { code?: string | null };
  };
  const transformed = babel.transform(VIDEO_LAYOUT_PRIMITIVES_TSX, {
    filename: "layout-primitives.tsx",
    presets: ["react", "typescript", ["env", { modules: "commonjs" }]],
  }).code;
  assert.ok(transformed);

  const moduleRef: { exports: Record<string, unknown> } = { exports: {} };
  const requireStub = (name: string) => {
    if (name === "react") {
      return {
        createElement: () => null,
        Fragment: Symbol("Fragment"),
      };
    }
    if (name === "remotion") {
      return {
        useVideoConfig: () => ({ width: 1920, height: 1080, fps: 30 }),
      };
    }
    throw new Error(`Unexpected import in layout source: ${name}`);
  };
  new Function("exports", "module", "require", transformed)(
    moduleRef.exports,
    moduleRef,
    requireStub,
  );

  for (const name of layout.VIDEO_LAYOUT_PRIMITIVE_NAMES) {
    assert.equal(
      typeof moduleRef.exports[name],
      "function",
      `sandbox layout source is missing primitive ${name}`,
    );
    assert.equal(
      typeof (layout as Record<string, unknown>)[name],
      "function",
      `runtime layout module is missing primitive ${name}`,
    );
  }
  assert.equal(moduleRef.exports.SAFE_MARGIN_RATIO, layout.SAFE_MARGIN_RATIO);
});

test("scenes using layout primitives compile in the browser runtime", async () => {
  const sceneCode = `
export default function VideoScene() {
  const frame = useCurrentFrame();
  const { height } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: "#0b1020" }}>
      <SafeArea justify="center">
        <TitleBlock title="Layout" subtitle="Primitives" />
        <BulletList items={["One", "Two"]} />
      </SafeArea>
    </AbsoluteFill>
  );
}
`.trim();
  const component = await compileSceneModuleOnBrowser(sceneCode, "VideoScene");
  assert.equal(typeof component, "function");
});
