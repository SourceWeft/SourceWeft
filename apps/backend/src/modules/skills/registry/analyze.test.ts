import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { analyzeRegistrySkill } from "./analyze";
import { RegistrySubmissionError } from "./errors";
import type { DiscoveredSkill, DiscoveredSkillFile } from "./read";

function file(bundlePath: string, contentText: string): DiscoveredSkillFile {
  const bytes = Buffer.from(contentText, "utf8");
  return {
    bundlePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
    mimeType: bundlePath.endsWith(".md") ? "text/markdown" : "text/plain",
    contentText,
  };
}

function skillMd(input: {
  name?: string;
  description?: string;
  license?: string;
  allowedTools?: string;
  body?: string;
}): string {
  const lines = ["---"];
  if (input.name !== undefined) lines.push(`name: ${input.name}`);
  if (input.description !== undefined)
    lines.push(`description: ${input.description}`);
  if (input.license !== undefined) lines.push(`license: ${input.license}`);
  if (input.allowedTools !== undefined)
    lines.push(`allowed-tools: ${input.allowedTools}`);
  lines.push("---", "", input.body ?? "# Skill\nInstructions.");
  return lines.join("\n");
}

function discovered(input: {
  repoSubpath?: string;
  dirName?: string;
  files: DiscoveredSkillFile[];
}): DiscoveredSkill {
  return {
    repoSubpath: input.repoSubpath ?? "",
    dirName: input.dirName ?? "repo",
    files: input.files,
  };
}

const OWNER = "acme";
const REPO = "skills";

test("prompt-only skill: no scripts, no shell, permissive license", () => {
  const analyzed = analyzeRegistrySkill({
    owner: OWNER,
    repo: REPO,
    discovered: discovered({
      files: [
        file(
          "SKILL.md",
          skillMd({
            name: "writer",
            description: "Writes prose",
            license: "MIT",
          }),
        ),
        file("resources/notes.md", "extra reference notes"),
      ],
    }),
  });
  assert.equal(analyzed.capability, "prompt-only");
  assert.equal(analyzed.license, "MIT");
  assert.deepEqual(analyzed.scan.flags, []);
  assert.equal(analyzed.scan.reviewRequired, false);
});

test("capability classification: ships scripts but reads prompt-only → executable + mismatch flag", () => {
  const analyzed = analyzeRegistrySkill({
    owner: OWNER,
    repo: REPO,
    discovered: discovered({
      files: [
        file(
          "SKILL.md",
          skillMd({
            name: "runner",
            description: "Does a thing",
            license: "MIT",
          }),
        ),
        file("scripts/run.py", "print('hello')"),
      ],
    }),
  });
  assert.equal(analyzed.capability, "executable");
  // The "don't trust the manifest" gate: prose says nothing about execution but
  // the bundle ships scripts.
  assert.ok(analyzed.scan.flags.includes("capability:undeclared-scripts"));
});

test("capability classification: a fenced bash block declares execution (no mismatch)", () => {
  const analyzed = analyzeRegistrySkill({
    owner: OWNER,
    repo: REPO,
    discovered: discovered({
      files: [
        file(
          "SKILL.md",
          skillMd({
            name: "builder",
            description: "Builds",
            license: "MIT",
            body: "# Builder\nRun:\n```bash\nmake all\n```",
          }),
        ),
        file("scripts/build.sh", "make all"),
      ],
    }),
  });
  assert.equal(analyzed.capability, "executable");
  assert.equal(
    analyzed.scan.flags.includes("capability:undeclared-scripts"),
    false,
  );
});

test("license string is captured for display; absent license is null and never flags", () => {
  const gpl = analyzeRegistrySkill({
    owner: OWNER,
    repo: REPO,
    discovered: discovered({
      files: [
        file(
          "SKILL.md",
          skillMd({ name: "x", description: "d", license: "GPL-3.0" }),
        ),
      ],
    }),
  });
  assert.equal(gpl.license, "GPL-3.0");
  assert.deepEqual(gpl.scan.flags, []);

  const none = analyzeRegistrySkill({
    owner: OWNER,
    repo: REPO,
    discovered: discovered({
      files: [
        file("SKILL.md", skillMd({ name: "x", description: "d" })),
        file("LICENSE", "Copyright (c) 2026 ...full body we never read..."),
      ],
    }),
  });
  assert.equal(none.license, null);
  assert.deepEqual(none.scan.flags, []);
});

