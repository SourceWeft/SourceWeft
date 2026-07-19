import assert from "node:assert/strict";
import test from "node:test";
import { generateImagePresentation } from "../src/presentation";

const readField = (output: unknown, key: string) => {
  const value =
    output && typeof output === "object"
      ? (output as Record<string, unknown>)[key]
      : undefined;
  return typeof value === "string" ? value : null;
};

test("running title reports the streamed stage label", () => {
  const title = (stage: string) =>
    generateImagePresentation.title({
      status: "running",
      toolOutput: { stage },
      toolInput: {},
      readOutputField: readField,
    });
  assert.equal(title("preparing"), "Composing");
  assert.equal(title("generating"), "Rendering");
  assert.equal(title("saving"), "Polishing");
  assert.equal(title("billing"), "Finalizing");
  assert.equal(title("ready"), "Ready");
});

test("running title falls back when the stage is unknown or absent", () => {
  assert.equal(
    generateImagePresentation.title({
      status: "running",
      toolOutput: { stage: "post_processing" },
      toolInput: {},
      readOutputField: readField,
    }),
    "Generating image",
  );
  assert.equal(
    generateImagePresentation.title({
      status: "running",
      toolInput: {},
      readOutputField: readField,
    }),
    "Generating image",
  );
});

test("error and completed titles are fixed", () => {
  assert.equal(
    generateImagePresentation.title({
      status: "error",
      toolInput: {},
      readOutputField: readField,
    }),
    "Image generation failed",
  );
  assert.equal(
    generateImagePresentation.title({
      status: "completed",
      toolInput: {},
      readOutputField: readField,
    }),
    "Generated image",
  );
});
