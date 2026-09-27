import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { MAX_README_BYTES } from "../../../shared/catalog-readme";
import {
  fetchGitHubReadme,
  githubReadmeLinkBases,
  parseGitHubRepoRef,
} from "./github-readme";

const COMMIT = "c0ffee".padEnd(40, "0");
const API = "https://api.github.com/repos";

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** GitHub's contents answer: base64 wrapped at 60 columns, as the API sends it. */
function readmeBody(path: string, content: string | Buffer, extra = {}) {
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  return {
    type: "file",
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
    size: bytes.byteLength,
    encoding: "base64",
    content: bytes.toString("base64").replace(/.{60}/g, "$&\n"),
    sha: "b".repeat(40),
    ...extra,
  };
}

type Route = (init?: RequestInit) => Response | Promise<Response>;

/** A `fetch` answering by exact URL; any other URL fails the test. */
function routes(table: Record<string, Route>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const route = table[url];
    if (!route) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    return route(init);
  });
}

const commitRoute = (owner: string, repo: string) => ({
  [`${API}/${owner}/${repo}/commits/HEAD`]: () =>
    jsonResponse({
      sha: COMMIT,
      commit: { committer: { date: "2026-09-01T00:00:00Z" } },
    }),
});

function headerOf(init: RequestInit | undefined, name: string) {
  return new Headers(init?.headers).get(name);
}

