// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { flush, mountWithIntl, unmountAll } from "@/test/react";

const STORAGE_KEY = "sourceweft.dashboard.workspace-context.v1";
const WORKSPACES = [
  { id: "ws-1", name: "My Workspace" },
  { id: "ws-2", name: "Research" },
];

const auth = vi.hoisted(() => ({
  activeOrg: null as { id: string; name: string } | null,
  // One stable list: the provider re-runs its bootstrap when the list changes.
  organizations: [] as Array<{ id: string }>,
}));
const getChatBootstrap = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/auth-client", () => ({
  authClient: {
    useActiveOrganization: () => ({ data: auth.activeOrg }),
    useListOrganizations: () => ({ data: auth.organizations }),
    organization: { setActive: vi.fn() },
  },
}));
vi.mock("../../../lib/sdk", () => ({
  contentClient: {},
  dashboardClient: { getChatBootstrap },
  workspaceClient: {},
}));
vi.mock("../../../lib/analytics-events", () => ({
  trackWorkspaceCreated: vi.fn(),
}));

import {
  DashboardChatStateProvider,
  useDashboardChatState,
} from "./dashboard-chat-state";

function ActiveWorkspace() {
  const { hasWorkspaceHydrated, workspaceId } = useDashboardChatState();
  return (
    <output data-testid="active-workspace">
      {hasWorkspaceHydrated ? workspaceId : "loading"}
    </output>
  );
}

async function loadDashboard() {
  await mountWithIntl(
    <DashboardChatStateProvider>
      <ActiveWorkspace />
    </DashboardChatStateProvider>,
  );
  await flush(4);
  return document.querySelector('[data-testid="active-workspace"]')
    ?.textContent;
}

function rememberedWorkspaces() {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
}

beforeEach(() => {
  window.localStorage.clear();
  auth.activeOrg = { id: "org-1", name: "Acme" };
  // The server opens the requested workspace, or the first one without it.
  getChatBootstrap
    .mockReset()
    .mockImplementation(async ({ workspaceId }: { workspaceId?: string }) => ({
      authenticated: true,
      activeOrganizationId: "org-1",
      activeOrganizationName: "Acme",
      workspaces: WORKSPACES,
      activeWorkspace:
        WORKSPACES.find((workspace) => workspace.id === workspaceId) ??
        WORKSPACES[0],
      privateChats: { items: [], nextCursor: null },
      initialChatPreferences: {
        thinking: { mode: "auto", effort: "medium" },
        webAccess: true,
        composerOptions: {},
      },
      modelCatalog: null,
      cacheHints: null,
      warnings: [],
    }));
});
afterEach(unmountAll);

test("a full load opens the workspace last selected in this browser", async () => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ "org-1": "ws-2" }));

  expect(await loadDashboard()).toBe("ws-2");
  expect(getChatBootstrap.mock.calls).toEqual([
    [{ includeModelCatalog: false, workspaceId: "ws-2" }],
  ]);
  expect(rememberedWorkspaces()).toEqual({ "org-1": "ws-2" });
});

test("a full load keeps the remembered workspace when the session has no active organization yet", async () => {
  auth.activeOrg = null;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ "org-1": "ws-2" }));

  expect(await loadDashboard()).toBe("ws-2");
  expect(rememberedWorkspaces()).toEqual({ "org-1": "ws-2" });
});

test("a first visit opens the default workspace and remembers it", async () => {
  expect(await loadDashboard()).toBe("ws-1");
  expect(getChatBootstrap).toHaveBeenCalledTimes(1);
  expect(rememberedWorkspaces()).toEqual({ "org-1": "ws-1" });
});
