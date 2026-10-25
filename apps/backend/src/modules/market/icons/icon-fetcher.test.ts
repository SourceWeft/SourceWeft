import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import {
  createIconFetcher,
  ICON_FETCH_LIMITS,
  ICON_USER_AGENT,
  IconFetchError,
  type IconTransport,
} from "./icon-fetcher";
import { replayable } from "./test-support";

type Answer = Response | (() => Response) | Error;

/** A transport answering by URL and recording every request it receives. */
function fakeTransport(answers: Record<string, Answer>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const replays = new Map<string, () => Promise<Response>>();
  const transport: IconTransport = async (url, init) => {
    calls.push({ url: url.toString(), headers: { ...init.headers } });
    const answer = answers[url.toString()];
    if (!answer) return new Response("not found", { status: 404 });
    if (answer instanceof Error) throw answer;
    if (typeof answer === "function") return answer();
    let replay = replays.get(url.toString());
    if (!replay) {
      replay = replayable(answer);
      replays.set(url.toString(), replay);
    }
    return replay();
  };
  return { transport, calls };
}

const redirect = (to: string, status = 302) =>
  new Response(null, { status, headers: { location: to } });
const ok = (body: string | Uint8Array, headers: Record<string, string> = {}) =>
  new Response(body as BodyInit, { status: 200, headers });

const approved = (...hosts: string[]) => ({ approvedHosts: new Set(hosts) });

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});
function fetcherFor(
  answers: Record<string, Answer>,
  options: { resourceTimeoutMs?: number } = {},
) {
  const { transport, calls } = fakeTransport(answers);
  const fetcher = createIconFetcher({ transport, ...options });
  closers.push(() => fetcher.close());
  return { fetcher, calls };
}

describe("request shape", () => {
  test("sends only the fixed user agent and accept headers, on every hop", async () => {
    const { fetcher, calls } = fetcherFor({
      "https://example.com/": redirect("https://www.example.com/"),
      "https://www.example.com/": ok("<html>", { "set-cookie": "sid=abc; Path=/" }),
    });
    await fetcher.fetch("https://example.com/", "html", approved("example.com"));
    expect(calls.map((c) => c.url)).toEqual([
      "https://example.com/",
      "https://www.example.com/",
    ]);
    for (const call of calls) {
      expect(Object.keys(call.headers).sort()).toEqual(["accept", "user-agent"]);
      expect(call.headers["user-agent"]).toBe(ICON_USER_AGENT);
    }
  });

  test("a Set-Cookie answer is never replayed on the next request", async () => {
    const { fetcher, calls } = fetcherFor({
      "https://example.com/a": ok("a", { "set-cookie": "sid=abc" }),
      "https://example.com/b": ok("b"),
    });
    await fetcher.fetch("https://example.com/a", "html", approved("example.com"));
    await fetcher.fetch("https://example.com/b", "html", approved("example.com"));
    expect(calls[1]!.headers).not.toHaveProperty("cookie");
    expect(calls[1]!.headers).not.toHaveProperty("authorization");
  });

  test("refuses embedded credentials, other schemes and other ports", async () => {
    const { fetcher } = fetcherFor({});
    for (const url of [
      "https://user:pass@example.com/",
      "http://example.com/",
      "https://example.com:8443/",
      "ftp://example.com/",
    ]) {
      await expect(
        fetcher.fetch(url, "html", approved("example.com")),
      ).rejects.toMatchObject({ code: "scheme" });
    }
  });

  test("refuses a host the caller did not approve", async () => {
    const { fetcher, calls } = fetcherFor({});
    await expect(
      fetcher.fetch("https://other.example/", "html", approved("example.com")),
    ).rejects.toMatchObject({ code: "host-not-approved" });
    expect(calls).toEqual([]);
  });

  test("refuses IP literals and local names before any request", async () => {
    const { fetcher, calls } = fetcherFor({});
    for (const host of ["127.0.0.1", "10.1.2.3", "[::1]", "localhost", "printer.local"]) {
      await expect(
        fetcher.fetch(`https://${host}/`, "html", approved(host.replace(/^\[|\]$/g, ""))),
      ).rejects.toMatchObject({ code: "private-address" });
    }
    expect(calls).toEqual([]);
  });
});