test("fileManifest paths are bundle-relative with correct roles", () => {
  const analyzed = analyzeRegistrySkill({
    owner: OWNER,
    repo: REPO,
    discovered: discovered({
      repoSubpath: "skills/writer",
      dirName: "writer",
      files: [
        file(
          "SKILL.md",
          skillMd({ name: "writer", description: "d", license: "MIT" }),
        ),
        file("resources/notes.md", "notes"),
        file("scripts/run.py", "print(1)"),
      ],
    }),
  });
  const byPath = new Map(
    analyzed.fileManifest.map((entry) => [entry.path, entry]),
  );
  // Bundle-relative, NOT repo-root-relative (no `skills/writer/` prefix).
  assert.ok(byPath.has("SKILL.md"));
  assert.ok(byPath.has("resources/notes.md"));
  assert.equal(byPath.get("SKILL.md")?.role, "model-readable");
  assert.equal(byPath.get("resources/notes.md")?.role, "model-readable");
  assert.equal(byPath.get("scripts/run.py")?.role, "script");
  // contentSha256 pins the SKILL.md bytes for runtime cross-check.
  assert.equal(analyzed.contentSha256, byPath.get("SKILL.md")?.sha256);
});

test("a script referencing a path above the bundle is flagged (PR-4)", () => {
  const analyzed = analyzeRegistrySkill({
    owner: OWNER,
    repo: REPO,
    discovered: discovered({
      files: [
        file(
          "SKILL.md",
          skillMd({ name: "x", description: "d", license: "MIT" }),
        ),
        file("scripts/run.py", "open('../../secrets/creds.txt')"),
      ],
    }),
  });
  assert.ok(analyzed.scan.flags.includes("script:out-of-bundle-path"));
});

test("an oversize description is truncated to 1024 chars, not rejected", () => {
  const analyzed = analyzeRegistrySkill({
    owner: OWNER,
    repo: REPO,
    discovered: discovered({
      files: [
        file("SKILL.md", skillMd({ name: "x", description: "d".repeat(1025) })),
      ],
    }),
  });
  assert.equal(analyzed.description.length, 1024);
  assert.equal(analyzed.description, "d".repeat(1024));
});

test("frontmatter validation rejects a bad name and an empty description", () => {
  assert.throws(
    () =>
      analyzeRegistrySkill({
        owner: OWNER,
        repo: REPO,
        discovered: discovered({
          files: [
            file("SKILL.md", skillMd({ name: "Bad Name!", description: "d" })),
          ],
        }),
      }),
    (error) =>
      error instanceof RegistrySubmissionError &&
      error.code === "REGISTRY_SUBMISSION_INVALID_SKILL",
  );

  // Empty description is still rejected (truncation only applies to oversize).
  assert.throws(
    () =>
      analyzeRegistrySkill({
        owner: OWNER,
        repo: REPO,
        discovered: discovered({
          files: [file("SKILL.md", skillMd({ name: "x", description: "" }))],
        }),
      }),
    RegistrySubmissionError,
  );
});

test("frontmatter name wins over the directory it sits in", () => {
  // Real repos routinely suffix the directory (`…-skill`) or name the skill
  // after the technique rather than the folder. The frontmatter is
  // authoritative, and the slug is derived from it, so the skill still indexes.
  const analyzed = analyzeRegistrySkill({
    owner: OWNER,
    repo: REPO,
    discovered: discovered({
      repoSubpath: "skills/writer-skill",
      dirName: "writer-skill",
      files: [
        file("SKILL.md", skillMd({ name: "different", description: "d" })),
      ],
    }),
  });

  assert.equal(analyzed.name, "different");
  assert.equal(analyzed.slug, `gh-${OWNER}-${REPO}-different`);
  assert.equal(analyzed.repoSubpath, "skills/writer-skill");
});
