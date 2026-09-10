// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  download: vi.fn(),
  preview: vi.fn(),
}));
vi.mock("../../../../lib/local-execution", () => ({
  localRequest: mocks.request,
}));
vi.mock("../../../../lib/local-file-download", () => ({
  downloadLocalFile: mocks.download,
}));
vi.mock("../../../../lib/local-file-preview", () => ({
  readLocalPreviewBlob: mocks.preview,
}));
vi.mock("@sourceweft/preview/react", () => ({
  Preview: ({ source }: { source: { name: string } }) =>
    createElement("div", { "data-testid": "shared-preview" }, source.name),
}));
import { LocalFilesPanel } from "./local-files-panel";
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.preview
    .mockReset()
    .mockResolvedValue(new Blob(["physical file content"]));
  mocks.download.mockReset().mockResolvedValue(undefined);
  mocks.request.mockReset().mockImplementation(async (path: string) =>
    path.includes("content=true")
      ? { content: "physical file content" }
      : {
          root: "/local/task",
          path: "/local/task",
          files: [{ path: "/local/task/report.txt", size: 21, is_dir: false }],
        },
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
test("Hub Workfiles reads the PC directory and clears its preview when offline", async () => {
  await act(async () =>
    root.render(
      createElement(LocalFilesPanel, {
        workspaceId: "w",
        threadId: "t",
        variant: "hub",
        computerName: "Mac A",
      }),
    ),
  );
  assert.match(container.textContent ?? "", /Workfiles/);
  assert.match(container.textContent ?? "", /This computer · Mac A/);
  assert.match(container.textContent ?? "", /report.txt/);
  assert.equal(container.querySelector('[aria-label="Close files"]'), null);
  const file = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "report.txt",
  );
  assert(file);
  await act(async () => file.click());
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.ok(dialog.querySelector('[data-testid="shared-preview"]'));
  assert.ok(mocks.preview.mock.calls[0]?.[0].includes("download=true"));
  assert.equal(
    container.contains(dialog),
    false,
    "Preview is an in-app overlay, not inline list content",
  );
  assert.equal(
    file.isConnected,
    true,
    "Opening preview keeps the original list mounted",
  );
  mocks.request.mockRejectedValue(new Error("DEVICE_OFFLINE"));
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  assert.match(container.textContent ?? "", /DEVICE_OFFLINE/);
  assert.equal(
    document.body.textContent?.includes("physical file content"),
    false,
  );
  assert.ok(
    mocks.request.mock.calls.every(
      ([path]) =>
        String(path).includes("/local-files") &&
        !String(path).includes("/working-files"),
    ),
  );
});
test("Hub search filters physical filenames without changing the file store", async () => {
  await act(async () =>
    root.render(
      createElement(LocalFilesPanel, {
        workspaceId: "w",
        threadId: "t",
        variant: "hub",
        searchQuery: "missing",
      }),
    ),
  );
  assert.match(container.textContent ?? "", /No files match/);
  assert.equal(container.textContent?.includes("report.txt"), false);
});

test("directories navigate instead of opening a file preview", async () => {
  mocks.request.mockImplementation(async (url: string) => ({
    root: "/local/task",
    path: url.includes("?path=") ? "/local/task/docs" : "/local/task",
    files: url.includes("?path=")
      ? []
      : [{ path: "/local/task/docs", is_dir: true }],
  }));
  await act(async () =>
    root.render(
      createElement(LocalFilesPanel, {
        workspaceId: "w",
        threadId: "t",
        variant: "hub",
      }),
    ),
  );
  const folder = container.querySelector<HTMLButtonElement>(
    '[aria-label="Open folder docs"]',
  );
  assert(folder);
  await act(async () => folder.click());
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.match(container.textContent ?? "", /\/local\/task\/docs/);
  assert.ok(
    mocks.request.mock.calls.every(
      ([url]) => !String(url).includes("content=true"),
    ),
  );
});

test("preview opens immediately without refetching the list and ignores a late response after closing", async () => {
  let finish!: (value: Blob) => void;
  const pending = new Promise<Blob>((resolve) => {
    finish = resolve;
  });
  mocks.preview.mockReturnValue(pending);
  await act(async () =>
    root.render(
      createElement(LocalFilesPanel, { workspaceId: "w", threadId: "t" }),
    ),
  );
  const file = container.querySelector<HTMLButtonElement>(
    '[aria-label="Preview report.txt"]',
  );
  assert(file);
  await act(async () => file.click());
  const dialog = document.querySelector('[role="dialog"]');
  assert(dialog);
  assert.match(dialog.textContent ?? "", /Loading file preview/);
  assert.equal(file.isConnected, true);
  assert.equal(
    mocks.request.mock.calls.filter(
      ([url]) => !String(url).includes("content=true"),
    ).length,
    1,
  );
  const close = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Close",
  );
  assert(close);
  await act(async () => close.click());
  await act(async () => finish(new Blob(["late content"])));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  assert.equal(
    document.activeElement,
    file,
    "Closing preview restores keyboard focus to its file row",
  );
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.body.textContent?.includes("late content"), false);
});

test("failed binary reads show the error and retain the download action", async () => {
  mocks.preview.mockRejectedValue(new Error("File read failed"));
  await act(async () =>
    root.render(
      createElement(LocalFilesPanel, { workspaceId: "w", threadId: "t" }),
    ),
  );
  const file = container.querySelector<HTMLButtonElement>(
    '[aria-label="Preview report.txt"]',
  );
  assert(file);
  await act(async () => file.click());
  const dialog = document.querySelector('[role="dialog"]');
  assert(dialog);
  assert.match(dialog.textContent ?? "", /File read failed/);
  const download = dialog.querySelector<HTMLButtonElement>(
    '[aria-label="Download file"]',
  );
  assert(download);
  await act(async () => download.click());
  assert.equal(mocks.download.mock.calls[0]?.[1], "report.txt");
  assert.match(mocks.download.mock.calls[0]?.[0], /download=true/);
});

test("changing conversations closes the old preview and resets directory navigation", async () => {
  await act(async () =>
    root.render(
      createElement(LocalFilesPanel, { workspaceId: "w", threadId: "first" }),
    ),
  );
  const file = container.querySelector<HTMLButtonElement>(
    '[aria-label="Preview report.txt"]',
  );
  assert(file);
  await act(async () => file.click());
  assert.ok(document.querySelector('[role="dialog"]'));
  await act(async () =>
    root.render(
      createElement(LocalFilesPanel, { workspaceId: "w", threadId: "second" }),
    ),
  );
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(
    document.body.textContent?.includes("physical file content"),
    false,
  );
  assert.ok(
    mocks.request.mock.calls.some(
      ([url]) => url === "/v1/workspaces/w/threads/second/local-files",
    ),
  );
});
