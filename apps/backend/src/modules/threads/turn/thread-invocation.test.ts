import assert from "node:assert/strict";
import { test } from "vitest";
import type { CapabilityCommandListItem } from "@sourceweft/capability-runtime";
import { ContentError } from "../../content/errors";
import { createSelectableInvocationRegistry } from "../../invocations/registry";
import { createCapabilityToolInvocationProvider } from "../../invocations/providers/capability-tools";
import {
  buildDefaultTurnInvocationRegistry,
  resolveThreadInvocation,
} from "./thread-invocation";

function generateImageCommand(): CapabilityCommandListItem {
  return {
    action: { kind: "tool", targetId: "generate_image" },
    aliases: ["image"],
    capabilityId: "sourceweft/generate-image",
    category: "Artifacts",
    contributionId: "generate_image",
    displayTitle: "Generate Image",
    id: "cap:sourceweft/generate-image:generate_image",
    order: 0,
    parentKind: null,
    parentTitle: null,
    sourcePackageName: null,
    title: "Generate Image",
    visible: true,
    workflow: null,
  };
}

function generateVideoPresentationCommand(): CapabilityCommandListItem {
  return {
    action: { kind: "tool", targetId: "generate_video_presentation" },
    aliases: ["video", "slides"],
    capabilityId: "sourceweft/video-presentation-tool",
    category: "Artifacts",
    contributionId: "generate_video_presentation",
    displayTitle: "Generate Video Presentation",
    id: "cap:sourceweft/video-presentation-tool:generate_video_presentation",
    order: 0,
    parentKind: null,
    parentTitle: null,
    sourcePackageName: null,
    title: "Generate Video Presentation",
    visible: true,
    workflow: null,
  };
}

function registry() {
  return createSelectableInvocationRegistry({
    providers: [
      createCapabilityToolInvocationProvider({
        commands: [generateImageCommand(), generateVideoPresentationCommand()],
      }),
    ],
  });
}

test("resolveThreadInvocation accepts capability selectable ids", () => {
  const resolved = resolveThreadInvocation({
    envelope: {
      selectableId: "cap:sourceweft/generate-image:generate_image",
      userInput: "make an image",
    },
    registry: registry(),
    userId: "user_1",
    workspaceId: "workspace_1",
  });

  assert.equal(resolved?.kind, "fixed_tool_choice");
  assert.equal(resolved?.sourceRef.kind, "capability_tool");
  assert.equal(resolved?.toolName, "generate_image");
});

test("resolveThreadInvocation rejects legacy builtin_tool selectable ids", () => {
  assert.throws(
    () =>
      resolveThreadInvocation({
        envelope: {
          selectableId: "builtin_tool.generate_image",
          userInput: "make an image",
        },
        registry: registry(),
        userId: "user_1",
        workspaceId: "workspace_1",
      }),
    (error: unknown) => {
      assert.equal(error instanceof ContentError, true);
      if (!(error instanceof ContentError)) {
        return false;
      }
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "INVOCATION_NOT_FOUND");
      assert.equal(error.recoverable, false);
      return true;
    },
  );
});

test("buildDefaultTurnInvocationRegistry resolves discovered capability tool commands", async () => {
  const invocationRegistry = await buildDefaultTurnInvocationRegistry({
    enabledSkills: [],
  });

  const current = invocationRegistry.resolve("cap:sourceweft/web-search:web_search");

  assert.ok(current);
  assert.equal(current.sourceRef.kind, "capability_tool");
  assert.equal(
    current.semantics.kind === "fixed_tool_choice"
      ? current.semantics.target
      : null,
    "capability_tool",
  );
  assert.equal(
    invocationRegistry.resolve("builtin_tool.web_search"),
    null,
  );
});

test("resolveThreadInvocation returns ContentError for unknown selectable ids", () => {
  assert.throws(
    () =>
      resolveThreadInvocation({
        envelope: {
          selectableId: "builtin_tool.unknown",
          userInput: "make an artifact",
        },
        registry: registry(),
        userId: "user_1",
        workspaceId: "workspace_1",
      }),
    (error: unknown) => {
      assert.equal(error instanceof ContentError, true);
      if (!(error instanceof ContentError)) {
        return false;
      }
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "INVOCATION_NOT_FOUND");
      assert.equal(error.recoverable, false);
      return true;
    },
  );
});