beforeEach(() => {
  // Independent of whatever a developer's .env holds.
  vi.stubEnv("GITHUB_TOKEN", "test-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("fetchGitHubReadme", () => {
  test("reads the repository README and pins it to the default branch's commit", async () => {
    const markdown = "# carrerlift\n\nFind jobs. [Docs](docs/setup.md)\n";
    const fetchMock = routes({
      [`${API}/acme/server/readme`]: () =>
        jsonResponse(readmeBody("README.md", markdown), 200, {
          etag: 'W/"etag-1"',
        }),
      ...commitRoute("acme", "server"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGitHubReadme({ owner: "acme", repo: "server" });

    assert.deepEqual(result, {
      status: "ok",
      markdown,
      path: "README.md",
      ref: COMMIT,
      sha256: createHash("sha256").update(markdown).digest("hex"),
      etag: 'W/"etag-1"',
      byteSize: Buffer.byteLength(markdown),
      tokenPresent: true,
    });
    const [readmeCall, commitCall] = fetchMock.mock.calls;
    assert.equal(readmeCall?.[0], `${API}/acme/server/readme`);
    assert.equal(
      headerOf(readmeCall?.[1], "authorization"),
      "Bearer test-token",
    );
    assert.equal(
      headerOf(readmeCall?.[1], "accept"),
      "application/vnd.github+json",
    );
    assert.equal(headerOf(readmeCall?.[1], "if-none-match"), null);
    assert.equal(commitCall?.[0], `${API}/acme/server/commits/HEAD`);
    assert.equal(fetchMock.mock.calls.length, 2);
  });

  test("reads a subfolder's README by its directory path", async () => {
    const markdown = "# genesis402 MCP\n\n中文说明\n";
    vi.stubGlobal(
      "fetch",
      routes({
        [`${API}/FTHTrading/genesis402-agent-kit/readme/mcp`]: () =>
          jsonResponse(readmeBody("mcp/README.md", markdown)),
        ...commitRoute("FTHTrading", "genesis402-agent-kit"),
      }),
    );

    const result = await fetchGitHubReadme({
      owner: "FTHTrading",
      repo: "genesis402-agent-kit",
      subfolder: "mcp",
    });

    assert.equal(result.status, "ok");
    assert.ok(result.status === "ok");
    assert.equal(result.path, "mcp/README.md");
    assert.equal(result.markdown, markdown);
    assert.equal(result.byteSize, Buffer.byteLength(markdown));
    assert.equal(result.ref, COMMIT);
    // No ETag header on the response: nothing to send back next time.
    assert.equal(result.etag, null);
  });

  test("encodes every subfolder segment and normalizes empty and `.` ones", async () => {
    const fetchMock = routes({
      [`${API}/acme/server/readme/servers/my%20server%231/%C3%A9t%C3%A9`]: () =>
        jsonResponse({ message: "Not Found" }, 404),
      [`${API}/acme/server/readme/mcp`]: () =>
        jsonResponse({ message: "Not Found" }, 404),
    });
    vi.stubGlobal("fetch", fetchMock);

    for (const subfolder of ["servers/my server#1/été", "./mcp/", "/mcp"]) {
      const result = await fetchGitHubReadme({
        owner: "acme",
        repo: "server",
        subfolder,
      });
      assert.equal(result.status, "not_found", subfolder);
    }
    assert.equal(fetchMock.mock.calls.length, 3);
  });

  test("an empty subfolder asks for the repository's own README", async () => {
    const fetchMock = routes({
      [`${API}/acme/server/readme`]: () =>
        jsonResponse({ message: "Not Found" }, 404),
    });
    vi.stubGlobal("fetch", fetchMock);
    for (const subfolder of ["", " ", ".", null]) {
      await fetchGitHubReadme({ owner: "acme", repo: "server", subfolder });
    }
    assert.equal(fetchMock.mock.calls.length, 4);
  });

  test("a path that climbs out of the repository is refused without a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const input of [
      { owner: "acme", repo: "server", subfolder: "../../orgs/x" },
      { owner: "acme", repo: "server", subfolder: "mcp/../.." },
      { owner: "..", repo: "server" },
      { owner: "acme", repo: "a/b" },
    ]) {
      const result = await fetchGitHubReadme(input);
      assert.equal(result.status, "error", JSON.stringify(input));
    }
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  test("an unchanged README answers 304 with the stored ETag and costs no commit lookup", async () => {
    const fetchMock = routes({
      [`${API}/acme/server/readme/mcp`]: () =>
        new Response(null, { status: 304, headers: { etag: '"etag-1"' } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGitHubReadme({
      owner: "acme",
      repo: "server",
      subfolder: "mcp",
      etag: 'W/"etag-1"',
    });

    assert.deepEqual(result, { status: "not_modified", tokenPresent: true });
    assert.equal(
      headerOf(fetchMock.mock.calls[0]?.[1], "if-none-match"),
      'W/"etag-1"',
    );
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  test("a repository or directory without a README is not_found", async () => {
    const fetchMock = routes({
      [`${API}/acme/server/readme`]: () =>
        jsonResponse({ message: "Not Found" }, 404),
    });
    vi.stubGlobal("fetch", fetchMock);
    assert.deepEqual(
      await fetchGitHubReadme({ owner: "acme", repo: "server" }),
      { status: "not_found", reason: "missing", tokenPresent: true },
    );
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  test("a README GitHub prefers that is not Markdown, or is blank, is not shown", async () => {
    vi.stubGlobal(
      "fetch",
      routes({
        [`${API}/acme/rst/readme`]: () =>
          jsonResponse(readmeBody("README.rst", "Title\n=====\n"), 200, {
            etag: '"e-rst"',
          }),
        [`${API}/acme/plain/readme`]: () =>
          jsonResponse(readmeBody("docs/README", "plain")),
        [`${API}/acme/blank/readme`]: () =>
          jsonResponse(readmeBody("README.md", " \n\n")),
      }),
    );

    assert.deepEqual(await fetchGitHubReadme({ owner: "acme", repo: "rst" }), {
      status: "not_found",
      reason: "not_markdown",
      path: "README.rst",
      etag: '"e-rst"',
      tokenPresent: true,
    });
    const plain = await fetchGitHubReadme({ owner: "acme", repo: "plain" });
    assert.equal(plain.status === "not_found" && plain.reason, "not_markdown");
    const blank = await fetchGitHubReadme({ owner: "acme", repo: "blank" });
    assert.equal(blank.status === "not_found" && blank.reason, "empty");
  });

  test("accepts the README variants the shared rule accepts", async () => {
    for (const path of ["readme.md", "README.zh-CN.md", ".github/README.md"]) {
      vi.stubGlobal(
        "fetch",
        routes({
          [`${API}/acme/server/readme`]: () =>
            jsonResponse(readmeBody(path, "# hi")),
          ...commitRoute("acme", "server"),
        }),
      );
      const result = await fetchGitHubReadme({ owner: "acme", repo: "server" });
      assert.equal(result.status, "ok", path);
    }
  });

  test("a README past the shared limit is too_large and never decoded or pinned", async () => {
    const fetchMock = routes({
      [`${API}/acme/server/readme`]: () =>
        jsonResponse(
          {
            ...readmeBody("README.md", ""),
            size: MAX_README_BYTES + 1,
            // What GitHub sends for a file too big to inline.
            encoding: "none",
            content: "",
          },
          200,
          { etag: '"big"' },
        ),
    });
    vi.stubGlobal("fetch", fetchMock);

    assert.deepEqual(
      await fetchGitHubReadme({ owner: "acme", repo: "server" }),
      {
        status: "too_large",
        path: "README.md",
        byteSize: MAX_README_BYTES + 1,
        etag: '"big"',
        tokenPresent: true,
      },
    );
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  test("the limit is checked on the decoded bytes too, and exactly the limit passes", async () => {
    const atLimit = "x".repeat(MAX_README_BYTES);
    const overLimit = "x".repeat(MAX_README_BYTES + 1);
    vi.stubGlobal(
      "fetch",
      routes({
        [`${API}/acme/at/readme`]: () =>
          jsonResponse(readmeBody("README.md", atLimit)),
        ...commitRoute("acme", "at"),
        // A declared size that understates the content.
        [`${API}/acme/over/readme`]: () =>
          jsonResponse({ ...readmeBody("README.md", overLimit), size: 10 }),
      }),
    );

    const at = await fetchGitHubReadme({ owner: "acme", repo: "at" });
    assert.equal(at.status === "ok" && at.byteSize, MAX_README_BYTES);
    const over = await fetchGitHubReadme({ owner: "acme", repo: "over" });
    assert.equal(over.status, "too_large");
    assert.equal(
      over.status === "too_large" && over.byteSize,
      MAX_README_BYTES + 1,
    );
  });

  test("content that is truncated or not UTF-8 text is an error, not a README", async () => {
    vi.stubGlobal(
      "fetch",
      routes({
        [`${API}/acme/short/readme`]: () =>
          jsonResponse({ ...readmeBody("README.md", "# hi"), size: 100 }),
        [`${API}/acme/binary/readme`]: () =>
          jsonResponse(
            readmeBody("README.md", Buffer.from([0x23, 0x00, 0x41])),
          ),
        [`${API}/acme/latin1/readme`]: () =>
          jsonResponse(
            readmeBody("README.md", Buffer.from([0x23, 0xe9, 0x41])),
          ),
        [`${API}/acme/dir/readme`]: () =>
          jsonResponse({ type: "dir", path: "README.md" }),
      }),
    );
    for (const repo of ["short", "binary", "latin1", "dir"]) {
      const result = await fetchGitHubReadme({ owner: "acme", repo });
      assert.equal(result.status, "error", repo);
    }
  });

  test("a spent primary rate limit (403) is rate_limited with GitHub's reset time", async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: "API rate limit exceeded" }, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(reset),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    assert.deepEqual(
      await fetchGitHubReadme({ owner: "acme", repo: "server" }),
      {
        status: "rate_limited",
        resetAt: new Date(reset * 1000),
        tokenPresent: true,
      },
    );
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  test("a secondary rate limit (429 + retry-after) is rate_limited at now + retry-after", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ message: "slow down" }, 429, { "retry-after": "3600" }),
      ),
    );
    const before = Date.now();
    const result = await fetchGitHubReadme({ owner: "acme", repo: "server" });
    assert.equal(result.status, "rate_limited");
    assert.ok(result.status === "rate_limited");
    assert.ok(
      Math.abs(result.resetAt.getTime() - (before + 3_600_000)) < 5_000,
    );
  });

  test("a rate limit hit while pinning the commit is rate_limited too", async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    vi.stubGlobal(
      "fetch",
      routes({
        [`${API}/acme/server/readme`]: () =>
          jsonResponse(readmeBody("README.md", "# hi")),
        [`${API}/acme/server/commits/HEAD`]: () =>
          jsonResponse({ message: "API rate limit exceeded" }, 403, {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(reset),
          }),
      }),
    );
    const result = await fetchGitHubReadme({ owner: "acme", repo: "server" });
    assert.equal(
      result.status === "rate_limited" && result.resetAt.getTime(),
      reset * 1000,
    );
  });

  test("a commit GitHub cannot resolve leaves the README unpinned: an error", async () => {
    vi.stubGlobal(
      "fetch",
      routes({
        [`${API}/acme/server/readme`]: () =>
          jsonResponse(readmeBody("README.md", "# hi")),
        [`${API}/acme/server/commits/HEAD`]: () =>
          jsonResponse({ message: "No commit found for SHA: HEAD" }, 422),
      }),
    );
    const result = await fetchGitHubReadme({ owner: "acme", repo: "server" });
    assert.equal(result.status, "error");
  });

  test("a plain 403 is a refusal reported as an error, not a rate limit", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: "Repository access blocked" }, 403),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchGitHubReadme({ owner: "acme", repo: "server" });
    assert.equal(result.status, "error");
    assert.match(result.status === "error" ? result.message : "", /failed 403/);
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  test("a network failure is an error carrying its cause, with no other source tried", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("getaddrinfo ENOTFOUND api.github.com"),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    assert.deepEqual(
      await fetchGitHubReadme({ owner: "acme", repo: "server" }),
      {
        status: "error",
        message: "fetch failed (getaddrinfo ENOTFOUND api.github.com)",
        tokenPresent: true,
      },
    );
    // No retry against raw.githubusercontent.com or anywhere else.
    assert.deepEqual(
      fetchMock.mock.calls.map((call) => (call as unknown[])[0]),
      [`${API}/acme/server/readme`],
    );
  });

  test("the caller's own cancellation is re-thrown, not reported", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal!.reason),
            );
          }),
      ),
    );
    const pending = fetchGitHubReadme({
      owner: "acme",
      repo: "server",
      signal: controller.signal,
    });
    controller.abort(new Error("worker shutting down"));
    await assert.rejects(pending, /worker shutting down/);
  });

  test("without GITHUB_TOKEN it reads anonymously and says so", async () => {
    vi.stubEnv("GITHUB_TOKEN", undefined);
    const fetchMock = routes({
      [`${API}/acme/server/readme`]: () =>
        jsonResponse(readmeBody("README.md", "# hi")),
      ...commitRoute("acme", "server"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGitHubReadme({ owner: "acme", repo: "server" });

    assert.equal(result.status, "ok");
    assert.equal(result.tokenPresent, false);
    for (const call of fetchMock.mock.calls) {
      assert.equal(headerOf(call[1], "authorization"), null);
    }

    const failed = routes({
      [`${API}/acme/server/readme`]: () =>
        jsonResponse({ message: "Not Found" }, 404),
    });
    vi.stubGlobal("fetch", failed);
    assert.equal(
      (await fetchGitHubReadme({ owner: "acme", repo: "server" })).tokenPresent,
      false,
    );
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
