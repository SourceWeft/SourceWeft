// @vitest-environment jsdom

import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { buttons, click, flush, mountWithIntl, unmountAll } from "@/test/react";

const mocks = vi.hoisted(() => ({
  exportRecords: vi.fn(),
  clearRecords: vi.fn(),
}));

vi.mock("../../../../../lib/sdk", () => ({
  contentClient: {
    exportArtifactRecords: mocks.exportRecords,
    clearArtifactRecords: mocks.clearRecords,
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ArtifactPageData, pageDataFileName } from "./artifact-page-data";
import type { ArtifactListItem } from "../sources-hub/types";

afterEach(unmountAll);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.clearRecords.mockResolvedValue({ removed: 3 });
});

function artifact(
  overrides: Record<string, unknown> = {},
  capabilities?: string[],
) {
  return {
    id: "art-1",
    artifactType: "html",
    status: "ready",
    payloadJson: {
      metadata: capabilities
        ? { schemaVersion: 1, capabilities }
        : { schemaVersion: 1 },
    },
    ...overrides,
  } as unknown as ArtifactListItem;
}

function panel(item: ArtifactListItem, workspaceId: string | null = "ws-1") {
  return mountWithIntl(
    <ArtifactPageData artifact={item} title="Page" workspaceId={workspaceId} />,
  );
}

test("nothing renders unless an HTML artifact declares storage", async () => {
  for (const item of [
    artifact({}, undefined),
    artifact({ artifactType: "report" }, ["storage"]),
    artifact({ status: "pending" }, ["storage"]),
  ]) {
    const view = await panel(item);
    assert.equal(view.container.textContent, "");
  }
  const noWorkspace = await panel(artifact({}, ["storage"]), null);
  assert.equal(noWorkspace.container.textContent, "");
});

test("personal storage offers only the user's own data", async () => {
  const view = await panel(artifact({}, ["storage"]));
  assert.equal(buttons("Export data", view.container).length, 1);
  assert.equal(buttons("Clear data", view.container).length, 1);
  assert.ok(!view.container.textContent?.includes("Shared data"));
});

test("shared storage adds a shared row, and clearing asks for confirmation naming the scope", async () => {
  const view = await panel(artifact({}, ["storage.shared"]));
  const clear = buttons("Clear data", view.container);
  assert.equal(clear.length, 2);
  await click(clear[1]!);
  assert.equal(mocks.clearRecords.mock.calls.length, 0);
  assert.match(document.body.textContent ?? "", /Clear shared data\?/u);
  await click(buttons("Clear data").at(-1)!);
  await flush(3);
  assert.deepEqual(mocks.clearRecords.mock.calls[0], [
    "ws-1",
    "art-1",
    "shared",
  ]);
});

test("export requests the chosen scope", async () => {
  mocks.exportRecords.mockResolvedValue(new Blob(["{}"]));
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
  const saved: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push(this.download);
  });
  const view = await panel(artifact({}, ["storage.shared"]));
  await click(buttons("Export data", view.container)[0]!);
  await flush(3);
  assert.deepEqual(mocks.exportRecords.mock.calls[0], [
    "ws-1",
    "art-1",
    "user",
  ]);
  assert.deepEqual(saved, ["Page-user-data.json"]);
});

test("file names are safe whatever the title holds", () => {
  assert.equal(
    pageDataFileName("My/Page: v2", "user"),
    "My-Page-v2-user-data.json",
  );
  assert.equal(pageDataFileName("///", "shared"), "artifact-shared-data.json");
});
