import { describe, expect, test } from "vitest";
import type {
  AgentToolWebProvider,
  AgentToolWebSearchResultItem,
} from "@sourceweft/contracts/agent-tools";
import type {
  GroundedAnchorPort,
  GroundedModelPort,
} from "@sourceweft/contracts/grounded-generation";
import type { LedgerEntry } from "./ledger";
import { runResearch, type ResearchRepo } from "./loop";

type ModelCall = Parameters<GroundedModelPort["completeStructured"]>[0];
type SavePatch = Parameters<ResearchRepo["saveProgress"]>[1];

const noAnchor: GroundedAnchorPort = {
  anchor: async (requests) => requests.map(() => null),
};

const now = () => 1_000;

const hit = (url: string): AgentToolWebSearchResultItem => ({
  title: `Title ${url}`,
  url,
  snippet: "snippet",
});

function makeWeb(config: {
  search: (query: string) => AgentToolWebSearchResultItem[];
  fetch: (url: string) => { markdown?: string; title?: string; error?: string };
}) {
  const searchCalls: string[] = [];
  const fetchCalls: string[] = [];
  const web: AgentToolWebProvider = {
    name: "fake",
    async search({ query }) {
      searchCalls.push(query);
      const results = config.search(query);
      return { provider: "fake", query, count: results.length, results };
    },
    async fetch({ items }) {
      const url = items[0]!.url;
      fetchCalls.push(url);
      const page = config.fetch(url);
      return {
        provider: "fake",
        count: 1,
        results: [
          {
            url,
            title: page.title,
            markdown: page.markdown ?? "",
            wordCount: 0,
            truncated: false,
            error: page.error,
          },
        ],
      };
    },
  };
  return { web, searchCalls, fetchCalls };
}

function makeModel(script: (call: ModelCall) => unknown) {
  const calls: ModelCall[] = [];
  const model: GroundedModelPort = {
    async completeStructured(call) {
      calls.push(call);
      return script(call);
    },
  };
  return { model, calls };
}

function makeRepo(overrides?: { isCancelRequested?: () => Promise<boolean> }) {
  const saved: SavePatch[] = [];
  const repo: ResearchRepo = {
    saveProgress: async (_runId, patch) => {
      saved.push(patch);
    },
    isCancelRequested: overrides?.isCancelRequested ?? (async () => false),
  };
  return { repo, saved };
}

