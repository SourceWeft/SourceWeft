// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import type {
  AssistantFeedItem,
  AssistantTicket,
} from "@sourceweft/contracts/assistants";
import type { WorkspaceMember } from "@sourceweft/contracts";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) => (
    <a href={href}>{children as never}</a>
  ),
}));

import { FeedList } from "./feed-list";
import { mountWithIntl, unmountAll } from "@/test/react";

afterEach(async () => {
  await unmountAll();
});

function item(over: Partial<AssistantFeedItem>): AssistantFeedItem {
  return {
    id: "f",
    assistantId: "a1",
    kind: "member_message",
    authorUserId: null,
    text: "",
    ticketId: null,
    ticketEvent: null,
    replyToItemId: null,
    createdAt: "2026-11-22T08:00:00.000Z",
    ...over,
  };
}

const members = [
  { userId: "u_me", name: "Me Myself" },
  { userId: "u_ann", name: "Ann" },
] as WorkspaceMember[];

const tickets = [
  { id: "t1", title: "Release notes", workerThreadId: "th_w1" },
] as AssistantTicket[];

test("member messages, router replies and ticket updates read in time order, oldest first", async () => {
  const { container } = await mountWithIntl(
    <FeedList
      // Newest first, as the API returns it.
      items={[
        item({
          id: "f3",
          kind: "ticket_update",
          ticketId: "t1",
          text: "Draft is ready",
          createdAt: "2026-11-22T08:03:00.000Z",
        }),
        item({
          id: "f2",
          kind: "router_message",
          text: "On it",
          createdAt: "2026-11-22T08:02:00.000Z",
        }),
        item({
          id: "f1",
          kind: "member_message",
          authorUserId: "u_ann",
          text: "Write the release notes",
          createdAt: "2026-11-22T08:01:00.000Z",
        }),
        item({
          id: "f0",
          kind: "member_message",
          authorUserId: "u_me",
          text: "Hello",
          createdAt: "2026-11-22T08:00:00.000Z",
        }),
      ]}
      tickets={tickets}
      members={members}
      viewerId="u_me"
      hasOlder={false}
      loadingOlder={false}
      onLoadOlder={() => {}}
    />,
  );
  const rows = [...container.querySelectorAll("[data-feed-id]")];
  expect(rows.map((row) => row.getAttribute("data-feed-id"))).toEqual([
    "f0",
    "f1",
    "f2",
    "f3",
  ]);
  expect(rows[0]!.textContent).toContain("You");
  expect(rows[1]!.textContent).toContain("Ann");
  expect(rows[2]!.textContent).toContain("Assistant");
  expect(rows[3]!.textContent).toContain("Release notes");
  // A ticket update opens that ticket's worker conversation.
  expect(
    rows[3]!.querySelector('a[href="/dashboard/chat/th_w1"]'),
  ).not.toBeNull();
});

test("a ticket update shows what happened as a label and only the report as text", async () => {
  const { container } = await mountWithIntl(
    <FeedList
      items={[
        item({
          id: "f2",
          kind: "ticket_update",
          ticketId: "t1",
          ticketEvent: "ready",
          text: "The notes are in the doc.",
          createdAt: "2026-11-22T08:02:00.000Z",
        }),
        item({
          id: "f1",
          kind: "ticket_update",
          ticketId: "t1",
          ticketEvent: "created",
          text: "Release notes",
          createdAt: "2026-11-22T08:01:00.000Z",
        }),
        // A ticket the list no longer holds: its title is only in the text.
        item({
          id: "f0",
          kind: "ticket_update",
          ticketId: "t_gone",
          ticketEvent: "created",
          text: "Old ticket",
          createdAt: "2026-11-22T08:00:00.000Z",
        }),
      ]}
      tickets={tickets}
      members={members}
      viewerId="u_me"
      hasOlder={false}
      loadingOlder={false}
      onLoadOlder={() => {}}
    />,
  );
  const rows = [...container.querySelectorAll("[data-feed-id]")];
  expect(rows[0]!.textContent).toContain("New ticket");
  expect(rows[0]!.textContent).toContain("Old ticket");

  expect(rows[1]!.textContent).toContain("New ticket");
  // The title shows once, in the header.
  expect(rows[1]!.textContent!.split("Release notes").length - 1).toBe(1);
  expect(rows[1]!.querySelector("p")).toBeNull();

  expect(rows[2]!.textContent).toContain("Done");
  expect(rows[2]!.querySelector("p")!.textContent).toBe(
    "The notes are in the doc.",
  );
});

test("an empty feed invites the first message", async () => {
  const { container } = await mountWithIntl(
    <FeedList
      items={[]}
      tickets={[]}
      members={[]}
      viewerId="u_me"
      hasOlder={false}
      loadingOlder={false}
      onLoadOlder={() => {}}
    />,
  );
  expect(container.textContent).toContain("No messages yet");
});
