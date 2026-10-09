import { createHash } from "node:crypto";
import { z } from "zod";
import {
  githubFetch,
  githubHeaders,
  githubDownloadHeaders,
  GitHubArchiveError,
  isGitHubTimeoutError,
  githubTimeoutError,
  GITHUB_REQUEST_TIMEOUTS,
  type GitHubRequestOptions,
} from "./github";
import { GITHUB_ZIP_LIMITS, type PinnedGitHubSource } from "./github-zip";

// Immutable commit/tree responses only. Bounded raw JSON avoids retaining unbounded object graphs.
const metadataCache = new Map<string, { body: Buffer; expires: number }>();
const METADATA_CACHE_BYTES = 16 * 1024 * 1024;
let metadataCacheBytes = 0;
export function clearGitHubSubtreeCache() {
  metadataCache.clear();
  metadataCacheBytes = 0;
}
async function metadataJson(url: string, options?: GitHubRequestOptions) {
  options?.signal?.throwIfAborted();
  const cached = metadataCache.get(url);
  if (cached && cached.expires > Date.now()) {
    metadataCache.delete(url);
    metadataCache.set(url, cached);
    return JSON.parse(cached.body.toString("utf8"));
  }
  if (cached) {
    metadataCache.delete(url);
    metadataCacheBytes -= cached.body.length;
  }
  const body = await bytes(url, githubHeaders(), 8 * 1024 * 1024, options);
  const value = JSON.parse(body.toString("utf8"));
  // Invalid/truncated replies must remain observable on the next request.
  const valid = url.includes("/trees/")
    ? treeSchema.safeParse(value).success && value.truncated === false
    : z.object({ sha, tree: z.object({ sha }) }).safeParse(value).success;
  if (valid && value.sha === url.split("/").at(-1)?.split("?")[0]) {
    // Concurrent callers may have populated the same entry while this fetch ran.
    const previous = metadataCache.get(url);
    if (previous) {
      metadataCache.delete(url);
      metadataCacheBytes -= previous.body.length;
    }
    while (
      (metadataCacheBytes + body.length > METADATA_CACHE_BYTES ||
        metadataCache.size >= 512) &&
      metadataCache.size
    ) {
      const oldest = metadataCache.keys().next().value!;
      metadataCacheBytes -= metadataCache.get(oldest)!.body.length;
      metadataCache.delete(oldest);
    }
    metadataCache.set(url, { body, expires: Date.now() + 15 * 60 * 1000 });
    metadataCacheBytes += body.length;
  }
  return value;
}

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const entrySchema = z.object({
  path: z.string(),
  mode: z.string(),
  type: z.string(),
  sha,
  size: z.number().int().nonnegative().optional(),
});
const treeSchema = z.object({
  sha,
  truncated: z.boolean(),
  tree: z.array(entrySchema),
});
function fail(message: string): never {
  throw new GitHubArchiveError("ARCHIVE_UNAVAILABLE", message);
}
function safePath(path: string) {
  return (
    path.length > 0 &&
    !/[\\\x00-\x1f\x7f]/.test(path) &&
    path.split("/").every((p) => p !== "" && p !== "." && p !== "..")
  );
}
async function bytes(
  url: string,
  headers: Record<string, string>,
  limit: number,
  options?: GitHubRequestOptions,
) {
  const response = await githubFetch(url, headers, options);
  if (!response.ok) {
    await response.body?.cancel();
    fail(`GitHub subtree read failed (${response.status}): ${url}`);
  }
  const advertised = Number(response.headers.get("content-length"));
  if (advertised > limit) {
    await response.body?.cancel();
    throw new GitHubArchiveError(
      "ARCHIVE_TOO_LARGE",
      "GitHub subtree response exceeds size limit",
    );
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    if (!response.body) fail("GitHub subtree response has no body");
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > limit) {
          await reader.cancel();
          throw new GitHubArchiveError(
            "ARCHIVE_TOO_LARGE",
            "GitHub subtree response exceeds size limit",
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (isGitHubTimeoutError(error) && !options?.signal?.aborted)
      throw githubTimeoutError(
        url,
        options?.timeoutMs ?? GITHUB_REQUEST_TIMEOUTS.metadataMs,
      );
    throw error;
  }
  return Buffer.concat(chunks, total);
}

/** Complete explicit subtree at an already provenance-verified immutable commit. Never follows symlinks or submodules. */
export async function readGitHubSubtree(
  source: PinnedGitHubSource,
  options?: GitHubRequestOptions,
) {
  if (!/^[a-f0-9]{40}$/.test(source.commitSha))
    throw new GitHubArchiveError(
      "ARCHIVE_UNPINNED",
      "Subtree requires a full commit SHA",
    );
  if (!safePath(source.subpath) || source.subpath.split("/").length > 64)
    fail("Invalid GitHub subtree path");
  const api = `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/git`;
  const json = (url: string) => metadataJson(url, options);
  const commit = z
    .object({ sha, tree: z.object({ sha }) })
    .parse(await json(`${api}/commits/${source.commitSha}`));
  if (commit.sha !== source.commitSha)
    fail("GitHub returned a different commit");
  const tree = async (id: string, recursive = false) => {
    const result = treeSchema.parse(
      await json(`${api}/trees/${id}${recursive ? "?recursive=1" : ""}`),
    );
    if (result.sha !== id) fail("GitHub returned a different tree");
    if (result.truncated)
      throw new GitHubArchiveError(
        "ARCHIVE_TOO_LARGE",
        "GitHub subtree listing is truncated; submit a smaller root",
      );
    if (result.tree.length > GITHUB_ZIP_LIMITS.maxEntries)
      throw new GitHubArchiveError(
        "ARCHIVE_TOO_LARGE",
        "GitHub subtree exceeds entry limit",
      );
    const seen = new Set<string>();
    for (const e of result.tree) {
      if (
        !safePath(e.path) ||
        (!recursive && e.path.includes("/")) ||
        seen.has(e.path)
      )
        fail("Unsafe or duplicate GitHub tree path");
      seen.add(e.path);
    }
    return result.tree;
  };
  let treeId = commit.tree.sha;
  for (const part of source.subpath.split("/")) {
    const entry = (await tree(treeId)).find((e) => e.path === part);
    if (!entry || entry.type !== "tree" || entry.mode !== "040000")
      fail("Submitted GitHub subtree is not a directory");
    treeId = entry.sha;
  }
  const listing = await tree(treeId, true);
  const blobs = new Map<string, z.infer<typeof entrySchema>>();
  for (const entry of listing) {
    if (entry.type === "tree" && entry.mode === "040000") continue;
    if (
      entry.type !== "blob" ||
      !["100644", "100755"].includes(entry.mode) ||
      entry.size === undefined
    )
      fail(
        "Unsupported GitHub subtree entry (symlink, submodule or missing size)",
      );
    blobs.set(`${source.subpath}/${entry.path}`, entry);
  }
  return {
    entries: [...blobs].map(([path, e]) => ({ path, declaredSize: e.size! })),
    async readFiles(wanted: ReadonlySet<string>, maxFileBytes: number) {
      let declared = 0;
      for (const path of wanted) {
        const e = blobs.get(path);
        if (!e) fail("Requested file is outside subtree");
        declared += e.size!;
        if (e.size! > maxFileBytes)
          throw new GitHubArchiveError(
            "ARCHIVE_TOO_LARGE",
            "Subtree file exceeds size limit",
          );
      }
      if (declared > GITHUB_ZIP_LIMITS.maxTotalUncompressedBytes)
        throw new GitHubArchiveError(
          "ARCHIVE_TOO_LARGE",
          "Subtree exceeds total size limit",
        );
      const files = new Map<string, Buffer>();
      const paths = [...wanted];
      let next = 0;
      let stopped = false;
      const outcomes = await Promise.allSettled(
        Array.from({ length: Math.min(4, paths.length) }, async () => {
          try {
            while (!stopped && next < paths.length) {
              const path = paths[next++]!;
              const entry = blobs.get(path)!;
              // Raw endpoint avoids one authenticated REST request per bundle file. Pinned path + blob hash bind every byte.
              const url = `https://raw.githubusercontent.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/${source.commitSha}/${path.split("/").map(encodeURIComponent).join("/")}`;
              const body = await bytes(
                url,
                githubDownloadHeaders(),
                Math.min(maxFileBytes, entry.size!),
                options,
              );
              const hash = createHash("sha1")
                .update(`blob ${body.length}\0`)
                .update(body)
                .digest("hex");
              if (body.length !== entry.size || hash !== entry.sha)
                fail("GitHub subtree blob integrity mismatch");
              files.set(path, body);
            }
          } catch (error) {
            stopped = true;
            throw error;
          }
        }),
      );
      const failed = outcomes.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      if (failed) throw failed.reason;
      return files;
    },
  };
}
