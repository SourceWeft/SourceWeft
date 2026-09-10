// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const { openPreview } = vi.hoisted(() => ({
  openPreview: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../../lib/desktop-bridge", () => ({
  desktopBridge: { isAvailable: () => true },
}));
vi.mock("../../../../lib/desktop-preview-bridge", () => ({
  openDesktopPreview: openPreview,
}));
vi.mock("sonner", () => ({
  toast: { loading: vi.fn(), dismiss: vi.fn(), error: vi.fn() },
}));
import { FilePreviewDialog } from "./file-preview-dialog";
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  openPreview.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
test("desktop opens the native reader and does not mount an inline dialog", async () => {
  const onOpenChange = vi.fn();
  await act(async () =>
    root.render(
      createElement(FilePreviewDialog, {
        open: true,
        path: "file.md",
        contentText: "# File",
        onOpenChange,
      }),
    ),
  );
  expect(openPreview).toHaveBeenCalledOnce();
  expect(openPreview.mock.calls[0]?.[0]).toMatchObject({
    name: "file.md",
    text: "# File",
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
test("desktop waits for authorized bytes before handing the file to native", async () => {
  const props = { open: true, path: "file.md", onOpenChange: vi.fn() };
  await act(async () =>
    root.render(createElement(FilePreviewDialog, { ...props, loading: true })),
  );
  expect(openPreview).not.toHaveBeenCalled();
  await act(async () =>
    root.render(
      createElement(FilePreviewDialog, { ...props, contentText: "ready" }),
    ),
  );
  expect(openPreview).toHaveBeenCalledOnce();
});
