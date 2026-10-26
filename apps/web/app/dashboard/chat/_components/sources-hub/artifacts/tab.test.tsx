// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";

import { mountWithIntl, unmountAll } from "@/test/react";
import en from "@/messages/en.json";
import type { ArtifactSummaryItem } from "../types";
import { ArtifactsTab } from "./tab";

afterEach(unmountAll);

const label = en.dashboardSourcesHub.artifacts.awaitingApproval;

function item(overrides: Partial<ArtifactSummaryItem>): ArtifactSummaryItem {
  return {
    id: "artifact-1",
    workspaceId: "workspace-1",
    threadId: null,
    artifactType: "html",
    status: "ready",
    title: "Team tracker",
    promptExcerpt: null,
    visibility: "workspace",
    isPublic: false,
    awaitingSharedApproval: false,
    createdAt: "2026-06-01T00:00:00.000Z",
    completedAt: "2026-06-01T00:00:01.000Z",
    updatedAt: "2026-06-01T00:00:01.000Z",
    hasPrimaryFile: false,
    primaryFileUrl: null,
    previewImage: null,
    ...overrides,
  };
}

async function render(artifacts: ArtifactSummaryItem[]) {
  return mountWithIntl(
    <ArtifactsTab
      artifacts={artifacts}
      hasMore={false}
      isLoading={false}
      isLoadingMore={false}
      loadingError={null}
      onLoadMore={vi.fn()}
      onPreview={vi.fn()}
      onRefresh={vi.fn()}
      searchQuery=""
      workspaceId="workspace-1"
    />,
  );
}

test("flags only artifacts waiting for shared-data approval", async () => {
  const { container } = await render([
    item({ id: "a", title: "Waiting page", awaitingSharedApproval: true }),
    item({ id: "b", title: "Approved page", awaitingSharedApproval: false }),
  ]);
  const rows = [...container.querySelectorAll("button")];
  expect(rows).toHaveLength(2);
  expect(rows[0]!.textContent).toContain(label);
  expect(rows[1]!.textContent).not.toContain(label);
});

test("a viewer's list (flag false everywhere) shows no marker", async () => {
  const { container } = await render([item({ awaitingSharedApproval: false })]);
  expect(container.textContent).not.toContain(label);
});

test("the marker sits beside the Public badge without replacing it", async () => {
  const { container } = await render([
    item({ isPublic: true, awaitingSharedApproval: true }),
  ]);
  expect(container.textContent).toContain(
    en.dashboardSourcesHub.artifacts.public,
  );
  expect(container.textContent).toContain(label);
});
