import assert from "node:assert/strict";
import { test } from "vitest";
import type { SkillManifestJson } from "@sourceweft/db";
import { testExports } from "./service";
import type { SkillCatalogItem } from "./types";

const {
  isRegistryRowVisibleToViewer,
  registryCatalogFields,
  skillSearchRelevanceRank,
  compareSkillSearchRelevance,
  mapCatalogRow,
} = testExports;

type CatalogRowParam = Parameters<typeof mapCatalogRow>[0];

function registryManifest(
  registry?: SkillManifestJson["registry"],
): SkillManifestJson {
  return {
    slug: "gh-owner-repo",
    displayName: "Repo Skill",
    version: "1.0.0",
    description: "A community skill.",
    visibility: "public",
    categories: [],
    registry,
  };
}

function catalogRow(input: {
  id: string;
  sourceType: "registry_github" | "workspace_custom";
  visibility: "public" | "restricted" | "workspace" | "team";
  ownerUserId: string | null;
  displayName: string;
  description: string;
  manifest: SkillManifestJson;
}): CatalogRowParam {
  return {
    definition: {
      id: input.id,
      teamId: null,
      workspaceId: null,
      sourceType: input.sourceType,
      slug: `slug-${input.id}`,
      displayName: input.displayName,
      description: input.description,
      visibility: input.visibility,
      status: "active",
      ownerUserId: input.ownerUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    version: {
      id: `${input.id}-v`,
      skillId: input.id,
      version: "1.0.0",
      status: "published",
      storageType: "pointer",
      storagePointer: "github:owner/repo@sha#SKILL.md",
      isCurrent: true,
      contentHash: "hash",
      manifestJson: input.manifest,
      createdBy: input.ownerUserId,
      publishedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    enabled: null,
  } as unknown as CatalogRowParam;
}

function catalogItem(input: {
  displayName: string;
  description: string;
}): SkillCatalogItem {
  return {
    displayName: input.displayName,
    description: input.description,
  } as unknown as SkillCatalogItem;
}

// --- catalog visibility (restricted must not leak to non-submitters) ---

test("isRegistryRowVisibleToViewer: public is visible to any viewer", () => {
  assert.equal(
    isRegistryRowVisibleToViewer({
      visibility: "public",
      ownerUserId: "submitter",
      viewerUserId: "someone-else",
    }),
    true,
  );
  assert.equal(
    isRegistryRowVisibleToViewer({
      visibility: "public",
      ownerUserId: null,
      viewerUserId: "anyone",
    }),
    true,
  );
});

test("isRegistryRowVisibleToViewer: restricted is visible only to its submitter", () => {
  assert.equal(
    isRegistryRowVisibleToViewer({
      visibility: "restricted",
      ownerUserId: "submitter",
      viewerUserId: "submitter",
    }),
    true,
  );
});

test("isRegistryRowVisibleToViewer: restricted is NOT leaked to a non-submitter", () => {
  assert.equal(
    isRegistryRowVisibleToViewer({
      visibility: "restricted",
      ownerUserId: "submitter",
      viewerUserId: "attacker",
    }),
    false,
  );
  // A restricted row with no recorded owner is visible to nobody.
  assert.equal(
    isRegistryRowVisibleToViewer({
      visibility: "restricted",
      ownerUserId: null,
      viewerUserId: "submitter",
    }),
    false,
  );
});

test("isRegistryRowVisibleToViewer: non public/restricted visibilities are hidden", () => {
  for (const visibility of ["workspace", "team"]) {
    assert.equal(
      isRegistryRowVisibleToViewer({
        visibility,
        ownerUserId: "submitter",
        viewerUserId: "submitter",
      }),
      false,
    );
  }
});

// --- attribution + trust surface ---

test("registryCatalogFields: Community publisher, unverified, attribution from manifest", () => {
  const fields = registryCatalogFields(
    registryManifest({
      identifier: "gh:owner/repo",
      sourceUrl: "https://github.com/owner/repo/blob/main/SKILL.md",
      repoUrl: "https://github.com/owner/repo",
      submittedBy: "submitter",
      capability: "prompt-only",
      scan: { reviewRequired: true, flags: ["egress"] },
      licenseTier: "permissive",
      license: "MIT",
      fileManifest: [],
    }),
  );
  assert.equal(fields.publisher, "Community");
  assert.equal(fields.verified, false);
  assert.equal(
    fields.sourceUrl,
    "https://github.com/owner/repo/blob/main/SKILL.md",
  );
  assert.equal(fields.license, "MIT");
  assert.equal(fields.flagged, true);
});

test("registryCatalogFields: safe defaults when the registry block is absent", () => {
  const fields = registryCatalogFields(registryManifest(undefined));
  assert.equal(fields.publisher, "Community");
  assert.equal(fields.verified, false);
  assert.equal(fields.sourceUrl, null);
  assert.equal(fields.license, null);
  assert.equal(fields.flagged, false);
});

test("mapCatalogRow: registry rows carry Community/attribution; others do not", () => {
  const registry = mapCatalogRow(
    catalogRow({
      id: "reg-1",
      sourceType: "registry_github",
      visibility: "public",
      ownerUserId: "submitter",
      displayName: "Repo Skill",
      description: "A community skill.",
      manifest: registryManifest({
        identifier: "gh:owner/repo",
        sourceUrl: "https://github.com/owner/repo",
        repoUrl: "https://github.com/owner/repo",
        submittedBy: "submitter",
        capability: "prompt-only",
        scan: { reviewRequired: false, flags: [] },
        licenseTier: "permissive",
        license: "Apache-2.0",
        fileManifest: [],
      }),
    }),
  );
  assert.equal(registry.sourceType, "registry_github");
  assert.equal(registry.publisher, "Community");
  assert.equal(registry.verified, false);
  assert.equal(registry.license, "Apache-2.0");
  assert.equal(registry.flagged, false);
  assert.equal(registry.catalogId, "reg-1:reg-1-v");

  const custom = mapCatalogRow(
    catalogRow({
      id: "cus-1",
      sourceType: "workspace_custom",
      visibility: "workspace",
      ownerUserId: "author",
      displayName: "Custom Skill",
      description: "A workspace skill.",
      manifest: registryManifest(undefined),
    }),
  );
  assert.equal(custom.sourceType, "workspace_custom");
  assert.equal(custom.publisher, undefined);
  assert.equal(custom.verified, undefined);
});

// --- lexical search relevance ---

test("skillSearchRelevanceRank: name matches outrank description matches", () => {
  const base = { displayName: "Meeting Summary", description: "notes" };
  assert.equal(skillSearchRelevanceRank({ ...base, query: "meeting summary" }), 0);
  assert.equal(skillSearchRelevanceRank({ ...base, query: "meeting" }), 1);
  assert.equal(skillSearchRelevanceRank({ ...base, query: "summary" }), 2);
  assert.equal(
    skillSearchRelevanceRank({
      displayName: "Standup Bot",
      description: "summarize a meeting transcript",
      query: "meeting",
    }),
    3,
  );
  assert.equal(
    skillSearchRelevanceRank({
      displayName: "Standup Bot",
      description: "nothing relevant",
      query: "meeting",
    }),
    4,
  );
});

test("compareSkillSearchRelevance: a name hit sorts above a description-only hit", () => {
  const items = [
    catalogItem({
      displayName: "Standup Bot",
      description: "summarize a meeting transcript",
    }),
    catalogItem({ displayName: "Meeting Summary", description: "notes" }),
  ];
  const sorted = [...items].sort(compareSkillSearchRelevance("meeting"));
  assert.deepEqual(
    sorted.map((item) => item.displayName),
    ["Meeting Summary", "Standup Bot"],
  );
});
