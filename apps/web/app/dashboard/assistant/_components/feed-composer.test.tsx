// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  useAssistantMutations: vi.fn(),
  assistantErrorCode: () => null,
}));
vi.mock("../../../../lib/assistant", () => hooks);
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { act } from "react";
import { FeedComposer } from "./feed-composer";
import {
  button,
  click,
  flush,
  mountWithIntl,
  typeInto,
  unmountAll,
  withIntl,
} from "@/test/react";

const postMessage = vi.fn();

beforeEach(() => {
  postMessage.mockResolvedValue({ item: { id: "f1" } });
  hooks.useAssistantMutations.mockReturnValue({
    postMessage: { mutateAsync: postMessage, isPending: false },
  });
});
afterEach(async () => {
  await unmountAll();
  vi.clearAllMocks();
});

function field(container: HTMLElement) {
  return container.querySelector("textarea")!;
}

async function write(container: HTMLElement, text: string) {
  await act(async () => typeInto(field(container), text));
}

test("two separate sends use two different idempotency keys", async () => {
  const { container } = await mountWithIntl(
    <FeedComposer workspaceId="ws_1" />,
  );
  await write(container, "Summarize last week's tickets");
  await click(button("Send", container));
  await flush(3);
  expect(field(container).value).toBe("");

  await write(container, "Draft the release notes");
  await click(button("Send", container));
  await flush(3);

  expect(postMessage).toHaveBeenCalledTimes(2);
  const [first, second] = postMessage.mock.calls.map(([input]) => input);
  expect(first.text).toBe("Summarize last week's tickets");
  expect(second.text).toBe("Draft the release notes");
  expect(first.idempotencyKey).toBeTruthy();
  expect(second.idempotencyKey).toBeTruthy();
  expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
});

test("a failed send keeps the draft, and retrying it reuses the same key", async () => {
  postMessage
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce({ item: { id: "f1" } });
  const { container } = await mountWithIntl(
    <FeedComposer workspaceId="ws_1" />,
  );
  await write(container, "Check the failing build");
  await click(button("Send", container));
  await flush(3);

  expect(field(container).value).toBe("Check the failing build");
  expect(toast.error).toHaveBeenCalled();

  await click(button("Send", container));
  await flush(3);

  expect(postMessage).toHaveBeenCalledTimes(2);
  const [first, retry] = postMessage.mock.calls.map(([input]) => input);
  expect(retry.idempotencyKey).toBe(first.idempotencyKey);
  expect(field(container).value).toBe("");
});

test("editing a failed draft makes it a new send with a new key", async () => {
  postMessage
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce({ item: { id: "f1" } });
  const { container } = await mountWithIntl(
    <FeedComposer workspaceId="ws_1" />,
  );
  await write(container, "Check the build");
  await click(button("Send", container));
  await flush(3);

  await write(container, "Check the nightly build");
  await click(button("Send", container));
  await flush(3);

  const [first, second] = postMessage.mock.calls.map(([input]) => input);
  expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
});

test("a paused assistant takes no messages and says why", async () => {
  const { container } = await mountWithIntl(
    <FeedComposer
      workspaceId="ws_1"
      disabledReason="The assistant is paused."
    />,
  );
  expect(field(container).disabled).toBe(true);
  expect(button("Send", container).disabled).toBe(true);
  expect(container.textContent).toContain("The assistant is paused.");
});

test("text typed while a send is in flight is kept as the next message", async () => {
  let finish: (value: unknown) => void = () => {};
  postMessage.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { container } = await mountWithIntl(
    <FeedComposer workspaceId="ws_1" />,
  );
  await write(container, "First request");
  await click(button("Send", container));
  await write(container, "First request\nAnd a follow-up");
  await act(async () => finish({ item: { id: "f1" } }));
  await flush(3);

  expect(postMessage).toHaveBeenCalledTimes(1);
  expect(field(container).value).toBe("First request\nAnd a follow-up");
});

test("a seed fills the box and focuses it, and a new seed replaces what was typed", async () => {
  const { container, render } = await mountWithIntl(
    <FeedComposer workspaceId="ws_1" seed={{ id: 1, text: "First idea" }} />,
  );
  await flush(2);
  expect(field(container).value).toBe("First idea");
  expect(document.activeElement).toBe(field(container));

  await write(container, "Edited by hand");
  await render(
    withIntl(
      <FeedComposer workspaceId="ws_1" seed={{ id: 2, text: "Second idea" }} />,
    ),
  );
  await flush(2);
  expect(field(container).value).toBe("Second idea");
});
