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
  renameThread: vi.fn(),
  pinThread: vi.fn(),
  unpinThread: vi.fn(),
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
    renameThread: sdk.renameThread,
    pinThread: sdk.pinThread,
    unpinThread: sdk.unpinThread,
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
      ],
      nextCursor: null,
    },
    pinnedChats: {
      items: [
        thread("pinned-team", "2026-10-01T00:00:00.000Z", "workspace"),
        thread("pinned-mine", "2026-11-02T12:00:00.000Z"),
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
  sdk.listThreads.mockReset();
  sdk.renameThread
    .mockReset()
    .mockImplementation(
      async (_ws: string, threadId: string, input: { title: string }) => ({
        threadId,
        title: input.title.trim(),
      }),
    );
  sdk.pinThread
    .mockReset()
    .mockImplementation(async (_ws: string, threadId: string) => ({
      threadId,
      pinned: true,
    }));
  sdk.unpinThread
    .mockReset()
    .mockImplementation(async (_ws: string, threadId: string) => ({
      threadId,
      pinned: false,
    }));
});
afterEach(unmountAll);

test("bootstrap pins sit in their own bucket in activity order, listed in pin order", async () => {
  await loadDashboard();

  expect(state.pinnedChatIds).toEqual(["pinned-team", "pinned-mine"]);
  expect(ids(state.privateChats)).toEqual(["newest", "pinned-mine", "middle"]);
  expect(ids(state.sharedChats)).toEqual(["pinned-team"]);
});

test("pinning puts a chat first in the pinned list and unpinning removes it", async () => {
  await loadDashboard();

  await run(() => state.pinChat("middle"));
  expect(sdk.pinThread).toHaveBeenCalledWith("ws-1", "middle");
  expect(state.pinnedChatIds).toEqual(["middle", "pinned-team", "pinned-mine"]);

  // Pinning again moves it to the front without duplicating it.
  await run(() => state.pinChat("pinned-mine"));
  expect(state.pinnedChatIds).toEqual(["pinned-mine", "middle", "pinned-team"]);

  await run(() => state.unpinChat("middle"));
  expect(sdk.unpinThread).toHaveBeenCalledWith("ws-1", "middle");
  expect(state.pinnedChatIds).toEqual(["pinned-mine", "pinned-team"]);
  // The chat itself never left its bucket.
  expect(ids(state.privateChats)).toContain("middle");
});

test("a failed pin leaves the pinned list unchanged", async () => {
  sdk.pinThread.mockRejectedValueOnce(new Error("offline"));
  await loadDashboard();

  let failure: unknown;
  await run(() =>
    state.pinChat("middle").catch((error: unknown) => {
      failure = error;
    }),
  );
  expect(failure).toBeInstanceOf(Error);
  expect(state.pinnedChatIds).toEqual(["pinned-team", "pinned-mine"]);
});

test("rename saves on the server and updates the title in place", async () => {
  await loadDashboard();

  await run(() => state.renameChat("middle", "  Budget notes  "));
  expect(sdk.renameThread).toHaveBeenCalledWith("ws-1", "middle", {
    title: "  Budget notes  ",
  });
  expect(state.privateChats.find((chat) => chat.id === "middle")?.title).toBe(
    "Budget notes",
  );
  // Renaming is not activity: the order is unchanged.
  expect(ids(state.privateChats)).toEqual(["newest", "pinned-mine", "middle"]);
});

test("a failed rename keeps the old title", async () => {
  sdk.renameThread.mockRejectedValueOnce(new Error("offline"));
  await loadDashboard();

  let failure: unknown;
  await run(() =>
    state.renameChat("middle", "New name").catch((error: unknown) => {
      failure = error;
    }),
  );
  expect(failure).toBeInstanceOf(Error);
  expect(state.privateChats.find((chat) => chat.id === "middle")?.title).toBe(
    "middle",
  );
});
