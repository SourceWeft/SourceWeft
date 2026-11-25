// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AssistantTicket } from "@sourceweft/contracts/assistants";

const hooks = vi.hoisted(() => ({
  useAssistantMutations: vi.fn(),
  assistantErrorCode: () => null,
}));
vi.mock("../../../../lib/assistant", () => hooks);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) => (
    <a href={href}>{children as never}</a>
  ),
}));

import { TicketList } from "./ticket-list";
import {
  button,
  buttons,
  click,
  mountWithIntl,
  unmountAll,
} from "@/test/react";

const retry = vi.fn();
const close = vi.fn();

function ticket(over: Partial<AssistantTicket> = {}): AssistantTicket {
  return {
    id: "t1",
    assistantId: "a1",
    workerThreadId: "th_worker_1",
    title: "Fix the flaky test",
    goal: "Make CI green",
    payerUserId: "u1",
    origin: "explicit",
    stage: "working",
    outcome: null,
    blockedReason: null,
    creditCap: 500,
    consecutiveFailures: 0,
    lastReportSummary: null,
    createdAt: "2026-11-22T08:00:00.000Z",
    updatedAt: "2026-11-22T08:00:00.000Z",
    endedAt: null,
    ...over,
  };
}

beforeEach(() => {
  retry.mockResolvedValue({});
  close.mockResolvedValue({});
  hooks.useAssistantMutations.mockReturnValue({
    retryTicket: { mutateAsync: retry, isPending: false },
    closeTicket: { mutateAsync: close, isPending: false },
  });
});
afterEach(async () => {
  await unmountAll();
  vi.clearAllMocks();
});

test("a ticket waiting for a person offers retry and close; a working one does not", async () => {
  const { container } = await mountWithIntl(
    <TicketList
      workspaceId="ws_1"
      tickets={[
        ticket({
          id: "t_wait",
          title: "Blocked report",
          stage: "waiting_person",
          blockedReason: "repeated_failure",
        }),
        ticket({ id: "t_work", title: "Running job" }),
      ]}
      members={[]}
      canWrite
      viewerId="u1"
    />,
  );
  const waiting = container.querySelector('[data-ticket-id="t_wait"]')!;
  const working = container.querySelector('[data-ticket-id="t_work"]')!;
  expect(buttons("Retry", waiting as HTMLElement)).toHaveLength(1);
  expect(buttons("Close", waiting as HTMLElement)).toHaveLength(1);
  expect(buttons("Retry", working as HTMLElement)).toHaveLength(0);
  expect(buttons("Close", working as HTMLElement)).toHaveLength(0);
  expect(waiting.textContent).toContain("repeated failed runs");

  await click(buttons("Retry", waiting as HTMLElement)[0]!);
  expect(retry).toHaveBeenCalledWith("t_wait");
  await click(buttons("Close", waiting as HTMLElement)[0]!);
  expect(close).toHaveBeenCalledWith("t_wait");
});

test("tickets are grouped into needs-a-person, in progress and idle; ended ones are left out", async () => {
  const { container } = await mountWithIntl(
    <TicketList
      workspaceId="ws_1"
      tickets={[
        ticket({ id: "a", stage: "waiting_person" }),
        ticket({ id: "b", stage: "queued" }),
        ticket({ id: "c", stage: "working" }),
        ticket({ id: "d", stage: "idle" }),
        ticket({ id: "e", stage: "ended", title: "Done long ago" }),
      ]}
      members={[]}
      canWrite
      viewerId="u1"
    />,
  );
  const groups = [...container.querySelectorAll("section[data-group]")].map(
    (section) => ({
      group: section.getAttribute("data-group"),
      ids: [...section.querySelectorAll("[data-ticket-id]")].map((row) =>
        row.getAttribute("data-ticket-id"),
      ),
    }),
  );
  expect(groups).toEqual([
    { group: "needsPerson", ids: ["a"] },
    { group: "inProgress", ids: ["b", "c"] },
    { group: "idle", ids: ["d"] },
  ]);
  expect(container.textContent).not.toContain("Done long ago");
});

test("each ticket links to its worker conversation", async () => {
  const { container } = await mountWithIntl(
    <TicketList
      workspaceId="ws_1"
      tickets={[ticket()]}
      members={[]}
      canWrite
      viewerId="u1"
    />,
  );
  expect(
    container.querySelector('a[href="/dashboard/chat/th_worker_1"]'),
  ).not.toBeNull();
});

test("a member without write access sees a waiting ticket but no retry or close", async () => {
  const { container } = await mountWithIntl(
    <TicketList
      workspaceId="ws_1"
      tickets={[ticket({ id: "t_wait", stage: "waiting_person" })]}
      members={[]}
      canWrite={false}
      viewerId="u1"
    />,
  );
  const waiting = container.querySelector(
    '[data-ticket-id="t_wait"]',
  ) as HTMLElement;
  expect(waiting).not.toBeNull();
  expect(buttons("Retry", waiting)).toHaveLength(0);
  expect(buttons("Close", waiting)).toHaveLength(0);
});

test("only the ticket's payer is offered Retry; another member with write access can still close it", async () => {
  const { container } = await mountWithIntl(
    <TicketList
      workspaceId="ws_1"
      tickets={[
        ticket({ id: "t_wait", stage: "waiting_person", payerUserId: "u1" }),
      ]}
      members={[]}
      canWrite
      viewerId="u2"
    />,
  );
  const waiting = container.querySelector(
    '[data-ticket-id="t_wait"]',
  ) as HTMLElement;
  expect(buttons("Retry", waiting)).toHaveLength(0);
  expect(buttons("Close", waiting)).toHaveLength(1);
});

test("a group folds and unfolds from its header", async () => {
  const { container } = await mountWithIntl(
    <TicketList
      workspaceId="ws_1"
      tickets={[ticket()]}
      members={[]}
      canWrite
      viewerId="u1"
    />,
  );
  const header = container.querySelector(
    "[data-group] button[aria-expanded]",
  ) as HTMLElement;
  expect(container.querySelector("[data-ticket-id]")).not.toBeNull();
  await click(header);
  expect(header.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector("[data-ticket-id]")).toBeNull();
  await click(header);
  expect(container.querySelector("[data-ticket-id]")).not.toBeNull();
});

test("a ticket's details open on request and show its goal, origin and cap", async () => {
  const { container } = await mountWithIntl(
    <TicketList
      workspaceId="ws_1"
      tickets={[ticket({ consecutiveFailures: 2 })]}
      members={[]}
      canWrite
      viewerId="u1"
    />,
  );
  expect(container.textContent).not.toContain("Make CI green");
  await click(button("Details", container));
  expect(container.textContent).toContain("Make CI green");
  expect(container.textContent).toContain("Asked for by a member");
  expect(container.textContent).toContain("500");
  expect(container.textContent).toContain("Failed runs in a row");
  await click(button("Hide details", container));
  expect(container.textContent).not.toContain("Make CI green");
});
