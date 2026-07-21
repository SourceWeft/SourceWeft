import assert from "node:assert/strict";
import test from "node:test";
import {
  VIDEO_LAYOUT_PRIMITIVES_TSX,
  VIDEO_LAYOUT_PRIMITIVE_EXPORT_NAMES,
} from "@sourceweft/video-presentation-runtime/layout-source";
import type { VideoPipelineDeps } from "../src/pipeline/deps";
import {
  normalizeSceneProjectCode,
  repairSceneModule,
  sceneSystemPrompt,
} from "../src/pipeline/scene-gen";

/**
 * The primitive names the sandbox project's layout-primitives.tsx actually
 * exports, read out of the TSX source rather than restated here — this is the
 * truth every derived string is checked against.
 */
function exportedPrimitiveNames() {
  return new Set(
    [
      ...VIDEO_LAYOUT_PRIMITIVES_TSX.matchAll(
        /^export\s+(?:function|const)\s+([A-Za-z_$][\w$]*)/gmu,
      ),
    ].map((match) => match[1]!),
  );
}

function namedImportsFrom(code: string, source: string) {
  const match = code.match(
    new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*"${source}"`, "u"),
  );
  assert.ok(match, `no import from "${source}" in:\n${code}`);
  return new Set(
    match[1]!
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  );
}

/** Names mentioned in a prompt line after its "available" preamble. */
function primitivesAdvertisedIn(prompt: string) {
  const line = prompt
    .split("\n")
    .find((candidate) => candidate.includes("layout globals"));
  assert.ok(line, `no layout globals line in prompt:\n${prompt}`);
  return new Set(
    line
      .slice(line.indexOf(":") + 1)
      .split(/[,.]/u)
      .map((name) => name.trim())
      .filter((name) => /^[A-Za-z_$][\w$]*$/u.test(name)),
  );
}

test("VIDEO_LAYOUT_PRIMITIVE_EXPORT_NAMES matches the layout-primitives source", () => {
  assert.deepEqual(
    [...VIDEO_LAYOUT_PRIMITIVE_EXPORT_NAMES].sort(),
    [...exportedPrimitiveNames()].sort(),
  );
});

test("the scene system prompt advertises exactly the exported primitives", () => {
  assert.deepEqual(
    [...primitivesAdvertisedIn(sceneSystemPrompt())].sort(),
    [...exportedPrimitiveNames()].sort(),
  );
});

test("normalizeSceneProjectCode imports exactly the exported primitives", () => {
  const normalized = normalizeSceneProjectCode(
    "export default function VideoScene() { return null; }",
  );
  assert.deepEqual(
    [...namedImportsFrom(normalized, "./layout-primitives")].sort(),
    [...exportedPrimitiveNames()].sort(),
  );
});

test("every advertised primitive is imported into the sandbox scene file", () => {
  // The regression that motivated this test: AssetImage was advertised to the
  // model but missing from the injected import, so scenes that used it threw a
  // ReferenceError at render time.
  const advertised = primitivesAdvertisedIn(sceneSystemPrompt());
  const imported = namedImportsFrom(
    normalizeSceneProjectCode("export default function VideoScene() {}"),
    "./layout-primitives",
  );
  for (const name of advertised) {
    assert.ok(
      imported.has(name),
      `prompt advertises ${name} but the scene file never imports it`,
    );
  }
});

test("the repair prompt advertises exactly the exported primitives", async () => {
  const systemPrompts: string[] = [];
  const deps = {
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    llm: {
      async complete(input: { messages: Array<{ role: string; content: unknown }> }) {
        const system = input.messages.find((message) => message.role === "system");
        if (typeof system?.content === "string") {
          systemPrompts.push(system.content);
        }
        return "export default function VideoScene() { return null; }";
      },
    },
  } as unknown as VideoPipelineDeps;

  await repairSceneModule({
    canvas: { width: 1920, height: 1080 },
    deps,
    diagnostics: ["broken"],
    maxAttempts: 1,
    sceneCode: "broken",
    slide: {
      slideNumber: 1,
      title: "Agenda",
      speakerTranscript: ["Welcome"],
      sceneIntent: "Intro",
      assetRefs: [],
    } as never,
  });

  assert.equal(systemPrompts.length, 1);
  assert.deepEqual(
    [...primitivesAdvertisedIn(systemPrompts[0]!)].sort(),
    [...exportedPrimitiveNames()].sort(),
  );
});
