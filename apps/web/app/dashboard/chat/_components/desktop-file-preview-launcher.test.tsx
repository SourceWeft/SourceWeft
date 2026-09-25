// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DesktopFilePreviewLauncher } from "./desktop-file-preview-launcher";
import {
  mountWithIntl,
  type Mounted,
  unmountAll,
  withIntl,
} from "@/test/react";

const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../../../../lib/desktop-preview-bridge", () => ({
  openDesktopPreview: mocks.open,
}));
vi.mock("sonner", () => ({
  toast: { loading: vi.fn(), dismiss: vi.fn(), error: vi.fn() },
}));
let view: Mounted | null = null;
const opened = vi.fn();
beforeEach(() => {
  mocks.open.mockReset().mockResolvedValue(undefined);
  opened.mockReset();
});
afterEach(async () => {
  await unmountAll();
  view = null;
});
/** First call mounts; later calls re-render into the same root. */
async function render(text: string) {
  const launcher = createElement(DesktopFilePreviewLauncher, {
    open: true,
    loading: false,
    source: { name: "file.txt", text },
    description: "file",
    onOpened: opened,
  });
  if (view) await view.render(withIntl(launcher));
  else view = await mountWithIntl(launcher);
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
