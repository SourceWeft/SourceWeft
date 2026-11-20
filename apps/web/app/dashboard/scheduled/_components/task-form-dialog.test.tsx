// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  agentTasksClient: { previewSchedule: vi.fn() },
  contentClient: {
    listWorkspaceMcpInstalls: vi.fn(),
    listSourceMentions: vi.fn(),
    getSource: vi.fn(),
    listWorkspaceSkills: vi.fn(),
    listSkillsCatalog: vi.fn(),
  },
}));
const mutations = vi.hoisted(() => ({
  create: { mutateAsync: vi.fn() },
  update: { mutateAsync: vi.fn() },
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("../../../../lib/sdk", () => sdk);
vi.mock("../../../../lib/scheduled-tasks", () => ({
  agentTaskErrorCode: (error: { code?: string }) => error?.code ?? null,
  useAgentTaskMutations: () => mutations,
}));

import { TaskFormDialog } from "./task-form-dialog";
import { button, mountWithIntl, typeInto, unmountAll } from "@/test/react";

function renderForm(props: Partial<Parameters<typeof TaskFormDialog>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return mountWithIntl(
    <QueryClientProvider client={client}>
      <TaskFormDialog
        open
        onOpenChange={vi.fn()}
        workspaceId="ws_1"
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  sdk.agentTasksClient.previewSchedule.mockResolvedValue({
    fireTimes: ["2026-11-20T08:00:00.000Z"],
    maxOffsetSeconds: 300,
  });
  sdk.contentClient.listWorkspaceMcpInstalls.mockResolvedValue({ items: [] });
  sdk.contentClient.listSourceMentions.mockResolvedValue({
    items: [
      { id: "s1", title: "Q3 report" },
      { id: "s2", title: "Roadmap" },
    ],
    nextCursor: null,
  });
  sdk.contentClient.getSource.mockResolvedValue({
    source: { title: "Old note" },
  });
  sdk.contentClient.listWorkspaceSkills.mockResolvedValue({
    items: [
      { selectionId: "w1", name: "brief", displayName: "Brief", enabled: true },
      { selectionId: "w2", name: "off", displayName: "Off", enabled: false },
    ],
  });
  sdk.contentClient.listSkillsCatalog.mockResolvedValue({ items: [] });
  mutations.create.mutateAsync.mockResolvedValue({ task: { id: "t1" } });
});
afterEach(async () => {
  await unmountAll();
  vi.clearAllMocks();
});

test("the create button stays off until there is a name and a prompt", async () => {
  await renderForm();
  expect(button("Create and enable").disabled).toBe(true);
  typeInto(document.querySelector<HTMLInputElement>("#task-name")!, "Digest");
  typeInto(
    document.querySelector<HTMLTextAreaElement>("#task-prompt")!,
    "Summarize the news",
  );
  expect(button("Create and enable").disabled).toBe(false);
});

test("creating sends the rule, the prompt and enables the task", async () => {
  const onSaved = vi.fn();
  await renderForm({ onSaved });
  typeInto(document.querySelector<HTMLInputElement>("#task-name")!, " Digest ");
  typeInto(
    document.querySelector<HTMLTextAreaElement>("#task-prompt")!,
    "Summarize the news",
  );
  button("Create and enable").click();
  await vi.waitFor(() =>
    expect(mutations.create.mutateAsync).toHaveBeenCalled(),
  );
  expect(mutations.create.mutateAsync.mock.calls[0]![0]).toMatchObject({
    name: "Digest",
    prompt: "Summarize the news",
    rule: { kind: "daily", time: "08:00" },
    activate: true,
    request: { webAccess: false, mcp: { installIds: [] } },
  });
  await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: "t1" }));
});

test("a refusal for the plan limit is told plainly and the form stays open", async () => {
  mutations.create.mutateAsync.mockRejectedValue({
    code: "AGENT_TASK_LIMIT_REACHED",
  });
  const onOpenChange = vi.fn();
  await renderForm({ onOpenChange, seedPrompt: "Check prices" });
  typeInto(document.querySelector<HTMLInputElement>("#task-name")!, "Prices");
  button("Create and enable").click();
  await vi.waitFor(() => expect(toasts.error).toHaveBeenCalled());
  expect(toasts.error.mock.calls[0]![0]).toContain("limit");
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
});

test("a prompt from the chat fills the new task", async () => {
  await renderForm({ seedPrompt: "Check prices" });
  expect(
    document.querySelector<HTMLTextAreaElement>("#task-prompt")!.value,
  ).toBe("Check prices");
});

test("picked sources and skills are saved with the task", async () => {
  await renderForm();
  typeInto(document.querySelector<HTMLInputElement>("#task-name")!, "Digest");
  typeInto(
    document.querySelector<HTMLTextAreaElement>("#task-prompt")!,
    "Summarize",
  );
  button("Add source").click();
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Roadmap"),
  );
  const roadmap = [
    ...document.querySelectorAll<HTMLElement>("[role=checkbox]"),
  ].find((el) => el.textContent?.includes("Roadmap"))!;
  roadmap.click();
  button("Add skill").click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("Brief"));
  // A disabled workspace skill is not offered.
  expect(document.body.textContent).not.toContain("Off");
  [...document.querySelectorAll<HTMLElement>("[role=checkbox]")]
    .find((el) => el.textContent?.includes("Brief"))!
    .click();
  // The chip appears once the choice reached the form state.
  await vi.waitFor(() =>
    expect(
      document.querySelector('[aria-label="Skills: Brief ×"]'),
    ).not.toBeNull(),
  );
  button("Create and enable").click();
  await vi.waitFor(() =>
    expect(mutations.create.mutateAsync).toHaveBeenCalled(),
  );
  expect(mutations.create.mutateAsync.mock.calls[0]![0].request).toMatchObject({
    sourceIds: ["s2"],
    skillIds: ["w1"],
  });
});

test("an edited task shows its saved source by name and a gone skill as unavailable", async () => {
  await renderForm({
    task: {
      id: "t1",
      version: 1,
      name: "Digest",
      prompt: "Summarize",
      schedule: {
        rule: { kind: "manual" },
        timezone: "UTC",
        enabled: false,
        nextDueAt: null,
      },
      request: {
        sourceIds: ["old"],
        skillIds: ["gone"],
        mcp: { installIds: [] },
        webAccess: false,
      },
      notifyOnSuccess: true,
      notifyEmail: true,
    } as never,
  });
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Old note"),
  );
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Skill no longer available"),
  );
});
