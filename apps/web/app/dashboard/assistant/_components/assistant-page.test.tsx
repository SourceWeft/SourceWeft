// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  useAssistant: vi.fn(),
  useAssistantFeed: vi.fn(),
  useAssistantTickets: vi.fn(),
  useAssistantMembers: vi.fn(),
  useAssistantMutations: vi.fn(),
  useAssistantDecisions: vi.fn(),
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
  FeedComposer: ({
    disabledReason,
    seed,
  }: {
    disabledReason?: string | null;
    seed?: { id: number; text: string } | null;
  }) => (
    <div
      data-testid="composer"
      data-disabled={disabledReason ?? ""}
      data-seed={seed?.text ?? ""}
    />
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
vi.mock("./decision-list", () => ({
  DecisionList: () => <div data-testid="decisions" />,
}));

import { AssistantPage } from "./assistant-page";
import { click, mountWithIntl, unmountAll } from "@/test/react";

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
  hooks.useAssistantMutations.mockReturnValue({
    update: { mutateAsync: vi.fn(), isPending: false },
  });
  hooks.useAssistantDecisions.mockReturnValue({
    data: { pages: [{ items: [], nextCursor: null }] },
    isPending: false,
    isError: false,
    hasNextPage: false,
  });
  hooks.useAssistantMembers.mockReturnValue({
    data: [{ userId: "u_me", name: "Me", email: null }],
    isPending: false,
  });
  hooks.viewerStanding.mockReturnValue({ isAdmin: false, canWrite: true });
  hooks.useAssistantFeed.mockReturnValue({
    data: { pages: [{ items: [{ id: "f1" }], nextCursor: null }] },
    isPending: false,
    isError: false,
    hasNextPage: false,
  });
  hooks.useAssistantTickets.mockReturnValue({
    data: [{ id: "t0", stage: "working" }],
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

test("on a phone the activity and the tickets are two tabs, opened on the tickets when a notification linked one", async () => {
  hooks.useAssistant.mockReturnValue({
    data: assistant(),
    isPending: false,
    isError: false,
  });
  hooks.useAssistantTickets.mockReturnValue({
    data: [
      { id: "t1", stage: "waiting_person" },
      { id: "t2", stage: "working" },
      { id: "t3", stage: "ended" },
    ],
    isPending: false,
    isError: false,
  });
  const { container } = await mountWithIntl(<AssistantPage />);
  const tabs = [...container.querySelectorAll("[data-view-tab]")];
  expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
    "false",
    "true",
  ]);
  // The badge counts the tickets that need a person; ended ones are not open.
  expect(tabs[1]?.textContent).toContain("1");

  await click(tabs[0] as HTMLElement);
  expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
});

test("a workspace that has never used the assistant gets a greeting, and a suggestion only fills the composer", async () => {
  hooks.useAssistant.mockReturnValue({
    data: assistant(),
    isPending: false,
    isError: false,
  });
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
  const { container } = await mountWithIntl(<AssistantPage />);
  expect(container.querySelector('[data-testid="feed"]')).toBeNull();
  expect(container.querySelector('[data-testid="tickets"]')).toBeNull();
  expect(container.querySelector("[data-view-tab]")).toBeNull();
  expect(container.textContent).toContain("What should the assistant work on?");

  const pick = container.querySelector(
    'button[type="button"]',
  ) as HTMLButtonElement;
  await click(pick);
  expect(
    container
      .querySelector('[data-testid="composer"]')
      ?.getAttribute("data-seed"),
  ).toBe(pick.textContent);
});

test("a paused assistant disables the suggestions", async () => {
  hooks.useAssistant.mockReturnValue({
    data: assistant({ status: "paused" }),
    isPending: false,
    isError: false,
  });
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
  const { container } = await mountWithIntl(<AssistantPage />);
  const pick = container.querySelector(
    'button[type="button"]',
  ) as HTMLButtonElement;
  expect(pick.disabled).toBe(true);
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

test("while the members are loading the page waits, instead of telling an admin to ask one", async () => {
  hooks.useAssistant.mockReturnValue({
    data: null,
    isPending: false,
    isError: false,
  });
  hooks.useAssistantMembers.mockReturnValue({
    data: undefined,
    isPending: true,
  });
  const { container } = await mountWithIntl(<AssistantPage />);
  expect(container.querySelector('[data-testid="enable"]')).toBeNull();
  expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
});

test("while the members are loading an enabled assistant names no steward yet", async () => {
  hooks.useAssistant.mockReturnValue({
    data: assistant({ stewardUserId: "u_other" }),
    isPending: false,
    isError: false,
  });
  hooks.useAssistantMembers.mockReturnValue({
    data: undefined,
    isPending: true,
  });
  const { container } = await mountWithIntl(<AssistantPage />);
  expect(container.textContent).not.toContain("A former member");
  expect(container.textContent).not.toContain("Steward:");
});

test("the tickets panel can be hidden and shown again", async () => {
  hooks.useAssistant.mockReturnValue({
    data: assistant(),
    isPending: false,
    isError: false,
  });
  const { container } = await mountWithIntl(<AssistantPage />);
  const toggle = container.querySelector(
    "button[aria-pressed]",
  ) as HTMLButtonElement;
  const panel = container.querySelector("aside") as HTMLElement;
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(panel.className).not.toContain("md:hidden");
  await click(toggle);
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(panel.className).toContain("md:hidden");
});

test("the summary strip counts what needs a person and opens the tickets; a quiet assistant shows none", async () => {
  hooks.useAssistant.mockReturnValue({
    data: assistant(),
    isPending: false,
    isError: false,
  });
  const quiet = await mountWithIntl(<AssistantPage />);
  expect(quiet.container.querySelector('[role="status"]')).toBeNull();
  await unmountAll();

  hooks.useAssistantTickets.mockReturnValue({
    data: [
      { id: "t1", stage: "waiting_person", blockedReason: null },
      { id: "t2", stage: "working", blockedReason: "credit_cap" },
      { id: "t3", stage: "ended", blockedReason: "credit_cap" },
    ],
    isPending: false,
    isError: false,
  });
  const { container } = await mountWithIntl(<AssistantPage />);
  const strip = container.querySelector('[role="status"]') as HTMLElement;
  expect(strip.textContent).toContain("1 ticket is waiting for you");
  expect(strip.textContent).toContain("1 ticket is blocked");
  const tabs = [...container.querySelectorAll("[data-view-tab]")];
  // The test's URL names a ticket, so it opens on the tickets; go back to the
  // activity, then let the strip take us to the tickets again.
  await click(tabs[0] as HTMLElement);
  expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
  await click(strip.querySelector("button") as HTMLElement);
  expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
});

test("the decisions section replaces the conversation and brings it back", async () => {
  hooks.useAssistant.mockReturnValue({
    data: assistant(),
    isPending: false,
    isError: false,
  });
  const { container } = await mountWithIntl(<AssistantPage />);
  const section = (key: string) =>
    container.querySelector(`[data-section="${key}"]`) as HTMLElement;
  await click(section("decisions"));
  expect(container.querySelector('[data-testid="decisions"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="feed"]')).toBeNull();
  expect(container.querySelector('[data-testid="composer"]')).toBeNull();
  await click(section("chat"));
  expect(container.querySelector('[data-testid="feed"]')).not.toBeNull();
});
