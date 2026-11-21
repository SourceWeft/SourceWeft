import assert from "node:assert/strict";
import { test } from "vitest";
import { buildCapabilityCommandList } from "@sourceweft/capability-runtime";
import { listCapabilityRecords } from "./capability-command-workflows";
import { resolveThreadCommand } from "./thread-command";

/**
 * `/table` against the real capability manifests: it is a listed tool command
 * with a workflow (which is what the composer requires to show it), and the
 * backend resolves it into a turn that binds generate_table without forcing it,
 * so the agent may ask what to compare first.
 */

test("/table is a visible capability command with a workflow", async () => {
  const commands = buildCapabilityCommandList(await listCapabilityRecords());
  const table = commands.find(
    (command) =>
      command.action.kind === "tool" && command.action.targetId === "generate_table",
  );
  assert.ok(table, "the table capability contributes a command");
  assert.deepEqual(table.aliases, ["table"]);
  assert.equal(table.visible, true);
  assert.equal(table.category, "Artifacts");
  assert.ok(table.workflow, "a tool command needs a workflow to be listed");
  assert.deepEqual(table.workflow.defaultTools, ["generate_table"]);
  assert.equal(table.workflow.initialToolPolicy, "auto");
  assert.deepEqual(table.workflow.successCriteria, { kind: "none" });
});

test("/table resolves on the backend to a tool workflow around generate_table", async () => {
  const resolved = await resolveThreadCommand({
    command: { name: "table", arguments: "compare pricing and launch dates", kind: "tool" },
    enabledSkills: [],
  });
  assert.ok(resolved);
  assert.equal(resolved.kind, "tool");
  assert.equal(resolved.toolName, "generate_table");
  assert.equal(resolved.canonicalName, "/generate_table");
  const workflow = resolved.workflow!;
  assert.equal(workflow.kind, "tool_workflow");
  assert.deepEqual(workflow.defaultTools, ["generate_table"]);
  assert.equal(workflow.initialToolPolicy, "auto");
  assert.deepEqual(workflow.successCriteria, { kind: "none" });
  assert.equal(workflow.execution, "agent");
  const prompt = workflow.renderedPrompt;
  assert.match(prompt, /compare pricing and launch dates/);
  assert.match(prompt, /2 to 12 columns/);
  assert.match(prompt, /@mention/);
  assert.match(prompt, /Artifacts tab/);
});
