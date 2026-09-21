import assert from "node:assert/strict";
import { test } from "vitest";
import type { SkillManifestJson } from "@sourceweft/db";
import {
  changelogVersion,
  diffSkillVersions,
  githubCompareUrl,
  type ChangelogVersion,
} from "./changelog";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const hash = (n: number) => String(n).repeat(64).slice(0, 64);

function version(
  sha: string,
  files: ChangelogVersion["files"],
  flags: string[] = [],
): ChangelogVersion {
  return {
    storagePointer: `github:Acme/Skills@${sha}#pdf`,
    files,
    flags,
  };
}

test("files are added, removed and modified by path and content hash", () => {
  const changes = diffSkillVersions(
    version(OLD, [
      { path: "SKILL.md", contentHash: hash(1) },
      { path: "ref/old.md", contentHash: hash(2) },
      { path: "ref/same.md", contentHash: hash(3) },
    ]),
    version(NEW, [
      { path: "SKILL.md", contentHash: hash(4) },
      { path: "ref/same.md", contentHash: `sha256:${hash(3).toUpperCase()}` },
      { path: "ref/new.md", contentHash: hash(5) },
    ]),
  );
  assert.deepEqual(changes.added, ["ref/new.md"]);
  assert.deepEqual(changes.removed, ["ref/old.md"]);
  // The same digest spelled differently is the same file.
  assert.deepEqual(changes.modified, ["SKILL.md"]);
  assert.deepEqual(changes.newScripts, []);
  assert.deepEqual(changes.newFlags, []);
});

test("new scripts and new scan flags are what the older version lacked", () => {
  const changes = diffSkillVersions(
    version(
      OLD,
      [
        { path: "run.sh", contentHash: hash(1), role: "script" },
        { path: "tool.py", contentHash: hash(2), role: "model-readable" },
      ],
      ["egress:fetch"],
    ),
    version(
      NEW,
      [
        // Still a script, changed: modified, but not new.
        { path: "run.sh", contentHash: hash(3), role: "script" },
        // Was reference text, is a script now: new.
        { path: "tool.py", contentHash: hash(2), role: "script" },
        { path: "setup.sh", contentHash: hash(4), role: "script" },
      ],
      ["egress:fetch", "secrets:env-access", "secrets:env-access"],
    ),
  );
  assert.deepEqual(changes.newScripts, ["setup.sh", "tool.py"]);
  assert.deepEqual(changes.newFlags, ["secrets:env-access"]);
  assert.deepEqual(changes.modified, ["run.sh"]);
  assert.deepEqual(changes.added, ["setup.sh"]);
});

test("the compare link needs two commits of one repository", () => {
  assert.equal(
    githubCompareUrl(
      `github:acme/skills@${OLD}#pdf`,
      `github:Acme/Skills@${NEW}#pdf`,
    ),
    `https://github.com/Acme/Skills/compare/${OLD}...${NEW}`,
  );
  assert.equal(
    githubCompareUrl(`github:other/skills@${OLD}`, `github:acme/skills@${NEW}`),
    null,
  );
  assert.equal(
    githubCompareUrl(`github:acme/skills@${NEW}`, `github:acme/skills@${NEW}`),
    null,
  );
  assert.equal(githubCompareUrl(null, `github:acme/skills@${NEW}`), null);
  assert.equal(githubCompareUrl("builtin:pdf", `github:acme/skills@${NEW}`), null);
});

test("a version reads from its manifest, or from its file rows with the manifest's roles", () => {
  const manifestJson = {
    slug: "pdf",
    displayName: "PDF",
    version: "1",
    description: "",
    visibility: "public",
    categories: [],
    registry: {
      identifier: "gh:acme/skills/pdf",
      sourceUrl: "",
      repoUrl: "",
      submittedBy: "u",
      capability: "executable",
      scan: { reviewRequired: false, flags: ["tool:sensitive"] },
      fileManifest: [
        { path: "SKILL.md", sha256: hash(1), sizeBytes: 1, role: "model-readable" },
        { path: "run.sh", sha256: hash(2), sizeBytes: 1, role: "script" },
      ],
    },
  } satisfies SkillManifestJson;
  const fromManifest = changelogVersion({
    storagePointer: `github:acme/skills@${NEW}`,
    manifestJson,
  });
  assert.deepEqual(fromManifest.flags, ["tool:sensitive"]);
  assert.deepEqual(
    fromManifest.files.map((file) => [file.path, file.contentHash, file.role]),
    [
      ["SKILL.md", hash(1), "model-readable"],
      ["run.sh", hash(2), "script"],
    ],
  );
  const fromRows = changelogVersion({
    storagePointer: null,
    manifestJson,
    files: [{ path: "run.sh", contentHash: hash(9) }],
  });
  assert.deepEqual(fromRows.files, [
    { path: "run.sh", contentHash: hash(9), role: "script" },
  ]);
});