describe("redirects", () => {
  test("follows the same origin and the www twin, at most three hops", async () => {
    const { fetcher } = fetcherFor({
      "https://example.com/a": redirect("/b"),
      "https://example.com/b": redirect("https://www.example.com/c"),
      "https://www.example.com/c": redirect("https://example.com/d"),
      "https://example.com/d": ok("done"),
    });
    const response = await fetcher.fetch(
      "https://example.com/a",
      "html",
      approved("example.com"),
    );
    expect(response.body.toString()).toBe("done");
    expect(response.url).toBe("https://example.com/d");
  });

  test("a fourth redirect is refused", async () => {
    const { fetcher } = fetcherFor({
      "https://example.com/1": redirect("/2"),
      "https://example.com/2": redirect("/3"),
      "https://example.com/3": redirect("/4"),
      "https://example.com/4": redirect("/5"),
      "https://example.com/5": ok("never"),
    });
    await expect(
      fetcher.fetch("https://example.com/1", "html", approved("example.com")),
    ).rejects.toMatchObject({ code: "redirect-limit" });
  });

  test("a redirect to another registrable domain is refused before it is requested", async () => {
    const { fetcher, calls } = fetcherFor({
      "https://example.com/": redirect("https://evil.test/logo.png"),
    });
    await expect(
      fetcher.fetch("https://example.com/", "html", approved("example.com")),
    ).rejects.toMatchObject({ code: "redirect-not-approved" });
    expect(calls.map((c) => c.url)).toEqual(["https://example.com/"]);
  });

  test("an equal registrable domain alone is not enough", async () => {
    const { fetcher, calls } = fetcherFor({
      "https://example.com/": redirect("https://cdn.example.com/x.png"),
    });
    await expect(
      fetcher.fetch("https://example.com/", "image", approved("example.com")),
    ).rejects.toMatchObject({ code: "redirect-not-approved" });
    expect(calls).toHaveLength(1);
  });

  test("redirects to a named host are allowed (GitHub's avatar CDN)", async () => {
    const { fetcher } = fetcherFor({
      "https://github.com/acme.png?size=128": redirect(
        "https://avatars.githubusercontent.com/u/1?size=128",
      ),
      "https://avatars.githubusercontent.com/u/1?size=128": ok("img"),
    });
    const response = await fetcher.fetch(
      "https://github.com/acme.png?size=128",
      "image",
      {
        approvedHosts: new Set(["github.com"]),
        redirectHosts: new Set(["avatars.githubusercontent.com"]),
      },
    );
    expect(response.body.toString()).toBe("img");
  });

  test("redirects to http, to credentials or to a private address are refused", async () => {
    for (const target of [
      "http://example.com/x",
      "https://u:p@example.com/x",
      "https://example.com:444/x",
    ]) {
      const { fetcher } = fetcherFor({ "https://example.com/": redirect(target) });
      await expect(
        fetcher.fetch("https://example.com/", "html", approved("example.com")),
      ).rejects.toBeInstanceOf(IconFetchError);
    }
    const { fetcher } = fetcherFor({
      "https://example.com/": redirect("https://127.0.0.1/"),
    });
    await expect(
      fetcher.fetch("https://example.com/", "html", {
        approvedHosts: new Set(["example.com"]),
        redirectHosts: new Set(["127.0.0.1"]),
      }),
    ).rejects.toMatchObject({ code: "private-address" });
  });
});

