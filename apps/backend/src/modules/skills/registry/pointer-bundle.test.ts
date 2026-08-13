import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import {
  __clearPointerBundleCache,
  loadPointerSkillBundle,
  parsePointer,
} from "./pointer-bundle";

const SHA = "f".repeat(40);
const POINTER = `github:acme/skills@${SHA}#skills/demo`;

function digest(text: string): string {
  return createHash("sha256").update(Buffer.from(text)).digest("hex");
}

const SKILL_MD = "---\nname: demo\ndescription: Demo skill\n---\nBody";
const SCRIPT_PY = "print('hello from script')";

function manifestFor(files: Record<string, string>) {
  return {
    identifier: "gh:acme/skills",
    sourceUrl: "https://github.com/acme/skills",
    repoUrl: "https://github.com/acme/skills",
    submittedBy: "user-1",
    capability: "executable" as const,
    scan: { reviewRequired: false, flags: [] },
    fileManifest: Object.entries(files).map(([p, text]) => ({
      path: p,
      sha256: digest(text),
      sizeBytes: Buffer.byteLength(text),
      role: p.startsWith("scripts/")
        ? ("script" as const)
        : ("model-readable" as const),
    })),
  };
}

/**
 * Materialize a fake extracted repo on disk and return an injectable
 * prepareRepository double that reports it (plus call/cleanup counters).
 */
async function fakeRepository(input: {
  files: Record<string, string>;
  subpath?: string;
  commitSha?: string;
}) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "pointer-bundle-test-"));
  const rootDir = path.join(tempRoot, "extract", `skills-${SHA}`);
  const skillRoot = path.join(rootDir, input.subpath ?? "skills/demo");
  for (const [p, text] of Object.entries(input.files)) {
    const abs = path.join(skillRoot, p);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, text);
  }
  const calls = { prepare: 0, cleanup: 0 };
  const repository = {
    owner: "acme",
    repo: "skills",
    subpath: "",
    repoUrl: "https://github.com/acme/skills",
    sourceUrl: "https://github.com/acme/skills",
    commitSha: input.commitSha ?? SHA,
    requestedRef: SHA,
    resolvedRef: SHA,
    rootDir,
    workDir: rootDir,
    tempRoot,
  };
  return {
    calls,
    tempRoot,
    prepareRepository: (async () => {
      calls.prepare += 1;
      return repository;
    }) as never,
    cleanupRepository: (async () => {
      calls.cleanup += 1;
    }) as never,
  };
}

const tempRoots: string[] = [];
afterEach(async () => {
  __clearPointerBundleCache();
  await Promise.all(
    tempRoots.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }).catch(() => {}),
    ),
  );
});

test("parsePointer accepts pinned pointers and rejects unsafe ones", () => {
  assert.deepEqual(parsePointer(POINTER), {
    owner: "acme",
    repo: "skills",
    sha: SHA,
    subpath: "skills/demo",
  });
  // Repo-root skill (no subpath).
  assert.equal(parsePointer(`github:acme/solo@${SHA}`)?.subpath, "");
  // .git suffix stripped.
  assert.equal(parsePointer(`github:acme/skills.git@${SHA}`)?.repo, "skills");
  // Abbreviated sha is not an immutable pin.
  assert.equal(parsePointer("github:acme/skills@f17010c"), null);
  // Traversal in subpath.
  assert.equal(parsePointer(`github:acme/skills@${SHA}#../etc`), null);
  assert.equal(parsePointer("not-a-pointer"), null);
});

test("loads the FULL bundle — scripts included — with per-file verification", async () => {
  const files = { "SKILL.md": SKILL_MD, "scripts/run.py": SCRIPT_PY };
  const fake = await fakeRepository({ files });
  tempRoots.push(fake.tempRoot);

  const bundle = await loadPointerSkillBundle(
    POINTER,
    digest(SKILL_MD),
    manifestFor(files),
    fake,
  );

  assert.ok(bundle);
  assert.deepEqual(
    bundle.map((f) => f.path).sort(),
    ["SKILL.md", "scripts/run.py"],
  );
  const script = bundle.find((f) => f.path === "scripts/run.py");
  assert.equal(script?.contentText, SCRIPT_PY);
  assert.equal(script?.mimeType, "text/plain");
  assert.equal(fake.calls.prepare, 1);
  assert.equal(fake.calls.cleanup, 1);
});

