// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { flush, mountWithIntl, unmountAll } from "@/test/react";

const WORKSPACE = { id: "ws-1", name: "My Workspace" };

const auth = vi.hoisted(() => ({
  activeOrg: { id: "org-1", name: "Acme" },
  organizations: [] as Array<{ id: string }>,
}));
const sdk = vi.hoisted(() => ({
  getChatBootstrap: vi.fn(),
  listThreads: vi.fn(),
  archiveThread: vi.fn(),
  deleteThread: vi.fn(),
}));

vi.mock("../../../lib/auth-client", () => ({
  authClient: {
    useActiveOrganization: () => ({ data: auth.activeOrg }),
    useListOrganizations: () => ({ data: auth.organizations }),
    organization: { setActive: vi.fn() },
  },
}));
vi.mock("../../../lib/sdk", () => ({
  contentClient: {
    listThreads: sdk.listThreads,
    archiveThread: sdk.archiveThread,
    deleteThread: sdk.deleteThread,
  },
  dashboardClient: { getChatBootstrap: sdk.getChatBootstrap },
  workspaceClient: {},
}));
vi.mock("../../../lib/analytics-events", () => ({
  trackWorkspaceCreated: vi.fn(),
}));

import {
  DashboardChatStateProvider,
  useDashboardChatState,
  type DashboardChatState,
} from "./dashboard-chat-state";

function thread(
  id: string,
  lastMessageAt: string,
  visibility: "private" | "workspace" = "private",
) {
  return {
    id,
    title: id,
    visibility,
    createdAt: lastMessageAt,
    updatedAt: lastMessageAt,
    lastMessageAt,
    sourceCount: 0,
    parentThreadId: null,
  };
}

let state: DashboardChatState;
function Capture() {
  state = useDashboardChatState();
  return null;
}

async function loadDashboard() {
  await mountWithIntl(
    <DashboardChatStateProvider>
      <Capture />
    </DashboardChatStateProvider>,
  );
  await flush(4);
}

async function run(action: () => Promise<void>) {
  await act(async () => {
    await action();
  });
  await flush(2);
}

const ids = (items: Array<{ id: string }>) => items.map((item) => item.id);

beforeEach(() => {
  sdk.getChatBootstrap.mockReset().mockResolvedValue({
    authenticated: true,
    activeOrganizationId: "org-1",
    activeOrganizationName: "Acme",
    workspaces: [WORKSPACE],
    activeWorkspace: WORKSPACE,
    privateChats: {
      items: [
        thread("newest", "2026-11-03T00:00:00.000Z"),
        thread("middle", "2026-11-02T00:00:00.000Z"),
        thread("team", "2026-11-01T00:00:00.000Z", "workspace"),
      ],
      nextCursor: null,
    },
    initialChatPreferences: {
      thinking: { mode: "auto", effort: "medium" },
      webAccess: true,
      composerOptions: {},
    },
    modelCatalog: null,
    cacheHints: null,
    warnings: [],
  });
  sdk.listThreads.mockReset().mockResolvedValue({
    items: [thread("old", "2026-10-01T00:00:00.000Z")],
    nextCursor: "cursor-2",
  });
  sdk.archiveThread
    .mockReset()
    .mockImplementation(
      async (_ws: string, threadId: string, input: { archived: boolean }) => ({
        threadId,
        archived: input.archived,
      }),
    );
});
afterEach(unmountAll);

test("archiving saves on the server and the archived list is loaded from it", async () => {
  await loadDashboard();

  await run(() => state.archiveChat("middle"));
  expect(sdk.archiveThread).toHaveBeenCalledWith("ws-1", "middle", {
    archived: true,
  });
  expect(ids(state.privateChats)).toEqual(["newest"]);
  // Nothing is shown as archived until the server list is loaded.
  expect(state.archivedChats).toEqual([]);

  await run(() => state.loadArchivedChats());
  expect(sdk.listThreads).toHaveBeenCalledWith("ws-1", {
    archived: true,
    cursor: undefined,
    limit: 20,
  });
  expect(ids(state.archivedChats)).toEqual(["old"]);
  expect(state.hasMoreArchivedChats).toBe(true);

  // Opening the list again does not fetch it again.
  await run(() => state.loadArchivedChats());
  expect(sdk.listThreads).toHaveBeenCalledTimes(1);

  sdk.listThreads.mockResolvedValueOnce({
    items: [thread("older", "2026-09-01T00:00:00.000Z")],
    nextCursor: null,
  });
  await run(() => state.loadMoreArchivedChats());
  expect(sdk.listThreads).toHaveBeenLastCalledWith("ws-1", {
    archived: true,
    cursor: "cursor-2",
    limit: 20,
  });
  expect(ids(state.archivedChats)).toEqual(["old", "older"]);
  expect(state.hasMoreArchivedChats).toBe(false);

  // Once loaded, a newly archived chat joins it in activity order.
  await run(() => state.archiveChat("newest"));
  expect(ids(state.archivedChats)).toEqual(["newest", "old", "older"]);
});

test("unarchiving moves a chat back into its own bucket in activity order", async () => {
  sdk.listThreads.mockResolvedValue({
    items: [
      thread("shared-old", "2026-11-01T12:00:00.000Z", "workspace"),
      thread("private-old", "2026-11-02T12:00:00.000Z"),
    ],
    nextCursor: null,
  });
  await loadDashboard();
  await run(() => state.loadArchivedChats());

  await run(() => state.unarchiveChat("private-old"));
  expect(sdk.archiveThread).toHaveBeenCalledWith("ws-1", "private-old", {
    archived: false,
  });
  expect(ids(state.privateChats)).toEqual(["newest", "private-old", "middle"]);

  await run(() => state.unarchiveChat("shared-old"));
  expect(ids(state.sharedChats)).toEqual(["shared-old", "team"]);
  expect(state.archivedChats).toEqual([]);
});

test("a failed archive leaves the chat where it was and reports the error", async () => {
  sdk.archiveThread.mockRejectedValueOnce(new Error("offline"));
  await loadDashboard();

  let failure: unknown;
  await run(() =>
    state.archiveChat("middle").catch((error: unknown) => {
      failure = error;
    }),
  );
  expect(failure).toBeInstanceOf(Error);
  expect(ids(state.privateChats)).toEqual(["newest", "middle"]);
});

test("clearing private chats leaves the workspace assistant's own conversations alone", async () => {
  sdk.getChatBootstrap.mockResolvedValueOnce({
    ...(await sdk.getChatBootstrap()),
    privateChats: {
      items: [
        thread("newest", "2026-11-03T00:00:00.000Z"),
        {
          ...thread("ticket", "2026-11-02T00:00:00.000Z"),
          origin: "assistant_ticket",
        },
      ],
      nextCursor: null,
    },
  });
  sdk.getChatBootstrap.mockClear();
  sdk.deleteThread.mockReset().mockResolvedValue({ deleted: true });
  await loadDashboard();
  expect(ids(state.privateChats)).toEqual(["newest", "ticket"]);

  await run(() => state.clearPrivateChats());
  expect(sdk.deleteThread.mock.calls).toEqual([["ws-1", "newest"]]);
  expect(ids(state.privateChats)).toEqual(["ticket"]);
});
