import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test, vi } from "vitest";
import { ContentError } from "../content/errors";

// Object storage as an in-memory map, counting every blob read: the point of
// the manifest model is how FEW of these a turn makes.
const store = vi.hoisted(() => ({
  blobs: new Map<string, Buffer>(),
  blobReads: [] as string[],
}));
vi.mock("./storage", async (original) => ({
  ...(await original<typeof import("./storage")>()),
  readSkillBlob: async ({ objectKey }: { objectKey: string }) => {
    store.blobReads.push(objectKey);
    return store.blobs.get(objectKey)!;
  },
}));

import {
  builtinSkillSelectionId,
  resolveSelectedSkills,
  resolveSkillIdsWithSlashCommand,
} from "./selection";
import type { WorkspaceSkillRecord } from "./types";

const emptyWorkspaceSkillDependencies = {
  listEnabledWorkspaceSkills: async () => [],
  listWorkspaceSkillsByIds: async () => [],
};

function workspaceSkill(
  overrides: Partial<WorkspaceSkillRecord> = {},
): WorkspaceSkillRecord {
  return {
    id: "workspace-skill-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    skillId: "skill-1",
    skillVersionId: "version-1",
    enabled: true,
    configJson: {},
    enabledBy: null,
    enabledAt: null,
    installedVia: "user",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

test("resolveSkillIdsWithSlashCommand resolves a managed builtin via the workspace install path", async () => {
  // feynman is a `managed` builtin (opt-in): a slash activation must resolve
  // through the install-checked workspace path, not the always-on builtin id.
  const skillIds = await resolveSkillIdsWithSlashCommand({
    teamId: "team-1",
    workspaceId: "workspace-1",
    skillIds: [],
    commandName: "/feynman",
    findSkillBySlug: async (input) => ({
      id: `enabled-${input.slug}`,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      skillId: "skill-1",
      skillVersionId: "version-1",
      enabled: true,
      configJson: {},
      enabledBy: null,
      enabledAt: null,
      installedVia: "user",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }),
  });

  assert.deepEqual(skillIds, ["enabled-feynman"]);
});

test("resolveSkillIdsWithSlashCommand adds builtin id for an always-on builtin", async () => {
  // ppt-deck is a non-managed (always-on) builtin, so its slash activation
  // resolves directly to the builtin selection id without an install lookup.
  const skillIds = await resolveSkillIdsWithSlashCommand({
    teamId: "team-1",
    workspaceId: "workspace-1",
    skillIds: [],
    commandName: "/ppt-deck",
    findSkillBySlug: async () => {
      throw new Error("always-on builtin must not hit the workspace path");
    },
  });

  assert.deepEqual(skillIds, ["builtin:ppt-deck"]);
});

test("resolveSkillIdsWithSlashCommand ignores slash subcommands", async () => {
  const skillIds = await resolveSkillIdsWithSlashCommand({
    teamId: "team-1",
    workspaceId: "workspace-1",
    skillIds: ["existing-skill"],
    commandName: "/feynman:explain",
    findSkillBySlug: async (input) => ({
      id: `enabled-${input.slug}`,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      skillId: "skill-1",
      skillVersionId: "version-1",
      enabled: true,
      configJson: {},
      enabledBy: null,
      enabledAt: null,
      installedVia: "user",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }),
  });

  assert.deepEqual(skillIds, ["existing-skill"]);
});

test("resolveSkillIdsWithSlashCommand leaves ids unchanged when workspace skill is not enabled", async () => {
  const skillIds = await resolveSkillIdsWithSlashCommand({
    teamId: "team-1",
    workspaceId: "workspace-1",
    skillIds: [],
    commandName: "/custom-review",
    findSkillBySlug: async () => null,
  });

  assert.deepEqual(skillIds, []);
});

test("resolveSelectedSkills allows builtin runtime ids without workspace install records", async () => {
  const skills = await resolveSelectedSkills({
    teamId: "team-1",
    workspaceId: "workspace-1",
    skillIds: [builtinSkillSelectionId("ppt-deck")],
    ...emptyWorkspaceSkillDependencies,
  });

  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.workspaceSkillId, "builtin:ppt-deck");
  assert.equal(skills[0]?.selectionId, "builtin:ppt-deck");
  assert.equal(skills[0]?.sourceType, "builtin");
  assert.equal(skills[0]?.name, "ppt-deck");
  assert.equal(skills[0]?.defaultEnabled, true);
});

test("resolveSelectedSkills preserves an explicitly non-default builtin runtime", async () => {
  const skills = await resolveSelectedSkills({
    teamId: "team-1",
    workspaceId: "workspace-1",
    skillIds: [builtinSkillSelectionId("video-presentation")],
    ...emptyWorkspaceSkillDependencies,
  });

  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.name, "video-presentation");
  assert.equal(skills[0]?.defaultEnabled, false);
});