describe("bounds", () => {
  test("a body past the cap is cut off while streaming", async () => {
    const chunk = new Uint8Array(64 * 1024);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const { fetcher } = fetcherFor({
      "https://example.com/big.png": () => new Response(stream),
    });
    await expect(
      fetcher.fetch("https://example.com/big.png", "image", approved("example.com")),
    ).rejects.toMatchObject({ code: "too-large" });
    // 1 MiB cap + the chunk that crossed it: it stopped reading, not drained.
    expect(pulled).toBeLessThanOrEqual(ICON_FETCH_LIMITS.image / chunk.length + 3);
  });

  test("a declared length past the cap is refused without reading", async () => {
    const { fetcher } = fetcherFor({
      "https://example.com/x.png": ok("x", {
        "content-length": String(ICON_FETCH_LIMITS.image + 1),
      }),
    });
    await expect(
      fetcher.fetch("https://example.com/x.png", "image", approved("example.com")),
    ).rejects.toMatchObject({ code: "too-large" });
  });

  test("a page over its cap is read as far as the cap, not refused", async () => {
    const head = "<html><head><title>Big</title></head><body>";
    const body = head + "x".repeat(ICON_FETCH_LIMITS.html * 2);
    const { fetcher } = fetcherFor({ "https://example.com/": ok(body) });
    const response = await fetcher.fetch("https://example.com/", "html", approved("example.com"));
    expect(response.body.length).toBe(ICON_FETCH_LIMITS.html);
    expect(response.body.toString().startsWith(head)).toBe(true);
  });

  test("each kind has its own cap", async () => {
    const body = new Uint8Array(ICON_FETCH_LIMITS.manifest + 1);
    const { fetcher } = fetcherFor({ "https://example.com/m": ok(body) });
    await expect(
      fetcher.fetch("https://example.com/m", "manifest", approved("example.com")),
    ).rejects.toMatchObject({ code: "too-large" });
    await expect(
      fetcher.fetch("https://example.com/m", "image", approved("example.com")),
    ).resolves.toMatchObject({ status: 200 });
  });

  test("a body that never finishes ends at the resource deadline", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      // never closes
    });
    const { fetcher } = fetcherFor(
      { "https://example.com/slow": () => new Response(stream) },
      { resourceTimeoutMs: 60 },
    );
    const started = Date.now();
    await expect(
      fetcher.fetch("https://example.com/slow", "html", approved("example.com")),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("the job signal ends a request too", async () => {
    const controller = new AbortController();
    const { transport } = fakeTransport({
      "https://example.com/slow": () => new Response(new ReadableStream()),
    });
    const fetcher = createIconFetcher({ transport, signal: controller.signal });
    closers.push(() => fetcher.close());
    const pending = fetcher.fetch("https://example.com/slow", "html", approved("example.com"));
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
  });

  test("network errors are classified, not leaked", async () => {
    const { fetcher } = fetcherFor({
      "https://example.com/": new TypeError("fetch failed: secret internals"),
    });
    const error = await fetcher
      .fetch("https://example.com/", "html", approved("example.com"))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "network", message: "Icon fetch failed" });
  });
});

describe("robots.txt", () => {
  const page = (extra: Record<string, Answer>) => ({
    "https://example.com/": ok("<html>"),
    ...extra,
  });

  test("a missing robots.txt (404) allows the fetch", async () => {
    const { fetcher, calls } = fetcherFor(page({}));
    await expect(
      fetcher.checkedFetch("https://example.com/", "html", approved("example.com")),
    ).resolves.toMatchObject({ status: 200 });
    expect(calls[0]!.url).toBe("https://example.com/robots.txt");
  });

  test("a disallow stops the fetch before the page is requested", async () => {
    const { fetcher, calls } = fetcherFor(
      page({ "https://example.com/robots.txt": ok("User-agent: *\nDisallow: /") }),
    );
    await expect(
      fetcher.checkedFetch("https://example.com/", "html", approved("example.com")),
    ).rejects.toMatchObject({ code: "robots-disallowed" });
    expect(calls.map((c) => c.url)).toEqual(["https://example.com/robots.txt"]);
  });

  test("an allow rule for our token wins over a blanket disallow", async () => {
    const { fetcher } = fetcherFor(
      page({
        "https://example.com/robots.txt": ok(
          "User-agent: *\nDisallow: /\n\nUser-agent: SourceWeftIconFetcher\nAllow: /",
        ),
      }),
    );
    await expect(
      fetcher.checkedFetch("https://example.com/", "html", approved("example.com")),
    ).resolves.toMatchObject({ status: 200 });
  });

  test.each([
    ["a 429", () => new Response("slow down", { status: 429 })],
    ["a 503", () => new Response("down", { status: 503 })],
    ["a 403", () => new Response("no", { status: 403 })],
    ["a network failure", new TypeError("boom")],
    ["an oversize file", () => ok(new Uint8Array(ICON_FETCH_LIMITS.robots + 1))],
  ] as Array<[string, Answer]>)("%s defers instead of fetching", async (_label, answer) => {
    const { fetcher, calls } = fetcherFor(
      page({ "https://example.com/robots.txt": answer }),
    );
    await expect(
      fetcher.checkedFetch("https://example.com/", "html", approved("example.com")),
    ).rejects.toMatchObject({ code: "robots-unavailable" });
    expect(calls.map((c) => c.url)).toEqual(["https://example.com/robots.txt"]);
  });

  test("robots.txt is read once per origin", async () => {
    const { fetcher, calls } = fetcherFor(
      page({
        "https://example.com/robots.txt": ok("User-agent: *\nDisallow: /private"),
        "https://example.com/logo.png": ok("img"),
      }),
    );
    await fetcher.checkedFetch("https://example.com/", "html", approved("example.com"));
    await fetcher.checkedFetch("https://example.com/logo.png", "image", approved("example.com"));
    expect(calls.filter((c) => c.url.endsWith("/robots.txt"))).toHaveLength(1);
  });

  test("skipRobots goes straight to the resource", async () => {
    const { fetcher, calls } = fetcherFor(page({}));
    await fetcher.checkedFetch("https://example.com/", "html", {
      approvedHosts: new Set(["example.com"]),
      skipRobots: true,
    });
    expect(calls.map((c) => c.url)).toEqual(["https://example.com/"]);
  });
});

