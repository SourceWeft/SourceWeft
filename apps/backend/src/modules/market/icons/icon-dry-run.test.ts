import { describe, expect, test, vi } from "vitest";

vi.mock("../../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import {
  decisionDiffers,
  iconRelatesToIdentity,
  planUrlCandidates,
  runIconDryRun,
  siteTrustOf,
  type IconDryRunTarget,
} from "./icon-dry-run";
import { fakeNetwork, html, imageResponse, logo, testDeps } from "./test-support";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const OWN_HOST = "assets.test";

function target(overrides: Partial<IconDryRunTarget> & { identifier: string }): IconDryRunTarget {
  return {
    key: `${overrides.identifier}@1.0.0`,
    current: { iconSource: "placeholder" },
    ...overrides,
  };
}

const planFor = (t: IconDryRunTarget) =>
  planUrlCandidates(t, siteTrustOf(t), OWN_HOST).map((p) => [p.source, p.tier]);

describe("planUrlCandidates", () => {
  test("a registry icon on the publisher's own domain is tier A, on a stranger's host B", () => {
    expect(
      planFor(
        target({
          identifier: "com.acme/mcp",
          registryIconUrl: "https://static.acme.com/logo.png",
        }),
      ),
    ).toEqual([["registry", "A"]]);
    expect(
      planFor(
        target({
          identifier: "com.acme/mcp",
          registryIconUrl: "https://cdn.stranger.example/logo.png",
        }),
      ),
    ).toEqual([["registry", "B"]]);
  });

  test("a registry icon in the declared repository owner's GitHub path relates to the identity", () => {
    expect(
      iconRelatesToIdentity("https://raw.githubusercontent.com/acme/mcp/main/logo.png", {
        domains: [],
        githubOwner: "Acme",
      }),
    ).toBe(true);
    expect(
      iconRelatesToIdentity("https://raw.githubusercontent.com/other/mcp/main/logo.png", {
        domains: [],
        githubOwner: "acme",
      }),
    ).toBe(false);
  });

  test("server-info icons are B only when they relate to the entry, else C", () => {
    const selfDescription = (src: string) => ({ serverInfo: { name: "x", icons: [{ src }] } });
    expect(
      planFor(
        target({
          identifier: "com.acme/mcp",
          selfDescription: selfDescription("https://acme.com/i.png"),
        }),
      ),
    ).toEqual([["server-info", "B"]]);
    expect(
      planFor(
        target({
          identifier: "com.acme/mcp",
          selfDescription: selfDescription("https://elsewhere.example/i.png"),
        }),
      ),
    ).toEqual([["server-info", "C"]]);
  });

  test("a GitHub namespace's avatar is A; an owner read only from a repository URL is C", () => {
    expect(planFor(target({ identifier: "io.github.acme/mcp" }))).toEqual([["github-avatar", "A"]]);
    expect(
      planFor(
        target({
          identifier: "com.acme/mcp",
          repositoryUrl: "https://github.com/someone-else/mcp",
        }),
      ),
    ).toEqual([["github-avatar", "C"]]);
    expect(
      planFor(
        target({ identifier: "com.acme/mcp", repositoryUrl: "https://github.com/acme/mcp" }),
      ),
    ).toEqual([["github-avatar", "B"]]);
  });

  test("the GitHub MCP Registry's owner avatar is B and only on GitHub hosts", () => {
    expect(
      planFor(
        target({
          identifier: "io.github.acme/mcp",
          githubRegistry: { ownerAvatarUrl: "https://avatars.githubusercontent.com/u/9?v=4" },
        }),
      ),
    ).toEqual([
      ["github-avatar", "A"],
      ["github-registry", "B"],
    ]);
    expect(
      planFor(
        target({
          identifier: "io.github.acme/mcp",
          githubRegistry: { ownerAvatarUrl: "https://evil.example/a.png" },
        }),
      ),
    ).toEqual([["github-avatar", "A"]]);
  });

  test("the stored favicon is A only with a confirmed domain and only from our own bucket", () => {
    const base = {
      identifier: "com.acme/mcp",
      faviconUrl: "https://assets.test/market/mcp-icons/acme.com/x.png",
    };
    expect(planFor(target({ ...base, endpointUrl: "https://mcp.acme.com/mcp" }))).toEqual([
      ["favicon", "A"],
    ]);
    expect(planFor(target({ ...base, endpointUrl: "https://acme.workers.dev/mcp" }))).toEqual([
      ["favicon", "C"],
    ]);
    expect(
      planFor(target({ ...base, faviconUrl: "https://evil.example/x.png", endpointUrl: "https://mcp.acme.com/mcp" })),
    ).toEqual([]);
  });
});

