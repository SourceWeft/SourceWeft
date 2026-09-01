import assert from "node:assert/strict";
import type { CapabilityCommandListItem } from "@sourceweft/capability-runtime";
import { test } from "vitest";
import { createSelectableInvocationRegistry } from "../registry";
import { createCapabilityToolInvocationProvider } from "./capability-tools";

function capabilityCommand(
  input: Partial<CapabilityCommandListItem> & {
    readonly action: CapabilityCommandListItem["action"];
    readonly capabilityId: string;
    readonly contributionId: string;
    readonly id: string;
    readonly title: string;
  },
): CapabilityCommandListItem {
  return {
    aliases: [],
    category: null,
    displayTitle: input.title,
    order: 0,
    parentKind: null,
    parentTitle: null,
    sourcePackageName: null,
    visible: true,
    workflow: null,
    ...input,
  };
}

test("capability tool provider projects tool contributions as fixed tool choice", () => {
  const provider = createCapabilityToolInvocationProvider({
    commands: [
      capabilityCommand({
        action: { kind: "tool", targetId: "generate_image" },
        aliases: ["image"],
        capabilityId: "sourceweft/generate-image",
        contributionId: "generate_image",
        id: "cap:sourceweft/generate-image:generate_image",
        title: "Generate Image",
      }),
      capabilityCommand({
        action: { kind: "tool", targetId: "publish_report" },
        aliases: ["report", "document"],
        capabilityId: "sourceweft/report-builder",
        contributionId: "publish_report",
        id: "cap:sourceweft/report-builder:publish_report",
        title: "Publish Report",
      }),
      capabilityCommand({
        action: { kind: "skill", targetId: "feynman" },
        aliases: ["explain"],
        capabilityId: "sourceweft/feynman",
        contributionId: "feynman",
        id: "cap:sourceweft/feynman:feynman",
        title: "Feynman",
      }),
    ],
  });

  const definitions = provider.list();
  assert.deepEqual(
    definitions.map((definition) => definition.id),
    [
      "cap:sourceweft/generate-image:generate_image",
      "cap:sourceweft/report-builder:publish_report",
    ],
  );
  assert.equal(definitions[0]?.sourceRef.kind, "capability_tool");
  assert.equal(
    definitions[0]?.sourceRef.kind === "capability_tool"
      ? definitions[0].sourceRef.toolName
      : null,
    "generate_image",
  );
  assert.equal(
    definitions[0]?.semantics.kind === "fixed_tool_choice"
      ? definitions[0].semantics.target
      : null,
    "capability_tool",
  );
  assert.equal(definitions[0]?.slashAlias, "/image");
  assert.deepEqual(definitions[0]?.alternateSlashAliases, []);
  assert.deepEqual(definitions[1]?.alternateSlashAliases, ["/document"]);
});

test("capability tool provider derives projection from arbitrary tool command records", () => {
  const provider = createCapabilityToolInvocationProvider({
    commands: [
      capabilityCommand({
        action: { kind: "tool", targetId: "future_chart_tool" },
        aliases: ["chart", "/visualize"],
        capabilityId: "sourceweft/future-chart",
        contributionId: "future_chart_tool",
        id: "cap:sourceweft/future-chart:future_chart_tool",
        title: "Future Chart",
      }),
    ],
  });

  const definition = provider.list()[0];

  assert.ok(definition);
  assert.equal(definition.id, "cap:sourceweft/future-chart:future_chart_tool");
  assert.equal(definition.sourceRef.kind, "capability_tool");
  assert.equal(
    definition.sourceRef.kind === "capability_tool"
      ? definition.sourceRef.toolName
      : null,
    "future_chart_tool",
  );
  assert.equal(definition.slashAlias, "/chart");
  assert.deepEqual(definition.alternateSlashAliases, ["/visualize"]);
  assert.equal(
    definition.semantics.kind === "fixed_tool_choice"
      ? definition.semantics.toolName
      : null,
    "future_chart_tool",
  );
});

test("capability tool provider resolves capability ids and slash aliases only", () => {
  const registry = createSelectableInvocationRegistry({
    providers: [
      createCapabilityToolInvocationProvider({
        commands: [
          capabilityCommand({
            action: { kind: "tool", targetId: "generate_image" },
            aliases: ["image"],
            capabilityId: "sourceweft/generate-image",
            contributionId: "generate_image",
            id: "cap:sourceweft/generate-image:generate_image",
            title: "Generate Image",
          }),
        ],
      }),
    ],
  });

  const current = registry.resolve("cap:sourceweft/generate-image:generate_image");

  assert.ok(current);
  assert.equal(registry.resolve("builtin_tool.generate_image"), null);
  assert.equal(registry.resolveAlias("/image"), current);
});

test("capability tool provider ignores non-tool and invisible command records", () => {
  const provider = createCapabilityToolInvocationProvider({
    commands: [
      capabilityCommand({
        action: { kind: "tool", targetId: "generate_image" },
        capabilityId: "sourceweft/generate-image",
        contributionId: "generate_image",
        id: "cap:sourceweft/generate-image:generate_image",
        title: "Generate Image",
        visible: false,
      }),
      capabilityCommand({
        action: { kind: "skill", targetId: "feynman" },
        capabilityId: "sourceweft/feynman",
        contributionId: "feynman",
        id: "cap:sourceweft/feynman:feynman",
        title: "Feynman",
      }),
    ],
  });

  assert.deepEqual(provider.list(), []);
});
