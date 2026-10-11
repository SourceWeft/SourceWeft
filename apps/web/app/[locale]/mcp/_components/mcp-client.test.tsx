// @vitest-environment jsdom
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
afterEach(unmountAll);

test("copies the value, says so in the caller's words, and reports it", async () => {
  const onCopied = vi.fn();
  const { container } = await mount(
    <CopyButton
      copiedLabel="已复制"
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

test("reports nothing when the clipboard refuses", async () => {
  writeText.mockRejectedValue(new Error("denied"));
  const onCopied = vi.fn();
  const { container } = await mount(
    <CopyButton
      copiedLabel="Copied"
      label="Copy"
      onCopied={onCopied}
      value="x"
    />,
  );
  const button = container.querySelector("button")!;

  await click(button);
  await flush(2);

  expect(onCopied).not.toHaveBeenCalled();
  expect(button.textContent).toBe("Copy");
});
