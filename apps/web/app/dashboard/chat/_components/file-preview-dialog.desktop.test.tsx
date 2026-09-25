// @vitest-environment jsdom
import { createElement } from "react";
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
import { mountWithIntl, unmountAll, withIntl } from "@/test/react";
beforeEach(() => {
  openPreview.mockClear();
});
afterEach(unmountAll);
test("desktop opens the native reader and does not mount an inline dialog", async () => {
  const onOpenChange = vi.fn();
  await mountWithIntl(
    createElement(FilePreviewDialog, {
      open: true,
      path: "file.md",
      contentText: "# File",
      onOpenChange,
    }),
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
  const view = await mountWithIntl(
    createElement(FilePreviewDialog, { ...props, loading: true }),
  );
  expect(openPreview).not.toHaveBeenCalled();
  await view.render(
    withIntl(
      createElement(FilePreviewDialog, { ...props, contentText: "ready" }),
    ),
  );
  expect(openPreview).toHaveBeenCalledOnce();
});
