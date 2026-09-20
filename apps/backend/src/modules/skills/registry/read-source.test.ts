import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

/**
 * What the read stage takes from — and how it reports failures of — the shared
 * GitHub reader. The archive itself is faked; `read.test.ts` covers discovery.
 */
const github = vi.hoisted(() => ({
  resolve: vi.fn(),
  download: vi.fn(),
}));
vi.mock("../../market/parser/github-zip", async (original) => ({
  ...(await original<typeof import("../../market/parser/github-zip")>()),
  resolvePinnedGitHubSource: github.resolve,
  downloadRepoZip: github.download,
  listZipEntries: vi.fn(async () => [{ path: "SKILL.md", declaredSize: 40 }]),
  readZipEntries: vi.fn(
    async () =>
      new Map([
        ["SKILL.md", Buffer.from("---\nname: writer\ndescription: W\n---\n")],
      ]),
  ),
}));

import { GitHubArchiveError } from "../../market/parser/github-zip";
import { RegistrySubmissionError } from "./errors";
import { readRegistrySkillsFromGitHub } from "./read";

const pinned = {
  owner: "acme",
  repo: "skills",
  subpath: "",
  commitSha: "a".repeat(40),
};

beforeEach(() => {
  vi.clearAllMocks();
  github.download.mockResolvedValue(Buffer.alloc(0));
});

test("the pinned commit's date is passed on for version ordering", async () => {
  github.resolve.mockResolvedValue({
    ...pinned,
    committedAt: "2026-02-01T10:00:00.000Z",
  });
  const read = await readRegistrySkillsFromGitHub("acme/skills");
  assert.equal(read.committedAt, "2026-02-01T10:00:00.000Z");
});

test("a commit whose date cannot be read is refused before anything is downloaded", async () => {
  // Versions are ordered by commit age; an undated one cannot be placed, and
  // inventing a date would silently decide which version users get.
  for (const committedAt of [undefined, "not-a-date"]) {
    github.resolve.mockResolvedValue({ ...pinned, committedAt });
    await assert.rejects(
      readRegistrySkillsFromGitHub("acme/skills"),
      (error) =>
        error instanceof RegistrySubmissionError &&
        error.code === "REGISTRY_SUBMISSION_UNDATED",
    );
  }
  assert.equal(github.download.mock.calls.length, 0);
});

test("a GitHub timeout is a submission error, whichever request stalled", async () => {
  const timeout = new GitHubArchiveError("ARCHIVE_TIMEOUT", "too slow");
  const isMapped = (error: unknown) =>
    error instanceof RegistrySubmissionError &&
    error.code === "REGISTRY_SUBMISSION_TIMEOUT" &&
    error.message === "too slow";

  github.resolve.mockRejectedValue(timeout);
  await assert.rejects(readRegistrySkillsFromGitHub("acme/skills"), isMapped);

  github.resolve.mockResolvedValue({
    ...pinned,
    committedAt: "2026-02-01T10:00:00.000Z",
  });
  github.download.mockRejectedValue(timeout);
  await assert.rejects(readRegistrySkillsFromGitHub("acme/skills"), isMapped);
});
