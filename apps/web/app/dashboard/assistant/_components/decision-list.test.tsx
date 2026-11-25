// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const hooks = vi.hoisted(() => ({ useAssistantDecisions: vi.fn() }));
vi.mock("../../../../lib/assistant", () => hooks);
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) => (
    <a href={href}>{children as never}</a>
  ),
}));

import { DecisionList } from "./decision-list";
import { button, click, mountWithIntl, unmountAll } from "@/test/react";

const item = (over: Record<string, unknown> = {}) => ({
  id: "d1",
  action: "create_ticket",
  reason: "A clear request with a deliverable.",
  createdAt: "2026-11-25T08:00:00.000Z",
  trigger: {
    id: "tr1",
    sourceKind: "member_message",
    authorUserId: "u1",
    text: "Summarize the changelog",
  },
  ticket: { id: "t1", title: "Changelog summary" },
  ...over,
});

function result(items: unknown[], over: Record<string, unknown> = {}) {
  return {
    data: { pages: [{ items, nextCursor: null }] },
    isPending: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  hooks.useAssistantDecisions.mockReturnValue(result([item()]));
});
afterEach(async () => {
  await unmountAll();
  vi.clearAllMocks();
});

const members = [{ userId: "u1", name: "Ada", email: null }] as never;

test("each decision shows what it judged, what it decided, why, and links its ticket", async () => {
  const { container } = await mountWithIntl(
    <DecisionList workspaceId="ws_1" members={members} />,
  );
  const text = container.textContent ?? "";
  expect(text).toContain("Opened a ticket");
  expect(text).toContain("A member's message");
  expect(text).toContain("Ada");
  expect(text).toContain("Summarize the changelog");
  expect(text).toContain("Why: A clear request with a deliverable.");
  expect(container.querySelector("a")?.getAttribute("href")).toBe(
    "/dashboard/assistant?ticket=t1",
  );
});

test("a filter asks for that kind of decision only", async () => {
  const { container } = await mountWithIntl(
    <DecisionList workspaceId="ws_1" members={members} />,
  );
  await click(button("Ignored", container));
  expect(hooks.useAssistantDecisions).toHaveBeenLastCalledWith(
    "ws_1",
    "ignore",
    true,
  );
});

test("an empty log, a failed load and a further page each say so", async () => {
  hooks.useAssistantDecisions.mockReturnValue(result([]));
  const empty = await mountWithIntl(
    <DecisionList workspaceId="ws_1" members={members} />,
  );
  expect(empty.container.textContent).toContain("No decisions yet");
  await unmountAll();

  hooks.useAssistantDecisions.mockReturnValue(
    result([], { isError: true, data: undefined }),
  );
  const failed = await mountWithIntl(
    <DecisionList workspaceId="ws_1" members={members} />,
  );
  expect(failed.container.querySelector('[role="alert"]')).not.toBeNull();
  await unmountAll();

  const fetchNextPage = vi.fn();
  hooks.useAssistantDecisions.mockReturnValue(
    result([item()], { hasNextPage: true, fetchNextPage }),
  );
  const more = await mountWithIntl(
    <DecisionList workspaceId="ws_1" members={members} />,
  );
  await click(button("Load earlier decisions", more.container));
  expect(fetchNextPage).toHaveBeenCalledTimes(1);
});
