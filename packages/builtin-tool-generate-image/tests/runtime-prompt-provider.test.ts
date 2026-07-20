import assert from "node:assert/strict";
import { test } from "node:test";
import { imageRuntimePromptProvider } from "../src/index";

/**
 * These assertions moved here from the backend's agent-runner test.
 *
 * Their subject is this capability's prompt wording under a given turn state,
 * not the host's prompt assembler — the host only concatenates whatever
 * `buildLines` returns, which its own test now proves with a synthetic
 * provider. Asserting this text through the host meant a copy edit in this
 * package failed a test in `apps/backend`, and it made the backend's build
 * depend on this package being installed.
 */
function promptFor(turnState: Record<string, unknown>) {
  return imageRuntimePromptProvider.buildLines({ turnState }).join("\n");
}

test("image auto mode is presented as available but optional", () => {
  const prompt = promptFor({
    generate_image: {
      artifactIntent: {
        kind: "image",
        shouldInjectTool: true,
        source: "explicit_tool",
        confidence: 0.55,
        reason:
          "User-facing image generation controls configured generate_image.",
        config: {
          aspectRatio: "auto",
          quality: "auto",
          style: "auto",
        },
        warnings: [],
      },
    },
  });

  assert.match(prompt, /generate_image is available in auto mode/);
  assert.match(prompt, /decide semantically from the user's goal/);
  assert.match(prompt, /Never claim an image was created/);
  assert.match(prompt, /do not include image markdown or raw artifact URLs/);
  assert.match(prompt, /otherwise answer normally/);
});

test("sandbox fallback is blocked when image generation is unavailable", () => {
  const prompt = promptFor({
    generate_image: {
      artifactIntent: {
        kind: "image",
        shouldInjectTool: false,
        source: "skill",
        confidence: 0.82,
        reason: "A selected skill declares generate_image.",
        config: {
          aspectRatio: "auto",
          quality: "auto",
          style: "auto",
        },
        warnings: ["image_model_unavailable"],
      },
    },
  });

  assert.match(prompt, /generate_image is not available for this turn/);
  assert.match(prompt, /image_model_unavailable/);
  assert.match(
    prompt,
    /Briefly tell the user that image generation is unavailable/,
  );
  assert.doesNotMatch(prompt, /sandbox tools/);
  assert.doesNotMatch(prompt, /filesystem scripts/);
  assert.doesNotMatch(prompt, /code drawing as a substitute/);
  assert.doesNotMatch(prompt, /generate_image is available in auto mode/);
});
