// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { button, click, flush, mountWithIntl, unmountAll } from "@/test/react";

const toasts = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

import { DeleteChatDialog } from "./delete-chat-dialog";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function text() {
  return document.body.textContent ?? "";
}

beforeEach(() => {
  toasts.error.mockReset();
});

afterEach(unmountAll);

async function mountDialog(onConfirm: () => Promise<void>) {
  const onOpenChange = vi.fn();
  await mountWithIntl(
    <DeleteChatDialog
      open
      title="Quarterly plan"
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
    />,
  );
  return onOpenChange;
}

test("the dialog names the chat and says the delete can't be undone", async () => {
  await mountDialog(async () => {});

  expect(text()).toContain("Delete this chat?");
  expect(text()).toContain("“Quarterly plan”");
  expect(text()).toContain("sub-agent chats");
  expect(text()).toContain("public link");
  expect(text()).toContain("This can't be undone.");
});

test("confirming deletes the chat and closes the dialog", async () => {
  const onConfirm = vi.fn(async () => {});
  const onOpenChange = await mountDialog(onConfirm);

  await click(button("Delete"));
  await flush(2);

  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(toasts.error).not.toHaveBeenCalled();
});

test("cancel closes the dialog without deleting", async () => {
  const onConfirm = vi.fn(async () => {});
  const onOpenChange = await mountDialog(onConfirm);

  await click(button("Cancel"));

  expect(onConfirm).not.toHaveBeenCalled();
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("both buttons are disabled while the delete runs, so it can't be sent twice", async () => {
  const pending = deferred();
  const onConfirm = vi.fn(() => pending.promise);
  await mountDialog(onConfirm);

  await click(button("Delete"));

  const deleting = button("Deleting…");
  expect(deleting.disabled).toBe(true);
  expect(button("Cancel").disabled).toBe(true);
  await click(deleting);
  expect(onConfirm).toHaveBeenCalledTimes(1);

  pending.resolve();
  await flush(2);
});

test("a failed delete keeps the dialog open and shows an error", async () => {
  const onConfirm = vi.fn(async () => {
    throw new Error("boom");
  });
  const onOpenChange = await mountDialog(onConfirm);

  await click(button("Delete"));
  await flush(2);

  expect(toasts.error).toHaveBeenCalledWith("Couldn't delete this chat.");
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
  expect(button("Delete").disabled).toBe(false);
});
