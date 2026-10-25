import { describe, expect, test } from "vitest";
import {
  fakeNetwork,
  html,
  imageResponse,
  logo,
  testDeps,
} from "./test-support";
import { sha256Hex } from "./image-validate";
import { MAX_SITE_CANDIDATES, planSiteCandidates, scrapeSiteIcons } from "./site-icons";

async function scrape(
  host: string,
  answers: Parameters<typeof fakeNetwork>[0],
) {
  const network = fakeNetwork(answers);
  const deps = testDeps();
  const outcome = await scrapeSiteIcons(host, {
    state: deps.state,
    store: deps.store,
    createFetcher: network.createFetcher,
    jobTimeoutMs: 5000,
  });
  return { outcome, network, deps };
}

describe("scrapeSiteIcons", () => {
  test("reads the head, the manifest and the declared icons, and stores accepted ones by hash", async () => {
    const apple = await logo(1, 180);
    const manifestIcon = await logo(2, 192);
    const { outcome, network, deps } = await scrape("acme.io", {
      "https://acme.io/": html(`
        <title>Acme</title>
        <link rel="icon" href="/favicon-32.png" sizes="32x32">
        <link rel="apple-touch-icon" href="/apple.png" sizes="180x180">
        <link rel="manifest" href="/site.webmanifest">
        <meta property="og:image" content="https://acme.io/banner.png">`),
      "https://acme.io/apple.png": imageResponse(apple),
      "https://acme.io/favicon-32.png": imageResponse(await logo(3, 32)),
      "https://acme.io/site.webmanifest": new Response(
        JSON.stringify({ icons: [{ src: "/m.png", sizes: "192x192" }] }),
      ),
      "https://acme.io/m.png": imageResponse(manifestIcon),
    });
    expect(outcome.status).toBe("ok");
    const result = outcome.result!;
    expect(result.outcome).toBe("icons");
    expect(result.candidates.map((c) => [c.kind, c.url, c.rejection ?? "accepted"])).toEqual([
      ["apple-touch-icon", "https://acme.io/apple.png", "accepted"],
      ["manifest-icon", "https://acme.io/m.png", "accepted"],
      ["icon", "https://acme.io/favicon-32.png", "too-small"],
    ]);
    const first = result.candidates[0]!;
    expect(first).toMatchObject({ width: 180, height: 180 });
    // Stored by the hash of the re-encoded bytes, not of the fetched file.
    const stored = deps.objects.get(first.sha256!)!;
    expect(sha256Hex(stored.bytes)).toBe(first.sha256);
    expect(first.sha256).not.toBe(sha256Hex(apple));
    expect(first.storedUrl).toContain(first.sha256);
    // og:image was never requested.
    expect(network.calls).not.toContain("https://acme.io/banner.png");
  });

  test("falls back to /favicon.ico when the page declares no rel=icon", async () => {
    const { outcome } = await scrape("acme.io", {
      "https://acme.io/": html("<title>Acme</title>"),
      "https://acme.io/favicon.ico": imageResponse(await logo(4), "image/png"),
    });
    expect(outcome.result!.candidates).toMatchObject([
      { kind: "implicit-favicon", url: "https://acme.io/favicon.ico", width: 128 },
    ]);
  });

  test("a parked page yields no candidates and is cached as a refusal", async () => {
    const { outcome, network } = await scrape("parked.example", {
      "https://parked.example/": html(
        '<title>parked.example - Domain For Sale</title><link rel="icon" href="/registrar.png">',
      ),
      "https://parked.example/registrar.png": imageResponse(await logo(5)),
    });
    expect(outcome.status).toBe("denied");
    expect(outcome.result).toMatchObject({ outcome: "parked", candidates: [] });
    expect(network.calls).not.toContain("https://parked.example/registrar.png");
  });

  test("a bot-challenge page is not read for icons", async () => {
    const { outcome } = await scrape("wall.example", {
      "https://wall.example/": html(
        '<title>Just a moment...</title><link rel="icon" href="/cf.png">',
        403,
      ),
    });
    // A bot wall may lift: retried with backoff, not cached as a refusal.
    expect(outcome.status).toBe("deferred");
    expect(outcome.result).toMatchObject({ outcome: "challenge", candidates: [] });
  });

  test("a rate-limited homepage is deferred, not read as a challenge or cached", async () => {
    const { outcome, network } = await scrape("limited.example", {
      "https://limited.example/": new Response("slow down", { status: 429 }),
    });
    expect(outcome).toMatchObject({
      status: "deferred",
      result: { outcome: "page-unavailable", reason: "http-429", candidates: [] },
    });
    expect(network.calls).toEqual(["https://limited.example/robots.txt", "https://limited.example/"]);
  });

  test("robots.txt disallow stops before the page is requested", async () => {
    const { outcome, network } = await scrape("closed.example", {
      "https://closed.example/robots.txt": new Response("User-agent: *\nDisallow: /"),
      "https://closed.example/": html('<link rel="icon" href="/x.png">'),
    });
    expect(outcome).toMatchObject({ status: "denied", result: { outcome: "robots-disallowed" } });
    expect(network.calls).toEqual(["https://closed.example/robots.txt"]);
  });

  test("robots.txt 5xx defers the site", async () => {
    const { outcome } = await scrape("flaky.example", {
      "https://flaky.example/robots.txt": new Response("", { status: 503 }),
    });
    expect(outcome.status).toBe("deferred");
  });

  test("an icon on another registrable domain is rejected without being fetched", async () => {
    const { outcome, network } = await scrape("acme.io", {
      "https://acme.io/": html(
        '<link rel="icon" href="https://cdn.othercorp.com/logo.png" sizes="128x128">' +
          '<link rel="apple-touch-icon" href="https://static.acme.io/a.png">',
      ),
      "https://static.acme.io/a.png": imageResponse(await logo(6)),
    });
    expect(outcome.result!.candidates).toMatchObject([
      { url: "https://static.acme.io/a.png", width: 128 },
      { url: "https://cdn.othercorp.com/logo.png", rejection: "host-not-approved" },
    ]);
    expect(network.calls.some((c) => c.includes("othercorp"))).toBe(false);
  });

  test("a redirect of the page to another company is refused", async () => {
    const { outcome } = await scrape("acme.io", {
      "https://acme.io/": new Response(null, {
        status: 302,
        headers: { location: "https://competitor.com/" },
      }),
    });
    expect(outcome.status).toBe("error");
    expect(outcome.result!.candidates).toEqual([]);
  });

  test("SVG and mask-icon declarations are recorded as rejected and never fetched", async () => {
    const { outcome, network } = await scrape("acme.io", {
      "https://acme.io/": html(
        '<link rel="icon" href="/logo.svg" type="image/svg+xml">' +
          '<link rel="mask-icon" href="/mask.svg" color="#000">' +
          '<link rel="apple-touch-icon" href="/a.png">',
      ),
      "https://acme.io/a.png": imageResponse(await logo(7)),
    });
    expect(
      outcome.result!.candidates.map((c) => [c.url, c.rejection ?? "accepted"]),
    ).toEqual([
      ["https://acme.io/a.png", "accepted"],
      ["https://acme.io/logo.svg", "svg-not-published"],
      ["https://acme.io/mask.svg", "mask-icon-not-published"],
    ]);
    expect(network.calls).not.toContain("https://acme.io/logo.svg");
  });

  test("an image that is really a for-sale HTML page is rejected", async () => {
    const { outcome } = await scrape("acme.io", {
      "https://acme.io/": html('<link rel="icon" href="/x.png" sizes="128x128">'),
      "https://acme.io/x.png": new Response("<html>Sorry</html>", {
        headers: { "content-type": "text/html" },
      }),
    });
    expect(outcome.result!.candidates).toMatchObject([{ rejection: "not-an-image" }]);
    expect(outcome.result!.outcome).toBe("no-icons");
  });

  test("an oversize image is a rejection, not a stored object", async () => {
    const { outcome, deps } = await scrape("acme.io", {
      "https://acme.io/": html('<link rel="icon" href="/x.png" sizes="128x128">'),
      "https://acme.io/x.png": imageResponse(Buffer.alloc(1024 * 1024 + 10, 1)),
    });
    expect(outcome.result!.candidates).toMatchObject([{ rejection: "too-large" }]);
    expect(deps.objects.size).toBe(0);
  });

  test("records the serving domain for the shared-template count", async () => {
    const { deps } = await scrape("acme.io", {
      "https://acme.io/": html('<link rel="apple-touch-icon" href="/a.png">'),
      "https://acme.io/a.png": imageResponse(await logo(8)),
    });
    const [sha] = [...deps.objects.keys()];
    expect(await deps.state.countHashDomains(sha!)).toBe(1);
  });

  test("a transient image failure on every candidate retries the site later", async () => {
    const { outcome } = await scrape("acme.io", {
      "https://acme.io/": html('<link rel="apple-touch-icon" href="/a.png">'),
      "https://acme.io/a.png": new Response("busy", { status: 503 }),
    });
    expect(outcome.status).toBe("error");
  });
});

describe("planSiteCandidates", () => {
  test("is capped at eight candidates and puts raster before rejected declarations", () => {
    const icons = Array.from({ length: 12 }, (_, i) => ({
      rel: "icon" as const,
      url: `https://acme.io/i${i}.png`,
      size: i,
    }));
    const planned = planSiteCandidates(
      [
        ...icons,
        { rel: "mask-icon", url: "https://acme.io/mask.svg" },
      ],
      "https://acme.io",
    );
    expect(planned).toHaveLength(MAX_SITE_CANDIDATES);
    expect(planned[0]!.url).toBe("https://acme.io/i11.png");
    expect(planned.every((p) => !p.reject)).toBe(true);
  });

  test("duplicate URLs are planned once", () => {
    const planned = planSiteCandidates(
      [
        { rel: "icon", url: "https://acme.io/a.png" },
        { rel: "apple-touch-icon", url: "https://acme.io/a.png" },
      ],
      "https://acme.io",
    );
    expect(planned).toHaveLength(1);
  });
});
