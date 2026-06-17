import assert from "node:assert/strict";
import { test } from "vitest";
import type { CapabilityCommandListItem } from "@sourceweft/capability-runtime";
import { ContentError } from "../../content/errors";
import { createSelectableInvocationRegistry } from "../../invocations/registry";
import {
  createCapabilityToolInvocationProvider,
  legacyCapabilityToolSelectableId,
} from "../../invocations/providers/capability-tools";
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
    capabilityId: "sourceweft/generate-video-presentation",
    category: "Artifacts",
    contributionId: "generate_video_presentation",
    displayTitle: "Generate Video Presentation",
    id: "cap:sourceweft/generate-video-presentation:generate_video_presentation",
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

test("resolveThreadInvocation accepts capability and documented legacy tool ids", () => {
  const current = resolveThreadInvocation({
    envelope: {
      selectableId: "cap:sourceweft/generate-image:generate_image",
      userInput: "make an image",
    },
    registry: registry(),
    userId: "user_1",
    workspaceId: "workspace_1",
  });
  const legacy = resolveThreadInvocation({
    envelope: {
      selectableId: legacyCapabilityToolSelectableId("generate_image"),
      userInput: "make an image",
    },
    registry: registry(),
    userId: "user_1",
    workspaceId: "workspace_1",
  });

  assert.equal(current?.kind, "fixed_tool_choice");
  assert.equal(legacy?.kind, "fixed_tool_choice");
  assert.equal(current?.sourceRef.kind, "capability_tool");
  assert.equal(legacy?.sourceRef.kind, "capability_tool");
  assert.equal(current?.toolName, "generate_image");
  assert.equal(legacy?.toolName, "generate_image");
});

test("resolveThreadInvocation preserves documented legacy ids for artifact tools", () => {
  const cases = [
    {
      capabilityId: "sourceweft/generate-image",
      legacyId: legacyCapabilityToolSelectableId("generate_image"),
      toolName: "generate_image",
    },
    {
      capabilityId: "sourceweft/generate-video-presentation",
      legacyId: legacyCapabilityToolSelectableId(
        "generate_video_presentation",
      ),
      toolName: "generate_video_presentation",
    },
  ] as const;
  const currentRegistry = registry();

  for (const item of cases) {
    const resolved = resolveThreadInvocation({
      envelope: {
        selectableId: item.legacyId,
        userInput: "make an artifact",
      },
      registry: currentRegistry,
      userId: "user_1",
      workspaceId: "workspace_1",
    });

    assert.equal(resolved?.kind, "fixed_tool_choice");
    assert.equal(resolved?.sourceRef.kind, "capability_tool");
    assert.equal(
      resolved?.sourceRef.kind === "capability_tool"
        ? resolved.sourceRef.capabilityId
        : null,
      item.capabilityId,
    );
    assert.equal(resolved?.toolName, item.toolName);
  }
});

test("buildDefaultTurnInvocationRegistry resolves discovered capability tool commands", async () => {
  const registry = await buildDefaultTurnInvocationRegistry({
    enabledSkills: [],
  });

  const current = registry.resolve("cap:sourceweft/web-search:web_search");
  const legacy = registry.resolve(
    legacyCapabilityToolSelectableId("web_search"),
  );

  assert.ok(current);
  assert.equal(legacy, current);
  assert.equal(current.sourceRef.kind, "capability_tool");
  assert.equal(
    current.semantics.kind === "fixed_tool_choice"
      ? current.semantics.target
      : null,
    "capability_tool",
  );
});

test("resolveThreadInvocation returns ContentError for unknown selectable ids", () => {
  assert.throws(
    () =>
      resolveThreadInvocation({
        envelope: {
          selectableId: legacyCapabilityToolSelectableId("unknown"),
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
