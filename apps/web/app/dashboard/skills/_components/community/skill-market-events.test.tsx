// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

const audit = vi.hoisted(() => ({
  listSkillEvents: vi.fn(),
  reinferSkillCategories: vi.fn(),
}));
vi.mock("../../../../../lib/skill-market-audit", async (original) => ({
  ...(await original<typeof import("../../../../../lib/skill-market-audit")>()),
  ...audit,
}));

import { SkillMarketEvents } from "./skill-market-events";
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
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

async function render(onChanged?: () => void) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      withIntl(<SkillMarketEvents onChanged={onChanged} skillId="skill_1" />),
    ),
  );
}

const cleared = {
  id: "e1",
  skillId: "skill_1",
  skillSlug: "pdf",
  skillDisplayName: "PDF",
  repo: null,
  actorKind: "system" as const,
  actorUserId: null,
  actorName: null,
  action: "verified.cleared",
  detail: { fromVersionId: "aaaaaaaa1111", toVersionId: "bbbbbbbb2222" },
  createdAt: "2026-09-22T00:00:00.000Z",
};

test("nothing at all for someone who is not a market admin", async () => {
  audit.listSkillEvents.mockRejectedValue(
    Object.assign(new Error("Forbidden"), { status: 403 }),
  );
  await render();
  expect(audit.listSkillEvents).toHaveBeenCalledWith("skill_1", 50);
  expect(container.innerHTML).toBe("");
});

test("the history says which version cleared the verified badge, and who acted", async () => {
  audit.listSkillEvents.mockResolvedValue({
    items: [
      cleared,
      {
        ...cleared,
        id: "e2",
        action: "claim.granted",
        repo: "acme/skills",
        actorKind: "owner",
        actorUserId: "user_1",
        actorName: "Ada",
        detail: { claimId: "c1", skillCount: 3 },
      },
    ],
    nextCursor: null,
  });
  await render();
  const text = container.textContent ?? "";
  expect(text).toContain("Verified badge cleared by a new version");
  expect(text).toContain("Version aaaaaaaa → bbbbbbbb");
  expect(text).toContain("Repository claimed");
  expect(text).toContain("acme/skills");
  expect(text).toContain("Ada (author)");
  expect(text).toContain("3 skills");
});

test("re-inferring categories reports them and reloads the history", async () => {
  const onChanged = vi.fn();
  audit.listSkillEvents.mockResolvedValue({ items: [], nextCursor: null });
  audit.reinferSkillCategories.mockResolvedValue({
    categorySlugs: ["documents-office"],
  });
  await render(onChanged);
  expect(container.textContent).toContain("Nothing recorded yet.");
  const reinfer = [...container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes("Re-infer categories"),
  )!;
  await act(async () => reinfer.click());
  expect(audit.reinferSkillCategories).toHaveBeenCalledWith("skill_1");
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(audit.listSkillEvents).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Categories now: documents-office.");
});
