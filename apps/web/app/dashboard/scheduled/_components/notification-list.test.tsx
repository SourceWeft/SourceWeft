// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  useNotifications: vi.fn(),
  useNotificationMutations: vi.fn(),
  useUnreadNotificationCount: vi.fn(),
}));
const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("../../../../lib/scheduled-tasks", () => hooks);
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("../../_components/dashboard-chat-state", () => ({
  useDashboardChatState: () => ({ workspaceId: "ws_1" }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) => (
    <a href={href}>{children as never}</a>
  ),
}));

import { NotificationBell } from "./notification-bell";
import { NotificationList } from "./notification-list";
import { mountWithIntl, unmountAll } from "@/test/react";

const markRead = vi.fn();
const markAllRead = vi.fn();

function item(over: Record<string, unknown> = {}) {
  return {
    id: "n1",
    kind: "task_run_failed",
    ref: { kind: "agent_task", id: "t1" },
    payload: { taskName: "Digest" },
    occurrenceCount: 1,
    readAt: null,
    createdAt: "2026-11-19T08:00:00.000Z",
    lastOccurredAt: "2026-11-19T08:00:00.000Z",
    path: "/dashboard/scheduled/t1",
    ...over,
  };
}

beforeEach(() => {
  hooks.useNotifications.mockReturnValue({
    data: { pages: [{ notifications: [item()], nextCursor: null }] },
    isLoading: false,
    isError: false,
    hasNextPage: false,
  });
  hooks.useNotificationMutations.mockReturnValue({
    markRead: { mutate: markRead },
    markAllRead: { mutate: markAllRead, isPending: false },
  });
  hooks.useUnreadNotificationCount.mockReturnValue({ data: 3 });
});
afterEach(async () => {
  await unmountAll();
  vi.clearAllMocks();
});

test("a row names the task, and opening it marks it read and goes to its page", async () => {
  const { container } = await mountWithIntl(
    <NotificationList workspaceId="ws_1" />,
  );
  expect(container.textContent).toContain('"Digest" failed.');
  container.querySelector("button")!.click();
  expect(markRead).toHaveBeenCalledWith("n1");
  expect(nav.push).toHaveBeenCalledWith("/dashboard/scheduled/t1");
});

test("a row that is already read is not marked again, and repeats are counted", async () => {
  hooks.useNotifications.mockReturnValue({
    data: {
      pages: [
        {
          notifications: [
            item({ readAt: "2026-11-19T09:00:00.000Z", occurrenceCount: 4 }),
          ],
          nextCursor: null,
        },
      ],
    },
    isLoading: false,
    isError: false,
    hasNextPage: false,
  });
  const { container } = await mountWithIntl(
    <NotificationList workspaceId="ws_1" />,
  );
  expect(container.textContent).toContain("4 times");
  container.querySelector("button")!.click();
  expect(markRead).not.toHaveBeenCalled();
});

test("research notifications name the topic", async () => {
  hooks.useNotifications.mockReturnValue({
    data: {
      pages: [
        {
          notifications: [
            item({
              id: "r1",
              kind: "research_ready",
              ref: { kind: "source_research", id: "run1" },
              payload: { topic: "Solid-state batteries" },
              path: "/dashboard/chat",
            }),
            item({
              id: "r2",
              kind: "research_failed",
              ref: { kind: "source_research", id: "run2" },
              payload: { topic: "Fusion" },
              path: "/dashboard/chat",
            }),
          ],
          nextCursor: null,
        },
      ],
    },
    isLoading: false,
    isError: false,
    hasNextPage: false,
  });
  const { container } = await mountWithIntl(
    <NotificationList workspaceId="ws_1" />,
  );
  expect(container.textContent).toContain(
    'Your research on "Solid-state batteries" is ready.',
  );
  expect(container.textContent).toContain(
    'Your research on "Fusion" could not be completed.',
  );
});

