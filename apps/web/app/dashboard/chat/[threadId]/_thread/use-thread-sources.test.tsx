// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hubSkillMemory } from "../../../../../lib/hub-skill-memory";

vi.mock("../../../../../lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "user" } } }) },
}));
vi.mock("../../../../../lib/sdk", () => ({
  contentClient: {
    listWorkspaceSkills: async () => ({ items: [] }),
    listSkillsCatalog: async () => ({
      items: [
        {
          selectionId: "builtin:html",
          catalogId: "html",
          name: "HTML",
          sourceType: "builtin",
          installable: false,
          defaultEnabled: true,
        },
        {
          selectionId: "builtin:ppt-deck",
          catalogId: "ppt",
          name: "PPT",
          sourceType: "builtin",
          installable: false,
          defaultEnabled: true,
        },
      ],
    }),
    listCapabilityCatalog: async () => ({ commands: [], tools: [] }),
  },
}));
import { useThreadSources } from "./use-thread-sources";

let root: Root;
let controller: ReturnType<typeof useThreadSources>;
function Harness({ threadId }: { threadId: string }) {
  controller = useThreadSources({ workspaceId: "workspace", threadId });
  return null;
}
async function render(threadId: string) {
  await act(async () => root.render(createElement(Harness, { threadId })));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  hubSkillMemory.clear();
  window.localStorage.clear();
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  hubSkillMemory.clear();
  vi.unstubAllGlobals();
});

it("keeps a deselected default skill deselected after A → B → A", async () => {
  await render("A");
  expect(controller.activeSkillIds).toEqual([
    "builtin:html",
    "builtin:ppt-deck",
  ]);
  await act(async () =>
    controller.handleSkillSelectionChange(["builtin:ppt-deck"]),
  );
  await render("B");
  expect(controller.activeSkillIds).toEqual([
    "builtin:html",
    "builtin:ppt-deck",
  ]);
  await render("A");
  expect(controller.activeSkillIds).toEqual(["builtin:ppt-deck"]);
});

it("distinguishes an explicitly empty selection from a new conversation's defaults", async () => {
  await render("A");
  await act(async () => controller.handleSkillSelectionChange([]));
  await act(async () => controller.loadAvailableSkills());
  expect(controller.activeSkillIds).toEqual([]);
  await render("B");
  expect(controller.activeSkillIds).toHaveLength(2);
  await render("A");
  expect(controller.activeSkillIds).toEqual([]);
});
