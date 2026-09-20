// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import { DesktopFilePreviewLauncher } from "./desktop-file-preview-launcher";
import messages from "../../../../messages/en.json";

const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];
const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../../../../lib/desktop-preview-bridge", () => ({
  openDesktopPreview: mocks.open,
}));
vi.mock("sonner", () => ({
  toast: { loading: vi.fn(), dismiss: vi.fn(), error: vi.fn() },
}));
let root: Root;
const opened = vi.fn();
beforeEach(() => {
  mocks.open.mockReset().mockResolvedValue(undefined);
  opened.mockReset();
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
});
async function render(text: string) {
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale="en" messages={intlMessages}>
        {createElement(DesktopFilePreviewLauncher, {
          open: true,
          loading: false,
          source: { name: "file.txt", text },
          description: "file",
          onOpened: opened,
        })}
      </NextIntlClientProvider>,
    ),
  );
}
test("listing refresh with equivalent source values does not reopen the native window", async () => {
  await render("one");
  await render("one");
  expect(mocks.open).toHaveBeenCalledTimes(1);
  expect(opened).toHaveBeenCalledTimes(1);
});
test("source change cancels the old capture and ignores its late completion", async () => {
  let complete!: () => void;
  mocks.open.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  await render("one");
  const signal = mocks.open.mock.calls[0]![2] as AbortSignal;
  await render("two");
  expect(signal.aborted).toBe(true);
  await act(async () => complete());
  expect(mocks.open).toHaveBeenCalledTimes(2);
  expect(opened).toHaveBeenCalledTimes(1);
  expect(mocks.open.mock.calls[1]![0]).toEqual({
    name: "file.txt",
    mimeType: undefined,
    text: "two",
  });
});
