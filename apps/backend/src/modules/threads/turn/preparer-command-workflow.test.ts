import assert from "node:assert/strict";
import { resolve } from "node:path";
import { afterEach, test } from "vitest";
import { ContentError } from "../../content/errors";
import {
  listCapabilityCommands,
  testExports as capabilityWorkflowTestExports,
} from "./capability-command-workflows";
import { resolveThreadCommand } from "./thread-command";

afterEach(() => {
  capabilityWorkflowTestExports.resetCapabilityRuntimeAdapter();
  capabilityWorkflowTestExports.resetCapabilityRecordsCache();
});

test("capability workflow discovery exposes manifest artifact tool commands from configured packages", async () => {
  const previousRoot = process.env.SOURCEWEFT_CAPABILITY_PACKAGES_DIR;
  process.env.SOURCEWEFT_CAPABILITY_PACKAGES_DIR = resolve(
    process.cwd(),
    "../../packages",
  );
  capabilityWorkflowTestExports.resetCapabilityRecordsCache();
  try {
    const commands = await listCapabilityCommands();
    const artifactTools = commands
      .filter((command) => command.category === "Artifacts")
      .map((command) => ({
        actionKind: command.action.kind,
        aliases: command.aliases,
        iconName: command.iconName,
        targetId: command.action.targetId,
      }));

    assert.deepEqual(artifactTools, [
      {
        actionKind: "tool",
        aliases: ["image"],
        iconName: undefined,
        targetId: "generate_image",
      },
      {
        actionKind: "tool",
        aliases: ["video-presentation", "video"],
        iconName: undefined,
        targetId: "generate_video_presentation",
      },
      {
        actionKind: "skill",
        aliases: ["ppt", "slides", "deck", "presentation"],
        iconName: "presentation",
        targetId: "ppt-deck",
      },
    ]);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.SOURCEWEFT_CAPABILITY_PACKAGES_DIR;
    } else {
      process.env.SOURCEWEFT_CAPABILITY_PACKAGES_DIR = previousRoot;
    }
    capabilityWorkflowTestExports.resetCapabilityRecordsCache();
  }
});

test("capability workflow discovery fails when configured packages root is missing", async () => {
  const previousRoot = process.env.SOURCEWEFT_CAPABILITY_PACKAGES_DIR;
  const previousCwd = process.cwd();
  process.env.SOURCEWEFT_CAPABILITY_PACKAGES_DIR = resolve(
    process.cwd(),
    ".missing-capability-packages",
  );
  capabilityWorkflowTestExports.resetCapabilityRecordsCache();
  try {
    process.chdir(resolve(process.cwd(), "../.."));
    await assert.rejects(
      listCapabilityCommands(),
      (error) =>
        error instanceof Error &&
        error.message.includes(".missing-capability-packages"),
    );
  } finally {
    process.chdir(previousCwd);
    if (previousRoot === undefined) {
      delete process.env.SOURCEWEFT_CAPABILITY_PACKAGES_DIR;
    } else {
      process.env.SOURCEWEFT_CAPABILITY_PACKAGES_DIR = previousRoot;
    }
    capabilityWorkflowTestExports.resetCapabilityRecordsCache();
  }
});

test("resolveThreadCommand renders manifest workflow metadata for artifact tool commands", async () => {
  const cases = [
    {
      toolName: "generate_image",
      expectedExecution: "direct",
      expectedArtifactType: "image",
      expectedPromptText: "Create an image artifact from the user's request.",
      request: "draw a dashboard",
    },
    {
      toolName: "generate_video_presentation",
      expectedExecution: "agent",
      expectedSuccessCriteria: {
        kind: "tool_call",
        toolName: "generate_video_presentation",
      },
      expectedPromptText:
        "Create a narrated video presentation artifact from the user's request.",
      request: "make an onboarding video",
    },
  ] as const;

  for (const item of cases) {
    const command = await resolveThreadCommand({
      command: {
        arguments: item.request,
        kind: "tool",
        name: `/${item.toolName}`,
      },
      enabledSkills: [],
    });

    assert.equal(command?.canonicalName, `/${item.toolName}`);
    assert.equal(command?.workflow?.execution, item.expectedExecution);
    assert.equal(command?.workflow?.kind, "tool_workflow");
    assert.deepEqual(command?.workflow?.defaultTools, [item.toolName]);
    assert.deepEqual(command?.workflow?.permissionOverrides, {
      [item.toolName]: "allow",
    });
    assert.deepEqual(
      command?.workflow?.successCriteria,
      "expectedSuccessCriteria" in item
        ? item.expectedSuccessCriteria
        : {
            kind: "artifact",
            artifactType: "image",
            toolName: item.toolName,
          },
    );
    assert.match(
      command?.workflow?.renderedPrompt ?? "",
      /kind="tool_workflow"/,
    );
    assert.equal(
      command?.workflow?.renderedPrompt.includes(item.expectedPromptText),
      true,
    );
    assert.match(
      command?.workflow?.renderedPrompt ?? "",
      new RegExp(`<user_request>\\n${item.request}\\n</user_request>`),
    );
  }
});