describe("runResearch", () => {
  test("two rounds then enough yields a cited report", async () => {
    const pages: Record<string, string> = {
      "https://x/1": "Sentence one is here.",
      "https://x/2": "Sentence two is here.",
    };
    const { web, searchCalls, fetchCalls } = makeWeb({
      search: (query) => [hit(query === "s2" ? "https://x/2" : "https://x/1")],
      fetch: (url) => ({ markdown: pages[url], title: "T" }),
    });
    let round = 0;
    const { model } = makeModel((call) => {
      switch (call.operation) {
        case "research.plan":
          return { subquestions: ["a", "b"] };
        case "research.queries":
          return { queries: [round === 0 ? "s1" : "s2"] };
        case "research.select":
          return { urls: [round === 0 ? "https://x/1" : "https://x/2"] };
        case "research.digest": {
          const enough = round === 1;
          const url = round === 0 ? "https://x/1" : "https://x/2";
          const quote =
            round === 0 ? pages["https://x/1"] : pages["https://x/2"];
          round += 1;
          return {
            pages: [{ url, points: ["p"], quotes: [quote] }],
            enough,
            missing: enough ? [] : ["more"],
          };
        }
        case "research.report":
          return {
            report:
              "A [[e1|Sentence one is here.]] and B [[e2|Sentence two is here.]].",
          };
        default:
          throw new Error(`unexpected ${call.operation}`);
      }
    });
    const { repo, saved } = makeRepo();

    const result = await runResearch(
      { runId: "r1", topic: "Topic" },
      { web, model, anchor: noAnchor, repo, now },
    );

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.report).toContain("[1]");
      expect(result.report).toContain("[2]");
      expect(result.citations).toHaveLength(2);
    }
    expect(searchCalls).toHaveLength(2);
    expect(fetchCalls).toHaveLength(2);
    const last = saved.at(-1)!;
    expect(last.progress?.searches).toBe(2);
    expect(last.progress?.pagesRead).toBe(2);
  });

  test("stops after the fourth round and still reports", async () => {
    const { web, searchCalls } = makeWeb({
      search: (query) => [hit(`https://p/${query}`)],
      fetch: () => ({ markdown: "Fact here.", title: "T" }),
    });
    let r = 0;
    const { model, calls } = makeModel((call) => {
      switch (call.operation) {
        case "research.plan":
          return { subquestions: ["a"] };
        case "research.queries":
          return { queries: [`q${r}`] };
        case "research.select":
          return { urls: [`https://p/q${r}`] };
        case "research.digest": {
          const url = `https://p/q${r}`;
          r += 1;
          return {
            pages: [{ url, points: ["p"], quotes: ["Fact here."] }],
            enough: false,
            missing: ["more"],
          };
        }
        case "research.report":
          return { report: "R [[e1|Fact here.]]." };
        default:
          throw new Error(`unexpected ${call.operation}`);
      }
    });
    const { repo } = makeRepo();

    const result = await runResearch(
      { runId: "r2", topic: "T" },
      { web, model, anchor: noAnchor, repo, now },
    );

    expect(result.status).toBe("ready");
    expect(calls.filter((c) => c.operation === "research.digest")).toHaveLength(
      4,
    );
    expect(searchCalls).toHaveLength(4);
  });

  test("cancels before the second round without more model calls", async () => {
    const { web } = makeWeb({
      search: () => [hit("https://x/1")],
      fetch: () => ({ markdown: "Fact.", title: "T" }),
    });
    let modelCalls = 0;
    const { model, calls } = makeModel((call) => {
      modelCalls += 1;
      switch (call.operation) {
        case "research.plan":
          return { subquestions: ["a"] };
        case "research.queries":
          return { queries: ["s1"] };
        case "research.select":
          return { urls: ["https://x/1"] };
        case "research.digest":
          return {
            pages: [{ url: "https://x/1", points: ["p"], quotes: ["Fact."] }],
            enough: false,
            missing: ["m"],
          };
        default:
          throw new Error(`unexpected ${call.operation}`);
      }
    });
    const { repo } = makeRepo({
      isCancelRequested: async () => modelCalls >= 4,
    });

    const result = await runResearch(
      { runId: "r3", topic: "T" },
      { web, model, anchor: noAnchor, repo, now },
    );

    expect(result).toEqual({ status: "cancelled" });
    expect(calls).toHaveLength(4);
  });

  test("no search results fails with NO_RESULTS", async () => {
    const { web } = makeWeb({
      search: () => [],
      fetch: () => ({ markdown: "x" }),
    });
    const { model } = makeModel((call) => {
      switch (call.operation) {
        case "research.plan":
          return { subquestions: ["a"] };
        case "research.queries":
          return { queries: ["s"] };
        default:
          throw new Error(`unexpected ${call.operation}`);
      }
    });
    const { repo } = makeRepo();

    const result = await runResearch(
      { runId: "r4", topic: "T" },
      { web, model, anchor: noAnchor, repo, now },
    );

    expect(result).toEqual({ status: "failed", errorCode: "NO_RESULTS" });
  });

  test("a failing search fails with WEB_PROVIDER_UNAVAILABLE", async () => {
    const { web } = makeWeb({
      search: () => {
        throw new Error("provider down");
      },
      fetch: () => ({ markdown: "x" }),
    });
    const { model } = makeModel((call) => {
      switch (call.operation) {
        case "research.plan":
          return { subquestions: ["a"] };
        case "research.queries":
          return { queries: ["s"] };
        default:
          throw new Error(`unexpected ${call.operation}`);
      }
    });
    const { repo } = makeRepo();

    const result = await runResearch(
      { runId: "r4b", topic: "T" },
      { web, model, anchor: noAnchor, repo, now },
    );

    expect(result).toEqual({
      status: "failed",
      errorCode: "WEB_PROVIDER_UNAVAILABLE",
    });
  });

  test("a single fetch failure skips that page and keeps the rest", async () => {
    const pages: Record<string, { markdown?: string; title?: string }> = {
      "https://x/2": { markdown: "Two is here.", title: "T2" },
      "https://x/3": { markdown: "Three is here.", title: "T3" },
    };
    const { web, fetchCalls } = makeWeb({
      search: () => [
        hit("https://x/1"),
        hit("https://x/2"),
        hit("https://x/3"),
      ],
      fetch: (url) => {
        if (url === "https://x/1") throw new Error("fetch failed");
        return pages[url]!;
      },
    });
    const { model } = makeModel((call) => {
      switch (call.operation) {
        case "research.plan":
          return { subquestions: ["a"] };
        case "research.queries":
          return { queries: ["s"] };
        case "research.select":
          return {
            urls: ["https://x/1", "https://x/2", "https://x/3"],
          };
        case "research.digest":
          return {
            pages: [
              { url: "https://x/2", points: ["p2"], quotes: ["Two is here."] },
              {
                url: "https://x/3",
                points: ["p3"],
                quotes: ["Three is here."],
              },
            ],
            enough: true,
            missing: [],
          };
        case "research.report":
          return { report: "X [[e1|Two is here.]] Y [[e2|Three is here.]]." };
        default:
          throw new Error(`unexpected ${call.operation}`);
      }
    });
    const { repo, saved } = makeRepo();

    const result = await runResearch(
      { runId: "r5", topic: "T" },
      { web, model, anchor: noAnchor, repo, now },
    );

    expect(result.status).toBe("ready");
    const ledger = saved.at(-1)!.ledger!;
    expect(ledger.map((entry) => entry.url)).toEqual([
      "https://x/2",
      "https://x/3",
    ]);
    expect(fetchCalls).toContain("https://x/1");
  });

  test("rewrites past fabricated ids, then fails if they persist", async () => {
    const makeRun = (reports: string[]) => {
      const { web } = makeWeb({
        search: () => [hit("https://x/1")],
        fetch: () => ({ markdown: "Real quote here.", title: "T" }),
      });
      let reportIdx = 0;
      const { model } = makeModel((call) => {
        switch (call.operation) {
          case "research.plan":
            return { subquestions: ["a"] };
          case "research.queries":
            return { queries: ["s"] };
          case "research.select":
            return { urls: ["https://x/1"] };
          case "research.digest":
            return {
              pages: [
                {
                  url: "https://x/1",
                  points: ["p"],
                  quotes: ["Real quote here."],
                },
              ],
              enough: true,
              missing: [],
            };
          case "research.report":
            return { report: reports[reportIdx++] ?? reports.at(-1) };
          default:
            throw new Error(`unexpected ${call.operation}`);
        }
      });
      const { repo } = makeRepo();
      return runResearch(
        { runId: "r6", topic: "T" },
        { web, model, anchor: noAnchor, repo, now },
      );
    };

    const good = await makeRun([
      "Bad [[e9|x]].",
      "Bad [[e8|y]].",
      "Good [[e1|Real quote here.]].",
    ]);
    expect(good.status).toBe("ready");
    if (good.status === "ready") expect(good.report).toContain("[1]");

    const bad = await makeRun([
      "Bad [[e9|x]].",
      "Bad [[e8|y]].",
      "Bad [[e7|z]].",
    ]);
    expect(bad).toEqual({
      status: "failed",
      errorCode: "RESEARCH_QUALITY_TOO_LOW",
    });
  });

  test("resumes from the ledger without re-reading pages or recharging calls", async () => {
    const pages: Record<string, { markdown?: string; title?: string }> = {
      "https://a": { markdown: "Alpha text.", title: "A" },
      "https://b": { markdown: "Beta text.", title: "B" },
      "https://c": { markdown: "Gamma quote here.", title: "C" },
    };
    const { web, fetchCalls } = makeWeb({
      search: () => [hit("https://a"), hit("https://c")],
      fetch: (url) => pages[url]!,
    });
    const { model, calls } = makeModel((call) => {
      switch (call.operation) {
        case "research.queries":
          return { queries: ["s"] };
        case "research.select":
          return { urls: ["https://a", "https://c"] };
        case "research.digest":
          return {
            pages: [
              {
                url: "https://c",
                points: ["p"],
                quotes: ["Gamma quote here."],
              },
            ],
            enough: true,
            missing: [],
          };
        case "research.report":
          return { report: "Z [[e3|Gamma quote here.]]." };
        default:
          throw new Error(`unexpected ${call.operation}`);
      }
    });
    const ledger: LedgerEntry[] = [
      { id: "e1", url: "https://a", title: "A", points: ["pa"], quotes: [] },
      { id: "e2", url: "https://b", title: "B", points: ["pb"], quotes: [] },
    ];
    const { repo } = makeRepo();

    const result = await runResearch(
      {
        runId: "r7",
        topic: "T",
        resume: {
          plan: ["a"],
          ledger,
          progress: { round: 1, searches: 3, pagesRead: 2, modelCalls: 5 },
        },
      },
      { web, model, anchor: noAnchor, repo, now },
    );

    expect(result.status).toBe("ready");
    expect(calls[0]!.idempotencyKey).toBe("research:r7:call:6");
    expect(fetchCalls[0]).toBe("https://c");
  });
});
