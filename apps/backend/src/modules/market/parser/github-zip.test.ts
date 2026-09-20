import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, test, vi } from "vitest";
import {
  downloadRepoZip,
  GitHubArchiveError,
  GITHUB_ZIP_LIMITS,
  listZipEntries,
  readZipEntries,
  resolvePinnedGitHubSource,
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

  test("a caller may raise the per-file ceiling for its own read only", async () => {
    // The skills reader carries fonts and images; the MCP market's default
    // (asserted above) is untouched by another caller's higher limit.
    const size = GITHUB_ZIP_LIMITS.maxFileBytes + 1;
    const zip = repoZip({ "assets/font.ttf": "x".repeat(size) });
    const files = await readZipEntries(zip, () => true, {
      maxFileBytes: size,
    });
    assert.equal(files.get("assets/font.ttf")?.byteLength, size);
    await assert.rejects(
      () => readZipEntries(zip, () => true, { maxFileBytes: size - 1 }),
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

describe("GitHub requests are bounded in time", () => {
  const pinned = {
    owner: "acme",
    repo: "skills",
    subpath: "",
    repoUrl: "https://github.com/acme/skills",
    sourceUrl: "https://github.com/acme/skills",
    commitSha: "a".repeat(40),
  };
  const isTimeout = (error: unknown) =>
    error instanceof GitHubArchiveError && error.code === "ARCHIVE_TIMEOUT";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("a zipball whose headers never arrive times out", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal!.reason),
          );
        }),
    );
    await assert.rejects(downloadRepoZip(pinned, { timeoutMs: 20 }), isTimeout);
  });

  test("a zipball that stalls mid-body times out too", async () => {
    // Headers arrive at once and the stream then goes quiet — the deadline has
    // to cover the body, or this is exactly the hang it exists to prevent.
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          init?.signal?.addEventListener("abort", () =>
            controller.error(init.signal!.reason),
          );
        },
      });
      return new Response(body, { status: 200 });
    });
    await assert.rejects(downloadRepoZip(pinned, { timeoutMs: 20 }), isTimeout);
  });

  test("pinning carries the committer date, and times out rather than hanging", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      String(url).includes("/commits/")
        ? Response.json({
            sha: "B".repeat(40),
            commit: { committer: { date: "2026-02-01T10:00:00Z" } },
          })
        : Response.json({ default_branch: "trunk" }),
    );
    const source = await resolvePinnedGitHubSource("acme/skills");
    assert.equal(source.commitSha, "b".repeat(40));
    assert.equal(source.committedAt, "2026-02-01T10:00:00.000Z");

    vi.stubGlobal(
      "fetch",
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal!.reason),
          );
        }),
    );
    await assert.rejects(
      resolvePinnedGitHubSource("acme/skills", { timeoutMs: 20 }),
      isTimeout,
    );
  });
});

// A missing or private repo fails at the default-branch lookup with a plain
// Error; unmapped, the submit route turned it into an HTTP 500.
test("an unreadable repository is reported as unavailable, not thrown raw", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("{}", { status: 404 })) as typeof fetch;
  try {
    await assert.rejects(
      resolvePinnedGitHubSource("ghost-owner/ghost-repo"),
      (error: unknown) =>
        error instanceof GitHubArchiveError &&
        error.code === "ARCHIVE_UNAVAILABLE",
    );
  } finally {
    globalThis.fetch = original;
  }
});
