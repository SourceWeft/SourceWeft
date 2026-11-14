// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";

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
  const { HttpClientError } = await import("@sourceweft/sdk");
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
