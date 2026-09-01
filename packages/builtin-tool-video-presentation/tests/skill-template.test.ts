import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { videoPresentationDraftPayloadSchema } from "@sourceweft/contracts/video-presentation";
import { basicSceneCheck } from "../src/pipeline/scene-source";
import { VIDEO_LAYOUT_PRIMITIVE_NAMES } from "../src/pipeline/layout-source";

const workspaceRoot = dirname(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
);

test("the skill template is a valid, statically safe sandbox draft", async () => {
  const template = await readFile(
    join(
      workspaceRoot,
      "packages/builtin-skill-video-presentation/references/draft-template.md",
    ),
    "utf8",
  );
  const jsonBlock = template.match(/```json\n([\s\S]*?)\n```/u)?.[1];
  assert.ok(jsonBlock, "current draft template is missing its JSON fixture");
  const draft = videoPresentationDraftPayloadSchema.parse(
    JSON.parse(jsonBlock),
  );
  for (const scene of draft.sceneModules) {
    assert.deepEqual(basicSceneCheck(scene.code), []);
  }
  assert.match(template, /sourceweft-asset:<assetId>/u);
  assert.doesNotMatch(template, /"repairAttempts"/u);
  const advertised = template.match(
    /runtime layout primitives \(([^)]+)\)/u,
  )?.[1];
  assert.ok(advertised, "draft template does not list its layout primitives");
  assert.deepEqual(
    [...advertised.matchAll(/`([^`]+)`/gu)].map((match) => match[1]),
    [...VIDEO_LAYOUT_PRIMITIVE_NAMES],
  );
});
