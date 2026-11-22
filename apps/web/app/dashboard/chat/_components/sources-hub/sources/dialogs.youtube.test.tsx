// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { AddSourceDialog } from "./dialogs";
import { click, mountWithIntl, unmountAll } from "@/test/react";

afterEach(unmountAll);

function props(urlValue: string) {
  const noop = () => {};
  return {
    workspaceReady: true,
    addParentSourceId: null,
    addTab: "URL" as const,
    files: [],
    fileInputRef: { current: null },
    isDragActive: false,
    isOpen: true,
    isSubmitting: false,
    onAddFiles: noop,
    onAddTabChange: noop,
    onClose: noop,
    onCreateTextSource: noop,
    onCreateUrlSource: vi.fn(),
    onOpenYouTubeListing: vi.fn(),
    onDragEnter: noop,
    onDragLeave: noop,
    onDragOver: noop,
    onDrop: noop,
    onRemoveFile: noop,
    onTextContentChange: noop,
    onTextTitleChange: noop,
    onUploadFiles: noop,
    onUrlTitleChange: noop,
    onUrlValueChange: noop,
    sources: [],
    textContent: "",
    textTitle: "",
    uploadProgress: 0,
    urlTitle: "",
    urlValue,
  };
}

const footerButton = (label: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (node) => node.textContent?.trim() === label,
  );

test("playlist url opens the listing instead of creating a source", async () => {
  const url =
    "https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf";
  const p = props(`  ${url}  `);
  await mountWithIntl(createElement(AddSourceDialog, p));

  expect(document.body.textContent).toContain("YouTube playlist");
  await click(footerButton("Choose videos")!);

  expect(p.onOpenYouTubeListing).toHaveBeenCalledWith(url);
  expect(p.onCreateUrlSource).not.toHaveBeenCalled();
});

test("channel url opens the listing too", async () => {
  const p = props("https://www.youtube.com/@openuniversity");
  await mountWithIntl(createElement(AddSourceDialog, p));

  await click(footerButton("Choose videos")!);

  expect(p.onOpenYouTubeListing).toHaveBeenCalledWith(
    "https://www.youtube.com/@openuniversity",
  );
  expect(p.onCreateUrlSource).not.toHaveBeenCalled();
});

test("a single video url still creates one source", async () => {
  const p = props("https://youtu.be/aaaaaaaaaaa");
  await mountWithIntl(createElement(AddSourceDialog, p));

  expect(document.body.textContent).toContain("transcribe");
  expect(document.body.textContent).toContain(
    "Transcribing a video uses credits.",
  );
  await click(footerButton("Add URL")!);

  expect(p.onCreateUrlSource).toHaveBeenCalledTimes(1);
  expect(p.onOpenYouTubeListing).not.toHaveBeenCalled();
});
