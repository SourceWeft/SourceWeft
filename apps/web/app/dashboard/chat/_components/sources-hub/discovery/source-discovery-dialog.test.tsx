// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { act } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { HttpClientError } from "@sourceweft/sdk";

const discoverSources = vi.hoisted(() => vi.fn());
const getSourceDiscoveryAvailability = vi.hoisted(() => vi.fn());
const createUrlSource = vi.hoisted(() => vi.fn());
const listSourceStatuses = vi.hoisted(() => vi.fn());

vi.mock("../../../../../../lib/sdk", () => ({
  contentClient: {
    discoverSources,
    getSourceDiscoveryAvailability,
    createUrlSource,
    listSourceStatuses,
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import {
  SourceDiscoveryDialog,
  useSourceDiscoveryAvailable,
} from "./source-discovery-dialog";
import { click, flush, mountWithIntl, unmountAll } from "@/test/react";

const RESULT = {
  cached: false,
  cachedAt: null,
  queries: ["solid state batteries", "battery commercialization"],
  candidates: [
    {
      url: "https://a.com/1",
      title: "Batteries explained",
      snippet: "How they work.",
      domain: "a.com",
      existingSourceId: null,
    },
    {
      url: "https://b.com/2",
      title: "Market report",
      snippet: "Sales outlook.",
      domain: "b.com",
      existingSourceId: null,
    },
    {
      url: "https://c.com/3",
      title: "Old news",
      snippet: "",
      domain: "c.com",
      existingSourceId: "source-9",
    },
  ],
};

beforeEach(() => {
  discoverSources.mockReset();
  createUrlSource.mockReset();
  listSourceStatuses.mockReset();
  getSourceDiscoveryAvailability.mockReset();
});
afterEach(unmountAll);

const text = () => document.body.textContent ?? "";
const buttonNamed = (name: string) =>
  [...document.body.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(name),
  );

async function mountOpen(onImported = vi.fn()) {
  await mountWithIntl(
    createElement(SourceDiscoveryDialog, {
      onImported,
      onOpenChange: () => {},
      open: true,
      workspaceId: "w1",
    }),
  );
  await flush();
  return onImported;
}

async function typeTopic(value: string) {
  const input = document.body.querySelector("input") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
}

async function search() {
  discoverSources.mockResolvedValue(RESULT);
  await typeTopic("solid state batteries");
  await click(buttonNamed("Find sources")!);
  await flush();
}

test("a topic returns candidates with the searches that were run", async () => {
  await mountOpen();
  await search();

  assert.deepEqual(discoverSources.mock.calls[0], [
    "w1",
    "solid state batteries",
  ]);
  assert.ok(text().includes("Batteries explained"));
  assert.ok(text().includes("battery commercialization"));
  assert.ok(text().includes("Market report"));
});

test("a page already in the workspace is shown but cannot be chosen", async () => {
  await mountOpen();
  await search();

  assert.ok(text().includes("Already added"));
  const row = document.body.querySelector(
    '[data-candidate="https://c.com/3"]',
  )!;
  assert.equal(
    row.querySelector('[role="checkbox"]')?.hasAttribute("disabled"),
    true,
  );
  await click(buttonNamed("Select all")!);
  assert.ok(buttonNamed("Import 2 pages"));
});

test("nothing is imported until pages are chosen", async () => {
  await mountOpen();
  await search();

  assert.equal(createUrlSource.mock.calls.length, 0);
  assert.equal(buttonNamed("Import 0 pages")?.hasAttribute("disabled"), true);
});

test("chosen pages are imported one source each and reported", async () => {
  createUrlSource.mockImplementation(
    async (_ws: string, input: { url: string }) => ({
      source: { id: `id:${input.url}` },
    }),
  );
  listSourceStatuses.mockImplementation(
    async (_ws: string, input: { ids: string[] }) => ({
      items: input.ids.map((id) => ({
        id,
        status: {
          status: id.includes("b.com") ? "failed" : "indexed",
          error: id.includes("b.com") ? "The page blocked our reader." : null,
          errorCode: null,
        },
      })),
    }),
  );
  const onImported = await mountOpen();
  await search();

  await click(buttonNamed("Select all")!);
  await click(buttonNamed("Import 2 pages")!);
  for (let i = 0; i < 6; i += 1) await flush();

  assert.deepEqual(
    createUrlSource.mock.calls.map((call) => call[1].url).sort(),
    ["https://a.com/1", "https://b.com/2"],
  );
  assert.ok(text().includes("1 added, 1 failed, 0 not imported."));
  assert.ok(text().includes("The page blocked our reader."));
  assert.equal(onImported.mock.calls.length, 1);
});

test("running out of credits is explained on the search step", async () => {
  discoverSources.mockRejectedValue(
    new HttpClientError({
      message: "x",
      status: 402,
      statusText: "Payment Required",
      code: "INSUFFICIENT_CREDITS",
    }),
  );
  await mountOpen();
  await typeTopic("solid state batteries");
  await click(buttonNamed("Find sources")!);
  await flush();

  assert.ok(text().includes("not have enough credits"));
});

test("a topic that is too short cannot be searched", async () => {
  await mountOpen();
  await typeTopic("ab");

  assert.equal(buttonNamed("Find sources")?.hasAttribute("disabled"), true);
});

test("discovery is offered only where a web provider exists", async () => {
  getSourceDiscoveryAvailability.mockResolvedValue({ available: true });
  const seen: boolean[] = [];
  function Probe() {
    seen.push(useSourceDiscoveryAvailable("w1"));
    return null;
  }
  await mountWithIntl(createElement(Probe));
  await flush();
  assert.equal(seen.at(-1), true);

  await unmountAll();
  seen.length = 0;
  getSourceDiscoveryAvailability.mockResolvedValue({ available: false });
  await mountWithIntl(createElement(Probe));
  await flush();
  assert.equal(seen.at(-1), false);
});

const limitedError = (details: Record<string, unknown>) =>
  new HttpClientError({
    message: "slow down",
    status: 429,
    statusText: "Too Many Requests",
    code: "SOURCE_DISCOVERY_RATE_LIMITED",
    details,
  });

test("a refused search says which limit it was, counts down, keeps the topic, and re-enables itself", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  try {
    discoverSources.mockRejectedValue(
      limitedError({ scope: "minute", retryAfterSeconds: 30 }),
    );
    await mountOpen();
    await typeTopic("solid state batteries");
    await click(buttonNamed("Find sources")!);
    await flush();

    const notice = document.body.querySelector("[data-rate-limit-notice]");
    assert.ok(notice);
    assert.ok(notice.textContent?.includes("You are searching quickly"));
    assert.ok(text().includes("Try again in 30s"));
    const input = document.body.querySelector("input") as HTMLInputElement;
    assert.equal(input.value, "solid state batteries");
    assert.equal(buttonNamed("Try again in")?.hasAttribute("disabled"), true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    assert.ok(text().includes("Try again in 20s"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(21_000);
    });
    assert.equal(document.body.querySelector("[data-rate-limit-notice]"), null);
    assert.equal(buttonNamed("Find sources")?.hasAttribute("disabled"), false);
  } finally {
    vi.useRealTimers();
  }
});

test("an hourly limit says when it clears", async () => {
  discoverSources.mockRejectedValue(
    limitedError({ scope: "hour", retryAfterSeconds: 1380 }),
  );
  await mountOpen();
  await typeTopic("solid state batteries");
  await click(buttonNamed("Find sources")!);
  await flush();

  const message =
    document.body.querySelector("[data-rate-limit-notice]")?.textContent ?? "";
  assert.ok(message.includes("hourly limit"));
  assert.ok(message.includes("23m"));
});

test("a refused search leaves the earlier results one click away", async () => {
  await mountOpen();
  await search();
  assert.ok(text().includes("Batteries explained"));
  await click(buttonNamed("New search")!);

  discoverSources.mockRejectedValue(
    limitedError({ scope: "minute", retryAfterSeconds: 30 }),
  );
  await typeTopic("something else");
  await click(buttonNamed("Find sources")!);
  await flush();
  assert.ok(document.body.querySelector("[data-rate-limit-notice]"));

  await click(buttonNamed("Back to the last results")!);

  assert.ok(text().includes("Batteries explained"));
});

test("results served from a recent search say so", async () => {
  discoverSources.mockResolvedValue({
    ...RESULT,
    cached: true,
    cachedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
  });
  await mountOpen();
  await typeTopic("solid state batteries");
  await click(buttonNamed("Find sources")!);
  await flush();

  const note = document.body.querySelector("[data-cached-note]");
  assert.ok(note);
  assert.ok(note.textContent?.includes("12 minutes ago"));
  assert.ok(note.textContent?.includes("No new search was made"));
});

test("fresh results carry no cache note", async () => {
  await mountOpen();
  await search();

  assert.equal(document.body.querySelector("[data-cached-note]"), null);
});

test("a limiter that is down is reported as a brief outage, not as a limit", async () => {
  discoverSources.mockRejectedValue(
    new HttpClientError({
      message: "x",
      status: 503,
      statusText: "Service Unavailable",
      code: "RATE_LIMIT_UNAVAILABLE",
    }),
  );
  await mountOpen();
  await typeTopic("solid state batteries");
  await click(buttonNamed("Find sources")!);
  await flush();

  assert.ok(text().includes("unavailable for a moment"));
  assert.equal(document.body.querySelector("[data-rate-limit-notice]"), null);
});
