// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  button,
  click,
  flush,
  mountWithIntl,
  typeInto,
  unmountAll,
} from "@/test/react";

const listArtifactSharedCollections = vi.hoisted(() => vi.fn());

vi.mock("../../../../../lib/sdk", () => ({
  contentClient: { listArtifactSharedCollections },
}));

import { PublicCollectionsPicker } from "./public-collections-picker";

const onSave = vi.fn<(collections: string[]) => Promise<void>>(async () => {});

async function mountPicker(saved: string[] = []) {
  const mounted = await mountWithIntl(
    createElement(PublicCollectionsPicker, {
      workspaceId: "ws-1",
      artifactId: "art-1",
      saved,
      onSave,
    }),
  );
  await flush(4);
  return mounted;
}

function switches(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[role="switch"]')];
}

beforeEach(() => {
  listArtifactSharedCollections.mockReset();
  onSave.mockClear();
});
afterEach(unmountAll);

test("shows a loading state until the collections arrive", async () => {
  listArtifactSharedCollections.mockReturnValue(new Promise(() => undefined));
  const { container } = await mountPicker();
  assert.match(container.textContent ?? "", /Loading collections/);
  assert.equal(switches(container).length, 0);
});

test("shows an error with a retry that reloads", async () => {
  listArtifactSharedCollections.mockRejectedValueOnce(new Error("boom"));
  const { container } = await mountPicker();
  assert.match(container.textContent ?? "", /Couldn't load/);
  listArtifactSharedCollections.mockResolvedValue({
    collections: [{ collection: "posts", count: 1 }],
  });
  await click(button("Try again"));
  await flush(4);
  assert.match(container.textContent ?? "", /posts/);
  assert.equal(listArtifactSharedCollections.mock.calls.length, 2);
});

test("lists existing collections with counts and saves toggled ones", async () => {
  listArtifactSharedCollections.mockResolvedValue({
    collections: [
      { collection: "comments", count: 1 },
      { collection: "posts", count: 3 },
    ],
  });
  const { container } = await mountPicker(["posts"]);
  const text = container.textContent ?? "";
  assert.match(text, /3 records/);
  assert.match(text, /1 record(?!s)/);
  const [comments, posts] = switches(container);
  assert.equal(comments!.getAttribute("aria-checked"), "false");
  assert.equal(posts!.getAttribute("aria-checked"), "true");
  assert.equal(button("Save").disabled, true);

  await click(comments!);
  assert.equal(button("Save").disabled, false);
  await click(button("Save"));
  assert.deepEqual(onSave.mock.calls[0]?.[0], ["posts", "comments"]);
});

test("keeps a public collection with no data listed and removable", async () => {
  listArtifactSharedCollections.mockResolvedValue({ collections: [] });
  const { container } = await mountPicker(["ghost"]);
  const row = container.querySelector("[data-no-data]");
  assert.ok(row);
  assert.match(row.textContent ?? "", /ghost/);
  assert.match(row.textContent ?? "", /No data yet/);
  await click(row.querySelector("button")!);
  assert.equal(container.querySelector("[data-no-data]"), null);
  await click(button("Save"));
  assert.deepEqual(onSave.mock.calls[0]?.[0], []);
});

test("validates a typed collection name before adding it", async () => {
  listArtifactSharedCollections.mockResolvedValue({ collections: [] });
  const { container } = await mountPicker();
  const input = container.querySelector("input")!;
  typeInto(input, "bad name!");
  await flush();
  await click(button("Add"));
  assert.match(container.textContent ?? "", /letters, digits/);
  assert.equal(container.querySelector("[data-no-data]"), null);

  typeInto(input, "scores");
  await flush();
  await click(button("Add"));
  const row = container.querySelector("[data-no-data]");
  assert.match(row?.textContent ?? "", /scores/);
  await click(button("Save"));
  assert.deepEqual(onSave.mock.calls[0]?.[0], ["scores"]);
});

test("says so when the artifact has no shared data", async () => {
  listArtifactSharedCollections.mockResolvedValue({ collections: [] });
  const { container } = await mountPicker();
  assert.match(container.textContent ?? "", /no shared data yet/);
});
