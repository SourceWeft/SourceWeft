// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) => (
    <a href={href}>{children as never}</a>
  ),
}));

import { AssistantThreadNotice } from "./assistant-thread-notice";
import { isHostOwnedChat } from "./host-owned-thread";
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
