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
  listZipEntries: vi.fn(async () => [{ path: "SKILL.md" }]),
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

test("an unknown commit date stays absent instead of being invented", async () => {
  github.resolve.mockResolvedValue(pinned);
  const read = await readRegistrySkillsFromGitHub("acme/skills");
  assert.equal("committedAt" in read, false);
});

test("a GitHub timeout is a submission error, whichever request stalled", async () => {
  const timeout = new GitHubArchiveError("ARCHIVE_TIMEOUT", "too slow");
  const isMapped = (error: unknown) =>
    error instanceof RegistrySubmissionError &&
    error.code === "REGISTRY_SUBMISSION_TIMEOUT" &&
    error.message === "too slow";

  github.resolve.mockRejectedValue(timeout);
  await assert.rejects(readRegistrySkillsFromGitHub("acme/skills"), isMapped);

  github.resolve.mockResolvedValue(pinned);
  github.download.mockRejectedValue(timeout);
  await assert.rejects(readRegistrySkillsFromGitHub("acme/skills"), isMapped);
});
