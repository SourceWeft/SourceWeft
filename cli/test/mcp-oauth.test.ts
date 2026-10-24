import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import {
  mcpInspectCommand,
  mcpOAuthLogoutCommand,
  type McpInspectContext,
  type McpInspectInput,
} from "../src/commands/mcp";
import { McpInspectError, UsageError } from "../src/errors";
import { browserCommand, openBrowser } from "../src/mcp/oauth/browser";
import { createCredentialedFetch, createOpenFetch } from "../src/mcp/oauth/guard";
import { startLoopbackListener } from "../src/mcp/oauth/loopback";
import { redactSecrets } from "../src/mcp/oauth/redact";
import {
  createFileStore,
  defaultConfigDirectory,
  resourceKey,
} from "../src/mcp/oauth/store";
import {
  browserApproves,
  startFakeOAuthMcp,
  type FakeOAuthMcp,
} from "./fixtures/fake-oauth-mcp";

describe("browser launch arguments", () => {
  const url =
    "https://auth.example.com/authorize?response_type=code&client_id=a b&state=x%26y&redirect_uri=http%3A%2F%2F127.0.0.1%3A5%2Fcallback";
  const href = new URL(url).href;

  it("passes the URL as one argument to open on macOS", () => {
    assert.deepEqual(browserCommand(url, "darwin"), {
      file: "open",
      args: [href],
    });
  });

  it("uses rundll32 on Windows so no shell sees the URL's ampersands", () => {
    assert.deepEqual(browserCommand(url, "win32"), {
      file: "rundll32",
      args: ["url.dll,FileProtocolHandler", href],
    });
    assert.ok(!href.includes(" "));
    assert.ok(href.includes("&"));
  });

  it("uses xdg-open on Linux with a display, and nothing without one or over SSH", () => {
    assert.deepEqual(browserCommand(url, "linux", { DISPLAY: ":0" }), {
      file: "xdg-open",
      args: [href],
    });
    assert.deepEqual(browserCommand(url, "linux", { WAYLAND_DISPLAY: "w0" }), {
      file: "xdg-open",
      args: [href],
    });
    assert.equal(browserCommand(url, "linux", {}), null);
    assert.equal(
      browserCommand(url, "linux", { DISPLAY: ":0", SSH_CONNECTION: "1 2 3 4" }),
      null,
    );
  });

  it("starts nothing and says so when there is no browser to start", async () => {
    assert.equal(
      await openBrowser("https://auth.example.com/authorize", {
        platform: "linux",
        env: {},
      }),
      false,
    );
    assert.equal(await openBrowser("file:///etc/passwd"), false);
  });

  it("refuses anything but http(s), so a URL cannot name a program or file", () => {
    for (const bad of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "calc.exe",
      "-a Calculator",
      "",
    ]) {
      assert.equal(browserCommand(bad, "darwin"), null, bad);
      assert.equal(browserCommand(bad, "win32"), null, bad);
    }
  });
});

describe("redacting secrets", () => {
  it("removes known values and values that merely look like credentials", () => {
    const text = redactSecrets(
      'Bearer abc.def-ghi failed; access_token=tok123456&x=1; {"refresh_token":"rt-secret-1"}; custom-secret-value',
      ["custom-secret-value"],
    );
    for (const leaked of ["abc.def-ghi", "tok123456", "rt-secret-1", "custom-secret-value"]) {
      assert.ok(!text.includes(leaked), leaked);
    }
    assert.match(text, /x=1/u);
  });

  it("leaves very short secrets alone rather than shredding the message", () => {
    assert.equal(redactSecrets("a b c", ["a"]), "a b c");
  });
});