test("resolveThreadCommand resolves manifest aliases to artifact tool workflows", async () => {
  const cases = [
    {
      alias: "/image",
      expectedCanonicalName: "/generate_image",
      expectedToolName: "generate_image",
    },
    {
      alias: "/video",
      expectedCanonicalName: "/generate_video_presentation",
      expectedToolName: "generate_video_presentation",
    },
  ] as const;

  for (const item of cases) {
    const command = await resolveThreadCommand({
      command: {
        arguments: "make the artifact",
        kind: "tool",
        name: item.alias,
      },
      enabledSkills: [],
    });

    assert.equal(command?.name, item.alias);
    assert.equal(command?.canonicalName, item.expectedCanonicalName);
    assert.equal(command?.toolName, item.expectedToolName);
    assert.equal(command?.workflow?.name, item.expectedCanonicalName);
    assert.equal(command?.workflow?.kind, "tool_workflow");
    assert.deepEqual(command?.workflow?.defaultTools, [item.expectedToolName]);
  }
});

test("resolveThreadCommand resolves manifest skill aliases to enabled skills", async () => {
  const command = await resolveThreadCommand({
    command: {
      arguments: "make the artifact",
      kind: "skill",
      name: "/ppt",
    },
    enabledSkills: [
      {
        workspaceSkillId: "workspace-skill-1",
        sourceType: "builtin",
        name: "ppt-deck",
        displayName: "PPT Deck",
        version: "2.0.0",
        description: "Create a PPT deck",
        files: [],
        slash: false,
      },
    ],
  });

  assert.equal(command?.name, "/ppt");
  assert.equal(command?.canonicalName, "/ppt-deck");
  assert.equal(command?.kind, "skill");
  assert.equal(command?.skillSlug, "ppt-deck");
  assert.equal(command?.displayName, "PPT Deck");
  assert.equal(command?.workflow?.kind, "skill_workflow");
  assert.match(
    command?.workflow?.renderedPrompt ?? "",
    /kind="skill_workflow"/,
  );
  assert.match(
    command?.workflow?.renderedPrompt ?? "",
    /DeepAgents skills middleware/,
  );
  assert.doesNotMatch(
    command?.workflow?.renderedPrompt ?? "",
    /Create a PowerPoint PPTX deck by following the ppt-deck skill workflow/,
  );
  assert.doesNotMatch(command?.workflow?.renderedPrompt ?? "", /SKILL\.md/);
  assert.match(
    command?.workflow?.renderedPrompt ?? "",
    /publish_sandbox_artifact/,
  );
  assert.deepEqual(command?.workflow?.defaultTools, [
    "prepare_sandbox_workspace",
    "execute",
    "publish_sandbox_artifact",
  ]);
  assert.deepEqual(command?.workflow?.successCriteria, {
    kind: "artifact",
    artifactType: "slides",
    toolName: "publish_sandbox_artifact",
  });
});

test("resolveThreadCommand rejects skill bundle subcommands", async () => {
  await assert.rejects(
    resolveThreadCommand({
      command: {
        arguments: "what is SFT?",
        kind: "skill",
        name: "/feynman:explain",
      },
      enabledSkills: [
        {
          workspaceSkillId: "workspace-skill-1",
          sourceType: "builtin",
          name: "feynman",
          displayName: "Feynman",
          version: "1.0.0",
          description: "Use the Feynman technique",
          files: [],
        },
      ],
    }),
    (error) =>
      error instanceof ContentError &&
      error.code === "COMMAND_NOT_FOUND" &&
      error.statusCode === 404,
  );
});

test("resolveThreadCommand rejects unknown tool aliases as command-not-found", async () => {
  await assert.rejects(
    resolveThreadCommand({
      command: {
        arguments: "make the artifact",
        kind: "tool",
        name: "/not-a-tool-alias",
      },
      enabledSkills: [],
    }),
    (error) =>
      error instanceof ContentError &&
      error.code === "COMMAND_NOT_FOUND" &&
      error.statusCode === 404,
  );
});
