// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ThreadShare } from "@sourceweft/contracts";

import { button, click, flush, mountWithIntl, unmountAll } from "@/test/react";
import { formatDisplayDate } from "../../../lib/i18n/format";

const toasts = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

import {
  ShareChatDialog,
  type ShareChatDialogClient,
} from "./share-chat-dialog";

// Mirrors the component's own date formatting so the test can assert the
// snapshot line changes without hard-coding a locale string.
const DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};

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
  await mountWithIntl(
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