describe("credentialed fetch", () => {
  const ok = () => new Response("ok");

  it("sends nothing to an origin it was not made for", async () => {
    let calls = 0;
    const guarded = createCredentialedFetch(["https://mcp.example.com"], async () => {
      calls += 1;
      return ok();
    });
    await assert.rejects(
      guarded("https://evil.example.net/mcp", { headers: { authorization: "Bearer x" } }),
      /Refusing to send credentials to https:\/\/evil\.example\.net/u,
    );
    assert.equal(calls, 0);
    await guarded("https://mcp.example.com/mcp");
    assert.equal(calls, 1);
  });

  it("stops at a redirect to another origin without following it", async () => {
    const seen: string[] = [];
    const guarded = createCredentialedFetch(
      ["https://mcp.example.com"],
      async (input) => {
        seen.push(String(input));
        return new Response(null, {
          status: 307,
          headers: { location: "https://evil.example.net/steal" },
        });
      },
    );
    await assert.rejects(
      guarded("https://mcp.example.com/mcp", { method: "POST", body: "{}" }),
      /redirected to https:\/\/evil\.example\.net/u,
    );
    assert.deepEqual(seen, ["https://mcp.example.com/mcp"]);
  });

  it("follows a 307 on the same origin a few times and no 302", async () => {
    let hops = 0;
    const same = createCredentialedFetch(["https://a.example"], async (input) => {
      hops += 1;
      return hops < 3
        ? new Response(null, { status: 307, headers: { location: "/next" } })
        : new Response(String(input));
    });
    assert.equal(await (await same("https://a.example/start")).text(), "https://a.example/next");

    const endless = createCredentialedFetch(["https://a.example"], async () =>
      new Response(null, { status: 307, headers: { location: "/loop" } }),
    );
    await assert.rejects(endless("https://a.example/start"), /redirect/u);

    const found = createCredentialedFetch(["https://a.example"], async () =>
      new Response(null, { status: 302, headers: { location: "/elsewhere" } }),
    );
    await assert.rejects(found("https://a.example/start"), /not redirected/u);
  });

  it("refuses plain http except on the machine itself", async () => {
    const guarded = createCredentialedFetch(["http://mcp.example.com"], async () => ok());
    await assert.rejects(guarded("http://mcp.example.com/mcp"), /Refusing/u);
    const open = createOpenFetch(async () => ok());
    await assert.rejects(open("http://auth.example.com/.well-known/x"), /https/u);
  });
});