test("second load hits the LRU without re-downloading", async () => {
  const files = { "SKILL.md": SKILL_MD };
  const fake = await fakeRepository({ files });
  tempRoots.push(fake.tempRoot);

  const first = await loadPointerSkillBundle(
    POINTER,
    digest(SKILL_MD),
    manifestFor(files),
    fake,
  );
  const second = await loadPointerSkillBundle(
    POINTER,
    digest(SKILL_MD),
    manifestFor(files),
    fake,
  );

  assert.ok(first && second);
  assert.equal(fake.calls.prepare, 1);
});

test("rejects the whole skill on a hash mismatch (tamper)", async () => {
  const files = { "SKILL.md": SKILL_MD, "scripts/run.py": "tampered" };
  const fake = await fakeRepository({ files });
  tempRoots.push(fake.tempRoot);
  const manifest = manifestFor({
    "SKILL.md": SKILL_MD,
    "scripts/run.py": SCRIPT_PY, // manifest promises the original
  });

  const bundle = await loadPointerSkillBundle(
    POINTER,
    digest(SKILL_MD),
    manifest,
    fake,
  );

  assert.equal(bundle, null);
  assert.equal(fake.calls.cleanup, 1);
});

test("rejects when a manifest file is missing from the pinned tarball", async () => {
  const fake = await fakeRepository({ files: { "SKILL.md": SKILL_MD } });
  tempRoots.push(fake.tempRoot);
  const manifest = manifestFor({
    "SKILL.md": SKILL_MD,
    "scripts/gone.py": SCRIPT_PY,
  });

  assert.equal(
    await loadPointerSkillBundle(POINTER, digest(SKILL_MD), manifest, fake),
    null,
  );
});

test("rejects when SKILL.md disagrees with the version contentHash", async () => {
  const files = { "SKILL.md": SKILL_MD };
  const fake = await fakeRepository({ files });
  tempRoots.push(fake.tempRoot);

  assert.equal(
    await loadPointerSkillBundle(
      POINTER,
      digest("some other skill body"),
      manifestFor(files),
      fake,
    ),
    null,
  );
});

test("rejects when the prepared commit does not match the pin", async () => {
  const files = { "SKILL.md": SKILL_MD };
  const fake = await fakeRepository({ files, commitSha: "a".repeat(40) });
  tempRoots.push(fake.tempRoot);

  assert.equal(
    await loadPointerSkillBundle(POINTER, digest(SKILL_MD), manifestFor(files), fake),
    null,
  );
  assert.equal(fake.calls.cleanup, 1);
});

test("download failure degrades to null (skill skipped, turn survives)", async () => {
  const bundle = await loadPointerSkillBundle(
    POINTER,
    digest(SKILL_MD),
    manifestFor({ "SKILL.md": SKILL_MD }),
    {
      prepareRepository: (async () => {
        throw new Error("network down");
      }) as never,
    },
  );
  assert.equal(bundle, null);
});

test("pre-checks refuse unsafe or oversized manifests without downloading", async () => {
  const fake = await fakeRepository({ files: { "SKILL.md": SKILL_MD } });
  tempRoots.push(fake.tempRoot);

  const traversal = manifestFor({ "SKILL.md": SKILL_MD });
  traversal.fileManifest.push({
    path: "../outside.txt",
    sha256: digest("x"),
    sizeBytes: 1,
    role: "model-readable",
  });
  assert.equal(
    await loadPointerSkillBundle(POINTER, digest(SKILL_MD), traversal, fake),
    null,
  );

  const oversized = manifestFor({ "SKILL.md": SKILL_MD });
  oversized.fileManifest[0]!.sizeBytes = 10 * 1024 * 1024;
  assert.equal(
    await loadPointerSkillBundle(POINTER, digest(SKILL_MD), oversized, fake),
    null,
  );

  // Neither pre-check rejection should have downloaded anything.
  assert.equal(fake.calls.prepare, 0);
});
