import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import {
  mcpInstallCommand,
  mcpTestCommand,
  parseClient,
  parseKey,
  pinEndpoint,
  type McpInstallContext,
  type McpTestContext,
} from "../src/commands/mcp-install";
import {
  ConfirmationRequiredError,
  McpInspectError,
  UsageError,
} from "../src/errors";
import { createFileStore } from "../src/mcp/oauth/store";
import { createRegistryClient } from "../src/registry/client";
import {
  browserApproves,
  startFakeOAuthMcp,
  type FakeOAuthMcp,
} from "./fixtures/fake-oauth-mcp";

type Manifest = Record<string, unknown>;

function manifestOf(overrides: Manifest = {}): Manifest {
  return {
    schemaVersion: 1,
    identifier: "com.acme/search",
    version: "1.2.0",
    name: "Acme Search",
    summary: "Search Acme.",
    transport: "streamable_http",
    endpointUrl: "https://mcp.acme.dev/mcp",
    auth: { type: "none", required: false, allowedHeaderNames: [] },
    tools: [],
    ...overrides,
  };
}

const KEY_AUTH = {
  type: "api_key_header",
  required: true,
  headerName: "X-Acme-Key",
  allowedHeaderNames: [],
};

/** A registry that serves manifests from a map, and records what it was asked. */
function fakeRegistry(manifests: Record<string, Manifest>) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    asked.push(url.pathname);
    const match = /^\/v1\/mcp\/(.+)\/manifest$/u.exec(url.pathname);
    const manifest = match ? manifests[decodeURIComponent(match[1]!)] : undefined;
    if (!manifest) {
      return new Response(JSON.stringify({ code: "NOT_FOUND", message: "no" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ item: {}, version: {}, manifest }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { asked, client: createRegistryClient("https://api.sourceweft.com", fetchImpl) };
}

describe("choosing a client", () => {
  it("accepts the known ids and defaults to generic", () => {
    assert.equal(parseClient(undefined), "generic");
    assert.equal(parseClient("cursor"), "cursor");
    assert.throws(() => parseClient("vim"), UsageError);
  });
});

describe("mcp install", () => {
  let dir: string;
  let out: string[];
  let notices: string[];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sw-mcp-install-"));
    out = [];
    notices = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const context = (manifests: Record<string, Manifest>): McpInstallContext => ({
    client: fakeRegistry(manifests).client,
    registry: "https://api.sourceweft.com",
    out: (line) => out.push(line),
    notice: (line) => notices.push(line),
    cwd: dir,
  });
  const input = (extra: Partial<Parameters<typeof mcpInstallCommand>[1]> = {}) => ({
    identifier: "com.acme/search",
    client: "generic" as const,
    write: false,
    force: false,
    json: false,
    ...extra,
  });

  it("prints the config keyed by the server's name, and changes nothing", async () => {
    const ctx = context({ "com.acme/search": manifestOf() });
    const result = await mcpInstallCommand(ctx, input());
    assert.deepEqual(result, { action: "printed", key: "acme-search" });
    assert.deepEqual(JSON.parse(out.join("\n")), {
      mcpServers: {
        "acme-search": { type: "http", url: "https://mcp.acme.dev/mcp" },
      },
    });
    assert.deepEqual(await readdir(dir), []);
  });

  it("refers to the key by variable name in each client's own syntax", async () => {
    const ctx = context({ "com.acme/search": manifestOf({ auth: KEY_AUTH }) });
    await mcpInstallCommand(ctx, input({ client: "claude-code", keyEnv: "ACME_KEY" }));
    assert.deepEqual(JSON.parse(out.pop()!).mcpServers["acme-search"], {
      type: "http",
      url: "https://mcp.acme.dev/mcp",
      headers: { "X-Acme-Key": "${ACME_KEY}" },
    });
    await mcpInstallCommand(ctx, input({ client: "cursor", keyEnv: "ACME_KEY" }));
    assert.deepEqual(JSON.parse(out.pop()!).mcpServers["acme-search"], {
      url: "https://mcp.acme.dev/mcp",
      headers: { "X-Acme-Key": "${env:ACME_KEY}" },
    });
    assert.match(notices.join("\n"), /ACME_KEY/u);
  });

  it("keeps placeholders without --key-env and says how to avoid pasting a key", async () => {
    const ctx = context({ "com.acme/search": manifestOf({ auth: KEY_AUTH }) });
    await mcpInstallCommand(ctx, input());
    assert.equal(
      JSON.parse(out[0]!).mcpServers["acme-search"].headers["X-Acme-Key"],
      "<YOUR_API_KEY>",
    );
    assert.match(notices.join("\n"), /--key-env NAME/u);
  });

  it("refuses a key where a variable name belongs", async () => {
    const ctx = context({ "com.acme/search": manifestOf({ auth: KEY_AUTH }) });
    for (const secret of ["sk-live-abc123", "ghp_AbCdEf123456", "abc def", "$(id)", "A;B"]) {
      await assert.rejects(
        mcpInstallCommand(ctx, input({ client: "cursor", keyEnv: secret })),
        (error: unknown) => {
          assert.ok(error instanceof UsageError);
          assert.ok(!error.message.includes(secret), error.message);
          return true;
        },
      );
    }
    assert.deepEqual(out, []);
  });

  it("gives an OAuth server no headers and no --key-env", async () => {
    const ctx = context({
      "com.acme/search": manifestOf({ auth: { type: "oauth", required: true, allowedHeaderNames: [] } }),
    });
    await mcpInstallCommand(ctx, input({ client: "claude-code" }));
    assert.equal("headers" in JSON.parse(out[0]!).mcpServers["acme-search"], false);
    assert.match(notices.join("\n"), /OAuth/u);
    assert.match(notices.join("\n"), /https:\/\/sourceweft\.com\/mcp\/com\.acme%2Fsearch/u);
    await assert.rejects(
      mcpInstallCommand(ctx, input({ client: "claude-code", keyEnv: "X_KEY" })),
      /OAuth/u,
    );
  });

  it("will not name several secrets with one variable", async () => {
    const ctx = context({
      "com.acme/search": manifestOf({
        auth: { type: "custom_headers", required: true, allowedHeaderNames: ["X-A", "X-B"] },
      }),
    });
    await assert.rejects(
      mcpInstallCommand(ctx, input({ client: "cursor", keyEnv: "A_KEY" })),
      /several different headers/u,
    );
  });

  it("explains stdio, SSE-less and endpoint-less servers instead of guessing", async () => {
    const ctx = context({
      "local/one": manifestOf({ identifier: "local/one", transport: "stdio", endpointUrl: undefined, repoUrl: "https://github.com/a/b" }),
      "odd/one": manifestOf({ identifier: "odd/one", transport: "websocket" }),
      "none/one": manifestOf({ identifier: "none/one", endpointUrl: undefined }),
    });
    await assert.rejects(
      mcpInstallCommand(ctx, input({ identifier: "local/one" })),
      /does not record the command[\s\S]*github\.com\/a\/b/u,
    );
    await assert.rejects(mcpInstallCommand(ctx, input({ identifier: "odd/one" })), /update @sourceweft\/cli/u);
    await assert.rejects(mcpInstallCommand(ctx, input({ identifier: "none/one" })), /no endpoint/u);
    assert.deepEqual(out, []);
  });

  it("reports an unknown entry, and an answer for another entry, as errors", async () => {
    await assert.rejects(
      mcpInstallCommand(context({}), input({ identifier: "no/such" })),
      /No catalog entry no\/such/u,
    );
    const ctx = context({ "com.acme/search": manifestOf({ identifier: "evil/other" }) });
    await assert.rejects(mcpInstallCommand(ctx, input()), /evil\/other[\s\S]*nothing was done/u);
  });

  it("sends the identifier as one path segment, whatever it holds", async () => {
    const registry = fakeRegistry({});
    const ctx: McpInstallContext = { ...context({}), client: registry.client };
    await assert.rejects(
      mcpInstallCommand(ctx, input({ identifier: "../../v1/skills/x?y=1#z" })),
      /No catalog entry/u,
    );
    assert.deepEqual(registry.asked, ["/v1/mcp/..%2F..%2Fv1%2Fskills%2Fx%3Fy%3D1%23z/manifest"]);
    await assert.rejects(mcpInstallCommand(ctx, input({ identifier: "a\nb" })), UsageError);
    await assert.rejects(mcpInstallCommand(ctx, input({ identifier: "" })), UsageError);
  });

  describe("--write", () => {
    const keyed = () => context({ "com.acme/search": manifestOf({ auth: KEY_AUTH }) });
    const write = (extra: Partial<Parameters<typeof mcpInstallCommand>[1]> = {}) =>
      input({ client: "claude-code", keyEnv: "ACME_KEY", write: true, ...extra });

    it("creates the project's config, then adds to it without touching the rest", async () => {
      const result = await mcpInstallCommand(keyed(), write());
      assert.equal(result.action, "created");
      const path = join(dir, ".mcp.json");
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")).mcpServers["acme-search"].headers, {
        "X-Acme-Key": "${ACME_KEY}",
      });
      await writeFile(path, JSON.stringify({ theme: "dark", mcpServers: { other: { url: "https://o.example" } } }));
      const added = await mcpInstallCommand(keyed(), write());
      assert.equal(added.action, "added");
      const merged = JSON.parse(await readFile(path, "utf8"));
      assert.equal(merged.theme, "dark");
      assert.deepEqual(merged.mcpServers.other, { url: "https://o.example" });
      assert.ok(merged.mcpServers["acme-search"]);
      assert.deepEqual(Object.keys(merged.mcpServers), ["other", "acme-search"]);
    });

    it("is idempotent", async () => {
      await mcpInstallCommand(keyed(), write());
      const path = join(dir, ".mcp.json");
      const before = await readFile(path, "utf8");
      const again = await mcpInstallCommand(keyed(), write());
      assert.equal(again.action, "unchanged");
      assert.equal(await readFile(path, "utf8"), before);
      assert.match(out.at(-1)!, /nothing changed/u);
    });

    it("does not replace a different server under the same key without --force", async () => {
      const path = join(dir, ".mcp.json");
      const original = JSON.stringify({ mcpServers: { "acme-search": { url: "https://mine.example" } } });
      await writeFile(path, original);
      await assert.rejects(mcpInstallCommand(keyed(), write()), /--force/u);
      assert.equal(await readFile(path, "utf8"), original);
      const forced = await mcpInstallCommand(keyed(), write({ force: true }));
      assert.equal(forced.action, "replaced");
      assert.equal(JSON.parse(await readFile(path, "utf8")).mcpServers["acme-search"].url, "https://mcp.acme.dev/mcp");
    });

    it("leaves a file that is not plain JSON, a link, or oddly shaped alone", async () => {
      const path = join(dir, ".mcp.json");
      for (const body of ['{ // comment\n "mcpServers": {} }', "[]", '{"mcpServers": []}', "not json"]) {
        await writeFile(path, body);
        await assert.rejects(mcpInstallCommand(keyed(), write()), McpInspectError);
        assert.equal(await readFile(path, "utf8"), body);
      }
      await rm(path);
      await writeFile(join(dir, "real.json"), "{}");
      await symlink(join(dir, "real.json"), path);
      await assert.rejects(mcpInstallCommand(keyed(), write()), /symbolic link/u);
      assert.equal(await readFile(join(dir, "real.json"), "utf8"), "{}");
    });

    it("leaves no temporary file behind", async () => {
      await mcpInstallCommand(keyed(), write());
      assert.deepEqual(await readdir(dir), [".mcp.json"]);
    });

    it("writes Cursor's file in its own directory with its own syntax", async () => {
      const result = await mcpInstallCommand(keyed(), write({ client: "cursor" }));
      assert.equal(result.action, "created");
      const file = JSON.parse(await readFile(join(dir, ".cursor", "mcp.json"), "utf8"));
      assert.deepEqual(file.mcpServers["acme-search"].headers, { "X-Acme-Key": "${env:ACME_KEY}" });
    });

    it("insists on a variable for a keyed server, and on a client with a file", async () => {
      await assert.rejects(mcpInstallCommand(keyed(), write({ keyEnv: undefined })), /--key-env/u);
      await assert.rejects(mcpInstallCommand(keyed(), write({ client: "generic", keyEnv: undefined })), /--client claude-code or cursor/u);
      await assert.rejects(mcpInstallCommand(keyed(), input({ force: true })), /--write/u);
      assert.deepEqual(await readdir(dir), []);
    });
  });
});

