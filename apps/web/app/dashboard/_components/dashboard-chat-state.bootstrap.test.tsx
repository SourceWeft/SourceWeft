// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  flush,
  mount,
  mountWithIntl,
  unmountAll,
  withIntl,
} from "@/test/react";

const STORAGE_KEY = "sourceweft.dashboard.workspace-context.v1";
const WORKSPACES = [
  { id: "ws-1", name: "My Workspace" },
  { id: "ws-2", name: "Research" },
];

const auth = vi.hoisted(() => ({
  activeOrg: null as { id: string; name: string } | null,
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

function tree() {
  return withIntl(
    <DashboardChatStateProvider>
      <ActiveWorkspace />
    </DashboardChatStateProvider>,
  );
}

function shownWorkspace() {
  return document.querySelector('[data-testid="active-workspace"]')
    ?.textContent;
}

test("the session's organization arriving after the bootstrap does not bootstrap again", async () => {
  // On a real load the auth hooks resolve after the first bootstrap is out.
  auth.activeOrg = null;
  const page = await mount(tree());
  await flush(4);
  expect(shownWorkspace()).toBe("ws-1");

  auth.activeOrg = { id: "org-1", name: "Acme" };
  auth.organizations = [{ id: "org-1" }];
  await page.render(tree());
  await flush(4);

  expect(getChatBootstrap).toHaveBeenCalledTimes(1);
  expect(shownWorkspace()).toBe("ws-1");
});

test("the session's organization arriving while the bootstrap is in flight keeps that request", async () => {
  auth.activeOrg = null;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const respond = getChatBootstrap.getMockImplementation()!;
  getChatBootstrap.mockImplementation(async (input) => {
    await gate;
    return respond(input);
  });
  const page = await mount(tree());
  await flush(2);
  expect(shownWorkspace()).toBe("loading");

  auth.activeOrg = { id: "org-1", name: "Acme" };
  auth.organizations = [{ id: "org-1" }];
  await page.render(tree());
  await flush(2);
  release();
  await flush(4);

  expect(getChatBootstrap).toHaveBeenCalledTimes(1);
  expect(shownWorkspace()).toBe("ws-1");
});

test("a session organization other than the one bootstrapped bootstraps again", async () => {
  auth.activeOrg = null;
  const page = await mount(tree());
  await flush(4);
  expect(getChatBootstrap).toHaveBeenCalledTimes(1);

  // A team switch: the session now names another organization.
  const respond = getChatBootstrap.getMockImplementation()!;
  getChatBootstrap.mockImplementation(async (input) => ({
    ...(await respond(input)),
    activeOrganizationId: "org-2",
    activeOrganizationName: "Beta",
  }));
  auth.activeOrg = { id: "org-2", name: "Beta" };
  await page.render(tree());
  await flush(4);

  expect(getChatBootstrap).toHaveBeenCalledTimes(2);
  expect(shownWorkspace()).toBe("ws-1");
});

function WorkspaceRecords() {
  const { workspaceRecords } = useDashboardChatState();
  return (
    <output data-testid="workspace-records">
      {JSON.stringify(workspaceRecords)}
    </output>
  );
}

test("keeps the bootstrap's full workspace records for pages that need them", async () => {
  const records = WORKSPACES.map((workspace) => ({
    ...workspace,
    organizationId: "org-1",
    slug: workspace.id,
    createdBy: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  }));
  const respond = getChatBootstrap.getMockImplementation()!;
  getChatBootstrap.mockImplementation(async (input) => ({
    ...(await respond(input)),
    workspaces: records,
  }));
  await mount(
    withIntl(
      <DashboardChatStateProvider>
        <WorkspaceRecords />
      </DashboardChatStateProvider>,
    ),
  );
  await flush(4);

  expect(
    JSON.parse(
      document.querySelector('[data-testid="workspace-records"]')
        ?.textContent ?? "[]",
    ),
  ).toEqual(records);
});
