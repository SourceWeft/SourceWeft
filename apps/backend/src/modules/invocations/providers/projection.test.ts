import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { createSelectableInvocationRegistry } from "../registry";
import { createCapabilityToolInvocationProvider } from "./capability-tools";
import { capabilityCommand } from "./capability-tool-fixtures";
import { createSkillCommandInvocationProvider } from "./skills";

test("obsolete builtin tool compatibility provider is deleted", async () => {
  await assert.rejects(
    readFile(
      join(
        process.cwd(),
        "src/modules/invocations/providers/builtin-tools.ts",
      ),
      "utf8",
    ),
  );
});

test("legacy builtin_tool selectable ids are documented as removed", async () => {
  const repositoryRoot = join(process.cwd(), "../..");
  const capabilityBindingDoc = await readFile(
    join(repositoryRoot, "docs/architecture/capability-binding.md"),
    "utf8",
  );

  assert.match(
    capabilityBindingDoc,
    /Legacy `builtin_tool\.\*` selectable IDs and `legacyIds` aliases were removed/u,
  );
});

test("legacy builtin_tool selectable ids do not resolve", () => {
  const registry = createSelectableInvocationRegistry({
    providers: [
      createCapabilityToolInvocationProvider({
        commands: [
          capabilityCommand({
            action: { kind: "tool", targetId: "generate_image" },
            capabilityId: "sourceweft/generate-image",
            contributionId: "generate_image",
            id: "cap:sourceweft/generate-image:generate_image",
            title: "Generate Image",
          }),
        ],
      }),
    ],
  });

  assert.equal(registry.resolve("cap:sourceweft/generate-image:generate_image")?.id, "cap:sourceweft/generate-image:generate_image");
  assert.equal(registry.resolve("builtin_tool.generate_image"), null);
});

test("skill command provider projects commands as workflow context injection only", () => {
  const provider = createSkillCommandInvocationProvider({
    skills: [
      {
        workspaceSkillId: "skill_1",
        skillSlug: "research",
        displayName: "Research",
        commands: [
          {
            name: "summarize",
            title: "Summarize",
            description: "Summarize sources",
            workflow: "Read all selected sources, then summarize.",
          },
        ],
        enabled: true,
      },
    ],
  });

  const definition = provider.list()[0];
  assert.ok(definition);
  assert.equal(definition.id, "skill_command.research.summarize");
  assert.equal(definition.sourceRef.kind, "skill_command");
  assert.equal(definition.semantics.kind, "context_injection");
});
