// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) => (
    <a href={href}>{children as never}</a>
  ),
}));

import { AssistantThreadNotice } from "./assistant-thread-notice";
import { isHostOwnedChat, unlistedLookupState } from "./host-owned-thread";
import { mountWithIntl, unmountAll } from "@/test/react";

afterEach(unmountAll);

test("only the assistant's Router and ticket conversations are host-owned", () => {
  expect(isHostOwnedChat({ origin: "assistant_router" })).toBe(true);
  expect(isHostOwnedChat({ origin: "assistant_ticket" })).toBe(true);
  expect(isHostOwnedChat({ origin: "scheduled" })).toBe(false);
  expect(isHostOwnedChat({ origin: "user" })).toBe(false);
  expect(isHostOwnedChat({})).toBe(false);
  expect(isHostOwnedChat(undefined)).toBe(false);
});

test("the Router's work log and a ticket conversation each say they take no messages, and point to the assistant", async () => {
  const router = await mountWithIntl(
    <AssistantThreadNotice origin="assistant_router" />,
  );
  expect(router.container.textContent).toContain("work log");
  expect(
    router.container.querySelector('a[href="/dashboard/assistant"]'),
  ).not.toBeNull();

  const ticket = await mountWithIntl(
    <AssistantThreadNotice origin="assistant_ticket" />,
  );
  expect(ticket.container.textContent).toContain(
    "belongs to an assistant ticket",
  );
});

test("a thread is looked up on its own only once the lists have settled without it", () => {
  const base = {
    workspaceId: "ws_1",
    listed: false,
    listsSettled: true,
    queryPending: true,
  };
  // Lists settled, thread not in them: look it up, and hold the
  // "missing thread" verdict until the answer comes.
  expect(unlistedLookupState(base)).toEqual({ enabled: true, pending: true });
  expect(unlistedLookupState({ ...base, queryPending: false })).toEqual({
    enabled: true,
    pending: false,
  });
  // A cold open while the lists still load: no extra request.
  expect(unlistedLookupState({ ...base, listsSettled: false })).toEqual({
    enabled: false,
    pending: false,
  });
  // The lists hold it, or there is no workspace: nothing to look up.
  expect(unlistedLookupState({ ...base, listed: true })).toEqual({
    enabled: false,
    pending: false,
  });
  expect(unlistedLookupState({ ...base, workspaceId: null })).toEqual({
    enabled: false,
    pending: false,
  });
});
