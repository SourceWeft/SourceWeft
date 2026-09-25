// @vitest-environment jsdom
import { act, createElement } from "react";
import { expect, test, vi } from "vitest";
import { AddSourceDialog } from "./dialogs";
import { mountWithIntl, unmountAll, withIntl } from "@/test/react";

test("file submission waits for a usable workspace, then resumes without a timer", async () => {
  const upload = vi.fn();
  const noop = () => {};
  const props = {
    addParentSourceId: null,
    addTab: "File" as const,
    files: [new File(["content"], "source.txt", { type: "text/plain" })],
    fileInputRef: { current: null },
    isDragActive: false,
    isOpen: true,
    isSubmitting: false,
    onAddFiles: noop,
    onAddTabChange: noop,
    onClose: noop,
    onCreateTextSource: noop,
    onCreateUrlSource: noop,
    onDragEnter: noop,
    onDragLeave: noop,
    onDragOver: noop,
    onDrop: noop,
    onRemoveFile: noop,
    onTextContentChange: noop,
    onTextTitleChange: noop,
    onUploadFiles: upload,
    onUrlTitleChange: noop,
    onUrlValueChange: noop,
    sources: [],
    textContent: "",
    textTitle: "",
    uploadProgress: 0,
    urlTitle: "",
    urlValue: "",
  };
  const button = () =>
    Array.from(document.querySelectorAll("button")).find(
      (node) => node.textContent?.trim() === "Upload files",
    )!;
  try {
    const view = await mountWithIntl(
      createElement(AddSourceDialog, { ...props, workspaceReady: false }),
    );
    expect(button().disabled).toBe(true);
    await act(async () => button().click());
    expect(upload).not.toHaveBeenCalled();
    await view.render(
      withIntl(
        createElement(AddSourceDialog, { ...props, workspaceReady: true }),
      ),
    );
    expect(button().disabled).toBe(false);
    await act(async () => button().click());
    expect(upload).toHaveBeenCalledTimes(1);
  } finally {
    await unmountAll();
  }
});
