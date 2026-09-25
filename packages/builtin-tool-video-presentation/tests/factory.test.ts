import assert from "node:assert/strict";
import test from "node:test";
import {
  createCapabilityAgentTools,
  videoPresentationAgentToolDefs,
} from "../src";
import { createFakeVideoServices } from "./helpers";

const toolNames = [
  "load_video_presentation",
  "generate_video_assets",
  "generate_video_narration",
  "validate_video_presentation",
  "publish_video_presentation",
];

test("selection binds the five root-only Video Presentation tools", () => {
  const modelState = (modelKind: string) => ({
    profile: {
      gatewayConfigId: `${modelKind}-gateway`,
      profileAlias: `${modelKind}-default`,
      modelAlias: `${modelKind}-model`,
    },
  });
  const result = createCapabilityAgentTools({
    toolIds: toolNames,
    context: {
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      userMessageId: "message-1",
      turnState: {
        generate_video_assets: modelState("image"),
        generate_video_narration: modelState("tts"),
        validate_video_presentation: modelState("vision"),
      },
      runtimeTools: {},
      isToolDenied: () => false,
      shouldBindAgentTool: (name) => toolNames.includes(name),
    },
    services: createFakeVideoServices({
      operationCache: {
        claimMany: async () => ({
          kind: "unknown",
          code: "SIDE_EFFECT_OUTCOME_UNKNOWN",
        }),
      },
    }),
  });
  const tools = ("tools" in result ? result.tools : result) ?? [];
  const names = tools.map((entry) => entry.tool.name);

  assert.deepEqual(names.sort(), [...toolNames].sort());
  const definitions = videoPresentationAgentToolDefs.filter((tool) =>
    toolNames.includes(tool.name),
  );
  assert.equal(
    definitions.every((tool) => tool.executionScope === "root_only"),
    true,
  );
  assert.equal(
    definitions.find((tool) => tool.name === "publish_video_presentation")
      ?.terminalResult?.kind,
    "committed_artifact",
  );
});
