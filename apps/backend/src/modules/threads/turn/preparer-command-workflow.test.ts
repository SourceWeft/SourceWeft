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
        visible: command.visible,
      }))
      .sort((left, right) => {
        if (left.visible !== right.visible) {
          return Number(left.visible) - Number(right.visible);
        }
        return left.targetId.localeCompare(right.targetId);
      });

    assert.deepEqual(artifactTools, [
      {
        actionKind: "skill",
        aliases: ["image", "generate-image", "picture"],
        iconName: "image",
        targetId: "image-generate",
        visible: true,
      },
      {
        actionKind: "skill",
        aliases: ["ppt", "slides", "deck", "presentation"],
        iconName: "presentation",
        targetId: "ppt-deck",
        visible: true,
      },
      {
        actionKind: "skill",
        aliases: ["video-presentation", "video"],
        iconName: "video-presentation",
        targetId: "video-presentation",
        visible: true,
      },
    ]);
    assert.deepEqual(
      artifactTools
        .filter((command) => command.visible)
        .map((command) => command.targetId),
      ["image-generate", "ppt-deck", "video-presentation"],
    );
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

test("resolveThreadCommand rejects hidden artifact tool slash commands", async () => {
  const cases = ["/generate_image", "/generate_video_presentation"] as const;

  for (const alias of cases) {
    await assert.rejects(
      resolveThreadCommand({
        command: {
          arguments: "make the artifact",
          kind: "tool",
          name: alias,
        },
        enabledSkills: [],
      }),
      (error) =>
        error instanceof ContentError &&
        error.code === "COMMAND_NOT_FOUND" &&
        error.statusCode === 404,
    );
  }
});

test("resolveThreadCommand resolves video skill alias to agent generate_video_presentation workflow", async () => {
  const command = await resolveThreadCommand({
    command: {
      arguments: "make an onboarding video",
      kind: "skill",
      name: "/video",
    },
    enabledSkills: [
      {
        workspaceSkillId: "builtin:video-presentation",
        selectionId: "builtin:video-presentation",
        sourceType: "builtin",
        name: "video-presentation",
        displayName: "Video Presentation",
        version: "1.0.0",
        description: "Create video presentation artifacts",
        files: [],
        slash: false,
        tools: ["generate_video_presentation"],
      },
    ],
  });

  assert.equal(command?.name, "/video");
  assert.equal(command?.canonicalName, "/video-presentation");
  assert.equal(command?.kind, "skill");
  assert.equal(command?.skillSlug, "video-presentation");
  assert.equal(command?.displayName, "Video Presentation");
  assert.equal(command?.workflow?.kind, "skill_workflow");
  assert.equal(command?.workflow?.execution, "agent");
  assert.deepEqual(command?.workflow?.defaultTools, [
    "generate_video_presentation",
  ]);
  assert.deepEqual(command?.workflow?.permissionOverrides, {
    generate_video_presentation: "allow",
  });
  assert.deepEqual(command?.workflow?.successCriteria, {
    kind: "artifact",
    artifactType: "video_presentation",
    toolName: "generate_video_presentation",
  });
  assert.match(
    command?.workflow?.renderedPrompt ?? "",
    /kind="skill_workflow"/,
  );
  assert.match(
    command?.workflow?.renderedPrompt ?? "",
    /video-presentation skill workflow/,
  );
  assert.match(
    command?.workflow?.renderedPrompt ?? "",
    /\/skills\/video-presentation\/SKILL\.md/,
  );
  assert.match(command?.workflow?.renderedPrompt ?? "", /generate_video_presentation/);
});

test("resolveThreadCommand rejects legacy generate_image tool alias", async () => {
  await assert.rejects(
    resolveThreadCommand({
      command: {
        arguments: "draw a dashboard",
        kind: "tool",
        name: "/generate_image",
      },
      enabledSkills: [
        {
          workspaceSkillId: "builtin:image-generate",
          selectionId: "builtin:image-generate",
          sourceType: "builtin",
          name: "image-generate",
          displayName: "Image Generate",
          version: "1.0.0",
          description: "Generate image artifacts",
          files: [],
          slash: false,
          tools: ["generate_image"],
        },
      ],
    }),
    (error) =>
      error instanceof ContentError &&
      error.code === "COMMAND_NOT_FOUND" &&
      error.statusCode === 404,
  );
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
    /publish_artifact/,
  );
  assert.deepEqual(command?.workflow?.defaultTools, [
    "prepare_sandbox_workspace",
    "execute",
    "publish_artifact",
  ]);
  assert.deepEqual(command?.workflow?.successCriteria, {
    kind: "artifact",
    artifactType: "slides",
    toolName: "publish_artifact",
  });
});

test("resolveThreadCommand resolves image skill alias to agent generate_image workflow", async () => {
  const command = await resolveThreadCommand({
    command: {
      arguments: "draw a dashboard",
      kind: "skill",
      name: "/image",
    },
    enabledSkills: [
      {
        workspaceSkillId: "builtin:image-generate",
        selectionId: "builtin:image-generate",
        sourceType: "builtin",
        name: "image-generate",
        displayName: "Image Generate",
        version: "1.0.0",
        description: "Generate image artifacts",
        files: [],
        slash: false,
        tools: ["generate_image"],
      },
    ],
  });

  assert.equal(command?.name, "/image");
  assert.equal(command?.canonicalName, "/image-generate");
  assert.equal(command?.kind, "skill");
  assert.equal(command?.skillSlug, "image-generate");
  assert.equal(command?.displayName, "Image Generate");
  assert.equal(command?.workflow?.kind, "skill_workflow");
  assert.equal(command?.workflow?.execution, "agent");
  assert.deepEqual(command?.workflow?.defaultTools, ["generate_image"]);
  assert.deepEqual(command?.workflow?.permissionOverrides, {
    generate_image: "allow",
  });
  assert.deepEqual(command?.workflow?.successCriteria, {
    kind: "artifact",
    artifactType: "image",
    toolName: "generate_image",
  });
  assert.match(
    command?.workflow?.renderedPrompt ?? "",
    /kind="skill_workflow"/,
  );
  assert.match(
    command?.workflow?.renderedPrompt ?? "",
    /Create a persisted SourceWeft image artifact/,
  );
  assert.match(command?.workflow?.renderedPrompt ?? "", /generate_image/);
  assert.doesNotMatch(command?.workflow?.renderedPrompt ?? "", /\/workspace/);
  assert.doesNotMatch(
    command?.workflow?.renderedPrompt ?? "",
    /filesystem scripts/,
  );
  assert.doesNotMatch(
    command?.workflow?.renderedPrompt ?? "",
    /code drawing as a substitute/,
  );
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
