// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import { SkillsGallery } from "./skills-gallery";
import { SKILLS_PAGE_SIZE } from "./skills-market-browse";
import messages from "../../../../messages/en.json";

const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];
const withIntl = (node: ReactNode) => (
  <NextIntlClientProvider locale="en" messages={intlMessages}>
    {node}
  </NextIntlClientProvider>
);

const api = vi.hoisted(() => ({
  listSkillsCatalog: vi.fn(),
  listSkillCatalogCategories: vi.fn(),
  enableWorkspaceSkill: vi.fn(),
  deleteWorkspaceSkill: vi.fn(),
}));
const navigation = vi.hoisted(() => ({ search: "" }));

vi.mock("../../../../lib/sdk", () => ({
  contentClient: api,
  workspaceClient: { getCurrentContext: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/skills",
  useSearchParams: () => new URLSearchParams(navigation.search),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../../_components/dashboard-chat-state", () => ({
  useDashboardChatState: () => ({
    workspaceId: "ws-1",
    workspaceName: "Research",
    hasWorkspaceHydrated: true,
    workspaces: [{ id: "ws-1", name: "Research" }],
    switchWorkspace: vi.fn(),
  }),
}));
// Not under test, and each drags in its own network calls.
vi.mock("./skill-submissions", () => ({
  MySubmissions: () => null,
  useSkillSubmissions: () => ({}),
}));
vi.mock("./submit-skill-dialog", () => ({ SubmitSkillDialog: () => null }));
vi.mock("./skill-detail-dialog", () => ({ SkillDetailDialog: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  navigation.search = "";
  api.listSkillCatalogCategories.mockResolvedValue({
    items: [
      { slug: "writing", name: "Writing", description: null, count: 2 },
      { slug: "finance", name: "Finance", description: null, count: 0 },
    ],
  });
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.resetAllMocks();
});

function skill(id: string, extra: Record<string, unknown> = {}) {
  return {
    catalogId: `${id}:v1`,
    selectionId: null,
    sourceType: "registry_github",
    skillId: id,
    skillVersionId: "v1",
    slug: id,
    name: id,
    displayName: `Skill ${id}`,
    description: `About ${id}`,
    version: "1",
    visibility: "public",
    categories: [],
    tools: [],
    enabled: false,
    enabledWorkspaceSkillId: null,
    installable: true,
    verified: false,
    hasReadme: false,
    ...extra,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(variant: "page" | "modal" = "page") {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(withIntl(<SkillsGallery variant={variant} />));
  });
  await flush();
}

function titles() {
  return [...container.querySelectorAll("article h3")].map(
    (node) => node.textContent,
  );
}

function button(name: string) {
  const match = [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === name,
  );
  if (!match) throw new Error(`No button named ${name}`);
  return match;
}

test("asks the server for one page and sections built-ins, own and community skills", async () => {
  api.listSkillsCatalog.mockResolvedValue({
    items: [
      skill("feynman", { sourceType: "builtin" }),
      skill("house-style", { sourceType: "workspace_custom" }),
      skill("pdf", { installCount: 1250, verified: true, categories: ["writing"] }),
    ],
    nextCursor: null,
  });
  await render();

  expect(api.listSkillsCatalog).toHaveBeenCalledTimes(1);
  expect(api.listSkillsCatalog).toHaveBeenCalledWith("ws-1", {
    limit: SKILLS_PAGE_SIZE,
  });
  expect(
    [...container.querySelectorAll("section[aria-label]")].map((node) =>
      node.getAttribute("aria-label"),
    ),
  ).toEqual(["Built-in", "Your skills", "Community"]);

  const card = [...container.querySelectorAll("article")].find((node) =>
    node.textContent?.includes("Skill pdf"),
  )!;
  expect(card.textContent).toContain("Verified");
  expect(card.textContent).toContain("Writing");
  expect(card.textContent).toContain("1.2k");
  expect(card.textContent).not.toContain("Unverified");
  // No "Load more" without a cursor.
  expect(container.textContent).not.toContain("Load more");
});

test("a featured skill carries its own mark, and no unverified caution", async () => {
  api.listSkillsCatalog.mockResolvedValue({
    items: [
      skill("docx", { featured: true }),
      skill("plain", {}),
    ],
    nextCursor: null,
  });
  await render();

  const cardOf = (name: string) =>
    [...container.querySelectorAll("article")].find((node) =>
      node.textContent?.includes(`Skill ${name}`),
    )!;
  expect(cardOf("docx").textContent).toContain("Featured");
  expect(cardOf("docx").textContent).not.toContain("Verified");
  expect(cardOf("docx").textContent).not.toContain("Unverified");
  expect(cardOf("plain").textContent).not.toContain("Featured");
  expect(cardOf("plain").textContent).toContain("Unverified");
});

test("sends the URL's filters, sort and query to the server", async () => {
  navigation.search =
    "category=writing&trust=community&capability=executable&installed=installed&sort=new&q=pdf";
  api.listSkillsCatalog.mockResolvedValue({ items: [], nextCursor: null });
  await render();

  expect(api.listSkillsCatalog).toHaveBeenCalledWith("ws-1", {
    limit: SKILLS_PAGE_SIZE,
    q: "pdf",
    category: "writing",
    trust: "community",
    capability: "executable",
    installed: "installed",
    sort: "new",
  });
  expect(container.textContent).toContain(
    "No skills match the current filters.",
  );
  expect(
    (container.querySelector("input") as HTMLInputElement | null)?.value,
  ).toBe("pdf");
});

test("offers non-empty categories with counts, hiding empty ones", async () => {
  api.listSkillsCatalog.mockResolvedValue({ items: [], nextCursor: null });
  await render();
  const aside = container.querySelector("aside")!;
  expect(aside.textContent).toContain("Writing");
  expect(aside.textContent).not.toContain("Finance");
});

test("loads the next page with the cursor and drops repeats", async () => {
  api.listSkillsCatalog
    .mockResolvedValueOnce({ items: [skill("a"), skill("b")], nextCursor: "c1" })
    .mockResolvedValueOnce({ items: [skill("b"), skill("c")], nextCursor: null });
  await render();
  expect(titles()).toEqual(["Skill a", "Skill b"]);

  await act(async () => button("Load more").click());
  await flush();

  expect(api.listSkillsCatalog).toHaveBeenLastCalledWith("ws-1", {
    limit: SKILLS_PAGE_SIZE,
    cursor: "c1",
  });
  expect(titles()).toEqual(["Skill a", "Skill b", "Skill c"]);
  expect(container.textContent).not.toContain("Load more");
});

test("a filter change restarts from page one and drops the old cursor", async () => {
  api.listSkillsCatalog
    .mockResolvedValueOnce({ items: [skill("a")], nextCursor: "c1" })
    .mockResolvedValueOnce({ items: [skill("z")], nextCursor: null });
  await render("modal");

  await act(async () => button("Not installed").click());
  await flush();

  expect(api.listSkillsCatalog).toHaveBeenLastCalledWith("ws-1", {
    limit: SKILLS_PAGE_SIZE,
    installed: "not_installed",
  });
  expect(titles()).toEqual(["Skill z"]);
});

test("ignores a slow answer to a question that is no longer being asked", async () => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  api.listSkillsCatalog
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  await render("modal");

  await act(async () => button("Not installed").click());
  await flush();
  expect(api.listSkillsCatalog).toHaveBeenCalledTimes(2);

  await act(async () => {
    second.resolve({ items: [skill("fresh")], nextCursor: null });
  });
  await flush();
  await act(async () => {
    first.resolve({ items: [skill("stale")], nextCursor: "stale-cursor" });
  });
  await flush();

  expect(titles()).toEqual(["Skill fresh"]);
  expect(container.textContent).not.toContain("Load more");
});

test("a late next page cannot leak into a newer result set", async () => {
  const more = deferred<unknown>();
  api.listSkillsCatalog
    .mockResolvedValueOnce({ items: [skill("a")], nextCursor: "c1" })
    .mockReturnValueOnce(more.promise)
    .mockResolvedValueOnce({ items: [skill("z")], nextCursor: null });
  await render("modal");

  await act(async () => button("Load more").click());
  await act(async () => button("Not installed").click());
  await flush();
  await act(async () => {
    more.resolve({ items: [skill("b")], nextCursor: "c2" });
  });
  await flush();

  expect(titles()).toEqual(["Skill z"]);
});

test("an INVALID_CURSOR answer starts the view over instead of failing", async () => {
  api.listSkillsCatalog
    .mockResolvedValueOnce({ items: [skill("a")], nextCursor: "c1" })
    .mockRejectedValueOnce(
      Object.assign(new Error("bad cursor"), {
        code: "INVALID_CURSOR",
        status: 400,
      }),
    )
    .mockResolvedValueOnce({ items: [skill("a2")], nextCursor: null });
  await render();

  await act(async () => button("Load more").click());
  await flush();

  expect(api.listSkillsCatalog).toHaveBeenCalledTimes(3);
  expect(api.listSkillsCatalog).toHaveBeenLastCalledWith("ws-1", {
    limit: SKILLS_PAGE_SIZE,
  });
  expect(titles()).toEqual(["Skill a2"]);
});

test("the modal gallery keeps its filters out of the URL", async () => {
  const replaceState = vi.spyOn(window.history, "replaceState");
  api.listSkillsCatalog.mockResolvedValue({ items: [], nextCursor: null });
  await render("modal");
  await act(async () => button("Installed").click());
  await flush();
  expect(replaceState).not.toHaveBeenCalled();
  replaceState.mockRestore();
});

test("the page gallery writes its filters to the URL", async () => {
  const replaceState = vi.spyOn(window.history, "replaceState");
  api.listSkillsCatalog.mockResolvedValue({ items: [], nextCursor: null });
  await render("page");
  await act(async () => button("Installed").click());
  expect(replaceState).toHaveBeenLastCalledWith(
    null,
    "",
    "/dashboard/skills?installed=installed",
  );
  replaceState.mockRestore();
});
