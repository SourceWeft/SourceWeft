// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ThreadShare } from "@sourceweft/contracts";

import {
  button,
  click,
  flush,
  mountWithIntl,
  unmountAll,
  withIntl,
} from "@/test/react";
import { formatDisplayDate } from "../../../lib/i18n/format";

const toasts = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

import {
  ShareChatDialog,
  type ShareChatDialogClient,
} from "./share-chat-dialog";

// Mirrors the component's own date formatting so the test can assert the
// snapshot line changes without hard-coding a locale string. Includes the
// time (hour/minute), matching the spec's "Snapshot from <date time>".
const DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeShare(patch: Partial<ThreadShare> = {}): ThreadShare {
  return {
    token: "tok-1",
    url: "https://sourceweft.test/s/tok-1",
    targetType: "thread",
    targetId: "chat-1",
    isPublic: true,
    noindex: true,
    accessLevel: "viewer",
    viewCount: 3,
    expiresAt: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    publicRecordCollections: [],
    snapshotTakenAt: "2026-11-01T00:00:00.000Z",
    ...patch,
  };
}

function fakeClient(
  overrides: Partial<ShareChatDialogClient> = {},
): ShareChatDialogClient {
  return {
    getThreadShare: vi.fn().mockResolvedValue({ share: null }),
    shareThread: vi.fn().mockResolvedValue({ share: makeShare() }),
    updateThreadShare: vi.fn().mockResolvedValue({ share: makeShare() }),
    revokeThreadShare: vi.fn().mockResolvedValue({ revoked: true as const }),
    ...overrides,
  };
}

async function mountDialog(client: ShareChatDialogClient) {
  const handle = await mountWithIntl(
    <ShareChatDialog
      open
      onOpenChange={() => {}}
      workspaceId="ws-1"
      chatId="chat-1"
      chatTitle="Research plan"
      client={client}
    />,
  );
  await flush(2);
  return handle;
}

beforeEach(() => {
  toasts.error.mockClear();
});
afterEach(unmountAll);

test("not shared: shows Create link, then shares and shows the link and Update link", async () => {
  const share = makeShare();
  const client = fakeClient({
    getThreadShare: vi.fn().mockResolvedValue({ share: null }),
    shareThread: vi.fn().mockResolvedValue({ share }),
  });
  await mountDialog(client);

  expect(client.getThreadShare).toHaveBeenCalledWith("ws-1", "chat-1");
  expect(button("Create link", document)).toBeTruthy();
  expect(document.body.textContent).toContain(
    "Anyone with the link can see this chat as it is now.",
  );

  await click(button("Create link", document));

  expect(client.shareThread).toHaveBeenCalledWith("ws-1", "chat-1", {});
  expect(button("Update link", document)).toBeTruthy();
  expect(button("Create link", document)).toBeFalsy();
  expect(
    document.body.querySelector<HTMLInputElement>("input[readonly]")?.value,
  ).toBe(share.url);
});

test("shared: Update link re-shares and updates the snapshot date, and the switch updates noindex", async () => {
  const first = makeShare({ snapshotTakenAt: "2026-11-01T00:00:00.000Z" });
  const second = makeShare({
    snapshotTakenAt: "2026-11-20T00:00:00.000Z",
    noindex: false,
  });
  const client = fakeClient({
    getThreadShare: vi.fn().mockResolvedValue({ share: first }),
    shareThread: vi.fn().mockResolvedValue({ share: second }),
    updateThreadShare: vi.fn().mockResolvedValue({
      share: { ...first, noindex: false },
    }),
  });
  await mountDialog(client);

  expect(button("Update link", document)).toBeTruthy();
  expect(button("Create link", document)).toBeFalsy();
  expect(document.body.textContent).toContain(
    formatDisplayDate(new Date(first.snapshotTakenAt), "en", DATE_OPTIONS),
  );
  expect(document.body.textContent).toContain("3 views");

  const searchSwitch = document.body.querySelector<HTMLElement>(
    '[role="switch"]',
  )!;
  await click(searchSwitch);
  expect(client.updateThreadShare).toHaveBeenCalledWith("ws-1", "chat-1", {
    noindex: false,
  });

  await click(button("Update link", document));
  expect(client.shareThread).toHaveBeenCalledWith("ws-1", "chat-1", {});
  expect(document.body.textContent).toContain(
    formatDisplayDate(new Date(second.snapshotTakenAt), "en", DATE_OPTIONS),
  );
});