// --- mcp test ---------------------------------------------------------------

type Seen = { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string };

function startMcpServer(options: {
  key?: string;
  redirectTo?: string;
  tools?: unknown[];
  headerName?: string;
} = {}) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
      if (options.redirectTo) {
        res.writeHead(307, { location: options.redirectTo });
        res.end();
        return;
      }
      const name = (options.headerName ?? "x-acme-key").toLowerCase();
      if (options.key !== undefined && req.headers[name] !== options.key) {
        res.writeHead(401);
        res.end(`bad key ${String(req.headers[name] ?? "")}`);
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      const message = JSON.parse(body) as { id?: number; method: string };
      if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      const result =
        message.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "acme", version: "9" } }
          : {
              tools: options.tools ?? [
                { name: "search", description: "Find\u001b[31m things\u001b[0m", inputSchema: { type: "object" } },
              ],
            };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  return new Promise<{ server: Server; url: string; seen: Seen[] }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen }),
    ),
  );
}

describe("mcp test", () => {
  const SECRET = "sk_test_0123456789abcdef";
  let mcp: Awaited<ReturnType<typeof startMcpServer>>;
  let evil: Awaited<ReturnType<typeof startMcpServer>> | undefined;
  let out: string[];
  let notices: string[];

  before(() => {
    out = [];
    notices = [];
  });
  beforeEach(() => {
    out = [];
    notices = [];
  });
  afterEach(async () => {
    mcp?.server.close();
    evil?.server.close();
    evil = undefined;
  });

  /** A registry on the loopback, so the pinned loopback endpoint is allowed. */
  function context(manifest: Manifest, overrides: Partial<McpTestContext> = {}): McpTestContext {
    const registry = "http://127.0.0.1:9";
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      assert.match(url.pathname, /^\/v1\/mcp\/com\.acme%2Fsearch\/manifest$/u);
      return new Response(JSON.stringify({ item: {}, version: {}, manifest }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return {
      client: createRegistryClient(registry, fetchImpl),
      registry,
      out: (line) => out.push(line),
      notice: (line) => notices.push(line),
      version: "0.0.0-test",
      yes: true,
      stdinIsTty: false,
      ...overrides,
    };
  }
  const input = (extra: Partial<Parameters<typeof mcpTestCommand>[1]> = {}) => ({
    identifier: "com.acme/search",
    keyStdin: false,
    oauth: false,
    json: false,
    ...extra,
  });

  it("lists the tools of an open server, as the server's own text with controls removed", async () => {
    mcp = await startMcpServer();
    const result = await mcpTestCommand(context(manifestOf({ endpointUrl: mcp.url })), input());
    assert.deepEqual(result.tools.map((tool) => tool.name), ["search"]);
    assert.match(out[0]!, /^search — Find .*things/u);
    assert.ok(!out.join("\n").includes("\u001b"));
    assert.match(out.at(-1)!, /1 tool/u);
    // initialize, initialized, tools/list, then the session close (none here).
    assert.deepEqual(
      mcp.seen.map((entry) => (entry.body ? (JSON.parse(entry.body) as { method: string }).method : entry.method)),
      ["initialize", "notifications/initialized", "tools/list"],
    );
  });

  it("prints JSON when asked", async () => {
    mcp = await startMcpServer();
    await mcpTestCommand(context(manifestOf({ endpointUrl: mcp.url })), input({ json: true }));
    const parsed = JSON.parse(out.join("\n"));
    assert.equal(parsed.identifier, "com.acme/search");
    assert.equal(parsed.endpoint, new URL(mcp.url).origin);
    assert.deepEqual(parsed.serverInfo, { name: "acme", version: "9" });
  });

  it("sends a piped key in the manifest's header, to the pinned origin only, and never prints it", async () => {
    mcp = await startMcpServer({ key: SECRET });
    const ctx = context(manifestOf({ endpointUrl: mcp.url, auth: KEY_AUTH }), {
      readStdin: async () => `${SECRET}\n`,
    });
    await mcpTestCommand(ctx, input({ keyStdin: true }));
    assert.ok(mcp.seen.length > 0);
    assert.ok(mcp.seen.every((entry) => entry.headers["x-acme-key"] === SECRET));
    assert.ok(!out.join("\n").includes(SECRET));
    assert.ok(!notices.join("\n").includes(SECRET));
  });

  it("uses the bearer scheme for a bearer server", async () => {
    mcp = await startMcpServer({ key: `Bearer ${SECRET}`, headerName: "authorization" });
    const ctx = context(
      manifestOf({ endpointUrl: mcp.url, auth: { type: "bearer", required: true, allowedHeaderNames: [] } }),
      { readStdin: async () => SECRET },
    );
    await mcpTestCommand(ctx, input({ keyStdin: true }));
    assert.equal(mcp.seen[0]!.headers.authorization, `Bearer ${SECRET}`);
  });

  it("redacts the key from what a server echoes back", async () => {
    mcp = await startMcpServer({ key: "different-key-value" });
    const ctx = context(manifestOf({ endpointUrl: mcp.url, auth: KEY_AUTH }), {
      readStdin: async () => SECRET,
    });
    await assert.rejects(mcpTestCommand(ctx, input({ keyStdin: true })), (error: unknown) => {
      assert.ok(error instanceof McpInspectError);
      assert.ok(!error.message.includes(SECRET), error.message);
      assert.match(error.message, /refused the key/u);
      return true;
    });
  });

  it("never follows a redirect off the pinned origin with the key", async () => {
    evil = await startMcpServer();
    mcp = await startMcpServer({ redirectTo: evil.url });
    const ctx = context(manifestOf({ endpointUrl: mcp.url, auth: KEY_AUTH }), {
      readStdin: async () => SECRET,
    });
    await assert.rejects(mcpTestCommand(ctx, input({ keyStdin: true })), /redirect|redirected/u);
    assert.deepEqual(evil.seen, []);
  });

  it("asks before sending a key, and stops with no one to ask", async () => {
    mcp = await startMcpServer({ key: SECRET });
    const ctx = context(manifestOf({ endpointUrl: mcp.url, auth: KEY_AUTH }), {
      readStdin: async () => SECRET,
      yes: false,
    });
    if (process.stdin.isTTY) return; // a terminal would prompt; the rule is tested without one
    await assert.rejects(mcpTestCommand(ctx, input({ keyStdin: true })), ConfirmationRequiredError);
    assert.deepEqual(mcp.seen, []);
  });

  it("takes the key from standard input only", async () => {
    mcp = await startMcpServer({ key: SECRET });
    const manifest = manifestOf({ endpointUrl: mcp.url, auth: KEY_AUTH });
    await assert.rejects(mcpTestCommand(context(manifest), input()), /--key-stdin/u);
    await assert.rejects(
      mcpTestCommand(context(manifest, { stdinIsTty: true }), input({ keyStdin: true })),
      /pipe/u,
    );
    await assert.rejects(
      mcpTestCommand(context(manifestOf({ endpointUrl: mcp.url })), input({ keyStdin: true })),
      /takes no key/u,
    );
    assert.deepEqual(mcp.seen, []);
  });

  it("accepts one line of printable ASCII as a key", () => {
    assert.equal(parseKey("abc123\n"), "abc123");
    assert.equal(parseKey("  abc 123  \r\n"), "abc 123");
    for (const bad of ["", "\n", "a\nb", "a\u0000b", "café", "a\tb"]) {
      assert.throws(() => parseKey(bad), UsageError, JSON.stringify(bad));
    }
  });

  it("pins the endpoint: https, no credentials, nothing private", () => {
    const pin = (endpointUrl: string, registry = "https://api.sourceweft.com") =>
      pinEndpoint(manifestOf({ endpointUrl }) as never, registry);
    assert.equal(pin("https://mcp.acme.dev/mcp").origin, "https://mcp.acme.dev");
    for (const bad of [
      "http://mcp.acme.dev/mcp",
      "https://u:p@mcp.acme.dev/mcp",
      "https://mcp.acme.dev/mcp#x",
      "https://10.0.0.5/mcp",
      "https://192.168.1.1/mcp",
      "https://169.254.169.254/latest",
      "https://localhost/mcp",
      "https://intranet/mcp",
      "http://127.0.0.1:8080/mcp",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "nonsense",
    ]) {
      assert.throws(() => pin(bad), McpInspectError, bad);
    }
    // A development registry on this machine may pin a local server.
    assert.equal(pin("http://127.0.0.1:8080/mcp", "http://127.0.0.1:3001").origin, "http://127.0.0.1:8080");
  });

  it("contacts nothing when the catalog's endpoint is private", async () => {
    let calls = 0;
    const ctx = context(manifestOf({ endpointUrl: "https://10.0.0.5/mcp" }), {
      registry: "https://api.sourceweft.com",
      fetchImpl: (async () => {
        calls += 1;
        return new Response("{}");
      }) as typeof fetch,
    });
    await assert.rejects(mcpTestCommand(ctx, input()), /private or local/u);
    assert.equal(calls, 0);
  });

  it("explains servers it cannot test", async () => {
    await assert.rejects(
      mcpTestCommand(context(manifestOf({ transport: "stdio", endpointUrl: undefined })), input()),
      /local process[\s\S]*inspect --stdio/u,
    );
    await assert.rejects(
      mcpTestCommand(context(manifestOf({ transport: "sse" })), input()),
      /Streamable HTTP only/u,
    );
    await assert.rejects(
      mcpTestCommand(
        context(manifestOf({ auth: { type: "oauth", required: true, allowedHeaderNames: [] } })),
        input(),
      ),
      /--oauth/u,
    );
    await assert.rejects(
      mcpTestCommand(context(manifestOf()), input({ oauth: true })),
      /does not sign in with OAuth/u,
    );
    await assert.rejects(
      mcpTestCommand(
        context(
          manifestOf({ auth: { type: "custom_headers", required: true, allowedHeaderNames: ["A", "B"] } }),
          { readStdin: async () => "k" },
        ),
        input({ keyStdin: true }),
      ),
      /several different headers/u,
    );
    await assert.rejects(mcpTestCommand(context(manifestOf()), input({ keyStdin: true, oauth: true })), UsageError);
  });

  describe("--oauth", () => {
    let fake: FakeOAuthMcp | undefined;
    let dir: string;
    before(async () => {
      dir = await mkdtemp(join(tmpdir(), "sw-mcp-test-oauth-"));
      await mkdir(join(dir, "store"), { recursive: true });
    });
    after(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    afterEach(async () => {
      await fake?.close();
      fake = undefined;
    });

    it("signs in through the existing flow and lists the tools", async () => {
      fake = await startFakeOAuthMcp();
      const launches: string[] = [];
      const ctx = context(
        manifestOf({ endpointUrl: fake.url, auth: { type: "oauth", required: true, allowedHeaderNames: [] } }),
        {
          oauthStore: createFileStore(join(dir, "store")),
          launchBrowser: async (url) => {
            launches.push(url);
            await browserApproves(url);
            return true;
          },
          oauthTimeoutMs: 10_000,
        },
      );
      const result = await mcpTestCommand(ctx, input({ oauth: true }));
      assert.equal(launches.length, 1);
      assert.ok(result.tools.length > 0);
      assert.ok(!out.join("\n").includes("access_token"));
    });

    it("asks before opening a sign-in, and stops with no one to ask", async () => {
      if (process.stdin.isTTY) return;
      fake = await startFakeOAuthMcp();
      const ctx = context(
        manifestOf({ endpointUrl: fake.url, auth: { type: "oauth", required: true, allowedHeaderNames: [] } }),
        { yes: false, oauthStore: createFileStore(join(dir, "store")) },
      );
      await assert.rejects(mcpTestCommand(ctx, input({ oauth: true })), ConfirmationRequiredError);
      assert.deepEqual(fake.requests, []);
    });
  });
});
