import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { MAX_README_BYTES } from "../../../shared/catalog-readme";
import {
  fetchGitHubReadmes,
  GITHUB_README_QUERY_SIZE,
  githubReadmeLinkBases,
  parseGitHubRepoRef,
  type GitHubReadmeTarget,
} from "./github-readme";

const GRAPHQL = "https://api.github.com/graphql";
const COMMIT = "c0ffee".padEnd(40, "0");
const SYMLINK = 40960;

// ---------------------------------------------------------------------------
// A fake GitHub GraphQL API over in-memory repositories
// ---------------------------------------------------------------------------

type FakeFile =
  | string
  | Buffer
  | { link: string }
  | { bytes: Buffer; text: string | null; isBinary?: boolean };

/** `files` by repository path; null is an empty repository (no default branch). */
type FakeRepository = { files: Record<string, FakeFile> } | null;

const blobId = (bytes: Buffer) =>
  createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");

/** What GitHub says about a file: its tree entry, with the blob asked for. */
function entryOf(
  repository: { files: Record<string, FakeFile> },
  path: string,
) {
  const file = repository.files[path];
  const name = path.split("/").at(-1)!;
  if (file === undefined) {
    const isDirectory = Object.keys(repository.files).some((other) =>
      other.startsWith(`${path}/`),
    );
    return isDirectory
      ? { name, type: "tree", mode: 16384, oid: "d".repeat(40), object: {} }
      : null;
  }
  if (typeof file === "object" && "link" in file) {
    const bytes = Buffer.from(file.link);
    return {
      name,
      type: "blob",
      mode: SYMLINK,
      oid: blobId(bytes),
      object: {
        byteSize: bytes.byteLength,
        isBinary: false,
        isTruncated: false,
        text: file.link,
      },
    };
  }
  const { bytes, text, isBinary } =
    typeof file === "string"
      ? { bytes: Buffer.from(file), text: file, isBinary: false }
      : Buffer.isBuffer(file)
        ? { bytes: file, text: file.toString("utf8"), isBinary: false }
        : { isBinary: false, ...file };
  return {
    name,
    type: "blob",
    mode: 33188,
    oid: blobId(bytes),
    object: { byteSize: bytes.byteLength, isBinary, isTruncated: false, text },
  };
}

function listing(repository: { files: Record<string, FakeFile> }, dir: string) {
  const prefix = dir ? `${dir}/` : "";
  const names = new Set<string>();
  for (const path of Object.keys(repository.files)) {
    if (path.startsWith(prefix))
      names.add(path.slice(prefix.length).split("/")[0]!);
  }
  return [...names].map((name) => {
    const { object: _object, ...entry } = entryOf(repository, prefix + name)!;
    return entry;
  });
}

type FakeGitHub = {
  repositories: Record<string, FakeRepository>;
  /** Makes a query fail as a whole (a timeout) when it asks for one of these. */
  failingRepositories?: string[];
  /** Answers every query with this instead. */
  respond?: () => Response;
};

const notFound = (path: string[]) => ({
  type: "NOT_FOUND",
  path,
  message: `Could not resolve file for path '${path.at(-1)}'.`,
});

type Call = {
  query: string;
  variables: Record<string, string>;
  auth: string | null;
};

/**
 * Answers the three queries the README client sends — probe, listing, file
 * read — by alias, from `repositories`, the way GitHub's GraphQL API would.
 */