describe("socket-time address validation", () => {
  test("a host that resolves to a private address is refused when the socket opens", async () => {
    // The real transport, a resolver that answers with private addresses.
    const fetcher = createIconFetcher({
      lookup: async () => [{ address: "10.0.0.5", family: 4 }],
      resourceTimeoutMs: 3000,
    });
    closers.push(() => fetcher.close());
    await expect(
      fetcher.fetch("https://rebind.example.com/", "html", approved("rebind.example.com")),
    ).rejects.toMatchObject({ code: "private-address" });
  });

  test("a mixed answer containing one private address is refused", async () => {
    const fetcher = createIconFetcher({
      lookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
      resourceTimeoutMs: 3000,
    });
    closers.push(() => fetcher.close());
    await expect(
      fetcher.fetch("https://mixed.example.com/", "html", approved("mixed.example.com")),
    ).rejects.toMatchObject({ code: "private-address" });
  });
});

describe("compressed bodies (real socket)", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  /** A transport that sends the request to a local plain-HTTP server through real fetch. */
  async function localTransport(body: Buffer, headers: Record<string, string>) {
    server = createServer((_request, response) => {
      response.writeHead(200, headers);
      response.end(body);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const transport: IconTransport = (url, init) =>
      globalThis.fetch(`http://127.0.0.1:${port}${url.pathname}`, {
        headers: init.headers,
        signal: init.signal,
        redirect: "manual",
      });
    return transport;
  }

  test("a gzip bomb is cut off at the decoded cap, not the compressed size", async () => {
    // 64 MiB of zeros compress to well under 100 KiB.
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(200 * 1024);
    const transport = await localTransport(bomb, { "content-encoding": "gzip" });
    const fetcher = createIconFetcher({ transport });
    closers.push(() => fetcher.close());
    const started = Date.now();
    await expect(
      fetcher.fetch("https://example.com/bomb.png", "image", approved("example.com")),
    ).rejects.toMatchObject({ code: "too-large" });
    expect(Date.now() - started).toBeLessThan(4000);
  });

  test("an ordinary compressed body under the cap is decoded and delivered", async () => {
    const transport = await localTransport(gzipSync(Buffer.from("hello icon")), {
      "content-encoding": "gzip",
    });
    const fetcher = createIconFetcher({ transport });
    closers.push(() => fetcher.close());
    const response = await fetcher.fetch("https://example.com/a", "html", approved("example.com"));
    expect(response.body.toString()).toBe("hello icon");
  });
});

describe("address refusals belong to their own request", () => {
  test("a refusal for one host is not blamed on a later request to another", async () => {
    const fetcher = createIconFetcher({
      lookup: async (host) =>
        host === "bad.example.com"
          ? [{ address: "10.0.0.9", family: 4 }]
          : [{ address: "93.184.216.34", family: 4 }],
      resourceTimeoutMs: 600,
    });
    closers.push(() => fetcher.close());
    const bad = fetcher.fetch("https://bad.example.com/", "html", approved("bad.example.com"));
    const good = fetcher.fetch("https://good.example.com/", "html", approved("good.example.com"));
    await expect(bad).rejects.toMatchObject({ code: "private-address" });
    // The good host is not refused for the bad one's address (it may fail to
    // connect or time out here, but never as a private address).
    await expect(good).rejects.not.toMatchObject({ code: "private-address" });
  });
});
