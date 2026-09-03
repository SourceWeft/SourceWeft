import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { describe, test } from "vitest";
import {
  GitHubArchiveError,
  GITHUB_ZIP_LIMITS,
  listZipEntries,
  readZipEntries,
} from "./github-zip";

/** GitHub zipballs nest everything under a single `<repo>-<sha>/` directory. */
function repoZip(files: Record<string, string>): Buffer {
  return Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([path, content]) => [
          `repo-abc123/${path}`,
          strToU8(content),
        ]),
      ),
    ),
  );
}

describe("listZipEntries", () => {
  test("enumerates repo-relative paths and strips the root directory", async () => {
    const entries = await listZipEntries(
      repoZip({ "SKILL.md": "# hi", "scripts/run.py": "print(1)" }),
    );
    assert.deepEqual(entries.map((entry) => entry.path).sort(), [
      "SKILL.md",
      "scripts/run.py",
    ]);
  });

  test("reports declared sizes without decompressing", async () => {
    // A 50 KiB run of one byte compresses to almost nothing. Seeing the real
    // uncompressed size here is what lets the read gate a bomb BEFORE inflating
    // it — the whole reason the size checks live in the filter.
    const zip = repoZip({ "big.txt": "x".repeat(50_000) });
    const [entry] = await listZipEntries(zip);
    assert.equal(entry?.declaredSize, 50_000);
    assert.ok(zip.byteLength < 1_000, "fixture should be highly compressible");
  });
});

describe("readZipEntries", () => {
  test("decompresses only what the caller keeps", async () => {
    const files = await readZipEntries(
      repoZip({ "SKILL.md": "# hi", "scripts/run.py": "print(1)" }),
      (path) => path === "SKILL.md",
    );
    assert.deepEqual([...files.keys()], ["SKILL.md"]);
    assert.equal(files.get("SKILL.md")?.toString("utf8"), "# hi");
  });

  test("rejects an oversize entry by default", async () => {
    const zip = repoZip({
      "huge.txt": "x".repeat(GITHUB_ZIP_LIMITS.maxFileBytes + 1),
    });
    await assert.rejects(
      () => readZipEntries(zip, () => true),
      (error: unknown) =>
        error instanceof GitHubArchiveError &&
        error.code === "ARCHIVE_TOO_LARGE",
    );
  });

  test("skips an oversize entry when asked, keeping the rest", async () => {
    // Whole-repo prospecting must not lose a submission over one large asset.
    const files = await readZipEntries(
      repoZip({
        "README.md": "# readme",
        "huge.txt": "x".repeat(GITHUB_ZIP_LIMITS.maxFileBytes + 1),
      }),
      () => true,
      { oversize: "skip" },
    );
    assert.deepEqual([...files.keys()], ["README.md"]);
  });

  test("rejects once the kept entries exceed the cumulative ceiling", async () => {
    // Each file is under the per-file cap; together they are not. Skipping
    // oversize entries must not turn the cumulative bound into a no-op.
    const perFile = GITHUB_ZIP_LIMITS.maxFileBytes;
    const count =
      Math.ceil(GITHUB_ZIP_LIMITS.maxTotalUncompressedBytes / perFile) + 1;
    const files: Record<string, string> = {};
    for (let index = 0; index < count; index += 1) {
      files[`part-${index}.txt`] = "x".repeat(perFile);
    }
    await assert.rejects(
      () => readZipEntries(repoZip(files), () => true, { oversize: "skip" }),
      (error: unknown) =>
        error instanceof GitHubArchiveError &&
        error.code === "ARCHIVE_TOO_LARGE",
    );
  });
});