describe("loopback listener", () => {
  let listener: Awaited<ReturnType<typeof startLoopbackListener>> | undefined;
  afterEach(async () => {
    await listener?.close();
    listener = undefined;
  });

  it("answers only the callback path, only under the literal loopback host", async () => {
    listener = await startLoopbackListener({ expectedState: "s1" });
    assert.match(listener.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/u);
    const base = listener.redirectUri.replace("/callback", "");
    assert.equal((await fetch(`${base}/other`)).status, 404);
    assert.equal((await fetch(`${base}/callback`, { method: "POST" })).status, 404);
    // A page that rebinds a DNS name to this port arrives with its own Host.
    const rebinding = await new Promise<number>((resolve, reject) => {
      const { port } = new URL(base);
      import("node:http").then(({ request }) => {
        const req = request(
          { host: "127.0.0.1", port, path: "/callback?code=c&state=s1", headers: { host: "evil.example:80" } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      }, reject);
    });
    assert.equal(rebinding, 400);
    const good = await fetch(`${listener.redirectUri}?code=the-code&state=s1`);
    assert.equal(good.status, 200);
    assert.deepEqual(await listener.result, { code: "the-code" });
  });

  it("rejects a different state and an issuer that is not the one used", async () => {
    listener = await startLoopbackListener({ expectedState: "good" });
    const wrong = await fetch(`${listener.redirectUri}?code=c&state=bad`);
    assert.equal(wrong.status, 400);
    await assert.rejects(listener.result, /different state/u);
    await listener.close();

    listener = await startLoopbackListener({
      expectedState: "good",
      issuer: "https://as.example.com",
    });
    await fetch(`${listener.redirectUri}?code=c&state=good&iss=https%3A%2F%2Fother.example`);
    await assert.rejects(listener.result, /different authorization server/u);
  });

  it("reports a denial and an error callback with the server's description", async () => {
    listener = await startLoopbackListener({ expectedState: "s" });
    await fetch(`${listener.redirectUri}?error=access_denied&error_description=No%0Away&state=s`);
    await assert.rejects(listener.result, /Access was denied in the browser \(No way\)/u);
    await listener.close();

    listener = await startLoopbackListener({ expectedState: "s" });
    await fetch(`${listener.redirectUri}?error=server_error&state=s`);
    await assert.rejects(listener.result, /refused the sign-in: server_error/u);
  });

  it("times out with a clear message and frees the port", async () => {
    listener = await startLoopbackListener({ expectedState: "s", timeoutMs: 50 });
    const uri = listener.redirectUri;
    await assert.rejects(listener.result, /No sign-in arrived within 1 second/u);
    await listener.close();
    await assert.rejects(fetch(uri));
  });

  it("stops waiting when it is aborted", async () => {
    const controller = new AbortController();
    listener = await startLoopbackListener({
      expectedState: "s",
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(listener.result, /cancelled/u);
  });

  it("says plainly when its port is taken", async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    try {
      const port = (holder.address() as AddressInfo).port;
      await assert.rejects(
        startLoopbackListener({ expectedState: "s", hosts: ["127.0.0.1"], port }),
        (error: unknown) =>
          error instanceof McpInspectError && /already in use/u.test(error.message),
      );
    } finally {
      holder.close();
    }
  });

  it("moves on to the next loopback address when the first does not exist here", async () => {
    // 203.0.113.0/24 is documentation space: no interface owns it.
    listener = await startLoopbackListener({
      expectedState: "s",
      hosts: ["203.0.113.7", "127.0.0.1"],
    });
    assert.match(listener.redirectUri, /^http:\/\/127\.0\.0\.1:/u);
  });

  it("fails clearly when no loopback address can be bound", async () => {
    await assert.rejects(
      startLoopbackListener({ expectedState: "s", hosts: ["203.0.113.7"] }),
      /Could not open the sign-in callback/u,
    );
  });
});

describe("token store", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "sw-oauth-store-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps one private file per endpoint and issuer, and forgets by endpoint", async () => {
    const store = createFileStore(join(dir, "state"));
    const base = {
      version: 1 as const,
      client: { client_id: "c1" },
      tokens: { access_token: "a-secret", token_type: "Bearer" },
    };
    await store.save({ ...base, resource: "https://a.example/mcp", issuer: "https://as1" });
    await store.save({ ...base, resource: "https://a.example/mcp", issuer: "https://as2" });
    await store.save({ ...base, resource: "https://b.example/mcp", issuer: "https://as1" });
    assert.equal((await store.load("https://a.example/mcp", "https://as1"))?.client.client_id, "c1");
    assert.equal(await store.load("https://a.example/mcp", "https://as3"), undefined);
    assert.equal((await readdir(join(dir, "state"))).length, 3);
    if (process.platform !== "win32") {
      assert.equal((await stat(join(dir, "state"))).mode & 0o777, 0o700);
      for (const name of await readdir(join(dir, "state"))) {
        assert.equal((await stat(join(dir, "state", name))).mode & 0o777, 0o600, name);
      }
    }
    assert.equal(await store.deleteResource("https://a.example/mcp"), 2);
    assert.equal(await store.deleteResource("https://a.example/mcp"), 0);
    assert.equal((await readdir(join(dir, "state"))).length, 1);
  });

  it("ignores a file that is not a record", async () => {
    const store = createFileStore(join(dir, "other"));
    await store.save({
      version: 1,
      resource: "https://a.example/mcp",
      issuer: "https://as",
      client: { client_id: "c" },
    });
    const [name] = await readdir(join(dir, "other"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "other", name!), "{ not json");
    assert.equal(await store.load("https://a.example/mcp", "https://as"), undefined);
    assert.equal(await store.deleteResource("https://a.example/mcp"), 0);
  });

  it("keys an endpoint without its query, fragment, userinfo or trailing slash", () => {
    assert.equal(
      resourceKey("https://u:p@mcp.example.com/v1/mcp/?key=abc#frag"),
      "https://mcp.example.com/v1/mcp",
    );
  });

  it("finds the config directory per platform", () => {
    assert.equal(defaultConfigDirectory("linux", {}, "/home/u"), join("/home/u", ".config", "sourceweft"));
    assert.equal(
      defaultConfigDirectory("darwin", { XDG_CONFIG_HOME: "/x" }, "/Users/u"),
      join("/x", "sourceweft"),
    );
    assert.equal(
      defaultConfigDirectory("win32", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "C:\\Users\\u"),
      join("C:\\Users\\u\\AppData\\Roaming", "sourceweft"),
    );
  });
});

describe("mcp inspect --oauth", () => {
  let dir: string;
  let fake: FakeOAuthMcp | undefined;
  let notices: string[];
  let launches: string[];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "sw-mcp-oauth-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    notices = [];
    launches = [];
    // A fresh store directory per test.
    await rm(join(dir, "store"), { recursive: true, force: true });
  });
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  const store = () => createFileStore(join(dir, "store"));
  const context = (
    overrides: Partial<McpInspectContext> = {},
  ): McpInspectContext => ({
    out: () => {},
    version: "0.0.0-test",
    cwd: dir,
    notice: (line) => notices.push(line),
    oauthStore: store(),
    launchBrowser: async (url) => {
      launches.push(url);
      await browserApproves(url);
      return true;
    },
    oauthTimeoutMs: 10_000,
    ...overrides,
  });
  const input = (url: string, extra: Partial<McpInspectInput> = {}): McpInspectInput => ({
    url,
    oauth: true,
    out: "oauth-tools.json",
    force: true,
    json: false,
    ...extra,
  });
  const storedText = async () => {
    const names = await readdir(join(dir, "store"));
    return Promise.all(names.map((name) => readFile(join(dir, "store", name), "utf8")));
  };

  it("registers, signs in with PKCE and writes the same file --header would", async () => {
    fake = await startFakeOAuthMcp();
    const file = await mcpInspectCommand(
      context(),
      input(fake.url, { clientName: "Pilot Sync" }),
    );

    assert.deepEqual(file.tools.map((tool) => tool.name), ["search_docs", "create_page"]);
    assert.deepEqual(file.target, { kind: "url", url: fake.origin });
    assert.deepEqual(file.serverInfo, { name: "fake-oauth-mcp", version: "9.9.9" });

    // Dynamic registration: a public client with the loopback redirect.
    assert.equal(fake.registrations.length, 1);
    const registration = fake.registrations[0]!;
    assert.equal(registration.client_name, "Pilot Sync");
    assert.equal(registration.token_endpoint_auth_method, "none");
    const redirect = (registration.redirect_uris as string[])[0]!;
    assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/callback$/u);

    // The authorization request: PKCE S256, fresh state, the resource.
    const query = fake.authorizeQueries[0]!;
    assert.equal(query.get("code_challenge_method"), "S256");
    assert.ok((query.get("code_challenge") ?? "").length >= 43);
    assert.ok((query.get("state") ?? "").length >= 32);
    assert.equal(query.get("redirect_uri"), redirect);
    assert.equal(query.get("resource"), `${fake.origin}/mcp`);
    const exchange = fake.tokenRequests[0]!;
    assert.equal(exchange.get("grant_type"), "authorization_code");
    assert.ok((exchange.get("code_verifier") ?? "").length >= 43);

    // The bearer token reached the endpoint and nothing secret reached the file.
    const bearer = fake.requests.find((r) => r.path === "/mcp" && r.authorization);
    assert.match(bearer?.authorization ?? "", /^Bearer at-/u);
    const text = await readFile(join(dir, "oauth-tools.json"), "utf8");
    for (const secret of [...fake.validTokens, ...fake.validRefreshTokens, "Bearer"]) {
      assert.ok(!text.includes(secret), secret);
    }
    assert.ok(!text.includes("/mcp\""));
    assert.ok(notices.some((line) => line.includes("Opened your browser")));
  });

  it("uses a fresh state and client on every sign-in", async () => {
    fake = await startFakeOAuthMcp();
    await mcpInspectCommand(context(), input(fake.url));
    // Signing out makes the next run a new sign-in.
    await mcpOAuthLogoutCommand({ out: () => {}, oauthStore: store() }, { url: fake.url });
    await mcpInspectCommand(context(), input(fake.url));
    assert.equal(fake.authorizeQueries.length, 2);
    assert.notEqual(
      fake.authorizeQueries[0]!.get("state"),
      fake.authorizeQueries[1]!.get("state"),
    );
    assert.equal(fake.registrations.length, 2);
  });

  it("reuses the stored token without the browser, then removes it on logout", async () => {
    fake = await startFakeOAuthMcp();
    await mcpInspectCommand(context(), input(fake.url));
    assert.equal(launches.length, 1);
    const registrations = fake.registrations.length;

    await mcpInspectCommand(context(), input(fake.url));
    assert.equal(launches.length, 1, "no second browser");
    assert.equal(fake.registrations.length, registrations);
    assert.equal(fake.tokenRequests.length, 1);

    const lines: string[] = [];
    const removed = await mcpOAuthLogoutCommand(
      { out: (line) => lines.push(line), oauthStore: store() },
      { url: `${fake.url}?ignored=1` },
    );
    assert.equal(removed, 1);
    assert.match(lines[0]!, /Removed the stored sign-in/u);
    assert.deepEqual(await readdir(join(dir, "store")), []);
    const again: string[] = [];
    await mcpOAuthLogoutCommand({ out: (line) => again.push(line), oauthStore: store() }, { url: fake.url });
    assert.match(again[0]!, /No stored sign-in/u);

    await mcpInspectCommand(context(), input(fake.url));
    assert.equal(launches.length, 2);
  });

  it("refreshes an expired token instead of opening the browser", async () => {
    fake = await startFakeOAuthMcp({ expiresIn: 1 });
    await mcpInspectCommand(context(), input(fake.url));
    await mcpInspectCommand(context(), input(fake.url));
    assert.equal(launches.length, 1);
    const grants = fake.tokenRequests.map((request) => request.get("grant_type"));
    assert.deepEqual(grants, ["authorization_code", "refresh_token"]);
    // The refreshed token replaced the stored one.
    const [record] = (await storedText()).map((text) => JSON.parse(text) as { tokens: { access_token: string } });
    assert.ok(fake.validTokens.has(record!.tokens.access_token));
  });

  it("renews a token the server revoked, and signs in again when the refresh token is gone too", async () => {
    fake = await startFakeOAuthMcp();
    await mcpInspectCommand(context(), input(fake.url));
    fake.validTokens.clear();
    await mcpInspectCommand(context(), input(fake.url));
    assert.equal(launches.length, 1, "refresh was enough");
    assert.ok(notices.some((line) => line.includes("renewing")));

    fake.validTokens.clear();
    fake.validRefreshTokens.clear();
    await mcpInspectCommand(context(), input(fake.url));
    assert.equal(launches.length, 2, "the browser was needed");
  });

  it("stops on a state mismatch and frees the callback port", async () => {
    fake = await startFakeOAuthMcp({ consent: "wrong-state" });
    await assert.rejects(
      mcpInspectCommand(context(), input(fake.url)),
      /different state/u,
    );
    const redirect = (fake.registrations[0]!.redirect_uris as string[])[0]!;
    await assert.rejects(fetch(redirect));
    assert.deepEqual(await readdir(join(dir, "store")).catch(() => []), []);
  });

  it("reports a denied consent", async () => {
    fake = await startFakeOAuthMcp({ consent: "deny" });
    await assert.rejects(
      mcpInspectCommand(context(), input(fake.url)),
      /Access was denied in the browser \(The user said no\)/u,
    );
  });

  it("times out when nobody approves, naming the wait", async () => {
    fake = await startFakeOAuthMcp();
    await assert.rejects(
      mcpInspectCommand(
        context({ launchBrowser: async () => true, oauthTimeoutMs: 100 }),
        input(fake.url),
      ),
      /No sign-in arrived within 1 second/u,
    );
  });

  it("prints the URL and the same-machine limit when no browser can be started", async () => {
    fake = await startFakeOAuthMcp();
    await mcpInspectCommand(
      context({
        launchBrowser: async (url) => {
          launches.push(url);
          // The person copies the URL into a browser on this machine.
          await browserApproves(url);
          return false;
        },
      }),
      input(fake.url),
    );
    const message = notices.find((line) => line.includes("Could not open a browser"));
    assert.ok(message);
    assert.ok(message.includes(launches[0]!));
    assert.match(message, /only when the browser runs here/u);
    assert.match(message, /another machine/u);
    assert.ok(!/poll|device code/iu.test(message));
  });

  it("fails clearly when the vendor has no dynamic client registration", async () => {
    fake = await startFakeOAuthMcp({ registration: false });
    await assert.rejects(
      mcpInspectCommand(context(), input(fake.url)),
      /does not offer dynamic client registration.*no preregistered client/su,
    );
    assert.equal(launches.length, 0);
  });

  it("does not echo secrets the authorization server repeats in an error", async () => {
    fake = await startFakeOAuthMcp({
      tokenError: (code) =>
        JSON.stringify({
          error: "server_error",
          error_description: `could not use code=${code} Bearer abcdef.ghijkl`,
        }),
    });
    await assert.rejects(
      mcpInspectCommand(context(), input(fake.url)),
      (error: unknown) => {
        assert.ok(error instanceof McpInspectError);
        const code = fake!.authorizeQueries.length
          ? fake!.tokenRequests[0]?.get("code") ?? ""
          : "";
        assert.ok(code.length > 0);
        assert.ok(!error.message.includes(code), error.message);
        assert.ok(!error.message.includes("abcdef.ghijkl"), error.message);
        return true;
      },
    );
  });

  it("never sends the token to another origin when the endpoint redirects", async () => {
    const attacker: string[] = [];
    const evil = createServer((req, res) => {
      attacker.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`);
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((resolve) => evil.listen(0, "127.0.0.1", resolve));
    try {
      const evilUrl = `http://127.0.0.1:${(evil.address() as AddressInfo).port}/steal`;
      fake = await startFakeOAuthMcp({ redirectMcpTo: evilUrl });
      await assert.rejects(
        mcpInspectCommand(context(), input(fake.url)),
        /redirected to/u,
      );
      assert.deepEqual(attacker, []);
    } finally {
      evil.close();
    }
  });

  it("keeps --header and --oauth apart, and --oauth to --url", async () => {
    for (const bad of [
      { url: "https://x.example/mcp", oauth: true, headers: ["A: b"] },
      { stdio: "node s.js", oauth: true },
      { url: "https://x.example/mcp", clientName: "n" },
      { url: "https://x.example/mcp", oauth: true, clientName: "  " },
    ]) {
      await assert.rejects(
        mcpInspectCommand(context(), { force: true, json: false, ...bad }),
        UsageError,
        JSON.stringify(bad),
      );
    }
  });

  it("keeps the stored files private and token-free in output", async () => {
    fake = await startFakeOAuthMcp();
    const lines: string[] = [];
    await mcpInspectCommand(
      context({ out: (line) => lines.push(line) }),
      input(fake.url, { json: true }),
    );
    const printed = [...lines, ...notices].join("\n");
    for (const secret of [...fake.validTokens, ...fake.validRefreshTokens]) {
      assert.ok(!printed.includes(secret));
    }
    const [stored] = await storedText();
    assert.ok([...fake.validTokens].some((token) => stored!.includes(token)));
    if (process.platform !== "win32") {
      assert.equal((await stat(join(dir, "store"))).mode & 0o777, 0o700);
    }
  });
});