test("stop sharing only revokes after an explicit confirm", async () => {
  const share = makeShare();
  const client = fakeClient({
    getThreadShare: vi.fn().mockResolvedValue({ share }),
  });
  await mountDialog(client);

  await click(button("Stop sharing", document));
  expect(client.revokeThreadShare).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(
    "Stop sharing this chat? The link will stop working.",
  );

  await click(button("Stop sharing", document));
  expect(client.revokeThreadShare).toHaveBeenCalledWith("ws-1", "chat-1");
  expect(button("Create link", document)).toBeTruthy();
  expect(button("Update link", document)).toBeFalsy();
});

test("stop sharing can be cancelled without revoking", async () => {
  const share = makeShare();
  const client = fakeClient({
    getThreadShare: vi.fn().mockResolvedValue({ share }),
  });
  await mountDialog(client);

  await click(button("Stop sharing", document));
  await click(button("Cancel", document));
  expect(client.revokeThreadShare).not.toHaveBeenCalled();
  expect(button("Update link", document)).toBeTruthy();
});

test("a forbidden (403) error shows the forbidden text instead of a toast", async () => {
  const client = fakeClient({
    getThreadShare: vi.fn().mockResolvedValue({ share: null }),
    shareThread: vi
      .fn()
      .mockRejectedValue({ status: 403, code: "FORBIDDEN", message: "no" }),
  });
  await mountDialog(client);

  await click(button("Create link", document));

  expect(document.body.textContent).toContain(
    "Only the chat's creator or a workspace admin can share it.",
  );
  expect(toasts.error).not.toHaveBeenCalled();
});

test("a non-forbidden error toasts a generic message", async () => {
  const client = fakeClient({
    getThreadShare: vi.fn().mockResolvedValue({ share: null }),
    shareThread: vi
      .fn()
      .mockRejectedValue({ status: 500, code: "INTERNAL", message: "boom" }),
  });
  await mountDialog(client);

  await click(button("Create link", document));

  expect(toasts.error).toHaveBeenCalledWith("Couldn't update sharing.");
  expect(document.body.textContent).not.toContain(
    "Only the chat's creator or a workspace admin can share it.",
  );
});

test("a stale share result for a chat the dialog has moved on from is ignored", async () => {
  const shareA = makeShare({ targetId: "chat-a", token: "tok-a" });
  const shareB = makeShare({
    targetId: "chat-b",
    token: "tok-b",
    url: "https://sourceweft.test/s/tok-b",
  });
  const pendingShareA = deferred<{ share: ThreadShare }>();

  const client = fakeClient({
    getThreadShare: vi.fn((_workspaceId: string, chatId: string) =>
      Promise.resolve({ share: chatId === "chat-b" ? shareB : null }),
    ),
    shareThread: vi.fn().mockReturnValue(pendingShareA.promise),
  });

  const handle = await mountWithIntl(
    <ShareChatDialog
      open
      onOpenChange={() => {}}
      workspaceId="ws-1"
      chatId="chat-a"
      chatTitle="Chat A"
      client={client}
    />,
  );
  await flush(2);

  // Start sharing chat A; the request is left pending.
  await click(button("Create link", document));
  expect(client.shareThread).toHaveBeenCalledWith("ws-1", "chat-a", {});

  // The dialog switches to chat B before A's request resolves (the same
  // instance, re-rendered with new props, exactly as the sidebar panel
  // reuses one unkeyed dialog across chats).
  await handle.render(
    withIntl(
      <ShareChatDialog
        open
        onOpenChange={() => {}}
        workspaceId="ws-1"
        chatId="chat-b"
        chatTitle="Chat B"
        client={client}
      />,
    ),
  );
  await flush(2);

  expect(
    document.body.querySelector<HTMLInputElement>("input[readonly]")?.value,
  ).toBe(shareB.url);
  // Busy from A's still-pending request must not disable B's button either.
  expect(button("Update link", document)?.hasAttribute("disabled")).toBe(
    false,
  );

  // Now A's stale share resolves; it must not overwrite B's displayed link.
  pendingShareA.resolve({ share: shareA });
  await flush(2);

  expect(
    document.body.querySelector<HTMLInputElement>("input[readonly]")?.value,
  ).toBe(shareB.url);
});
