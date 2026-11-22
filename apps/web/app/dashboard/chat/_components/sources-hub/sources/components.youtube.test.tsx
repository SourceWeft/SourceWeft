// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, test } from "vitest";

import { mapSourcesToUi, type SourceApiRecord } from "../source-mapping";
import { SourceTreeRow } from "./components";
import { mountWithIntl, unmountAll } from "@/test/react";

afterEach(unmountAll);

function record(overrides: Partial<SourceApiRecord>): SourceApiRecord {
  return {
    id: "s1",
    teamId: "t1",
    workspaceId: "w1",
    ingestKind: "url",
    sourceType: "youtube",
    connectorId: null,
    syncRunId: null,
    parentSourceId: null,
    title: "Lecture 1",
    contentText: "",
    externalId: null,
    externalUri: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    externalUpdatedAt: null,
    mimeType: "text/markdown",
    sizeBytes: null,
    contentHash: null,
    storageBucket: null,
    storageKey: null,
    previewUrl: null,
    downloadUrl: null,
    status: "indexed",
    estimatedPages: null,
    parsedTokens: null,
    parserVersion: null,
    parsingConfig: null,
    metadata: {},
    error: {},
    createdBy: null,
    indexedAt: null,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    ...overrides,
  } as SourceApiRecord;
}

async function renderRow(source: SourceApiRecord) {
  const [item] = mapSourcesToUi([source], "en");
  const noop = () => {};
  await mountWithIntl(
    createElement(SourceTreeRow, {
      node: { source: item!, children: [] },
      depth: 0,
      selectionStateById: new Map(),
      onToggle: noop,
      rowBusyById: {},
      editingId: null,
      editingTitle: "",
      onEditTitleChange: noop,
      onStartRename: noop,
      onCancelRename: noop,
      onSubmitRename: noop,
      onAddSource: noop,
      onCreateDirectory: noop,
      onDelete: noop,
      onDownload: noop,
      onEditReadme: noop,
      onMove: noop,
      onPreview: noop,
      onReindex: noop,
      onRetry: noop,
      expandedDirectoryIds: new Set<string>(),
      userCollapsedDirectoryIds: new Set<string>(),
      onDirectoryExpandedChange: noop,
    }),
  );
}

test("YOUTUBE_NO_SPEECH renders the localized message", async () => {
  await renderRow(
    record({
      status: "failed",
      error: { code: "YOUTUBE_NO_SPEECH", message: "raw provider text" },
    }),
  );

  expect(document.body.textContent).toContain(
    "No speech was found in this video",
  );
  expect(document.body.textContent).not.toContain("Processing failed");
});

test("an unknown failure code keeps today's failed label", async () => {
  await renderRow(
    record({
      status: "failed",
      error: { code: "PARSE_FAILED", message: "raw" },
    }),
  );

  expect(document.body.textContent).toContain("Processing failed");
});

test("an AI transcript carries the AI transcription badge", async () => {
  await renderRow(
    record({ metadata: { transcriptOrigin: "ai_transcription" } }),
  );
  expect(document.body.textContent).toContain("AI transcription");

  await unmountAll();
  await renderRow(record({ sourceType: "web_url", metadata: {} }));
  expect(document.body.textContent).not.toContain("AI transcription");
});