test("resolveSelectedSkills allows public builtin runtime ids from chat options", async () => {
  const skills = await resolveSelectedSkills({
    teamId: "team-1",
    workspaceId: "workspace-1",
    skillIds: [builtinSkillSelectionId("feynman")],
    ...emptyWorkspaceSkillDependencies,
  });

  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.workspaceSkillId, "builtin:feynman");
  assert.equal(skills[0]?.sourceType, "builtin");
  assert.equal(skills[0]?.name, "feynman");
});

test("resolveSelectedSkills includes Hub-enabled workspace skills without request skill ids", async () => {
  const record = workspaceSkill();
  const fileReads: string[] = [];
  const skills = await resolveSelectedSkills({
    teamId: "team-1",
    workspaceId: "workspace-1",
    skillIds: [],
    listEnabledWorkspaceSkills: async () => [record],
    listWorkspaceSkillsByIds: async () => [],
    loadWorkspaceSkillVersion: async () => ({
      definition: {
        id: record.skillId,
        teamId: "team-1",
        workspaceId: "workspace-1",
        sourceType: "workspace_custom",
        slug: "custom-review",
        displayName: "Custom Review",
        description: "Review custom material.",
        visibility: "workspace",
        status: "active",
        ownerUserId: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      version: {
        id: record.skillVersionId,
        skillId: record.skillId,
        version: "1.0.0",
        status: "published",
        storageType: "db_text",
        storagePointer: "db://version-1",
        isCurrent: true,
        contentHash: "hash",
        skillMd: null,
        bundleSha256: null,
        bundleObjectKey: null,
        bundleSizeBytes: null,
        manifestJson: {
          slug: "custom-review",
          displayName: "Custom Review",
          version: "1.0.0",
          description: "Review custom material.",
          visibility: "workspace",
          defaultEnabled: true,
          categories: [],
        },
        createdBy: "user-1",
        publishedAt: new Date(0),
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      // The manifest of a `db_text` version: SKILL.md's text rides inline,
      // every other body stays in the database until it is read.
      files: [
        {
          path: "SKILL.md",
          contentText: "# Custom Review",
          objectKey: null,
          mimeType: "text/markdown",
          sizeBytes: 15,
          contentHash: "hash-file",
        },
        {
          path: "reference/checklist.md",
          contentText: null,
          objectKey: null,
          mimeType: "text/markdown",
          sizeBytes: 9,
          contentHash: "hash-checklist",
        },
      ],
    }),
    readWorkspaceSkillFile: async (input) => {
      fileReads.push(`${input.skillVersionId}:${input.path}`);
      return { text: "- item 1" };
    },
  });

  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.workspaceSkillId, record.id);
  assert.equal(skills[0]?.sourceType, "workspace_custom");
  assert.equal(skills[0]?.name, "custom-review");
  assert.equal(skills[0]?.defaultEnabled, true);

  // Resolved without a body read; SKILL.md is there up front, no stored bundle.
  assert.equal(skills[0]?.skillMd, "# Custom Review");
  assert.equal(skills[0]?.bundle, undefined);
  assert.deepEqual(fileReads, []);
  // A body comes from its row, once, however often the turn reads it.
  const readFile = skills[0]!.readFile!;
  assert.deepEqual(await readFile("reference/checklist.md"), {
    text: "- item 1",
  });
  await readFile("reference/checklist.md");
  assert.deepEqual(fileReads, ["version-1:reference/checklist.md"]);
  await assert.rejects(readFile("not/in/manifest.md"), /ENOENT/);
});

test("resolveSelectedSkills ignores disabled workspace skills unless explicitly selected", async () => {
  const skills = await resolveSelectedSkills({
    teamId: "team-1",
    workspaceId: "workspace-1",
    skillIds: [],
    listEnabledWorkspaceSkills: async () => [],
    listWorkspaceSkillsByIds: async () => [],
  });

  assert.deepEqual(skills, []);
});

function registryBundle(input: {
  record: WorkspaceSkillRecord;
  contentHash: string;
  skillMdSha: string;
  skillMd: string;
}) {
  return {
    definition: {
      id: input.record.skillId,
      teamId: null,
      workspaceId: null,
      sourceType: "registry_github" as const,
      slug: "gh-acme-skill",
      displayName: "Community Skill",
      description: "A community-submitted skill.",
      visibility: "restricted" as const,
      status: "active" as const,
      ownerUserId: "user-1",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    version: {
      id: input.record.skillVersionId,
      skillId: input.record.skillId,
      version: "1.0.0",
      status: "published" as const,
      storageType: "object" as const,
      storagePointer: `github:acme/skill@${"a".repeat(40)}`,
      isCurrent: true,
      contentHash: input.contentHash,
      skillMd: input.skillMd,
      bundleSha256: "b".repeat(64),
      bundleObjectKey: `skills/bundles/${"b".repeat(64)}.zip`,
      bundleSizeBytes: 2048,
      manifestJson: {
        slug: "gh-acme-skill",
        displayName: "Community Skill",
        version: "1.0.0",
        description: "A community-submitted skill.",
        visibility: "restricted" as const,
        categories: [],
        registry: {
          identifier: "gh:acme/skill",
          sourceUrl: "https://github.com/acme/skill",
          repoUrl: "https://github.com/acme/skill",
          submittedBy: "user-1",
          capability: "prompt-only" as const,
          scan: { reviewRequired: false, flags: [] },
          fileManifest: [
            {
              path: "SKILL.md",
              sha256: input.skillMdSha,
              sizeBytes: 32,
              role: "model-readable" as const,
            },
          ],
        },
      },
      createdBy: "user-1",
      publishedAt: new Date(0),
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    files: [],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  store.blobs.clear();
  store.blobReads = [];
});

function objectFileRow(path: string, mimeType: string, body: Uint8Array) {
  const sha = createHash("sha256").update(body).digest("hex");
  const objectKey = `skills/blobs/${sha.slice(0, 2)}/${sha}`;
  store.blobs.set(objectKey, Buffer.from(body));
  return {
    path,
    contentText: null,
    objectKey,
    mimeType,
    sizeBytes: body.byteLength,
    contentHash: sha,
  };
}

test("resolveSelectedSkills resolves N object skills from their manifests with zero blob reads", async () => {
  const skillMd = "# Community Skill\ninstructions";
  const skillMdSha = createHash("sha256")
    .update(Buffer.from(skillMd, "utf8"))
    .digest("hex");
  const records = ["a", "b", "c"].map((suffix) =>
    workspaceSkill({
      id: `workspace-skill-${suffix}`,
      skillId: `skill-${suffix}`,
      skillVersionId: `version-${suffix}`,
    }),
  );
  const guide = new TextEncoder().encode("# Guide\nfollow it");
  const font = new Uint8Array([0, 1, 2, 255, 254]);

  const skills = await resolveSelectedSkills({
    teamId: "team-1",
    workspaceId: "workspace-1",
    skillIds: [],
    listEnabledWorkspaceSkills: async () => records,
    listWorkspaceSkillsByIds: async () => [],
    loadWorkspaceSkillVersion: async (input) => {
      const record = records.find(
        (candidate) => candidate.skillVersionId === input.skillVersionId,
      )!;
      const bundle = registryBundle({
        record,
        contentHash: skillMdSha,
        skillMdSha,
        skillMd,
      });
      return {
        ...bundle,
        definition: { ...bundle.definition, slug: `gh-acme-${record.skillId}` },
        files: [
          objectFileRow("SKILL.md", "text/markdown", Buffer.from(skillMd)),
          objectFileRow("reference/guide.md", "text/markdown", guide),
          objectFileRow("assets/brand.ttf", "font/ttf", font),
        ],
      };
    },
    readWorkspaceSkillFile: async () => {
      throw new Error("an object version's bodies are blobs, not rows");
    },
  });

  // Turn start: three skills, nine files, not one byte fetched.
  assert.equal(skills.length, 3);
  assert.deepEqual(store.blobReads, []);

  const skill = skills[0]!;
  assert.equal(skill.sourceType, "registry_github");
  assert.equal(skill.skillMd, skillMd);
  assert.deepEqual(skill.bundle, {
    sha256: "b".repeat(64),
    objectKey: `skills/bundles/${"b".repeat(64)}.zip`,
    sizeBytes: 2048,
  });
  assert.deepEqual(
    skill.files.map((file) => [file.path, file.isText, file.sizeBytes]),
    [
      ["SKILL.md", true, Buffer.byteLength(skillMd)],
      ["reference/guide.md", true, guide.byteLength],
      ["assets/brand.ttf", false, font.byteLength],
    ],
  );
  assert.equal("contentText" in skill.files[0]!, false);
  assert.equal("objectKey" in skill.files[0]!, false);

  // A text file: one blob read, decoded as UTF-8, cached for the turn.
  assert.deepEqual(await skill.readFile!("reference/guide.md"), {
    text: "# Guide\nfollow it",
  });
  await skill.readFile!("reference/guide.md");
  assert.equal(store.blobReads.length, 1);

  // A binary: answered from the manifest, never fetched.
  assert.deepEqual(await skill.readFile!("assets/brand.ttf"), {
    binary: true,
    sizeBytes: font.byteLength,
  });
  assert.equal(store.blobReads.length, 1);
});

test("a blob labelled text that is not valid UTF-8 is reported as binary, not decoded into mojibake", async () => {
  const record = workspaceSkill();
  const skills = await resolveSelectedSkills({
    teamId: "team-1",
    workspaceId: "workspace-1",
    skillIds: [record.id],
    listEnabledWorkspaceSkills: async () => [],
    listWorkspaceSkillsByIds: async () => [record],
    loadWorkspaceSkillVersion: async () => ({
      ...registryBundle({
        record,
        contentHash: "hash",
        skillMdSha: "hash",
        skillMd: "# s",
      }),
      files: [
        objectFileRow("SKILL.md", "text/markdown", Buffer.from("# s")),
        objectFileRow("data.txt", "text/plain", new Uint8Array([0xff, 0xfe, 0])),
      ],
    }),
  });

  assert.deepEqual(await skills[0]!.readFile!("data.txt"), {
    binary: true,
    sizeBytes: 3,
  });
});

test("resolveSelectedSkills rejects explicitly selected disabled workspace skills", async () => {
  const record = workspaceSkill({ enabled: false });
  await assert.rejects(
    () =>
      resolveSelectedSkills({
        teamId: "team-1",
        workspaceId: "workspace-1",
        skillIds: [record.id],
        listEnabledWorkspaceSkills: async () => [],
        listWorkspaceSkillsByIds: async () => [record],
      }),
    (error) => error instanceof ContentError && error.code === "SKILL_DISABLED",
  );
});
