// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { HttpClientError } from "@sourceweft/sdk";
import type { ArtifactListItem } from "../sources-hub/types";

const readArtifactVersionSourceFile = vi.hoisted(() => vi.fn());

vi.mock("../../../../../lib/sdk", () => ({
  contentClient: { readArtifactVersionSourceFile },
}));
vi.mock("../source-preview-panel", () => ({
  SourcePreviewPanel: (props: {
    citation: { sourceId: string; documentId: string; chunkId: string };
    open: boolean;
  }) =>
    createElement("div", {
      "data-testid": "source-preview",
      "data-source": props.citation.sourceId,
      "data-document": props.citation.documentId,
      "data-chunk": props.citation.chunkId,
      "data-open": String(props.open),
    }),
}));
vi.mock("../file-citation-preview", () => ({
  FileCitationPreview: (props: {
    reference: {
      file: { relativePath: string; revision: string; name: string };
      locator: { kind: string };
    };
    excerpt: string;
    open: boolean;
  }) =>
    createElement("div", {
      "data-testid": "file-preview",
      "data-path": props.reference.file.relativePath,
      "data-revision": props.reference.file.revision,
      "data-name": props.reference.file.name,
      "data-locator": props.reference.locator.kind,
      "data-excerpt": props.excerpt,
      "data-open": String(props.open),
    }),
}));

import { ReportEvidencePanel } from "./report-evidence-panel";
import { resetReportEvidenceCache } from "./report-evidence-loader";
import {
  click,
  flush,
  mountWithIntl,
  unmountAll,
  withIntl,
} from "@/test/react";

const REVISION = `sha256:${"a".repeat(64)}`;

function artifact(overrides: Partial<ArtifactListItem> = {}): ArtifactListItem {
  return {
    id: "artifact-1",
    artifactVersionId: "version-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    artifactType: "html",
    status: "ready",
    title: "Quarterly report",
    promptText: null,
    payloadJson: {},
    storageBucket: null,
    storageKey: null,
    previewStorageKey: null,
    previewMetadataJson: {},
    errorCode: null,
    errorMessage: null,
    visibility: "private",
    isPublic: false,
    createdBy: "user-1",
    completedAt: "2026-10-17T00:00:00.000Z",
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
    previewUrl: null,
    capabilities: {
      canDownloadFile: true,
      canOpenFile: true,
      canPreviewInline: true,
      canRenderClientSide: false,
    },
    ...overrides,
  };
}

const reportSource = {
  sources: [
    {
      id: "S1",
      display: { title: "Library doc", locator: "Section 2" },
      provenance: {
        kind: "chunk",
        sourceId: "source-1",
        documentId: "document-1",
        chunkId: "chunk-1",
        chunkNo: 3,
      },
    },
    {
      id: "S2",
      display: { title: "notes/a.md", locator: "Lines 1–3" },
      provenance: {
        kind: "file",
        workspaceId: "workspace-1",
        threadId: "thread-1",
        backendKind: "cloud_vfs",
        fileId: "file-1",
        relativePath: "notes/a.md",
        revision: REVISION,
        locator: { kind: "lines", start: 1, end: 3 },
      },
    },
    {
      id: "S3",
      display: { title: "Example site", url: "https://example.com/page" },
      provenance: { kind: "external", url: "https://example.com/page" },
    },
    {
      id: "S4",
      display: { title: "Legacy row" },
      provenance: { note: "free-form" },
    },
  ],
};

function notFound() {
  return new HttpClientError({
    message: "not found",
    status: 404,
    statusText: "Not Found",
    code: "ARTIFACT_VERSION_FILE_NOT_FOUND",
  });
}

async function mountPanel(item: ArtifactListItem, workspaceId = "workspace-1") {
  const mounted = await mountWithIntl(
    createElement(ReportEvidencePanel, { artifact: item, workspaceId }),
  );
  await flush(4);
  return mounted;
}

beforeEach(() => {
  readArtifactVersionSourceFile.mockReset();
  resetReportEvidenceCache();
});
afterEach(unmountAll);
afterEach(() => {
  vi.unstubAllGlobals();
});

test("renders nothing when the version has no private source file", async () => {
  readArtifactVersionSourceFile.mockRejectedValue(notFound());
  const { container } = await mountPanel(artifact());
  assert.equal(container.innerHTML, "");
  assert.deepEqual(readArtifactVersionSourceFile.mock.calls, [
    ["workspace-1", "artifact-1", "version-1", "report.source.json"],
  ]);
});

test("renders nothing when the file is not a report source", async () => {
  readArtifactVersionSourceFile.mockResolvedValue({ unrelated: true });
  const { container } = await mountPanel(artifact());
  assert.equal(container.innerHTML, "");
});

test("does not read the source file for non-report or unfinished artifacts", async () => {
  readArtifactVersionSourceFile.mockResolvedValue(reportSource);
  await mountPanel(artifact({ artifactType: "slides" }));
  await mountPanel(artifact({ status: "pending" }));
  await mountPanel(artifact({ artifactVersionId: null }));
  await mountPanel(artifact(), null as unknown as string);
  assert.equal(readArtifactVersionSourceFile.mock.calls.length, 0);
});