test("workspace assistant notifications read in words, each from its own payload", async () => {
  const assistantPath = "/dashboard/assistant";
  hooks.useNotifications.mockReturnValue({
    data: {
      pages: [
        {
          notifications: [
            item({
              id: "a1",
              kind: "assistant_reply",
              payload: { assistantId: "as1" },
              path: assistantPath,
            }),
            item({
              id: "a2",
              kind: "assistant_question",
              payload: { ticketId: "t1", taskName: "Release notes" },
              path: `${assistantPath}?ticket=t1`,
            }),
            item({
              id: "a3",
              kind: "assistant_ticket_blocked",
              payload: { taskName: "Audit", reason: "credit_cap" },
              path: `${assistantPath}?ticket=t2`,
            }),
            item({
              id: "a4",
              kind: "assistant_ticket_blocked",
              payload: { assistantId: "as1", reason: "insufficient_credits" },
              path: assistantPath,
            }),
            item({
              id: "a5",
              kind: "assistant_unavailable",
              payload: { assistantId: "as1", unavailableCount: 3 },
              path: assistantPath,
            }),
          ],
          nextCursor: null,
        },
      ],
    },
    isLoading: false,
    isError: false,
    hasNextPage: false,
  });
  const { container } = await mountWithIntl(
    <NotificationList workspaceId="ws_1" />,
  );
  const text = container.textContent;
  expect(text).toContain("The assistant replied to your message.");
  expect(text).toContain('"Release notes" has a question for you.');
  expect(text).toContain('"Audit" stopped: it reached its credit cap.');
  expect(text).toContain(
    "Your messages to the assistant are waiting: you are out of credits.",
  );
  expect(text).toContain("The assistant could not handle 3 messages.");
});

test("an unknown kind still reads sensibly", async () => {
  hooks.useNotifications.mockReturnValue({
    data: {
      pages: [
        {
          notifications: [item({ kind: "from_the_future" })],
          nextCursor: null,
        },
      ],
    },
    isLoading: false,
    isError: false,
    hasNextPage: false,
  });
  const { container } = await mountWithIntl(
    <NotificationList workspaceId="ws_1" />,
  );
  expect(container.textContent).toContain('Update about "Digest".');
});

test("the bell shows the unread count in its label and badge", async () => {
  const { container } = await mountWithIntl(<NotificationBell />);
  const button = container.querySelector("button")!;
  expect(button.getAttribute("aria-label")).toBe("Notifications, 3 unread");
  expect(
    container.querySelector('[data-testid="notification-unread"]')?.textContent,
  ).toBe("3");
});

test("with nothing unread the bell has no badge", async () => {
  hooks.useUnreadNotificationCount.mockReturnValue({ data: 0 });
  const { container } = await mountWithIntl(<NotificationBell />);
  expect(
    container.querySelector('[data-testid="notification-unread"]'),
  ).toBeNull();
  expect(container.querySelector("button")!.getAttribute("aria-label")).toBe(
    "Notifications",
  );
});

test("a failed background generation names what failed and leads to its conversation", async () => {
  hooks.useNotifications.mockReturnValue({
    data: {
      pages: [
        {
          notifications: [
            item({
              id: "n2",
              kind: "artifact_generation_failed",
              ref: { kind: "artifact", id: "a1" },
              payload: {
                title: "Flashcards: Cedar Beacon",
                threadId: "th1",
                regeneration: false,
              },
              path: "/dashboard/chat/th1",
            }),
            item({
              id: "n3",
              kind: "artifact_generation_failed",
              ref: { kind: "artifact", id: "a2" },
              payload: {
                title: "Quiz: Orchid",
                threadId: "th1",
                regeneration: true,
              },
              path: "/dashboard/chat/th1",
            }),
          ],
          nextCursor: null,
        },
      ],
    },
    isLoading: false,
    isError: false,
    hasNextPage: false,
  });
  const { container } = await mountWithIntl(
    <NotificationList workspaceId="ws_1" />,
  );
  expect(container.textContent).toContain(
    '"Flashcards: Cedar Beacon" could not be generated.',
  );
  expect(container.textContent).toContain(
    '"Quiz: Orchid" could not be regenerated. The previous version is kept',
  );
  container.querySelector("button")!.click();
  expect(nav.push).toHaveBeenCalledWith("/dashboard/chat/th1");
});
