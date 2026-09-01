import assert from "node:assert/strict";
import test from "node:test";
import type { VideoPresentationRenderableProject } from "@sourceweft/contracts/video-presentation";
import { materializeVideoPresentationAssetUris } from "../src/pipeline/asset-uris";

function project(code: string) {
  return {
    assets: [
      {
        assetId: "hero",
        sourceUrl: "/public/assets/hero.png",
      },
      {
        assetId: "hero-large",
        sourceUrl: "/public/assets/hero-large.png",
      },
    ],
    sceneModules: [{ code }],
  } as unknown as VideoPresentationRenderableProject;
}

test("asset materialization replaces only exact string literal identities", () => {
  const result = materializeVideoPresentationAssetUris(
    project(
      [
        "// sourceweft-asset:hero stays documentation",
        'const hero = "sourceweft-asset:hero";',
        "const large = 'sourceweft-asset:hero-large';",
        'const prose = "prefix sourceweft-asset:hero suffix";',
        "export default function VideoScene() {",
        "  return <><Img src={hero} /><Img src={large} /></>;",
        "}",
      ].join("\n"),
    ),
  );
  const code = result.sceneModules[0]!.code;

  assert.match(code, /const hero = "\/public\/assets\/hero\.png";/u);
  assert.match(code, /const large = "\/public\/assets\/hero-large\.png";/u);
  assert.match(code, /\/\/ sourceweft-asset:hero stays documentation/u);
  assert.match(code, /prefix sourceweft-asset:hero suffix/u);
  assert.equal(code.includes("/public/assets/hero.png-large"), false);
});

test("unknown asset identities remain unchanged", () => {
  const result = materializeVideoPresentationAssetUris(
    project('const missing = "sourceweft-asset:missing";'),
  );
  assert.equal(
    result.sceneModules[0]!.code,
    'const missing = "sourceweft-asset:missing";',
  );
});
