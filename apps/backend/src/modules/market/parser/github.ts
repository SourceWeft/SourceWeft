import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import type {
  NormalizedGitHubSource,
  PreparedGitHubRepository,
} from "../types";

const githubUserAgent = "SourceWeft-MCP-Ingest/1.0";
const shaRefPattern = /^[a-f0-9]{40}$/i;

function stripGitSuffix(value: string) {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

function cleanSubpath(segments: string[]) {
  return segments
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function sourceUrlFor(input: {
  owner: string;
  ref?: string;
  repo: string;
  subpath: string;
}) {
  const repoUrl = `https://github.com/${input.owner}/${input.repo}`;
  if (!input.ref) {
    return input.subpath ? `${repoUrl}/tree/HEAD/${input.subpath}` : repoUrl;
  }
  return input.subpath
    ? `${repoUrl}/tree/${input.ref}/${input.subpath}`
    : `${repoUrl}/tree/${input.ref}`;
}

export function normalizeGitHubSource(input: string): NormalizedGitHubSource {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("GitHub source is required");
  }

  const ownerRepoMatch = trimmed.match(
    /^(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+)$/,
  );
  const ownerRepoGroups = ownerRepoMatch?.groups;
  if (ownerRepoGroups?.owner && ownerRepoGroups.repo) {
    const owner = ownerRepoGroups.owner;
    const repo = stripGitSuffix(ownerRepoGroups.repo);
    return {
      owner,
      repo,
      subpath: "",
      repoUrl: `https://github.com/${owner}/${repo}`,
      sourceUrl: sourceUrlFor({ owner, repo, subpath: "" }),
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Unsupported GitHub source: ${input}`);
  }

  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    throw new Error(`Only github.com URLs are supported: ${input}`);
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const owner = segments[0];
  const repoSegment = segments[1];
  if (!owner || !repoSegment) {
    throw new Error(`GitHub URL must include owner and repo: ${input}`);
  }

  const repo = stripGitSuffix(repoSegment);
  let ref: string | undefined;
  let subpath = "";
  if (segments[2] === "tree" || segments[2] === "blob") {
    const rest = segments.slice(3);
    if (rest.length > 0) {
      if (shaRefPattern.test(rest[0] ?? "")) {
        ref = rest[0];
        subpath = cleanSubpath(rest.slice(1));
      } else {
        ref = rest[0];
        subpath = cleanSubpath(rest.slice(1));
      }
    }
  }

  return {
    owner,
    repo,
    ref,
    subpath,
    repoUrl: `https://github.com/${owner}/${repo}`,
    sourceUrl: sourceUrlFor({ owner, ref, repo, subpath }),
  };
}

function githubHeaders() {
  const headers: Record<string, string> = {
    "User-Agent": githubUserAgent,
    Accept: "application/vnd.github+json",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

const githubMaxRetries = 4;
const githubBaseBackoffMs = 500;
const githubMaxTotalWaitMs = 60_000;

function isRetryableGitHubResponse(response: Response) {
  const { status } = response;
  if (status === 429 || status >= 500) {
    return true;
  }
  // GitHub signals rate limiting with 403; only retry those, not genuine
  // permission-denied 403s.
  if (status === 403) {
    return (
      response.headers.get("x-ratelimit-remaining") === "0" ||
      response.headers.has("retry-after")
    );
  }
  return false;
}

function githubRetryDelayMs(response: Response, attempt: number) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000);
    }
    const parsedDate = Date.parse(retryAfter);
    if (!Number.isNaN(parsedDate)) {
      return Math.max(0, parsedDate - Date.now());
    }
  }
  if (
    response.headers.get("x-ratelimit-remaining") === "0" &&
    response.headers.get("x-ratelimit-reset")
  ) {
    const resetMs = Number(response.headers.get("x-ratelimit-reset")) * 1000;
    if (Number.isFinite(resetMs)) {
      return Math.max(0, resetMs - Date.now());
    }
  }
  // Exponential backoff with full jitter.
  const backoff = githubBaseBackoffMs * 2 ** attempt;
  return backoff + Math.floor(Math.random() * backoff);
}

