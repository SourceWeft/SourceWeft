// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import { AddSourceDialog } from "./dialogs";
import enMessages from "../../../../../../messages/en.json";

const intlMessages = enMessages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];

test("file submission waits for a usable workspace, then resumes without a timer", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
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
    await act(async () =>
      root.render(
        <NextIntlClientProvider locale="en" messages={intlMessages}>
          {createElement(AddSourceDialog, { ...props, workspaceReady: false })}
        </NextIntlClientProvider>,
      ),
    );
    expect(button().disabled).toBe(true);
    await act(async () => button().click());
    expect(upload).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        <NextIntlClientProvider locale="en" messages={intlMessages}>
          {createElement(AddSourceDialog, { ...props, workspaceReady: true })}
        </NextIntlClientProvider>,
      ),
    );
    expect(button().disabled).toBe(false);
    await act(async () => button().click());
    expect(upload).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});
