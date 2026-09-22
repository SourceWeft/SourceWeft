// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  getSkillAnalysisPreview: vi.fn(),
  queueSkillAnalysisBatch: vi.fn(),
  getSkillOverviewBilling: vi.fn(),
  getSkillOverviewStatus: vi.fn(),
  setSkillOverviewBilling: vi.fn(),
}));
vi.mock("../../../../../lib/skill-overviews", () => api);
vi.mock("../../../../../lib/auth-client", () => ({
  authClient: {
    useListOrganizations: () => ({
      data: [{ id: "team_1", name: "Platform" }],
    }),
  },
}));
const workspaces = vi.hoisted(() => ({ listWorkspaces: vi.fn() }));
vi.mock("../../../../../lib/sdk", () => ({ workspaceClient: workspaces }));

import {
  SkillMarketSettingsAdmin,
  overviewBillingRequest,
} from "./skill-market-settings-admin";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../../../messages/en.json";

const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];
const withIntl = (node: ReactNode) => (
  <NextIntlClientProvider locale="en" messages={intlMessages}>
    {node}
  </NextIntlClientProvider>
);

let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.resetAllMocks();
});

const status = {
  billingConfigured: false,
  eligible: 12,
  withOverview: 9,
  missing: 3,
  hidden: 1,
};

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(withIntl(<SkillMarketSettingsAdmin />)));
}

function select(label: string) {
  return container.querySelector<HTMLSelectElement>(
    `select[aria-label="${label}"]`,
  )!;
}

