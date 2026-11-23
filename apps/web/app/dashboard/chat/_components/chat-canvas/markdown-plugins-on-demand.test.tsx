// @vitest-environment jsdom

import { MessageResponse } from "@sourceweft/ui-web/components/ai-elements/message";
import { act } from "react";
import { afterEach, expect, test } from "vitest";
import { mount, unmountAll } from "@/test/react";

afterEach(unmountAll);

/** Waits, inside act, until `check` passes; the plugins load through dynamic imports. */
async function eventually(check: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

test("a reply with math renders the formula once the math plugin has loaded", async () => {
  const { container } = await mount(
    <MessageResponse>{"Energy: $$E = mc^2$$"}</MessageResponse>,
  );
  await eventually(() => container.querySelector(".katex") !== null);
  expect(container.textContent).not.toContain("$$");
}, 20_000);

test("a reply with a code block gets the code plugin's block", async () => {
  const { container } = await mount(
    <MessageResponse>{"Run:\n\n```bash\nls -la\n```"}</MessageResponse>,
  );
  await eventually(() => container.textContent?.includes("ls -la") ?? false);
  expect(
    container.querySelector('[data-streamdown="code-block"]'),
  ).not.toBeNull();
}, 20_000);

test("plain prose renders at once, without waiting for any plugin", async () => {
  const { container } = await mount(
    <MessageResponse>{"Just **words** here."}</MessageResponse>,
  );
  expect(
    container.querySelector('[data-streamdown="strong"]')?.textContent,
  ).toBe("words");
});
