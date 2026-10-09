import { createHash } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { readGitHubSubtree } from "./github-subtree";
import type { PinnedGitHubSource } from "./github-zip";
const commit = "a".repeat(40),
  root = "b".repeat(40),
  child = "c".repeat(40);
const body = Buffer.from("---\nname: charts\n---\nChart data.\n");
const hash = createHash("sha1")
  .update(`blob ${body.length}\0`)
  .update(body)
  .digest("hex");
const source: PinnedGitHubSource = {
  owner: "acme",
  repo: "huge",
  repoUrl: "https://github.com/acme/huge",
  sourceUrl: "https://github.com/acme/huge",
  subpath: "skills",
  commitSha: commit,
  committedAt: "2026-10-09T00:00:00Z",
};
const file = {
  path: "SKILL.md",
  type: "blob",
  mode: "100644",
  sha: hash,
  size: body.length,
};
function mock(
  entries: unknown[] = [file],
  opts: { truncated?: boolean; raw?: Buffer; wrongCommit?: boolean } = {},
) {
  return vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/commits/"))
        return Response.json({
          sha: opts.wrongCommit ? root : commit,
          tree: { sha: root },
        });
      if (url.endsWith(`/trees/${root}`))
        return Response.json({
          sha: root,
          truncated: false,
          tree: [{ path: "skills", type: "tree", mode: "040000", sha: child }],
        });
      if (url.endsWith(`/trees/${child}?recursive=1`))
        return Response.json({
          sha: child,
          truncated: opts.truncated ?? false,
          tree: entries,
        });
      if (url.startsWith("https://raw.githubusercontent.com/"))
        return new Response(opts.raw ?? body);
      throw Error("Unexpected fetch: " + url);
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());
test("reads only selected subtree at pinned SHA and verifies exact blob bytes", async () => {
  mock();
  const tree = await readGitHubSubtree(source);
  expect(tree.entries).toEqual([
    { path: "skills/SKILL.md", declaredSize: body.length },
  ]);
  const files = await tree.readFiles(new Set(["skills/SKILL.md"]), 1024);
  expect(files.get("skills/SKILL.md")).toEqual(body);
  const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
  expect(urls).toContain(
    `https://raw.githubusercontent.com/acme/huge/${commit}/skills/SKILL.md`,
  );
  expect(urls.some((u) => u.includes("codeload"))).toBe(false);
});
test("refuses truncated, duplicate, unsafe and nonregular trees", async () => {
  for (const entries of [
    [file, file],
    [{ ...file, path: "../SKILL.md" }],
    [{ ...file, mode: "120000" }],
    [{ ...file, type: "commit", mode: "160000" }],
    [{ ...file, size: undefined }],
  ]) {
    mock(entries);
    await expect(readGitHubSubtree(source)).rejects.toThrow();
  }
  mock([file], { truncated: true });
  await expect(readGitHubSubtree(source)).rejects.toThrow(/truncated/);
  mock([file], { wrongCommit: true });
  await expect(readGitHubSubtree(source)).rejects.toThrow(/different commit/);
});
test("refuses wrong blob bytes, stream overflow and unknown file requests", async () => {
  mock([file], { raw: Buffer.alloc(body.length, 1) });
  const t = await readGitHubSubtree(source);
  await expect(t.readFiles(new Set(["skills/SKILL.md"]), 1024)).rejects.toThrow(
    /integrity/,
  );
  mock([file], { raw: Buffer.alloc(body.length + 1) });
  const t2 = await readGitHubSubtree(source);
  await expect(
    t2.readFiles(new Set(["skills/SKILL.md"]), 1024),
  ).rejects.toThrow(/size/);
  await expect(t2.readFiles(new Set(["outside"]), 1024)).rejects.toThrow(
    /outside/,
  );
  await expect(t2.readFiles(new Set(["skills/SKILL.md"]), 1)).rejects.toThrow(
    /size/,
  );
});
test("untrusted subpaths and unpinned refs never reach network", async () => {
  mock();
  for (const subpath of [
    "",
    "../skills",
    "/skills",
    "skills//foo",
    "skills\\foo",
  ])
    await expect(readGitHubSubtree({ ...source, subpath })).rejects.toThrow();
  await expect(
    readGitHubSubtree({ ...source, commitSha: "main" }),
  ).rejects.toThrow(/full commit/);
  expect(fetch).not.toHaveBeenCalled();
});