async function choose(label: string, value: string) {
  const node = select(label);
  await act(async () => {
    node.value = value;
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

test("a blank member bills the admin saving it", () => {
  expect(
    overviewBillingRequest({ teamId: "t", workspaceId: "w", userId: "  " }),
  ).toEqual({ teamId: "t", workspaceId: "w" });
  expect(
    overviewBillingRequest({ teamId: "t", workspaceId: "w", userId: " u " }),
  ).toEqual({ teamId: "t", workspaceId: "w", userId: "u" });
});

test("unset billing is shown as such, with the coverage counts", async () => {
  api.getSkillOverviewBilling.mockResolvedValue({
    billing: null,
    updatedBy: null,
    updatedAt: null,
  });
  api.getSkillOverviewStatus.mockResolvedValue(status);
  await render();
  expect(
    container.querySelector('[data-testid="overview-billing-current"]')
      ?.textContent,
  ).toContain("Not set");
  const counts = container.querySelector('[data-testid="overview-status"]');
  expect(counts?.textContent).toContain("Eligible skills12");
  expect(counts?.textContent).toContain("Missing3");
  expect(counts?.textContent).toContain("Billing setNo");
});

test("choosing a team lists its workspaces; saving sends team and workspace", async () => {
  api.getSkillOverviewBilling.mockResolvedValue({
    billing: null,
    updatedBy: null,
    updatedAt: null,
  });
  api.getSkillOverviewStatus.mockResolvedValue(status);
  workspaces.listWorkspaces.mockResolvedValue({
    items: [{ id: "ws_1", name: "Ops", organizationId: "team_1" }],
  });
  api.setSkillOverviewBilling.mockResolvedValue({
    billing: { teamId: "team_1", workspaceId: "ws_1", userId: "admin_1" },
    updatedBy: "admin_1",
    updatedAt: "2026-09-22T00:00:00.000Z",
  });
  await render();

  await choose("Team", "team_1");
  expect(workspaces.listWorkspaces).toHaveBeenCalledWith("team_1");
  await choose("Workspace", "ws_1");

  const form = container.querySelector("form")!;
  await act(async () =>
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(api.setSkillOverviewBilling).toHaveBeenCalledWith({
    teamId: "team_1",
    workspaceId: "ws_1",
  });
  const current = container.querySelector(
    '[data-testid="overview-billing-current"]',
  )?.textContent;
  expect(current).toContain("Platform / Ops / admin_1");
  expect(container.textContent).toContain("Saved.");
});

test("a saved setting preselects its team and workspace; a refusal shows the reason", async () => {
  api.getSkillOverviewBilling.mockResolvedValue({
    billing: { teamId: "team_1", workspaceId: "ws_1", userId: "admin_1" },
    updatedBy: "admin_1",
    updatedAt: "2026-09-22T00:00:00.000Z",
  });
  api.getSkillOverviewStatus.mockResolvedValue({
    ...status,
    billingConfigured: true,
  });
  workspaces.listWorkspaces.mockResolvedValue({
    items: [{ id: "ws_1", name: "Ops", organizationId: "team_1" }],
  });
  api.setSkillOverviewBilling.mockRejectedValue(
    new Error("The billed user is not a member of this workspace"),
  );
  await render();
  expect(select("Team").value).toBe("team_1");
  expect(select("Workspace").value).toBe("ws_1");

  const member = container.querySelector<HTMLInputElement>(
    'input[aria-label="Billed member (user id)"]',
  )!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(member, "user_9");
    member.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(api.setSkillOverviewBilling).toHaveBeenCalledWith({
    teamId: "team_1",
    workspaceId: "ws_1",
    userId: "user_9",
  });
  expect(container.textContent).toContain("not a member of this workspace");
});

const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  )!;
test("preview preserves manual categories and queues only eligible reviewed batch IDs", async () => {
  api.getSkillOverviewBilling.mockResolvedValue({
    billing: null,
    updatedBy: null,
    updatedAt: null,
  });
  api.getSkillOverviewStatus.mockResolvedValue(status);
  const item = {
    skillId: "s1",
    skillVersionId: "v1",
    name: "PDF skill",
    categoriesSource: "auto",
    status: "legacy",
    categories: ["development"],
    suggestedCategories: ["documents"],
    error: null,
    stale: true,
  };
  api.getSkillAnalysisPreview.mockResolvedValue({
    qualityApproved: true,
    items: [
      item,
      { ...item, skillVersionId: "manual", categoriesSource: "admin" },
      { ...item, skillVersionId: "running", status: "running" },
    ],
    nextCursor: "next",
  });
  api.queueSkillAnalysisBatch.mockResolvedValue({ queued: 1, skipped: 0 });
  await render();
  expect(api.getSkillAnalysisPreview).not.toHaveBeenCalled();
  await act(async () => button("Preview analysis batch").click());
  expect(container.textContent).toContain("Current categories: development");
  expect(container.textContent).toContain("AI suggestions: documents");
  await act(async () => button("Generate / retry this batch (1)").click());
  expect(api.queueSkillAnalysisBatch).toHaveBeenCalledWith(["v1"]);
  expect(container.textContent).toContain("Queued 1; skipped 0.");
  await act(async () => button("Next batch").click());
  expect(api.getSkillAnalysisPreview).toHaveBeenLastCalledWith("next");
});

test("quality approval is required for bulk migration", async () => {
  api.getSkillOverviewBilling.mockResolvedValue({
    billing: null,
    updatedBy: null,
    updatedAt: null,
  });
  api.getSkillOverviewStatus.mockResolvedValue(status);
  api.getSkillAnalysisPreview.mockResolvedValue({
    qualityApproved: false,
    items: [
      {
        skillId: "s",
        skillVersionId: "v",
        name: "Skill",
        categoriesSource: "auto",
        status: "legacy",
        categories: [],
        suggestedCategories: [],
        error: null,
        stale: true,
      },
    ],
    nextCursor: null,
  });
  await render();
  await act(async () => button("Preview analysis batch").click());
  expect(button("Generate / retry this batch (1)").disabled).toBe(true);
  expect(container.textContent).toContain(
    "reviewed accuracy evaluation passes",
  );
  expect(api.queueSkillAnalysisBatch).not.toHaveBeenCalled();
});

test("a delayed poll cannot replace the next preview page", async () => {
  vi.useFakeTimers();
  try {
    api.getSkillOverviewBilling.mockResolvedValue({
      billing: null,
      updatedBy: null,
      updatedAt: null,
    });
    api.getSkillOverviewStatus.mockResolvedValue(status);
    const row = {
      skillId: "a",
      skillVersionId: "va",
      name: "Page A",
      categoriesSource: null,
      status: "running",
      categories: [],
      suggestedCategories: [],
      error: null,
      stale: true,
    };
    const pageA = {
      qualityApproved: false,
      items: [row],
      nextCursor: "page-b",
    };
    const pageB = {
      qualityApproved: false,
      items: [
        {
          ...row,
          skillId: "b",
          skillVersionId: "vb",
          name: "Page B",
          status: "missing",
        },
      ],
      nextCursor: null,
    };
    let resolvePoll!: (value: typeof pageA) => void;
    api.getSkillAnalysisPreview
      .mockResolvedValueOnce(pageA)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePoll = resolve;
          }),
      )
      .mockResolvedValueOnce(pageB);
    await render();
    await act(async () => button("Preview analysis batch").click());
    await act(async () => vi.advanceTimersByTime(3000));
    await act(async () => button("Next batch").click());
    expect(container.textContent).toContain("Page B");
    await act(async () => resolvePoll(pageA));
    expect(container.textContent).toContain("Page B");
    expect(container.textContent).not.toContain("Page A");
  } finally {
    vi.useRealTimers();
  }
});
