// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  getSkillMarketAdminMe: vi.fn(),
  getSkillOverviewAdmin: vi.fn(),
  regenerateSkillOverview: vi.fn(),
  setSkillOverviewHidden: vi.fn(),
}));
vi.mock("../../../../../lib/skill-overviews", () => api);

import { SkillOverviewAdmin } from "./skill-overview-admin";
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

const slot = {
  skillId: "skill_1",
  catalogId: "cat_1",
  slug: "gh-acme-skills-pdf",
  workspaceId: "ws_1",
};
const content = {
  summary: "s",
  whatItDoes: "w",
  whenToUse: "u",
  requirements: "",
  suggestedCategories: [],
};
function state(hidden: boolean, locales = ["en", "zh-CN", "zh-TW"]) {
  return {
    skillId: "skill_1",
    skillVersionId: "ver_1",
    bundleSha256: "sha",
    eligible: true,
    overviews: locales.map((locale) => ({
      locale,
      overview: content,
      model: "deepseek-v4",
      hidden,
      generatedAt: "2026-09-22T00:00:00.000Z",
    })),
  };
}

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(withIntl(<SkillOverviewAdmin {...slot} />)));
}
const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );

test("renders nothing for someone who is not a market admin", async () => {
  api.getSkillMarketAdminMe.mockResolvedValue(false);
  await render();
  expect(container.innerHTML).toBe("");
  expect(api.getSkillOverviewAdmin).not.toHaveBeenCalled();
});

test("shows each locale's state, the model and the generation time", async () => {
  api.getSkillMarketAdminMe.mockResolvedValue(true);
  api.getSkillOverviewAdmin.mockResolvedValue(state(false, ["en", "zh-CN"]));
  await render();
  const items = [...container.querySelectorAll("li")].map(
    (li) => li.textContent,
  );
  expect(items).toEqual(["enShown", "zh-CNShown", "zh-TWMissing"]);
  expect(container.textContent).toContain("deepseek-v4");
  expect(container.textContent).toContain("Generated");
  expect(button("Hide")).toBeDefined();
});

test("regenerate queues and reloads; hide and show flip the flag", async () => {
  api.getSkillMarketAdminMe.mockResolvedValue(true);
  api.getSkillOverviewAdmin.mockResolvedValue(state(false));
  api.regenerateSkillOverview.mockResolvedValue({ queued: true });
  api.setSkillOverviewHidden.mockResolvedValue({});
  await render();

  await act(async () => button("Regenerate")!.click());
  expect(api.regenerateSkillOverview).toHaveBeenCalledWith("skill_1");
  expect(container.textContent).toContain("Queued");
  expect(api.getSkillOverviewAdmin).toHaveBeenCalledTimes(2);

  api.getSkillOverviewAdmin.mockResolvedValue(state(true));
  await act(async () => button("Hide")!.click());
  expect(api.setSkillOverviewHidden).toHaveBeenCalledWith("skill_1", true);
  expect(container.textContent).toContain("Overview hidden.");

  await act(async () => button("Show")!.click());
  expect(api.setSkillOverviewHidden).toHaveBeenLastCalledWith("skill_1", false);
});

test("a skill that is not eligible says so, with no Hide button", async () => {
  api.getSkillMarketAdminMe.mockResolvedValue(true);
  api.getSkillOverviewAdmin.mockResolvedValue({
    ...state(false, []),
    eligible: false,
  });
  await render();
  expect(container.textContent).toContain("only public skills");
  expect(button("Hide")).toBeUndefined();
  expect(button("Regenerate")).toBeDefined();
});