const GH_REDIRECT = new Response(null, {
  status: 302,
  headers: { location: "https://avatars.githubusercontent.com/u/1?s=128" },
});

async function world() {
  const apple = await logo(1, 180);
  const registryLogo = await logo(2, 128);
  const avatar = await logo(3, 128);
  const favicon = await logo(4, 128);
  return {
    apple,
    registryLogo,
    avatar,
    favicon,
    answers: {
      "https://acme.com/": html('<link rel="apple-touch-icon" href="/apple.png" sizes="180x180">'),
      "https://acme.com/apple.png": imageResponse(apple),
      "https://static.acme.com/logo.png": imageResponse(registryLogo),
      "https://github.com/acme.png?size=128": GH_REDIRECT,
      "https://avatars.githubusercontent.com/u/1?s=128": imageResponse(avatar),
      "https://assets.test/market/mcp-icons/acme.com/f.png": imageResponse(favicon),
    },
  };
}

function depsFor(network: ReturnType<typeof fakeNetwork>, shared = testDeps()) {
  return {
    ...shared,
    ownStorageHost: OWN_HOST,
    now: NOW,
    createFetcher: network.createFetcher,
    jobTimeoutMs: 5000,
  };
}

describe("runIconDryRun", () => {
  test("collects every sanctioned source, stores accepted images by hash and decides without touching the displayed icon", async () => {
    const w = await world();
    const network = fakeNetwork(w.answers);
    const shared = testDeps();
    const entry = target({
      identifier: "com.acme/mcp",
      endpointUrl: "https://mcp.acme.com/mcp",
      repositoryUrl: "https://github.com/acme/mcp",
      registryIconUrl: "https://static.acme.com/logo.png",
      faviconUrl: "https://assets.test/market/mcp-icons/acme.com/f.png",
      current: { iconSource: "registry", iconUrl: "https://static.acme.com/logo.png" },
    });
    const { results, counts } = await runIconDryRun([entry], new Map(), {
      ...depsFor(network, shared),
    });
    const record = results.get(entry.key)!;
    expect(record.candidates.complete).toBe(true);
    expect(
      record.candidates.items.map((c) => [c.source, c.tier, c.rejection ?? "accepted"]),
    ).toEqual([
      ["registry", "A", "accepted"],
      ["github-avatar", "B", "accepted"],
      ["favicon", "A", "accepted"],
      ["site", "A", "accepted"],
      // No rel=icon was declared, so /favicon.ico was tried too.
      ["site", "A", "http-404"],
    ]);
    // Everything accepted is a stored, hashed object of ours.
    for (const item of record.candidates.items.filter((c) => !c.rejection)) {
      expect(item.storedUrl).toBe(`https://assets.test/market/mcp-icons/by-hash/${item.sha256}.png`);
      expect(shared.objects.has(item.sha256!)).toBe(true);
    }
    // The registry icon wins within tier A; the pages keep showing today's.
    expect(record.decision.pick).toMatchObject({ source: "registry", tier: "A" });
    expect(record.decision.current).toEqual(entry.current);
    expect(decisionDiffers(record.decision)).toBe(false);
    expect(counts).toMatchObject({ entries: 1, collected: 1, sitesScraped: 1, picks: 1, differs: 0, candidatesAccepted: 4 });
  });

  test("a tier C site is never fetched", async () => {
    const w = await world();
    const network = fakeNetwork(w.answers);
    const entry = target({
      identifier: "io.github.acme/mcp",
      endpointUrl: "https://mcp.elsewhere.net/mcp",
      registryWebsiteUrl: "https://acme.com", // a single declaration
    });
    const { results } = await runIconDryRun([entry], new Map(), depsFor(network));
    expect(network.calls.some((c) => c.startsWith("https://acme.com"))).toBe(false);
    expect(results.get(entry.key)!.decision.site.tier).toBe("C");
    expect(results.get(entry.key)!.candidates.items.some((c) => c.source === "site")).toBe(false);
  });

  test("a site icon replaces a github avatar for the decision, and the difference is reported", async () => {
    const w = await world();
    const network = fakeNetwork({ ...w.answers, "https://static.acme.com/logo.png": new Response("", { status: 404 }) });
    const entry = target({
      identifier: "com.acme/mcp",
      endpointUrl: "https://mcp.acme.com/mcp",
      repositoryUrl: "https://github.com/acme/mcp",
      current: { iconSource: "github-avatar", iconUrl: "https://github.com/acme.png?size=128" },
    });
    const { results, counts } = await runIconDryRun([entry], new Map(), depsFor(network));
    const decision = results.get(entry.key)!.decision;
    expect(decision.pick).toMatchObject({ source: "site", tier: "A" });
    expect(decision.disagreement).toBe(true);
    expect(decisionDiffers(decision)).toBe(true);
    expect(counts.differs).toBe(1);
  });

  test("a parked site leaves the letter placeholder where nothing else qualifies", async () => {
    const network = fakeNetwork({
      "https://acme.com/": html("<title>acme.com is for sale</title>"),
    });
    const entry = target({
      identifier: "com.acme/mcp",
      endpointUrl: "https://mcp.acme.com/mcp",
      current: { iconSource: "favicon", iconUrl: "https://assets.test/old.png" },
    });
    const { results } = await runIconDryRun([entry], new Map(), depsFor(network));
    const { candidates, decision } = results.get(entry.key)!;
    expect(candidates.items).toMatchObject([{ source: "site", rejection: "site-parked" }]);
    expect(decision).toMatchObject({ outcome: "placeholder" });
    expect(decisionDiffers(decision)).toBe(true);
  });

  test("one owner's avatar is fetched once for all of their listings", async () => {
    const w = await world();
    const network = fakeNetwork(w.answers);
    const entries = ["a", "b", "c"].map((n) =>
      target({ identifier: `io.github.acme/mcp-${n}`, key: `acme-${n}` }),
    );
    const { results } = await runIconDryRun(entries, new Map(), {
      ...depsFor(network),
      concurrency: 1,
    });
    expect(results.size).toBe(3);
    expect(network.calls.filter((c) => c === "https://github.com/acme.png?size=128")).toHaveLength(1);
  });

  test("a stored current record is reused without any request", async () => {
    const w = await world();
    const first = fakeNetwork(w.answers);
    const shared = testDeps();
    const entry = target({
      identifier: "com.acme/mcp",
      endpointUrl: "https://mcp.acme.com/mcp",
      registryIconUrl: "https://static.acme.com/logo.png",
    });
    const run1 = await runIconDryRun([entry], new Map(), depsFor(first, shared));
    const second = fakeNetwork({});
    const stored = new Map([
      [entry.key, { iconCandidates: run1.results.get(entry.key)!.candidates, iconDecision: run1.results.get(entry.key)!.decision }],
    ]);
    const run2 = await runIconDryRun(
      [{ ...entry, current: { iconSource: "favicon", iconUrl: "https://assets.test/new.png" } }],
      stored,
      { ...depsFor(second, shared), now: new Date(NOW.getTime() + 24 * 60 * 60 * 1000) },
    );
    expect(second.calls).toEqual([]);
    expect(run2.counts).toMatchObject({ reused: 1, collected: 0 });
    // The decision is recomputed against what the pages show now.
    expect(run2.results.get(entry.key)!.decision.current.iconSource).toBe("favicon");
  });

  test("an incomplete or expired record is redone", async () => {
    const w = await world();
    const shared = testDeps();
    const entry = target({
      identifier: "com.acme/mcp",
      registryIconUrl: "https://static.acme.com/logo.png",
    });
    const run1 = await runIconDryRun([entry], new Map(), depsFor(fakeNetwork(w.answers), shared));
    const record = run1.results.get(entry.key)!;
    const later = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000);
    const network = fakeNetwork(w.answers);
    const run2 = await runIconDryRun(
      [entry],
      new Map([[entry.key, { iconCandidates: record.candidates }]]),
      { ...depsFor(network, shared), now: later },
    );
    expect(run2.counts.collected).toBe(1);
  });

  test("the same logo under three unrelated domains is flagged and held back", async () => {
    const shared = testDeps();
    const template = await logo(9, 128);
    const entries = ["alpha.io", "beta.dev", "gamma.app"].map((domain) =>
      target({
        identifier: `${domain.split(".").reverse().join(".")}/mcp`,
        key: `k-${domain}`,
        endpointUrl: `https://mcp.${domain}/mcp`,
      }),
    );
    const answers: Record<string, Response> = {};
    for (const domain of ["alpha.io", "beta.dev", "gamma.app"]) {
      answers[`https://${domain}/`] = html('<link rel="apple-touch-icon" href="/t.png">');
      answers[`https://${domain}/t.png`] = imageResponse(template);
    }
    const { results } = await runIconDryRun(entries, new Map(), {
      ...depsFor(fakeNetwork(answers), shared),
      concurrency: 1,
    });
    const last = results.get("k-gamma.app")!;
    expect(last.candidates.items[0]!.signals).toEqual(["shared-template:3"]);
    expect(last.decision).toMatchObject({ outcome: "placeholder", reasons: ["shared-template-needs-review"] });
    // The first two were made before the third domain was seen.
    expect(results.get("k-alpha.io")!.decision.outcome).toBe("pick");
  });

  test("a storage failure costs the candidate, not the entry", async () => {
    const w = await world();
    const shared = testDeps();
    let n = 0;
    const store: typeof shared.store = async (input) => {
      n += 1;
      if (n === 1) throw new Error("bucket down");
      return shared.store(input);
    };
    const entry = target({
      identifier: "com.acme/mcp",
      key: "one",
      registryIconUrl: "https://static.acme.com/logo.png",
      repositoryUrl: "https://github.com/acme/mcp",
    });
    const { results, counts } = await runIconDryRun([entry], new Map(), {
      ...depsFor(fakeNetwork(w.answers), shared),
      store,
    });
    const items = results.get("one")!.candidates;
    expect(items.complete).toBe(false);
    expect(items.items[0]).toMatchObject({ source: "registry", rejection: "fetch-unavailable" });
    expect(items.items[1]).toMatchObject({ source: "github-avatar" });
    expect(items.items[1]!.rejection).toBeUndefined();
    expect(counts).toMatchObject({ collected: 1, failed: 0 });
  });

  test("an unexpected failure in one entry never stops the others", async () => {
    const w = await world();
    const shared = testDeps();
    let reads = 0;
    const state = {
      ...shared.state,
      read: async (scope: string) => {
        reads += 1;
        if (reads === 1) throw new Error("database down");
        return shared.state.read(scope);
      },
      acquireLease: shared.state.acquireLease,
      settle: shared.state.settle,
      recordHashDomain: shared.state.recordHashDomain,
      countHashLabels: shared.state.countHashLabels,
    };
    const entries = [
      target({ identifier: "io.github.acme/mcp", key: "one" }),
      target({ identifier: "io.github.acme/other", key: "two" }),
    ];
    const { results, counts } = await runIconDryRun(entries, new Map(), {
      ...depsFor(fakeNetwork(w.answers), shared),
      state,
      concurrency: 1,
    });
    expect(counts).toMatchObject({ failed: 1, collected: 1 });
    expect(results.has("one")).toBe(false);
    expect(results.has("two")).toBe(true);
  });

  test("entries past the page deadline are left for the next sync", async () => {
    const network = fakeNetwork({});
    const { results, counts } = await runIconDryRun(
      [target({ identifier: "io.github.acme/mcp" })],
      new Map(),
      { ...depsFor(network), deadlineMs: -1 },
    );
    expect(results.size).toBe(0);
    expect(counts.skipped).toBe(1);
    expect(network.calls).toEqual([]);
  });
});
