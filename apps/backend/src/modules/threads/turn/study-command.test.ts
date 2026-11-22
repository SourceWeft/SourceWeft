import assert from "node:assert/strict";
import { test } from "vitest";
import { buildCapabilityCommandList } from "@sourceweft/capability-runtime";
import type { EnabledSkillDescriptor } from "../../skills/types";
import { listCapabilityRecords } from "./capability-command-workflows";
import { parseRequestedCommand, resolveThreadCommand } from "./thread-command";

/**
 * `/flashcards`, `/quiz` and `/mindmap` against the real capability manifests:
 * each is a listed tool command with a workflow (which is what the composer
 * requires to show it), and the backend resolves each into a turn that binds
 * its own study tool without forcing it, so with no sources selected the agent
 * can ask for them instead of failing.
 */

const STUDY_COMMANDS = [
  { alias: "flashcards", tool: "generate_flashcards", title: "Flashcards", noun: "flashcards" },
  { alias: "quiz", tool: "generate_quiz", title: "Quiz", noun: "a quiz" },
  { alias: "mindmap", tool: "generate_mindmap", title: "Mind Map", noun: "a mind map" },
] as const;

for (const study of STUDY_COMMANDS) {
  test(`/${study.alias} is a visible capability command with a workflow`, async () => {
    const commands = buildCapabilityCommandList(await listCapabilityRecords());
    const command = commands.find(
      (candidate) =>
        candidate.action.kind === "tool" && candidate.action.targetId === study.tool,
    );
    assert.ok(command, `the study capability contributes /${study.alias}`);
    assert.equal(command.capabilityId, "sourceweft/study-tool");
    assert.equal(command.title, study.title);
    assert.deepEqual(command.aliases, [study.alias]);
    assert.equal(command.visible, true);
    assert.equal(command.category, "Artifacts");
    assert.ok(command.workflow, "a tool command needs a workflow to be listed");
    assert.deepEqual(command.workflow.defaultTools, [study.tool]);
    assert.equal(command.workflow.initialToolPolicy, "auto");
    assert.deepEqual(command.workflow.successCriteria, { kind: "none" });
  });

  test(`/${study.alias} resolves on the backend to a tool workflow around ${study.tool}`, async () => {
    const requested = parseRequestedCommand({
      command: {
        name: `/${study.alias}`,
        arguments: "  focus on chapter 3, in English  ",
        kind: "tool",
      },
    });
    assert.deepEqual(requested, {
      name: `/${study.alias}`,
      arguments: "focus on chapter 3, in English",
      kind: "tool",
    });
    const resolved = await resolveThreadCommand({ command: requested, enabledSkills: [] });
    assert.ok(resolved);
    assert.equal(resolved.kind, "tool");
    assert.equal(resolved.toolName, study.tool);
    assert.equal(resolved.canonicalName, `/${study.tool}`);
    assert.equal(resolved.displayName, study.title);
    const workflow = resolved.workflow!;
    assert.equal(workflow.kind, "tool_workflow");
    assert.deepEqual(workflow.defaultTools, [study.tool]);
    assert.equal(workflow.initialToolPolicy, "auto");
    assert.deepEqual(workflow.permissionOverrides, {});
    assert.deepEqual(workflow.successCriteria, { kind: "none" });
    assert.equal(workflow.execution, "agent");
    const prompt = workflow.renderedPrompt;
    assert.match(prompt, new RegExp(`tool="${study.tool}"`));
    assert.match(prompt, /focus on chapter 3, in English/);
    assert.match(prompt, /@mention/);
    assert.match(prompt, /Artifacts tab/);
    // The clarification path when the turn has no sources.
    assert.match(
      prompt,
      new RegExp(
        `no sources, do not call it again: ask the user to select or @mention the sources to make ${study.noun} from`,
      ),
    );
  });

  test(`/${study.alias} with no arguments is still a complete request`, async () => {
    const resolved = await resolveThreadCommand({
      command: { name: study.alias, arguments: "", kind: "tool" },
      enabledSkills: [],
    });
    assert.equal(resolved?.workflow?.kind, "tool_workflow");
    assert.deepEqual(resolved?.workflow?.defaultTools, [study.tool]);
  });
}

function workspaceSkill(name: string) {
  return {
    workspaceSkillId: `ws-skill-${name}`,
    sourceType: "workspace",
    name,
    version: "1.0.0",
    description: `A workspace skill called ${name}`,
  } as unknown as EnabledSkillDescriptor;
}

for (const name of ["mindmap", "quiz", "flashcards", "table"]) {
  test(`a skill named ${name} sent as a skill command runs the skill, not the tool`, async () => {
    const resolved = await resolveThreadCommand({
      command: { name: `/${name}`, arguments: "go", kind: "skill" },
      enabledSkills: [workspaceSkill(name)],
    });
    assert.equal(resolved?.kind, "skill");
    assert.equal(resolved?.skillSlug, name);
    assert.equal(resolved?.canonicalName, `/${name}`);
    assert.equal(resolved?.toolName, undefined);
  });
}

test("with a skill named mindmap enabled, /mindmap as a tool command still runs the tool", async () => {
  const resolved = await resolveThreadCommand({
    command: { name: "/mindmap", arguments: "", kind: "tool" },
    enabledSkills: [workspaceSkill("mindmap")],
  });
  assert.equal(resolved?.kind, "tool");
  assert.equal(resolved?.toolName, "generate_mindmap");
});

test("a skill command naming a tool alias with no such skill enabled is not found", async () => {
  await assert.rejects(
    resolveThreadCommand({
      command: { name: "/quiz", arguments: "", kind: "skill" },
      enabledSkills: [],
    }),
    (error: unknown) => (error as { code?: string }).code === "COMMAND_NOT_FOUND",
  );
});

test("the study commands are also found by tool name and without the kind hint", async () => {
  const byTool = await resolveThreadCommand({
    command: { name: "/generate_quiz", arguments: "", kind: "tool" },
    enabledSkills: [],
  });
  assert.equal(byTool?.toolName, "generate_quiz");
  const unhinted = await resolveThreadCommand({
    command: { name: "/Mindmap", arguments: "" },
    enabledSkills: [],
  });
  assert.equal(unhinted?.kind, "tool");
  assert.equal(unhinted?.toolName, "generate_mindmap");
});
