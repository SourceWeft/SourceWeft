// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const listWorkspaceTraces = vi.fn();

vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}));
vi.mock("@sourceweft/ui-web/components/ai-elements/message", () => ({
  MessageResponse: () => null,
}));
// Radix menus never open in jsdom; plain buttons keep the page's own wiring.
vi.mock("@sourceweft/ui-web/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) =>
    children,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div role="menu">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  }) => (
    <button onClick={onSelect} role="menuitem" type="button">
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuSeparator: () => null,
}));
vi.mock("../_components/dashboard-chat-state", () => ({
  useDashboardChatState: () => ({
    organizationId: "org-1",
    switchWorkspace: () => {},
    workspaceId: "ws-1",
    workspaceName: "Workspace",
    workspaces: [{ id: "ws-1", name: "Workspace" }],
  }),
}));
vi.mock("../../../lib/sdk", () => ({
  llmObservabilityClient: {
    listWorkspaceTraces: (...args: unknown[]) => listWorkspaceTraces(...args),
    listTeamTraces: () => Promise.resolve({ items: [], nextCursor: null }),
  },
  contentClient: {
    listWorkspaceMcpRuns: () =>
      Promise.resolve({ items: [], nextCursor: null }),
    listWorkspaceMcpActionRuns: () => Promise.resolve({ items: [] }),
  },
}));

import ObservabilityPage from "./page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function trace(name: string) {
  return {
    id: name,
    traceId: name,
    name,
    workspaceId: "ws-1",
    startedAt: "2026-11-24T00:00:00.000Z",
    status: "ok",
  };
}

// Three pages: a, b, c. The cursor names the page it fetches.
const pages: Record<string, { items: unknown[]; nextCursor: string | null }> = {
  start: { items: [trace("trace-a")], nextCursor: "to-b" },
  "to-b": { items: [trace("trace-b")], nextCursor: "to-c" },
  "to-c": { items: [trace("trace-c")], nextCursor: null },
};

let root: Root | undefined;

beforeEach(() => {
  listWorkspaceTraces.mockReset();
  listWorkspaceTraces.mockImplementation(
    async (_workspaceId: string, query: { cursor?: string }) =>
      pages[query.cursor ?? "start"],
  );
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = "";
});

async function settle() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function shownTraces() {
  return ["trace-a", "trace-b", "trace-c"].filter((name) =>
    document.body.textContent?.includes(name),
  );
}

function button(label: string) {
  const found = [...document.querySelectorAll("button")].find((element) =>
    element.textContent?.includes(label),
  );
  expect(found, label).toBeDefined();
  return found!;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

test("the first painted frame shows loading rows, not the empty state", async () => {
  // A layout effect after the page runs before paint and before the page's
  // own effects start the first request: what it sees is what a phone shows
  // on the first frame of opening Observe.
  let firstFrame = "";
  let firstFrameSkeletons = 0;
  function FirstFrameProbe() {
    React.useLayoutEffect(() => {
      firstFrame = document.body.textContent ?? "";
      firstFrameSkeletons = document.querySelectorAll(
        '[data-slot="skeleton"]',
      ).length;
    }, []);
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <>
        <ObservabilityPage />
        <FirstFrameProbe />
      </>,
    ),
  );

  expect(firstFrame).not.toContain("table.emptyNoTraces");
  expect(firstFrameSkeletons).toBeGreaterThan(0);
  await settle();
  expect(shownTraces()).toEqual(["trace-a"]);
});

test("Next and Previous replace the list one page at a time", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<ObservabilityPage />));
  await settle();

  expect(shownTraces()).toEqual(["trace-a"]);
  expect(button("table.previousPage").disabled).toBe(true);
  expect(document.body.textContent).toContain("table.pageNumber:1");

  await click(button("table.nextPage"));
  expect(shownTraces()).toEqual(["trace-b"]);
  expect(document.body.textContent).toContain("table.pageNumber:2");

  await click(button("table.nextPage"));
  expect(shownTraces()).toEqual(["trace-c"]);
  expect(button("table.nextPage").disabled).toBe(true);

  await click(button("table.previousPage"));
  expect(shownTraces()).toEqual(["trace-b"]);
  expect(listWorkspaceTraces.mock.lastCall?.[1]).toMatchObject({
    cursor: "to-b",
    limit: 50,
  });
});

test("picking a page size reloads the first page with that limit", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<ObservabilityPage />));
  await settle();
  await click(button("table.nextPage"));
  expect(shownTraces()).toEqual(["trace-b"]);

  const trigger = document.querySelector<HTMLButtonElement>(
    '[data-testid="trace-page-size"]',
  )!;
  expect(trigger.textContent).toContain("table.pageSize:50");
  const option = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((element) => element.textContent === "table.pageSize:100");
  expect(option).toBeDefined();
  await click(option!);

  expect(listWorkspaceTraces.mock.lastCall?.[1]).toMatchObject({
    cursor: undefined,
    limit: 100,
  });
  expect(shownTraces()).toEqual(["trace-a"]);
  expect(trigger.isConnected && trigger.textContent).toContain(
    "table.pageSize:100",
  );
  expect(document.body.textContent).toContain("table.pageNumber:1");
});
