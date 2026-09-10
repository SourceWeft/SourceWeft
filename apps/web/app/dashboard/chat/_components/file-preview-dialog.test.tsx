// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, test, vi } from "vitest";
import { FilePreviewDialog } from "./file-preview-dialog";
let root: Root, container: HTMLDivElement;
beforeEach(() => {
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
test("text preview is an application dialog with a filename, path and copy action", async () => {
  await act(async () =>
    root.render(
      createElement(FilePreviewDialog, {
        open: true,
        onOpenChange: () => {},
        path: "/local/report.txt",
        contentText: "first line\nsecond line",
      }),
    ),
  );
  const dialog = document.querySelector('[role="dialog"]');
  assert(dialog);
  assert.match(dialog.textContent ?? "", /report.txt/);
  assert.match(dialog.textContent ?? "", /first line/);
  assert.ok(dialog.querySelector('[aria-label="Copy preview"]'));
  assert.equal(
    document.activeElement,
    dialog.querySelector('[aria-label="File contents"]'),
  );
});
test("markdown offers rendered preview and source while empty text is explicit", async () => {
  await act(async () =>
    root.render(
      createElement(FilePreviewDialog, {
        open: true,
        onOpenChange: () => {},
        path: "/local/readme.md",
        contentText: "# Local document\n\nPreview this text.",
      }),
    ),
  );
  const dialog = document.querySelector('[role="dialog"]');
  assert(dialog);
  assert.ok(dialog.querySelector('[role="tab"]'));
  assert.match(dialog.textContent ?? "", /Preview/);
  assert.match(dialog.textContent ?? "", /Source/);
  await act(async () =>
    root.render(
      createElement(FilePreviewDialog, {
        open: true,
        onOpenChange: () => {},
        path: "/local/empty.txt",
        contentText: "",
      }),
    ),
  );
  assert.match(
    document.querySelector('[role="dialog"]')?.textContent ?? "",
    /This file is empty/,
  );
});
