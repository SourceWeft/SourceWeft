// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { SkillReadmeDialog } from "./readme-dialog";
import { mountWithIntl, unmountAll } from "@/test/react";

const api = vi.hoisted(() => ({ getSkillCatalogDetail: vi.fn() }));
vi.mock("../../../../../../lib/sdk", () => ({ contentClient: api }));
vi.mock("@sourceweft/ui-web/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
afterEach(async () => {
  await unmountAll();
  vi.resetAllMocks();
});
test("failed requests show retry; a successful retry displays SKILL.md without its metadata", async () => {
  api.getSkillCatalogDetail
    .mockRejectedValueOnce(new Error("Connection unavailable"))
    .mockResolvedValueOnce({
      skill: { displayName: "Writer", description: "Writes reports" },
      readmeContent: null,
      readmePath: null,
      skillContent:
        "---\nname: writer\ndescription: metadata-only\n---\n# Actual instructions",
    });
  await mountWithIntl(
    createElement(SkillReadmeDialog, {
      open: true,
      catalogId: "skill:version",
      workspaceId: "workspace",
      onOpenChange: () => {},
    }),
  );
  expect(document.body.textContent).toContain("Connection unavailable");
  expect(document.body.textContent).not.toContain("No detailed description");
  const retry = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  )!;
  await act(async () => retry.click());
  expect(document.body.textContent).toContain("From SKILL.md");
  expect(document.body.textContent).toContain("Actual instructions");
  expect(document.body.textContent).not.toContain("metadata-only");
  expect(document.body.textContent).not.toContain("Connection unavailable");
});
