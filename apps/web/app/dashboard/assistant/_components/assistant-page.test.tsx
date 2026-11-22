// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  useAssistant: vi.fn(),
  useAssistantFeed: vi.fn(),
  useAssistantTickets: vi.fn(),
  useAssistantMembers: vi.fn(),
  viewerStanding: vi.fn(),
}));
vi.mock("../../../../lib/assistant", () => hooks);
vi.mock("../../../../lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "u_me" } } }) },
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("ticket=t9"),
}));
const chatState = vi.hoisted(() => ({
  workspaceId: "ws_1" as string | null,
  hasWorkspaceHydrated: true,
}));
vi.mock("../../_components/dashboard-chat-state", () => ({
  useDashboardChatState: () => chatState,
}));
vi.mock("./enable-card", () => ({
  EnableCard: ({ isAdmin }: { isAdmin: boolean }) => (
    <div data-testid="enable" data-admin={String(isAdmin)} />
  ),
}));
vi.mock("./feed-list", () => ({
  FeedList: () => <div data-testid="feed" />,
}));
vi.mock("./feed-composer", () => ({
  FeedComposer: ({ disabledReason }: { disabledReason?: string | null }) => (
    <div data-testid="composer" data-disabled={disabledReason ?? ""} />
  ),
}));
vi.mock("./ticket-list", () => ({
  TicketList: ({
    highlightTicketId,
  }: {
    highlightTicketId?: string | null;
  }) => <div data-testid="tickets" data-highlight={highlightTicketId ?? ""} />,
}));
vi.mock("./assistant-menu", () => ({ AssistantMenu: () => null }));

import { AssistantPage } from "./assistant-page";
import { mountWithIntl, unmountAll } from "@/test/react";

function assistant(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    workspaceId: "ws_1",
    routerThreadId: "th_router",
    stewardUserId: "u_me",
    status: "active",
    statusReason: null,
    version: 1,
    createdAt: "2026-11-22T08:00:00.000Z",
    updatedAt: "2026-11-22T08:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  hooks.useAssistantMembers.mockReturnValue({
    data: [{ userId: "u_me", name: "Me", email: null }],
  });
  hooks.viewerStanding.mockReturnValue({ isAdmin: false, canWrite: true });
  hooks.useAssistantFeed.mockReturnValue({
    data: { pages: [{ items: [], nextCursor: null }] },
    isPending: false,
    isError: false,
    hasNextPage: false,
  });
  hooks.useAssistantTickets.mockReturnValue({
    data: [],
    isPending: false,
    isError: false,
  });
});
afterEach(async () => {
  await unmountAll();
  vi.clearAllMocks();
});

test("an assistant that is not enabled shows the enable card, told whether the viewer is an admin", async () => {
  hooks.useAssistant.mockReturnValue({
    data: null,
    isPending: false,
    isError: false,
  });
  const { container } = await mountWithIntl(<AssistantPage />);
  const card = container.querySelector('[data-testid="enable"]');
  expect(card?.getAttribute("data-admin")).toBe("false");
  expect(container.querySelector('[data-testid="feed"]')).toBeNull();
});

test("an enabled assistant shows its feed, composer and tickets, opened on the linked ticket", async () => {
  hooks.useAssistant.mockReturnValue({
    data: assistant(),
    isPending: false,
    isError: false,
  });
  const { container } = await mountWithIntl(<AssistantPage />);
  expect(container.querySelector('[data-testid="feed"]')).not.toBeNull();
  expect(
    container
      .querySelector('[data-testid="composer"]')
      ?.getAttribute("data-disabled"),
  ).toBe("");
  expect(
    container
      .querySelector('[data-testid="tickets"]')
      ?.getAttribute("data-highlight"),
  ).toBe("t9");
  expect(container.textContent).toContain("Me");
});

test("a paused assistant says why and its composer takes no messages", async () => {
  hooks.useAssistant.mockReturnValue({
    data: assistant({ status: "paused", statusReason: "steward_left" }),
    isPending: false,
    isError: false,
  });
  const { container } = await mountWithIntl(<AssistantPage />);
  expect(container.textContent).toContain("steward left");
  expect(
    container
      .querySelector('[data-testid="composer"]')
      ?.getAttribute("data-disabled"),
  ).toContain("paused");
});

test("a failed load says so", async () => {
  hooks.useAssistant.mockReturnValue({
    data: undefined,
    isPending: false,
    isError: true,
  });
  const { container } = await mountWithIntl(<AssistantPage />);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not load",
  );
});
