// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toast } from "sonner";

import { button, click, flush, mountWithIntl, unmountAll } from "@/test/react";

import DashboardPage from "./page";

const router = vi.hoisted(() => ({ push: vi.fn() }));
const chatState = vi.hoisted(() => ({
  switchWorkspace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../../lib/sdk", () => ({
  contentClient: {
    listSources: vi.fn().mockResolvedValue({ items: [] }),
    listThreads: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  },
  workspaceClient: { createWorkspace: vi.fn() },
}));
vi.mock("../../lib/dashboard-workspace-bootstrap", () => ({
  ensureDashboardWorkspace: vi.fn().mockResolvedValue({
    active: { id: "ws-1", name: "Research" },
    items: [
      {
        id: "ws-1",
        organizationId: "org-1",
        name: "Research",
        slug: "research",
        createdBy: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ],
  }),
}));
vi.mock("../../lib/dashboard-workspace-context", () => ({
  getStoredDashboardWorkspaceId: () => null,
  setStoredDashboardWorkspaceId: vi.fn(),
}));
vi.mock("../../lib/analytics-events", () => ({
  trackWorkspaceCreated: vi.fn(),
}));
vi.mock("./_components/dashboard-chat-state", () => ({
  useDashboardChatState: () => ({
    organizationId: "org-1",
    isWorkspaceHydrating: false,
    switchWorkspace: chatState.switchWorkspace,
  }),
}));
vi.mock("./_components/dashboard-team-switcher", () => ({
  DashboardTeamSwitcher: () => null,
}));

async function mountDashboard() {
  await mountWithIntl(<DashboardPage />);
  await flush(4);
  return button("Open workspace");
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(unmountAll);

test("opening a workspace navigates to the chat route when the switch succeeds", async () => {
  chatState.switchWorkspace.mockResolvedValue("switched");
  const open = await mountDashboard();

  await click(open);
  await flush(2);

  expect(chatState.switchWorkspace).toHaveBeenCalledWith("ws-1", "Research");
  expect(router.push).toHaveBeenCalledWith("/dashboard/chat");
  expect(toast.error).not.toHaveBeenCalled();
});

test("a failed switch shows an error toast, stays on the dashboard and re-enables the button", async () => {
  chatState.switchWorkspace.mockResolvedValue("failed");
  const open = await mountDashboard();

  await click(open);
  await flush(2);

  expect(toast.error).toHaveBeenCalledWith("Failed to open workspace.");
  expect(router.push).not.toHaveBeenCalled();
  expect(button("Open workspace").disabled).toBe(false);
});

test("the button is disabled while the switch is pending", async () => {
  let resolveSwitch!: (result: "switched") => void;
  chatState.switchWorkspace.mockReturnValue(
    new Promise<"switched">((resolve) => {
      resolveSwitch = resolve;
    }),
  );
  const open = await mountDashboard();

  await click(open);
  expect(button("Open workspace").disabled).toBe(true);
  expect(router.push).not.toHaveBeenCalled();

  resolveSwitch("switched");
  await flush(2);

  expect(router.push).toHaveBeenCalledWith("/dashboard/chat");
});

test("a superseded switch neither navigates nor reports an error", async () => {
  chatState.switchWorkspace.mockResolvedValue("superseded");
  const open = await mountDashboard();

  await click(open);
  await flush(2);

  expect(toast.error).not.toHaveBeenCalled();
  expect(router.push).not.toHaveBeenCalled();
});