function fakeGitHub(github: FakeGitHub) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== GRAPHQL || init?.method !== "POST") {
      throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
    }
    const { query, variables } = JSON.parse(String(init.body)) as {
      query: string;
      variables: Record<string, string>;
    };
    calls.push({
      query,
      variables,
      auth: new Headers(init.headers).get("authorization"),
    });
    if (github.respond) return github.respond();

    const aliases = [...query.matchAll(/\b(r\d+): repository\(/g)].map(
      (m) => m[1]!,
    );
    if (
      aliases.some((alias) =>
        github.failingRepositories?.includes(variables[`n${alias.slice(1)}`]!),
      )
    ) {
      return new Response("", { status: 502 });
    }
    const data: Record<string, unknown> = {
      rateLimit: { cost: 1, remaining: 4321, resetAt: "2026-09-28T11:00:00Z" },
    };
    const errors: unknown[] = [];
    for (const alias of aliases) {
      const i = alias.slice(1);
      const key = `${variables[`o${i}`]}/${variables[`n${i}`]}`.toLowerCase();
      const found = Object.entries(github.repositories).find(
        ([name]) => name.toLowerCase() === key,
      );
      if (!found) {
        data[alias] = null;
        errors.push({
          type: "NOT_FOUND",
          path: [alias],
          message: `Could not resolve to a Repository with the name '${key}'.`,
        });
        continue;
      }
      // Everything after the probe is asked at the commit the probe returned.
      const repository = found[1];
      if (query.includes("defaultBranchRef")) {
        if (!repository) {
          data[alias] = { defaultBranchRef: null };
          continue;
        }
        const commit: Record<string, unknown> = { oid: COMMIT };
        for (const [name, value] of Object.entries(variables)) {
          const match = name.match(/^p(\d+)_(\d+)$/);
          if (match && match[2] === i) {
            const field = `f${match[1]}`;
            commit[field] = entryOf(repository, value);
            // GitHub reports a path that is not there on the field itself.
            if (!commit[field]) {
              errors.push(
                notFound([alias, "defaultBranchRef", "target", field]),
              );
            }
          }
        }
        data[alias] = { defaultBranchRef: { target: commit } };
        continue;
      }
      if (!repository || variables[`c${i}`] !== COMMIT) {
        data[alias] = { object: null };
        errors.push(notFound([alias, "object"]));
        continue;
      }
      const path = variables[`p${i}`];
      if (query.includes("entries")) {
        if (path === undefined) {
          data[alias] = {
            object: { tree: { entries: listing(repository, "") } },
          };
        } else {
          const entry = entryOf(repository, path);
          if (!entry) errors.push(notFound([alias, "object", "file"]));
          data[alias] = {
            object: {
              file: entry && {
                type: entry.type,
                object:
                  entry.type === "tree"
                    ? { entries: listing(repository, path) }
                    : {},
              },
            },
          };
        }
      } else {
        const entry = entryOf(repository, path!);
        if (!entry) errors.push(notFound([alias, "object", "file"]));
        data[alias] = { object: { file: entry } };
      }
    }
    return new Response(
      JSON.stringify({ data, ...(errors.length ? { errors } : {}) }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

const target = (
  repo: string,
  subfolder = "",
  owner = "acme",
): GitHubReadmeTarget => ({
  owner,
  repo,
  subfolder,
});

const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

beforeEach(() => {
  // Independent of whatever a developer's .env holds.
  vi.stubEnv("GITHUB_TOKEN", "test-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("fetchGitHubReadmes", () => {
  test("reads each README with the commit it was read at, in one query", async () => {
    const markdown = "# carrerlift\n\nFind jobs. [Docs](docs/setup.md)\n";
    const { calls } = fakeGitHub({
      repositories: {
        "acme/server": {
          files: { "README.md": markdown, "docs/setup.md": "x" },
        },
        "FTHTrading/genesis402-agent-kit": {
          files: {
            "README.md": "# kit",
            "mcp/README.md": "# genesis402 MCP\n\n中文说明\n",
          },
        },
      },
    });

    const batch = await fetchGitHubReadmes([
      target("server"),
      target("genesis402-agent-kit", "mcp", "FTHTrading"),
    ]);

    assert.deepEqual(batch.results, [
      {
        status: "ok",
        markdown,
        path: "README.md",
        ref: COMMIT,
        sha256: sha256(markdown),
        byteSize: Buffer.byteLength(markdown),
      },
      {
        status: "ok",
        markdown: "# genesis402 MCP\n\n中文说明\n",
        path: "mcp/README.md",
        ref: COMMIT,
        sha256: sha256("# genesis402 MCP\n\n中文说明\n"),
        byteSize: Buffer.byteLength("# genesis402 MCP\n\n中文说明\n"),
      },
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.auth, "Bearer test-token");
    assert.deepEqual(
      { cost: batch.cost, remaining: batch.remaining, resetAt: batch.resetAt },
      { cost: 1, remaining: 4321, resetAt: new Date("2026-09-28T11:00:00Z") },
    );
  });

  test("names and paths travel only as variables", async () => {
    const { calls } = fakeGitHub({
      repositories: { "acme/server": { files: {} } },
    });
    await fetchGitHubReadmes([target("server", 'mcp"){ x }')]);
    const [probe] = calls;
    assert.ok(probe);
    assert.equal(probe.query.includes("acme"), false);
    assert.equal(probe.query.includes("server"), false);
    assert.equal(probe.query.includes("mcp"), false);
    assert.equal(probe.variables.o0, "acme");
    assert.equal(probe.variables.n0, "server");
    assert.equal(probe.variables.p0_0, 'mcp"){ x }/README.md');
  });

  test("asks about a directory once however many targets name it", async () => {
    const { calls } = fakeGitHub({
      repositories: {
        "acme/monorepo": { files: { "servers/a/README.md": "# A" } },
      },
    });
    const batch = await fetchGitHubReadmes([
      target("monorepo", "servers/a"),
      target("MonoRepo", "servers/a", "ACME"),
      target("monorepo", "servers/a/"),
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.variables.n1, undefined);
    assert.deepEqual(
      batch.results.map((result) => result.status),
      ["ok", "ok", "ok"],
    );
  });

  test(`probes ${GITHUB_README_QUERY_SIZE} directories per query`, async () => {
    const repositories = Object.fromEntries(
      Array.from({ length: GITHUB_README_QUERY_SIZE + 1 }, (_, i) => [
        `acme/s${i}`,
        { files: { "README.md": `# ${i}` } },
      ]),
    );
    const { calls } = fakeGitHub({ repositories });
    const batch = await fetchGitHubReadmes(
      Object.keys(repositories).map((name) => target(name.split("/")[1]!)),
    );
    assert.equal(calls.length, 2);
    assert.equal(batch.cost, 2);
    assert.ok(batch.results.every((result) => result.status === "ok"));
  });

  test("prefers the canonical README.md over another casing", async () => {
    fakeGitHub({
      repositories: {
        "acme/both": {
          files: { "readme.md": "# lower", "README.md": "# upper" },
        },
      },
    });
    const [result] = (await fetchGitHubReadmes([target("both")])).results;
    assert.equal(result?.status === "ok" && result.path, "README.md");
  });

  test("lists a directory without the usual names and picks a README variant the way skills do", async () => {
    const { calls } = fakeGitHub({
      repositories: {
        "acme/variant": {
          files: {
            "README.zh-CN.md": "# 中文",
            "README.ja.md": "# 日本語",
            "src/index.ts": "",
          },
        },
      },
    });
    const [result] = (await fetchGitHubReadmes([target("variant")])).results;
    assert.deepEqual(result, {
      status: "ok",
      markdown: "# 日本語",
      path: "README.ja.md",
      ref: COMMIT,
      sha256: sha256("# 日本語"),
      byteSize: Buffer.byteLength("# 日本語"),
    });
    // Probe, listing, then the picked file.
    assert.equal(calls.length, 3);
    assert.equal(calls[1]?.variables.c0, COMMIT);
  });

  test("a README that is not Markdown, or is blank, is not one to show", async () => {
    fakeGitHub({
      repositories: {
        "acme/rst": { files: { "README.rst": "Title\n=====\n" } },
        "acme/blank": { files: { "README.md": "  \n\n" } },
      },
    });
    const { results } = await fetchGitHubReadmes([
      target("rst"),
      target("blank"),
    ]);
    assert.deepEqual(results, [
      { status: "not_found", reason: "not_markdown", path: "README.rst" },
      { status: "not_found", reason: "empty", path: "README.md" },
    ]);
  });

  test("a subfolder without a README has none: the repository's own is not used", async () => {
    fakeGitHub({
      repositories: {
        "acme/mono": {
          files: { "README.md": "# Root", "servers/x/index.ts": "" },
        },
      },
    });
    const { results } = await fetchGitHubReadmes([
      target("mono", "servers/x"),
      target("mono", "servers/missing"),
    ]);
    assert.deepEqual(results, [
      { status: "not_found", reason: "missing" },
      { status: "not_found", reason: "missing" },
    ]);
  });

  test("a missing repository, an empty one and a refused one", async () => {
    const { fetchMock } = fakeGitHub({
      repositories: {
        "acme/empty": null,
        "acme/ok": { files: { "README.md": "# ok" } },
        "acme/blocked": { files: { "README.md": "# blocked" } },
      },
    });
    const answer = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      const response = await answer(url, init);
      const body = (await response.json()) as {
        data: Record<string, unknown>;
        errors?: unknown[];
      };
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      // A blocked repository fails its own alias only.
      if (query.includes("r3:")) {
        body.data.r3 = null;
        body.errors = [
          ...(body.errors ?? []),
          {
            type: "FORBIDDEN",
            path: ["r3"],
            message: "Repository access blocked",
          },
        ];
      }
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const { results } = await fetchGitHubReadmes([
      target("gone"),
      target("empty"),
      target("ok"),
      target("blocked"),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["not_found", "not_found", "ok", "error"],
    );
    assert.deepEqual(results[3], {
      status: "error",
      message: "GitHub: Repository access blocked",
    });
  });

  test("a README over the size limit is too large", async () => {
    const big = "x".repeat(MAX_README_BYTES + 1);
    fakeGitHub({
      repositories: { "acme/big": { files: { "README.md": big } } },
    });
    const [result] = (await fetchGitHubReadmes([target("big")])).results;
    assert.deepEqual(result, {
      status: "too_large",
      path: "README.md",
      byteSize: MAX_README_BYTES + 1,
    });
  });

  test("text that does not match the file's bytes is not stored", async () => {
    const latin1 = Buffer.from([0x23, 0x20, 0xe9, 0x74, 0xe9]); // "# été" in Latin-1
    fakeGitHub({
      repositories: {
        // GitHub substitutes what is not UTF-8, so the text no longer hashes to the blob.
        "acme/latin1": {
          files: {
            "README.md": { bytes: latin1, text: latin1.toString("utf8") },
          },
        },
        "acme/binary": {
          files: {
            "README.md": {
              bytes: Buffer.from([0, 1, 2]),
              text: null,
              isBinary: true,
            },
          },
        },
        "acme/nul": { files: { "README.md": Buffer.from("# a\0b") } },
      },
    });
    const { results } = await fetchGitHubReadmes([
      target("latin1"),
      target("binary"),
      target("nul"),
    ]);
    assert.deepEqual(
      results,
      ["README.md", "README.md", "README.md"].map((path) => ({
        status: "error",
        message: `GitHub README is not UTF-8 text: ${path}`,
      })),
    );
  });

  test("a byte-order mark is kept in the hash and left out of the text", async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("# Bom\n"),
    ]);
    fakeGitHub({
      repositories: {
        "acme/with": { files: { "README.md": { bytes, text: "﻿# Bom\n" } } },
        // GitHub may leave the mark out of `text`.
        "acme/without": { files: { "README.md": { bytes, text: "# Bom\n" } } },
      },
    });
    const { results } = await fetchGitHubReadmes([
      target("with"),
      target("without"),
    ]);
    for (const result of results) {
      assert.deepEqual(result, {
        status: "ok",
        markdown: "# Bom\n",
        path: "README.md",
        ref: COMMIT,
        sha256: sha256(bytes),
        byteSize: bytes.byteLength,
      });
    }
  });

  test("a symlinked README is followed once, and keeps the link's path", async () => {
    const { calls } = fakeGitHub({
      repositories: {
        "vercel/next.js": {
          files: {
            "readme.md": { link: "packages/next/README.md" },
            "packages/next/README.md": "# Next.js",
          },
        },
        "acme/escape": { files: { "README.md": { link: "../../etc/passwd" } } },
        "acme/chain": {
          files: {
            "README.md": { link: "docs/README.md" },
            "docs/README.md": { link: "README.md" },
          },
        },
      },
    });
    const { results } = await fetchGitHubReadmes([
      target("next.js", "", "vercel"),
      target("escape"),
      target("chain"),
    ]);
    assert.deepEqual(results, [
      {
        status: "ok",
        markdown: "# Next.js",
        path: "readme.md",
        ref: COMMIT,
        sha256: sha256("# Next.js"),
        byteSize: Buffer.byteLength("# Next.js"),
      },
      { status: "not_found", reason: "missing" },
      { status: "not_found", reason: "missing" },
    ]);
    assert.equal(calls.length, 2);
  });

  test("a query GitHub cannot answer is asked again in halves, down to the one that fails", async () => {
    const repositories = Object.fromEntries(
      ["a", "b", "slow", "c"].map((name) => [
        `acme/${name}`,
        { files: { "README.md": `# ${name}` } },
      ]),
    );
    const { calls } = fakeGitHub({
      repositories,
      failingRepositories: ["slow"],
    });
    const { results } = await fetchGitHubReadmes(
      ["a", "b", "slow", "c"].map((name) => target(name)),
    );
    assert.deepEqual(
      results.map((result) => result.status),
      ["ok", "ok", "error", "ok"],
    );
    assert.deepEqual(results[2], {
      status: "error",
      message: "GitHub GraphQL request failed 502",
    });
    // [a b slow c] → [a b] ok, [slow c] → [slow] fails, [c] ok. No retry of the same query.
    assert.equal(calls.length, 5);
  });

  test("a spent rate limit leaves every unanswered target rate limited", async () => {
    const resetSeconds = Math.floor(Date.now() / 1000) + 3600;
    fakeGitHub({
      repositories: {},
      respond: () =>
        new Response(
          JSON.stringify({
            data: null,
            errors: [
              { type: "RATE_LIMITED", message: "API rate limit exceeded" },
            ],
          }),
          {
            status: 200,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(resetSeconds),
            },
          },
        ),
    });
    const { results } = await fetchGitHubReadmes([target("a"), target("b")]);
    assert.deepEqual(results, [
      { status: "rate_limited", resetAt: new Date(resetSeconds * 1000) },
      { status: "rate_limited", resetAt: new Date(resetSeconds * 1000) },
    ]);
  });

  test("a primary limit answered with a 403 is a rate limit too", async () => {
    const resetSeconds = Math.floor(Date.now() / 1000) + 3600;
    fakeGitHub({
      repositories: {},
      respond: () =>
        new Response("{}", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetSeconds),
          },
        }),
    });
    const [result] = (await fetchGitHubReadmes([target("a")])).results;
    assert.deepEqual(result, {
      status: "rate_limited",
      resetAt: new Date(resetSeconds * 1000),
    });
  });

  test("a token GitHub refuses, or none at all, reads nothing", async () => {
    const { fetchMock } = fakeGitHub({
      repositories: {},
      respond: () => new Response("{}", { status: 401 }),
    });
    const refused = await fetchGitHubReadmes([target("a"), target("b")]);
    assert.deepEqual(refused.results, [
      {
        status: "unauthorized",
        message: "GitHub did not accept GITHUB_TOKEN (401)",
      },
      {
        status: "unauthorized",
        message: "GitHub did not accept GITHUB_TOKEN (401)",
      },
    ]);
    assert.equal(fetchMock.mock.calls.length, 1);

    vi.stubEnv("GITHUB_TOKEN", "");
    const missing = await fetchGitHubReadmes([target("a")]);
    assert.equal(missing.results[0]?.status, "unauthorized");
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  test("a target that names no GitHub directory is an error without a request", async () => {
    const { fetchMock } = fakeGitHub({ repositories: {} });
    const { results } = await fetchGitHubReadmes([
      target("repo", "../up"),
      target("re po"),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["error", "error"],
    );
    assert.equal(fetchMock.mock.calls.length, 0);
  });
});

describe("parseGitHubRepoRef", () => {
  test("reads owner and repository from github.com URLs", () => {
    for (const url of [
      "https://github.com/prakhar1605/carrerlift-mcp",
      "https://github.com/prakhar1605/carrerlift-mcp/",
      "https://github.com/prakhar1605/carrerlift-mcp.git",
      "https://www.github.com/prakhar1605/carrerlift-mcp",
      "http://github.com/prakhar1605/carrerlift-mcp",
      "git+https://github.com/prakhar1605/carrerlift-mcp.git",
      "  https://github.com/prakhar1605/carrerlift-mcp  ",
    ]) {
      assert.deepEqual(
        parseGitHubRepoRef(url),
        { owner: "prakhar1605", repo: "carrerlift-mcp", subfolder: "" },
        url,
      );
    }
  });

  test("takes the registry subfolder, normalized", () => {
    const url = "https://github.com/FTHTrading/genesis402-agent-kit";
    for (const subfolder of ["mcp", "./mcp", "mcp/", "/mcp"]) {
      assert.deepEqual(parseGitHubRepoRef(url, subfolder), {
        owner: "FTHTrading",
        repo: "genesis402-agent-kit",
        subfolder: "mcp",
      });
    }
    assert.equal(
      (parseGitHubRepoRef(url, "servers/my server#1") as { subfolder: string })
        .subfolder,
      "servers/my server#1",
    );
    assert.equal(
      (parseGitHubRepoRef(url, null) as { subfolder: string }).subfolder,
      "",
    );
  });

  test("a URL into a directory gives that directory, decoded, unless a subfolder is given", () => {
    const url =
      "https://github.com/acme/monorepo/tree/main/servers/my%20server";
    assert.deepEqual(parseGitHubRepoRef(url), {
      owner: "acme",
      repo: "monorepo",
      subfolder: "servers/my server",
    });
    assert.deepEqual(parseGitHubRepoRef(url, "packages/mcp"), {
      owner: "acme",
      repo: "monorepo",
      subfolder: "packages/mcp",
    });
  });

  test("anything that is not a github.com URL is unsupported", () => {
    for (const url of [
      "https://gitlab.com/acme/server",
      "https://bitbucket.org/acme/server",
      "https://github.com.evil.example/acme/server",
      "https://raw.githubusercontent.com/acme/server/main/README.md",
      "https://gist.github.com/acme/abc123",
      "acme/server",
      "git@github.com:acme/server.git",
      "",
      null,
      undefined,
    ]) {
      assert.deepEqual(
        parseGitHubRepoRef(url),
        { unsupported: true, reason: "not_github" },
        String(url),
      );
    }
  });

  test("a github.com URL or subfolder that names no repository directory is unsupported", () => {
    for (const [url, subfolder] of [
      ["https://github.com/acme", undefined],
      ["https://github.com/", undefined],
      ["https://github.com/acme/server", "../other"],
      ["https://github.com/acme/server", "mcp/../../x"],
      ["https://github.com/acme/server/tree/main/%E0%A4%A", undefined],
      ["https://github.com/ac%20me/server", undefined],
    ] as const) {
      assert.deepEqual(
        parseGitHubRepoRef(url, subfolder),
        { unsupported: true, reason: "invalid_path" },
        `${url} ${subfolder ?? ""}`,
      );
    }
  });
});

describe("githubReadmeLinkBases", () => {
  test("a root README resolves against the commit's root", () => {
    const bases = githubReadmeLinkBases({
      owner: "prakhar1605",
      repo: "carrerlift-mcp",
      ref: COMMIT,
      path: "README.md",
    });
    assert.deepEqual(bases, {
      blobBase: `https://github.com/prakhar1605/carrerlift-mcp/blob/${COMMIT}/`,
      rawBase: `https://raw.githubusercontent.com/prakhar1605/carrerlift-mcp/${COMMIT}/`,
    });
    assert.equal(
      new URL("docs/setup.md", bases.blobBase).href,
      `https://github.com/prakhar1605/carrerlift-mcp/blob/${COMMIT}/docs/setup.md`,
    );
  });

  test("a subfolder README resolves against its own directory", () => {
    const bases = githubReadmeLinkBases({
      owner: "FTHTrading",
      repo: "genesis402-agent-kit",
      ref: COMMIT,
      path: "mcp/README.md",
    });
    assert.deepEqual(bases, {
      blobBase: `https://github.com/FTHTrading/genesis402-agent-kit/blob/${COMMIT}/mcp/`,
      rawBase: `https://raw.githubusercontent.com/FTHTrading/genesis402-agent-kit/${COMMIT}/mcp/`,
    });
    assert.equal(
      new URL("../LICENSE", bases.blobBase).href,
      `https://github.com/FTHTrading/genesis402-agent-kit/blob/${COMMIT}/LICENSE`,
    );
    assert.equal(
      new URL("./img/arch.png", bases.rawBase).href,
      `https://raw.githubusercontent.com/FTHTrading/genesis402-agent-kit/${COMMIT}/mcp/img/arch.png`,
    );
  });

  test("directory names are URL-encoded", () => {
    const { blobBase } = githubReadmeLinkBases({
      owner: "acme",
      repo: "server",
      ref: COMMIT,
      path: "servers/my server#1/README.md",
    });
    assert.equal(
      blobBase,
      `https://github.com/acme/server/blob/${COMMIT}/servers/my%20server%231/`,
    );
    assert.equal(
      new URL("a.md", blobBase).href,
      `https://github.com/acme/server/blob/${COMMIT}/servers/my%20server%231/a.md`,
    );
  });
});
