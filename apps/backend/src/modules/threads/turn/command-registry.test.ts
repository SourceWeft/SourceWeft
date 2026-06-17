import assert from "node:assert/strict";
import { test } from "vitest";
import { renderToolCommandWorkflow } from "./command-registry";

test("renderToolCommandWorkflow renders manifest workflow metadata", () => {
  const workflow = renderToolCommandWorkflow({
    arguments: "draw a dashboard",
    canonicalName: "/generate_image",
    displayName: "Generate Image",
    toolName: "generate_image",
    workflow: {
      execution: "direct",
      promptIntro: "Create an image artifact from the user's request.",
      defaultTools: ["generate_image"],
      permissionOverrides: { generate_image: "allow" },
      successCriteria: {
        kind: "artifact",
        artifactType: "image",
        toolName: "generate_image",
      },
      additionalPromptLines: [],
    },
  });

  assert.equal(workflow?.execution, "direct");
  assert.deepEqual(workflow?.defaultTools, ["generate_image"]);
  assert.deepEqual(workflow?.permissionOverrides, { generate_image: "allow" });
  assert.deepEqual(workflow?.successCriteria, {
    kind: "artifact",
    artifactType: "image",
    toolName: "generate_image",
  });
  assert.match(
    workflow?.renderedPrompt ?? "",
    /Create an image artifact from the user's request/,
  );
});

test("renderToolCommandWorkflow falls back to tool_call for unknown artifact types", () => {
  const workflow = renderToolCommandWorkflow({
    arguments: "create custom artifact",
    canonicalName: "/generate_image",
    displayName: "Generate Image",
    toolName: "generate_image",
    workflow: {
      execution: "agent",
      promptIntro: "Create a custom artifact.",
      defaultTools: ["generate_image"],
      permissionOverrides: { generate_image: "allow" },
      successCriteria: {
        kind: "artifact",
        artifactType: "unknown_artifact",
        toolName: "generate_image",
      },
      additionalPromptLines: [],
    },
  });

  assert.deepEqual(workflow?.successCriteria, {
    kind: "tool_call",
    toolName: "generate_image",
  });
});
