// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { afterEach, test, vi } from "vitest";
vi.mock("@sourceweft/preview/react", () => ({
  Preview: ({ source }: { source: { name: string; text?: string } }) =>
    createElement(
      "div",
      { "data-testid": "shared-preview", "data-name": source.name },
      source.text,
    ),
}));
import { FilePreviewDialog } from "./file-preview-dialog";
import { mountWithIntl, unmountAll, withIntl } from "@/test/react";
afterEach(unmountAll);
test("file actions stay in the dialog header, including when preview fails", async () => {
  const download = vi.fn();
  await mountWithIntl(
    createElement(FilePreviewDialog, {
      open: true,
      onOpenChange: () => {},
      path: "/local/report.pdf",
      error: "Could not load file",
      onDownload: download,
    }),
  );
  const dialog = document.querySelector('[role="dialog"]');
  const buttons = dialog!.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Download file"]',
  );
  assert.equal(buttons.length, 1);
  await act(async () => buttons[0]!.click());
  assert.equal(download.mock.calls.length, 1);
});
test("text preview forwards its source to the shared preview inside the application dialog", async () => {
  await mountWithIntl(
    createElement(FilePreviewDialog, {
      open: true,
      onOpenChange: () => {},
      path: "/local/report.txt",
      contentText: "first line\nsecond line",
    }),
  );
  const dialog = document.querySelector('[role="dialog"]');
  assert(dialog);
  assert.match(dialog.textContent ?? "", /report.txt/);
  assert.match(dialog.textContent ?? "", /first line/);
  assert.equal(
    dialog
      .querySelector('[data-testid="shared-preview"]')
      ?.getAttribute("data-name"),
    "/local/report.txt",
  );
  assert.equal(
    document.activeElement,
    dialog.querySelector('[aria-label="File contents"]'),
  );
});
test("markdown uses the shared preview while empty text is explicit", async () => {
  const view = await mountWithIntl(
    createElement(FilePreviewDialog, {
      open: true,
      onOpenChange: () => {},
      path: "/local/readme.md",
      contentText: "# Local document\n\nPreview this text.",
    }),
  );
  const dialog = document.querySelector('[role="dialog"]');
  assert(dialog);
  assert.ok(dialog.querySelector('[data-testid="shared-preview"]'));
  assert.match(dialog.textContent ?? "", /Local document/);
  await view.render(
    withIntl(
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