async function githubFetch(
  url: string,
  headers: Record<string, string>,
): Promise<Response> {
  let totalWaited = 0;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, { headers });
    if (
      response.ok ||
      attempt >= githubMaxRetries ||
      !isRetryableGitHubResponse(response)
    ) {
      return response;
    }
    const delay = Math.min(
      githubRetryDelayMs(response, attempt),
      githubMaxTotalWaitMs - totalWaited,
    );
    if (delay <= 0) {
      return response;
    }
    totalWaited += delay;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await githubFetch(url, githubHeaders());
  if (!response.ok) {
    throw new Error(`GitHub request failed ${response.status}: ${url}`);
  }
  return (await response.json()) as T;
}

async function resolveDefaultBranch(source: NormalizedGitHubSource) {
  const data = await fetchJson<{ default_branch?: string }>(
    `https://api.github.com/repos/${source.owner}/${source.repo}`,
  );
  return data.default_branch || "main";
}

async function resolveCommitSha(source: NormalizedGitHubSource, ref: string) {
  try {
    const data = await fetchJson<{ sha?: string }>(
      `https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(ref)}`,
    );
    return data.sha;
  } catch {
    return shaRefPattern.test(ref) ? ref : undefined;
  }
}

async function downloadTarball(input: {
  archivePath: string;
  owner: string;
  ref: string;
  repo: string;
}) {
  const url = `https://codeload.github.com/${input.owner}/${input.repo}/tar.gz/${encodeURIComponent(input.ref)}`;
  const response = await githubFetch(url, {
    "User-Agent": githubUserAgent,
    ...(process.env.GITHUB_TOKEN
      ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
      : {}),
  });
  if (!response.ok || !response.body) {
    throw new Error(`GitHub tarball download failed ${response.status}: ${url}`);
  }

  await pipeline(
    Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(input.archivePath),
  );
}

async function runTarExtract(archivePath: string, targetDir: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archivePath, "-C", targetDir], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`tar exited with ${code}: ${stderr.trim()}`));
    });
  });
}

function cacheKey(source: NormalizedGitHubSource, ref: string) {
  return createHash("sha1")
    .update(`${source.owner}/${source.repo}/${ref}/${source.subpath}`)
    .digest("hex")
    .slice(0, 12);
}

export async function prepareGitHubRepository(
  input: string,
): Promise<PreparedGitHubRepository> {
  const source = normalizeGitHubSource(input);
  const requestedRef = source.ref ?? (await resolveDefaultBranch(source));
  const commitSha = await resolveCommitSha(source, requestedRef);
  const resolvedRef = commitSha ?? requestedRef;
  const tempRoot = path.join(
    tmpdir(),
    `sourceweft-mcp-${cacheKey(source, resolvedRef)}-${randomUUID()}`,
  );
  const archivePath = path.join(tempRoot, "repo.tar.gz");
  const extractDir = path.join(tempRoot, "extract");

  await rm(tempRoot, { force: true, recursive: true });
  await mkdir(extractDir, { recursive: true });
  await downloadTarball({
    archivePath,
    owner: source.owner,
    ref: resolvedRef,
    repo: source.repo,
  });
  await runTarExtract(archivePath, extractDir);

  const entries = await readdir(extractDir);
  const rootName = entries[0];
  if (!rootName) {
    throw new Error("Downloaded GitHub archive was empty");
  }
  const rootDir = path.join(extractDir, rootName);
  const workDir = source.subpath ? path.join(rootDir, source.subpath) : rootDir;
  const workDirStat = await stat(workDir).catch(() => null);
  if (!workDirStat?.isDirectory()) {
    throw new Error(`Repository subpath not found: ${source.subpath}`);
  }

  return {
    ...source,
    commitSha,
    requestedRef,
    resolvedRef,
    rootDir,
    sourceUrl: sourceUrlFor({
      owner: source.owner,
      ref: resolvedRef,
      repo: source.repo,
      subpath: source.subpath,
    }),
    workDir,
  };
}
