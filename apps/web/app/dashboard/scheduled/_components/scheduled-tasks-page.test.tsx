// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  useAgentTasks: vi.fn(),
  useNotificationMutations: vi.fn(),
  useUnreadNotificationCount: vi.fn(),
}));
vi.mock("../../../../lib/scheduled-tasks", () => hooks);
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) => (
    <a href={href}>{children as never}</a>
  ),
}));
vi.mock("../../_components/dashboard-chat-state", () => ({
  useDashboardChatState: () => ({
    workspaceId: "ws_1",
    hasWorkspaceHydrated: true,
  }),
}));
vi.mock("./notification-list", () => ({ NotificationList: () => null }));
vi.mock("./task-form-dialog", () => ({
  TaskFormDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="form" /> : null,
}));
vi.mock("./task-menu", () => ({ TaskMenu: () => <span>menu</span> }));

import { ScheduledTasksPage } from "./scheduled-tasks-page";
import { mountWithIntl, unmountAll } from "@/test/react";

function task(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    name: "Morning digest",
    status: "active",
    statusReason: null,
    schedule: {
      rule: { kind: "daily", time: "08:00" },
      timezone: "UTC",
      enabled: true,
      nextDueAt: "2026-11-20T08:00:00.000Z",
    },
    ...over,
  };
}

beforeEach(() => {
  hooks.useNotificationMutations.mockReturnValue({
    markAllRead: { mutate: vi.fn(), isPending: false },
  });
  hooks.useUnreadNotificationCount.mockReturnValue({ data: 0 });
});
afterEach(async () => {
  await unmountAll();
  vi.clearAllMocks();
});

test("each task shows its name, status, rule and next run, and links to its page", async () => {
  hooks.useAgentTasks.mockReturnValue({
    data: [task()],
    isLoading: false,
    isError: false,
  });
  const { container } = await mountWithIntl(<ScheduledTasksPage />);
  const link = container.querySelector('a[href="/dashboard/scheduled/t1"]')!;
  expect(link.textContent).toBe("Morning digest");
  expect(container.textContent).toContain("Active");
  expect(container.textContent).toContain("Every day at 08:00 · UTC");
  expect(container.textContent).toContain("Next run");
});

test("a blocked task says why, a deleted one is not listed", async () => {
  hooks.useAgentTasks.mockReturnValue({
    data: [
      task({ status: "blocked", statusReason: "tools_unavailable" }),
      task({ id: "t2", name: "Gone", status: "archived" }),
    ],
    isLoading: false,
    isError: false,
  });
  const { container } = await mountWithIntl(<ScheduledTasksPage />);
  expect(container.textContent).toContain("no longer available");
  expect(container.textContent).not.toContain("Gone");
});

test("with no tasks the page offers to create one", async () => {
  hooks.useAgentTasks.mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
  });
  const { container } = await mountWithIntl(<ScheduledTasksPage />);
  expect(container.textContent).toContain("No scheduled tasks yet");
  const create = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "New task",
  )!;
  create.click();
  await Promise.resolve();
  expect(container.querySelector('[data-testid="form"]')).not.toBeNull();
});

test("a failed load says so", async () => {
  hooks.useAgentTasks.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: true,
  });
  const { container } = await mountWithIntl(<ScheduledTasksPage />);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not load",
  );
});
