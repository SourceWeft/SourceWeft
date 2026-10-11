// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { click, flush, mount, unmountAll } from "@/test/react";

import { CopyButton } from "./mcp-client";

const writeText = vi.fn();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});
afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
});

test("copies the value, says so in the caller's words, and reports it", async () => {
  const onCopied = vi.fn();
  const { container } = await mount(
    <CopyButton
      copiedLabel="已复制"
      failedLabel="复制失败"
      label="复制"
      onCopied={onCopied}
      value="[![Listed on SourceWeft](x)](y)"
    />,
  );
  const button = container.querySelector("button")!;
  expect(button.textContent).toBe("复制");

  await click(button);
  await flush();

  expect(writeText).toHaveBeenCalledWith("[![Listed on SourceWeft](x)](y)");
  expect(onCopied).toHaveBeenCalledTimes(1);
  expect(button.textContent).toBe("已复制");
});

async function mountFailing() {
  const onCopied = vi.fn();
  const { container } = await mount(
    <CopyButton
      copiedLabel="已复制"
      failedLabel="复制失败"
      label="复制"
      onCopied={onCopied}
      value="x"
    />,
  );
  return { button: container.querySelector("button")!, onCopied };
}

test("says the copy failed, in the caller's words, when the clipboard refuses", async () => {
  writeText.mockRejectedValue(new Error("denied"));
  const { button, onCopied } = await mountFailing();

  await click(button);
  await flush(2);

  expect(writeText).toHaveBeenCalledWith("x");
  expect(onCopied).not.toHaveBeenCalled();
  expect(button.textContent).toBe("复制失败");
});

test("says the copy failed on a page with no clipboard (plain http), then offers it again", async () => {
  // Browsers leave `navigator.clipboard` undefined outside a secure context.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  vi.useFakeTimers();
  const { button, onCopied } = await mountFailing();

  await click(button);
  await flush(2);

  expect(onCopied).not.toHaveBeenCalled();
  expect(button.textContent).toBe("复制失败");

  await act(async () => vi.advanceTimersByTime(1600));
  expect(button.textContent).toBe("复制");
});
