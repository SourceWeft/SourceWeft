// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../../../lib/local-execution", () => ({
  localRequest: mocks.request,
}));
vi.mock("../../../../lib/local-file-download", () => ({
  downloadLocalFile: vi.fn(),
}));
import { LocalFilesPanel } from "./local-files-panel";
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.request
    .mockReset()
    .mockImplementation(async (path: string) =>
      path.includes("content=true")
        ? { content: "physical file content" }
        : {
            root: "/local/task",
            path: "/local/task",
            files: [
              { path: "/local/task/report.txt", size: 21, is_dir: false },
            ],
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
  assert.match(container.textContent ?? "", /physical file content/);
  mocks.request.mockRejectedValue(new Error("DEVICE_OFFLINE"));
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  assert.match(container.textContent ?? "", /DEVICE_OFFLINE/);
  assert.equal(container.textContent?.includes("physical file content"), false);
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