test("lists every source with its kind and marks legacy rows unresolvable", async () => {
  readArtifactVersionSourceFile.mockResolvedValue(reportSource);
  const { container } = await mountPanel(artifact());
  const rows = [...container.querySelectorAll("li")];
  assert.deepEqual(
    rows.map((row) => row.getAttribute("data-evidence-kind")),
    ["chunk", "file", "external", "legacy"],
  );
  assert.deepEqual(
    rows.map((row) => Boolean(row.querySelector("button"))),
    [true, true, true, false],
  );
  const text = container.textContent ?? "";
  assert.match(text, /Evidence \(4\)/);
  assert.match(text, /S1/);
  assert.match(text, /Library doc/);
  assert.match(text, /Section 2/);
  assert.match(text, /https:\/\/example\.com\/page/);
  assert.match(text, /This reference cannot be opened/);
  // The url is kept as text, never as a link.
  assert.equal(container.querySelector("a"), null);
});

test("opens the source-library preview for a chunk row", async () => {
  readArtifactVersionSourceFile.mockResolvedValue(reportSource);
  const { container } = await mountPanel(artifact());
  await click(container.querySelector<HTMLButtonElement>("li button")!);
  await flush(6);
  const preview = container.querySelector("[data-testid='source-preview']");
  assert.ok(preview, "source preview should mount");
  assert.equal(preview.getAttribute("data-source"), "source-1");
  assert.equal(preview.getAttribute("data-document"), "document-1");
  assert.equal(preview.getAttribute("data-chunk"), "chunk-1");
  assert.equal(preview.getAttribute("data-open"), "true");
});

test("opens the file citation preview with a synthesized reference for a file row", async () => {
  readArtifactVersionSourceFile.mockResolvedValue(reportSource);
  const { container } = await mountPanel(artifact());
  const buttons = container.querySelectorAll<HTMLButtonElement>("li button");
  await click(buttons[1]!);
  await flush(6);
  const preview = container.querySelector("[data-testid='file-preview']");
  assert.ok(preview, "file preview should mount");
  assert.equal(preview.getAttribute("data-path"), "notes/a.md");
  assert.equal(preview.getAttribute("data-name"), "a.md");
  assert.equal(preview.getAttribute("data-revision"), REVISION);
  assert.equal(preview.getAttribute("data-locator"), "lines");
  assert.equal(preview.getAttribute("data-excerpt"), "notes/a.md");
  assert.equal(preview.getAttribute("data-open"), "true");
});

test("opens an external row in a new tab without opener access", async () => {
  readArtifactVersionSourceFile.mockResolvedValue(reportSource);
  const open = vi.fn();
  vi.stubGlobal("open", open);
  const { container } = await mountPanel(artifact());
  const buttons = container.querySelectorAll<HTMLButtonElement>("li button");
  await click(buttons[2]!);
  assert.deepEqual(open.mock.calls, [
    ["https://example.com/page", "_blank", "noopener,noreferrer"],
  ]);
  assert.equal(container.querySelector("[data-testid='source-preview']"), null);
  assert.equal(container.querySelector("[data-testid='file-preview']"), null);
});

test("reads each artifact version once", async () => {
  readArtifactVersionSourceFile.mockResolvedValue(reportSource);
  const mounted = await mountPanel(artifact());
  await mounted.render(
    withIntl(
      createElement(ReportEvidencePanel, {
        artifact: artifact({ artifactVersionId: "version-2" }),
        workspaceId: "workspace-1",
      }),
    ),
  );
  await flush(4);
  await mounted.render(
    withIntl(
      createElement(ReportEvidencePanel, {
        artifact: artifact(),
        workspaceId: "workspace-1",
      }),
    ),
  );
  await flush(4);
  assert.deepEqual(
    readArtifactVersionSourceFile.mock.calls.map((call) => call[2]),
    ["version-1", "version-2"],
  );
});

test("panels mounted at the same time share one source-file request", async () => {
  let release: (value: unknown) => void = () => {};
  readArtifactVersionSourceFile.mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const first = await mountWithIntl(
    createElement(ReportEvidencePanel, {
      artifact: artifact(),
      workspaceId: "workspace-1",
    }),
  );
  const second = await mountWithIntl(
    createElement(ReportEvidencePanel, {
      artifact: artifact(),
      workspaceId: "workspace-1",
    }),
  );
  await flush(2);
  assert.equal(readArtifactVersionSourceFile.mock.calls.length, 1);
  release(reportSource);
  await flush(4);
  assert.equal(
    first.container.querySelectorAll("button[aria-label^='Open evidence']")
      .length,
    3,
  );
  assert.equal(
    second.container.querySelectorAll("button[aria-label^='Open evidence']")
      .length,
    3,
  );
  assert.equal(readArtifactVersionSourceFile.mock.calls.length, 1);
});

test("a remembered 404 is not requested again by a later panel", async () => {
  readArtifactVersionSourceFile.mockRejectedValue(notFound());
  const first = await mountPanel(artifact());
  await first.unmount();
  const { container } = await mountPanel(artifact());
  assert.equal(container.innerHTML, "");
  assert.equal(readArtifactVersionSourceFile.mock.calls.length, 1);
});

test("a transient failure is retried by a later panel", async () => {
  readArtifactVersionSourceFile.mockRejectedValueOnce(
    new HttpClientError({
      message: "upstream",
      status: 502,
      statusText: "Bad Gateway",
      code: "UPSTREAM",
    }),
  );
  const first = await mountPanel(artifact());
  assert.equal(first.container.innerHTML, "");
  await first.unmount();
  readArtifactVersionSourceFile.mockResolvedValueOnce(reportSource);
  const { container } = await mountPanel(artifact());
  assert.equal(
    container.querySelectorAll("button[aria-label^='Open evidence']").length,
    3,
  );
  assert.equal(readArtifactVersionSourceFile.mock.calls.length, 2);
});
