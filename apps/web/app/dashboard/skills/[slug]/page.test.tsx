// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import SkillDetailPage from "./page";
import {
  type Mounted,
  mountWithIntl,
  unmountAll,
  withIntl,
} from "@/test/react";

const api = vi.hoisted(() => ({
  getSkillCatalogDetailBySlug: vi.fn(),
  listSkillCatalogCategories: vi.fn(),
  enableWorkspaceSkill: vi.fn(),
  deleteWorkspaceSkill: vi.fn(),
}));
const navigation = vi.hoisted(() => ({
  search: "",
  replace: vi.fn(),
}));

vi.mock("../../../../lib/sdk", () => ({
  contentClient: api,
  workspaceClient: { getCurrentContext: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "deck-builder" }),
  usePathname: () => "/dashboard/skills/deck-builder",
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../../_components/dashboard-chat-state", () => ({
  useDashboardChatState: () => ({
    workspaceId: "ws-1",
    workspaceName: "Research",
  }),
}));
// Not under test, and each drags in its own network calls.
vi.mock("../_components/registry-versions", () => ({
  RegistryVersions: () => null,
}));
vi.mock("../_components/skill-market-admin-panel", () => ({
  SkillMarketAdminPanel: () => null,
}));
vi.mock("../_components/skill-claim-panel", () => ({
  SkillClaimPanel: () => null,
}));
vi.mock("../_components/skill-introduction", () => ({
  SkillIntroduction: () => null,
}));

let view: Mounted;
let container: HTMLDivElement;

function detail(extra: Record<string, unknown> = {}) {
  return {
    skill: {
      catalogId: "skill-1:v1",
      selectionId: null,
      sourceType: "workspace_custom",
      skillId: "skill-1",
      skillVersionId: "v1",
      slug: "deck-builder",
      name: "deck-builder",
      displayName: "Deck Builder",
      description: "Builds slide decks.",
      version: "1",
      visibility: "workspace",
      categories: [],
      enabled: false,
      enabledWorkspaceSkillId: null,
      installable: true,
      hasReadme: false,
      ...extra,
    },
    readmeContent: null,
    readmePath: null,
    skillContent: "# Instructions",
  };
}

async function renderPage() {
  view = await mountWithIntl(<SkillDetailPage />);
  ({ container } = view);
}
// What Next does after `router.replace`: the same page, without the param.
async function followReplace() {
  navigation.search = "";
  await view.render(withIntl(<SkillDetailPage />));
}
const prompt = () =>
  container.querySelector('[data-testid="skill-install-prompt"]');
const promptButton = (label: string) =>
  [...(prompt()?.querySelectorAll("button") ?? [])].find(
    (node) => node.textContent?.trim() === label,
  )!;

beforeEach(() => {
  navigation.search = "install=1";
  api.listSkillCatalogCategories.mockResolvedValue({ items: [] });
});
afterEach(async () => {
  await unmountAll();
  vi.resetAllMocks();
});

test("?install=1 asks first, leaves the URL at once, and installs only on yes", async () => {
  api.getSkillCatalogDetailBySlug.mockResolvedValue(detail());
  api.enableWorkspaceSkill.mockResolvedValue({
    workspaceSkill: { id: "ws-skill-1", enabled: true },
  });
  await renderPage();

  expect(prompt()?.textContent).toContain(
    "Install Deck Builder to this workspace?",
  );
  expect(api.enableWorkspaceSkill).not.toHaveBeenCalled();
  expect(navigation.replace).toHaveBeenCalledTimes(1);
  expect(navigation.replace).toHaveBeenCalledWith(
    "/dashboard/skills/deck-builder",
    { scroll: false },
  );

  // The question outlives the param, and is not asked a second time.
  await followReplace();
  expect(prompt()).not.toBeNull();
  expect(navigation.replace).toHaveBeenCalledTimes(1);

  await act(async () => promptButton("Install").click());
  expect(api.enableWorkspaceSkill).toHaveBeenCalledWith("ws-1", {
    skillId: "skill-1",
    skillVersionId: "v1",
  });
  expect(prompt()).toBeNull();
});

test("Cancel closes the question without installing", async () => {
  api.getSkillCatalogDetailBySlug.mockResolvedValue(detail());
  await renderPage();
  await act(async () => promptButton("Cancel").click());
  expect(prompt()).toBeNull();
  expect(api.enableWorkspaceSkill).not.toHaveBeenCalled();
});

test("an installed skill, or one that cannot be installed, only loses the param", async () => {
  api.getSkillCatalogDetailBySlug.mockResolvedValue(
    detail({ enabled: true, enabledWorkspaceSkillId: "ws-skill-1" }),
  );
  await renderPage();
  expect(prompt()).toBeNull();
  expect(navigation.replace).toHaveBeenCalledTimes(1);
  await unmountAll();
  navigation.replace.mockClear();

  api.getSkillCatalogDetailBySlug.mockResolvedValue(
    detail({ sourceType: "builtin", installable: false }),
  );
  await renderPage();
  expect(prompt()).toBeNull();
  expect(navigation.replace).toHaveBeenCalledTimes(1);
  expect(api.enableWorkspaceSkill).not.toHaveBeenCalled();
});

test("a skill that is not found behaves as without the param", async () => {
  const { HttpClientError } = await import("@sourceweft/sdk");
  api.getSkillCatalogDetailBySlug.mockRejectedValue(
    new HttpClientError({
      status: 404,
      statusText: "Not Found",
      code: "SKILL_NOT_FOUND",
      message: "Skill not found",
    }),
  );
  await renderPage();
  expect(container.textContent).toContain("Skill was not found.");
  expect(prompt()).toBeNull();
  expect(navigation.replace).not.toHaveBeenCalled();
});

test("without the param nothing is asked", async () => {
  navigation.search = "";
  api.getSkillCatalogDetailBySlug.mockResolvedValue(detail());
  await renderPage();
  expect(prompt()).toBeNull();
  expect(navigation.replace).not.toHaveBeenCalled();
});
