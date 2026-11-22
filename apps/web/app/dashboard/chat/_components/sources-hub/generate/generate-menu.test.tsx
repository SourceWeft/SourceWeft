// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const sdk = vi.hoisted(() => ({
  contentClient: {
    suggestTableColumns: vi.fn(),
    estimateTable: vi.fn(),
    generateTable: vi.fn(),
    regenerateTable: vi.fn(),
    listSourceMentions: vi.fn(async () => ({ items: [], nextCursor: null })),
    getSource: vi.fn(),
  },
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("../../../../../../lib/sdk", () => sdk);
// The menu renders its items inline so the test can pick one.
vi.mock("@sourceweft/ui-web/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", { role: "menu" }, children),
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) =>
    createElement(
      "button",
      { role: "menuitem", type: "button", disabled, onClick: () => onSelect?.() },
      children,
    ),
}));

import { button, flush, mountWithIntl, unmountAll } from "@/test/react";
import { GenerateMenu } from "./generate-menu";

const selected = [
  { id: "source-1", title: "Alpha report" },
  { id: "source-2", title: "Beta report" },
];

function generateButton() {
  return document.querySelector<HTMLButtonElement>('[data-testid="hub-generate-menu"]')!;
}

function text() {
  return document.body.textContent ?? "";
}

beforeEach(() => {
  sdk.contentClient.suggestTableColumns.mockResolvedValue({ columns: [] });
});

afterEach(async () => {
  await unmountAll();
  vi.clearAllMocks();
});

describe("GenerateMenu", () => {
  test("the Generate menu is disabled with no selection or no conversation", async () => {
    await mountWithIntl(
      <GenerateMenu onCreated={vi.fn()} sources={[]} threadId="thread-1" workspaceId="workspace-1" />,
    );
    expect(generateButton().disabled).toBe(true);
    expect(generateButton().title).toBe("Select sources to generate from");
    await unmountAll();

    await mountWithIntl(
      <GenerateMenu onCreated={vi.fn()} sources={selected} threadId={null} workspaceId="workspace-1" />,
    );
    expect(generateButton().disabled).toBe(true);
    expect(generateButton().title).toBe("Start a conversation to generate from sources");
  });

  test("opens the table dialog with the selected source ids", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await mountWithIntl(
      <QueryClientProvider client={client}>
        <GenerateMenu
          onCreated={vi.fn()}
          sources={selected}
          threadId="thread-1"
          workspaceId="workspace-1"
        />
      </QueryClientProvider>,
    );
    expect(generateButton().disabled).toBe(false);
    await act(async () => button("Data table").click());
    await flush(3);

    expect(text()).toContain("Generate a data table");
    expect(text()).toContain("2 sources");
    expect(text()).toContain("Alpha report");
    expect(text()).toContain("Beta report");

    await act(async () => button("Suggest columns").click());
    await flush(5);
    expect(sdk.contentClient.suggestTableColumns).toHaveBeenCalledWith("workspace-1", {
      sourceIds: ["source-1", "source-2"],
    });
  });

  test("offers flashcards, a quiz and a mind map, each with its own dialog", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await mountWithIntl(
      <QueryClientProvider client={client}>
        <GenerateMenu
          onCreated={vi.fn()}
          sources={selected}
          threadId="thread-1"
          workspaceId="workspace-1"
        />
      </QueryClientProvider>,
    );
    const items = [...document.querySelectorAll('[role="menuitem"]')].map(
      (item) => item.textContent,
    );
    expect(items).toEqual(["Data table", "Flashcards", "Quiz", "Mind map"]);

    await act(async () => button("Quiz").click());
    await flush(3);
    expect(text()).toContain("Generate a quiz");
    expect(text()).toContain("2 sources");
    expect(text()).toContain("Alpha report");
  });
});
