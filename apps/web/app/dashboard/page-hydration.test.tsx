// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { flush, mountWithIntl, unmountAll, withIntl } from "@/test/react";
import { ensureDashboardWorkspace } from "../../lib/dashboard-workspace-bootstrap";

import DashboardPage from "./page";

// What useDashboardChatState returns; tests change it and render again.
const chatState = vi.hoisted(() => ({
  organizationId: "org-1" as string | null,
  isWorkspaceHydrating: false,
  workspaceId: null as string | null,
  workspaces: [] as Array<{ id: string; name: string }>,
  workspaceRecords: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
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
  ensureDashboardWorkspace: vi.fn(async (organizationId: string) => ({
    active: { id: `${organizationId}-ws`, name: "Research" },
    items: [
      {
        id: `${organizationId}-ws`,
        organizationId,
        name: "Research",
        slug: "research",
        createdBy: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ],
  })),
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
    ...chatState,
    switchWorkspace: vi.fn(),
  }),
}));
vi.mock("./_components/dashboard-team-switcher", () => ({
  DashboardTeamSwitcher: () => null,
}));

const loadWorkspaces = vi.mocked(ensureDashboardWorkspace);

function skeletonShown() {
  return document.querySelector(".animate-pulse") !== null;
}

function workspaceShown() {
  return [...document.querySelectorAll("button")].some((element) =>
    element.textContent?.includes("Open workspace"),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  chatState.organizationId = "org-1";
  chatState.isWorkspaceHydrating = false;
  chatState.workspaceId = null;
  chatState.workspaces = [];
  chatState.workspaceRecords = [];
});
afterEach(unmountAll);

test("waits for the chat state to finish hydrating before loading", async () => {
  chatState.isWorkspaceHydrating = true;
  const page = await mountWithIntl(<DashboardPage />);
  await flush(4);

  expect(loadWorkspaces).not.toHaveBeenCalled();
  expect(skeletonShown()).toBe(true);

  chatState.isWorkspaceHydrating = false;
  await page.render(withIntl(<DashboardPage />));
  await flush(4);

  expect(loadWorkspaces).toHaveBeenCalledTimes(1);
  expect(workspaceShown()).toBe(true);
  expect(skeletonShown()).toBe(false);
});

test("hydrating again for the same organization keeps the list and does not refetch", async () => {
  // The auth session's organization arrives after the first bootstrap, so
  // the chat state hydrates a second time for the organization it already has.
  const page = await mountWithIntl(<DashboardPage />);
  await flush(4);
  expect(workspaceShown()).toBe(true);

  chatState.isWorkspaceHydrating = true;
  await page.render(withIntl(<DashboardPage />));
  await flush(4);
  expect(skeletonShown()).toBe(false);
  expect(workspaceShown()).toBe(true);

  chatState.isWorkspaceHydrating = false;
  await page.render(withIntl(<DashboardPage />));
  await flush(4);

  expect(loadWorkspaces).toHaveBeenCalledTimes(1);
  expect(skeletonShown()).toBe(false);
  expect(workspaceShown()).toBe(true);
});

test("switching to another organization loads that organization's workspaces", async () => {
  const page = await mountWithIntl(<DashboardPage />);
  await flush(4);

  chatState.organizationId = "org-2";
  await page.render(withIntl(<DashboardPage />));
  await flush(4);

  expect(loadWorkspaces).toHaveBeenCalledTimes(2);
  expect(loadWorkspaces).toHaveBeenLastCalledWith("org-2");
  expect(workspaceShown()).toBe(true);
});

test("a response for an organization that is no longer current is dropped", async () => {
  let resolveFirst!: (
    value: Awaited<ReturnType<typeof loadWorkspaces>>,
  ) => void;
  loadWorkspaces.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );
  const page = await mountWithIntl(<DashboardPage />);
  await flush(2);

  chatState.organizationId = "org-2";
  await page.render(withIntl(<DashboardPage />));
  await flush(4);
  expect(workspaceShown()).toBe(true);

  resolveFirst({ active: null, items: [] } as never);
  await flush(4);

  // Still org-2's workspace, not org-1's empty list.
  expect(workspaceShown()).toBe(true);
  expect(skeletonShown()).toBe(false);
});

function bootstrapped(organizationId: string, name = "Research") {
  const record = {
    id: `${organizationId}-ws`,
    organizationId,
    name,
    slug: "research",
    createdBy: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  chatState.workspaceId = record.id;
  chatState.workspaceRecords = [record];
  chatState.workspaces = [{ id: record.id, name: record.name }];
}

test("uses the workspaces the chat bootstrap already loaded", async () => {
  bootstrapped("org-1");
  await mountWithIntl(<DashboardPage />);
  await flush(4);

  expect(loadWorkspaces).not.toHaveBeenCalled();
  expect(workspaceShown()).toBe(true);
  expect(skeletonShown()).toBe(false);
});

test("asks the server when the bootstrap's list is out of date", async () => {
  bootstrapped("org-1");
  // Renamed since the bootstrap.
  chatState.workspaces = [{ id: "org-1-ws", name: "Renamed" }];
  await mountWithIntl(<DashboardPage />);
  await flush(4);

  expect(loadWorkspaces).toHaveBeenCalledTimes(1);
  expect(workspaceShown()).toBe(true);
});

test("asks the server when the bootstrap's list is for another organization", async () => {
  bootstrapped("org-2");
  await mountWithIntl(<DashboardPage />);
  await flush(4);

  expect(loadWorkspaces).toHaveBeenCalledWith("org-1");
});
