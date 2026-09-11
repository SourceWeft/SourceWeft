// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { Blob as NodeBlob } from "node:buffer";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { FileReference } from "@sourceweft/contracts";
import { FileCitationPreview } from "./file-citation-preview";

const api = vi.hoisted(() => ({
  read: vi.fn(),
  localRequest: vi.fn(),
  readLocal: vi.fn(),
}));
vi.mock("../../../../lib/sdk", () => ({
  contentClient: { readFileBlob: api.read },
}));
vi.mock("../../../../lib/local-execution", () => ({
  localRequest: api.localRequest,
}));
vi.mock("../../../../lib/local-file-preview", () => ({
  readLocalPreviewBlob: api.readLocal,
}));
vi.mock("@sourceweft/preview/react", () => ({
  Preview: () =>
    createElement(
      "div",
      { "data-testid": "original-file" },
      "Original content",
    ),
}));
let container: HTMLDivElement, root: Root;
const reference: FileReference = {
  workspaceId: "workspace",
  threadId: "thread",
  presentation: "text",
  locator: { kind: "lines", start: 2, end: 2 },
  file: {
    scopeKind: "files",
    backendKind: "cloud_vfs",
    fileId: "file",
    name: "report.txt",
    relativePath: "report.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
    revision: `sha256:${createHash("sha256").update("cited").digest("hex")}`,
    origin: "user_provided",
    capabilities: {
      readText: true,
      readDocument: true,
      searchText: true,
      viewImage: false,
      write: true,
    },
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(fileReference: FileReference = reference) {
  await act(async () =>
    root.render(
      createElement(FileCitationPreview, {
        reference: fileReference,
        excerpt: "<script>cited</script>",
        open: true,
        onOpenChange: () => {},
      }),
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}
it("verifies the cited version and displays the actual location as escaped text", async () => {
  api.read.mockResolvedValue(new NodeBlob(["cited"]));
  await render();
  expect(document.body.textContent).toContain("Files · Cloud · Line 2");
  expect(document.body.textContent).toContain("Cited version verified");
  expect(document.body.textContent).toContain("<script>cited</script>");
  expect(document.querySelector("script")).toBeNull();
  expect(api.read).toHaveBeenCalledWith(
    "workspace",
    "thread",
    "/files/report.txt",
    expect.any(AbortSignal),
  );
});
it("does not silently show newer bytes as the cited version", async () => {
  api.read.mockResolvedValue(new NodeBlob(["new version"]));
  await render();
  expect(document.body.textContent).toContain("File changed since cited");
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Original file")!
      .click(),
  );
  expect(document.querySelector('[data-testid="original-file"]')).toBeNull();
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Open current version")!
      .click(),
  );
  expect(
    document.querySelector('[data-testid="original-file"]'),
  ).not.toBeNull();
});

it("reads local citation roots with GET semantics and verifies the rooted file", async () => {
  api.localRequest.mockResolvedValue({ root: "/private/tmp/test-directory" });
  api.readLocal.mockResolvedValue(new NodeBlob(["cited"]));
  await render({
    ...reference,
    file: { ...reference.file, backendKind: "local_fs" },
  });
  expect(api.localRequest).toHaveBeenCalledWith(
    "/v1/workspaces/workspace/threads/thread/local-files",
  );
  expect(api.readLocal).toHaveBeenCalledWith(
    "/v1/workspaces/workspace/threads/thread/local-files?download=true&path=%2Fprivate%2Ftmp%2Ftest-directory%2Freport.txt",
    expect.any(AbortSignal),
  );
  expect(document.body.textContent).toContain("Cited version verified");
  expect(api.read).not.toHaveBeenCalled();
});
