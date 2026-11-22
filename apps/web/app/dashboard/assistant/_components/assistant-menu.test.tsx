// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Assistant } from "@sourceweft/contracts/assistants";

const hooks = vi.hoisted(() => ({
  useAssistantMutations: vi.fn(),
  assistantErrorCode: () => null,
}));
vi.mock("../../../../lib/assistant", () => hooks);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
// The menu's items rendered inline, so a test can see which are offered
// without driving Radix's pointer handling in jsdom.
vi.mock("@sourceweft/ui-web/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div role="menu">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    asChild,
    onSelect,
  }: {
    children: ReactNode;
    asChild?: boolean;
    onSelect?: () => void;
  }) =>
    asChild ? (
      children
    ) : (
      <button type="button" role="menuitem" onClick={() => onSelect?.()}>
        {children}
      </button>
    ),
}));

import { AssistantMenu } from "./assistant-menu";
import { buttons, click, mountWithIntl, unmountAll } from "@/test/react";

const update = vi.fn();

const assistant: Assistant = {
  id: "a1",
  workspaceId: "ws_1",
  routerThreadId: "th_router",
  stewardUserId: "u_admin",
  status: "active",
  statusReason: null,
  version: 4,
  createdAt: "2026-11-22T08:00:00.000Z",
  updatedAt: "2026-11-22T08:00:00.000Z",
};

beforeEach(() => {
  update.mockResolvedValue({ assistant });
  hooks.useAssistantMutations.mockReturnValue({
    update: { mutateAsync: update, isPending: false },
  });
});
afterEach(async () => {
  await unmountAll();
  vi.clearAllMocks();
});

function menu(container: HTMLElement) {
  return container.querySelector('[role="menu"]') as HTMLElement;
}

test("an admin who can write may pause, change the steward and view the work log", async () => {
  const { container } = await mountWithIntl(
    <AssistantMenu
      assistant={assistant}
      workspaceId="ws_1"
      isAdmin
      canWrite
      members={[]}
    />,
  );
  expect(buttons("Pause", menu(container))).toHaveLength(1);
  expect(buttons("Change steward", menu(container))).toHaveLength(1);
  expect(
    menu(container).querySelector('a[href="/dashboard/chat/th_router"]')
      ?.textContent,
  ).toBe("View work log");

  await click(buttons("Pause", menu(container))[0]!);
  expect(update).toHaveBeenCalledWith({ version: 4, action: "pause" });
});

test("a member who is not an admin is not offered the steward change", async () => {
  const { container } = await mountWithIntl(
    <AssistantMenu
      assistant={{ ...assistant, status: "paused", statusReason: "by_admin" }}
      workspaceId="ws_1"
      isAdmin={false}
      canWrite
      members={[]}
    />,
  );
  expect(buttons("Change steward", menu(container))).toHaveLength(0);
  expect(buttons("Resume", menu(container))).toHaveLength(1);
});

test("a read-only member can only view the work log", async () => {
  const { container } = await mountWithIntl(
    <AssistantMenu
      assistant={assistant}
      workspaceId="ws_1"
      isAdmin={false}
      canWrite={false}
      members={[]}
    />,
  );
  expect(buttons("Pause", menu(container))).toHaveLength(0);
  expect(buttons("Resume", menu(container))).toHaveLength(0);
  expect(buttons("Change steward", menu(container))).toHaveLength(0);
  expect(
    menu(container).querySelector('a[href="/dashboard/chat/th_router"]'),
  ).not.toBeNull();
});
