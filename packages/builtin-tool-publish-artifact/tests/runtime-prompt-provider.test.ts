import assert from "node:assert/strict";
import { test } from "vitest";
import { createCapabilityAgentTools } from "../src/index";

/**
 * These assertions moved here from the backend's agent-runner test.
 *
 * Their subject is this capability's factory and its prompt wording — when it
 * binds, what it says, and what it deliberately does not leak (deck generation
 * options belong to the skill, not the publisher). The host's contribution was
 * only to concatenate `buildLines` output, which its own test now proves with a
 * synthetic provider, so running these through `apps/backend` bought nothing
 * and made the backend's build depend on this package.
 */
const TOOL_NAME = "publish_artifact";

function factoryInput(overrides: Record<string, unknown> = {}) {
  return {
    toolIds: [TOOL_NAME],
    context: {
      shouldBindAgentTool: (candidate: string) => candidate === TOOL_NAME,
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      userMessageId: "message-1",
      ...((overrides.context as Record<string, unknown>) ?? {}),
    },
    services: {
      artifacts: {},
      sandbox: {
        downloadCurrentFile: async () => Buffer.from("pptx"),
      },
      storage: {},
    },
  } as never;
}

function promptLines(
  providers: readonly { buildLines: (ctx: never) => string[] }[],
  runtimeTools?: Record<string, unknown>,
) {
  return providers
    .flatMap((provider) =>
      provider.buildLines({
        availableArtifactTools: [TOOL_NAME],
        availableWebTools: [],
        availableMcpTools: [],
        currentDate: "2026-01-01",
        ...(runtimeTools ? { runtimeTools } : {}),
      } as never),
    )
    .join("\n");
}

function runtimeToolSelection(selection: Record<string, unknown>) {
  const normalizedSelection = {
    ...selection,
    enabled: typeof selection.enabled === "boolean" ? selection.enabled : true,
  };
  const { enabled, ...options } = normalizedSelection;
  const isEnabled = enabled !== false;
  return {
    [TOOL_NAME]: {
      toolName: TOOL_NAME,
      enabled: isEnabled,
      permission: "allow" as const,
      shouldBind: isEnabled,
      selection: normalizedSelection,
      options,
    },
  };
}

test("publisher prompt states its preconditions and hides deck generation options", () => {
  const prompt = promptLines(
    createCapabilityAgentTools(factoryInput()).promptProviders as never,
  );

  assert.match(
    prompt,
    /Use `publish_artifact` only after the output file has already been generated; for slides, content QA plus visual QA must have passed\./,
  );
  assert.match(prompt, /artifactType=file/);
  assert.match(prompt, /rendered slide image count and visual QA result/);
  assert.match(prompt, /QA_IMAGE_COUNT/);
  assert.match(prompt, /PREVIEW_IMAGE_PATH/);
  assert.match(prompt, /previewImage/);
  assert.match(prompt, /does not search the QA directory automatically/);
  assert.doesNotMatch(prompt, /stylePreset:/);
  assert.doesNotMatch(prompt, /visualDensity:/);
  assert.doesNotMatch(prompt, /language:/);
  assert.doesNotMatch(prompt, /slideCount:/);
  assert.doesNotMatch(prompt, /<ppt_deck_options>/);
});

test("publisher contributes nothing when the host does not bind its tool", () => {
  const result = createCapabilityAgentTools({
    ...(factoryInput() as unknown as Record<string, unknown>),
    context: {
      shouldBindAgentTool: () => false,
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      userMessageId: "message-1",
    },
  } as never);

  assert.deepEqual(result.promptProviders, []);
  assert.deepEqual(result.tools, []);
});

test("publisher prompt guidance is omitted when the tool is disabled for the turn", () => {
  const result = createCapabilityAgentTools(
    factoryInput({
      context: { runtimeTools: runtimeToolSelection({ enabled: false }) },
    }),
  );
  const prompt = promptLines(
    result.promptProviders as never,
    runtimeToolSelection({ enabled: false }),
  );

  assert.doesNotMatch(prompt, /publish_artifact` only after/);
  assert.doesNotMatch(prompt, /<ppt_deck_options>/);
});
