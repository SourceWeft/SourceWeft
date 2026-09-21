// @vitest-environment jsdom
import {
  act,
  createElement,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../../../messages/en.json";
import { hubSkillMemory } from "../../../../../lib/hub-skill-memory";

const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];
const withIntl = (node: ReactNode) => (
  <NextIntlClientProvider locale="en" messages={intlMessages}>
    {node}
  </NextIntlClientProvider>
);

vi.mock("../../../../../lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "user" } } }) },
}));
// Stands in for the server's per-thread chat preferences.
const savedSkillIds = vi.hoisted(() => new Map<string, string[]>());
vi.mock("../../../../../lib/sdk", () => ({
  contentClient: {
    getThread: async (_workspaceId: string, threadId: string) => ({
      thread: {
        chatPreferences: { skillIds: savedSkillIds.get(threadId) },
      },
    }),
    updateThreadChatPreferences: async (
      _workspaceId: string,
      threadId: string,
      input: { skillIds?: string[] },
    ) => {
      if (input.skillIds) savedSkillIds.set(threadId, input.skillIds);
      return { thread: { chatPreferences: { skillIds: input.skillIds } } };
    },
    getThreadSourceSelection: async () => ({
      selection: { selectedSourceIds: [], revision: 0 },
    }),
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
        {
          selectionId: "builtin:video-presentation",
          catalogId: "video",
          name: "Video",
          sourceType: "builtin",
          installable: false,
          defaultEnabled: false,
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
  await act(async () =>
    root.render(withIntl(createElement(Harness, { threadId }))),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  hubSkillMemory.clear();
  savedSkillIds.clear();
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

it("restores a thread's checked skills after a reload", async () => {
  await render("A");
  await act(async () =>
    controller.handleSkillSelectionChange([
      "builtin:html",
      "builtin:ppt-deck",
      "builtin:video-presentation",
    ]),
  );
  // A reload drops the in-page memory; only the saved choice remains.
  await act(async () => root.unmount());
  hubSkillMemory.clear();
  root = createRoot(document.createElement("div"));
  await render("A");
  expect(controller.activeSkillIds).toEqual([
    "builtin:html",
    "builtin:ppt-deck",
    "builtin:video-presentation",
  ]);
});

it("a thread with no saved choice follows the defaults", async () => {
  await render("fresh");
  expect(controller.activeSkillIds).toEqual([
    "builtin:html",
    "builtin:ppt-deck",
  ]);
  expect(savedSkillIds.has("fresh")).toBe(false);
});

it("the new-chat draft never reads or saves a thread's skills", async () => {
  await render("current");
  await act(async () =>
    controller.handleSkillSelectionChange(["builtin:video-presentation"]),
  );
  expect(controller.activeSkillIds).toEqual(["builtin:video-presentation"]);
  expect(savedSkillIds.has("current")).toBe(false);
});
