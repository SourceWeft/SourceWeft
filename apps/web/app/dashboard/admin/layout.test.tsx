// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const auth = vi.hoisted(() => ({ userId: "user-1" as string | undefined }));
const audit = vi.hoisted(() => ({ getSkillMarketAdminMe: vi.fn() }));
const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  pathname: "/dashboard/admin/market/skill-review",
}));

vi.mock("../../../lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: auth.userId ? { user: { id: auth.userId } } : null,
      isPending: false,
    }),
  },
}));
vi.mock("../../../lib/skill-market-audit", () => audit);
vi.mock("../../../lib/desktop-titlebar", () => ({
  useDesktopTitlebar: () => false,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams("page=2"),
  useRouter: () => navigation,
}));

import AdminLayout from "./layout";
import { mount, type Mounted, unmountAll, withIntl } from "@/test/react";

let view: Mounted | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  auth.userId = "user-1";
  navigation.pathname = "/dashboard/admin/market/skill-review";
});

afterEach(async () => {
  await unmountAll();
  view = undefined;
  vi.resetAllMocks();
});

const layout = () =>
  withIntl(
    <AdminLayout>
      <div>Private admin content</div>
    </AdminLayout>,
  );

// A second render within one test updates the same root.
async function render() {
  if (view) return view.render(layout());
  view = await mount(layout());
  container = view.container;
}

test("renders admin content only after the current user is approved", async () => {
  let resolve!: (value: { isMarketAdmin: boolean }) => void;
  audit.getSkillMarketAdminMe.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await render();
  expect(container.textContent).not.toContain("Private admin content");
  await act(async () => resolve({ isMarketAdmin: true }));
  expect(container.textContent).toContain("Private admin content");

  audit.getSkillMarketAdminMe.mockReturnValue(new Promise(() => {}));
  auth.userId = "user-2";
  await render();
  expect(container.textContent).not.toContain("Private admin content");
});

test("redirects a signed-in non-admin without rendering the page", async () => {
  audit.getSkillMarketAdminMe.mockResolvedValue({ isMarketAdmin: false });
  await render();
  expect(navigation.replace).toHaveBeenCalledWith("/dashboard");
  expect(container.textContent).not.toContain("Private admin content");
});

test("redirects an expired session to sign-in", async () => {
  audit.getSkillMarketAdminMe.mockRejectedValue({ status: 401 });
  await render();
  expect(navigation.replace).toHaveBeenCalledWith(
    "/auth/sign-in?redirectTo=%2Fdashboard%2Fadmin%2Fmarket%2Fskill-review%3Fpage%3D2",
  );
  expect(container.textContent).not.toContain("Private admin content");
});

test("redirects a forbidden session to the dashboard", async () => {
  audit.getSkillMarketAdminMe.mockRejectedValue({ status: 403 });
  await render();
  expect(navigation.replace).toHaveBeenCalledWith("/dashboard");
  expect(container.textContent).not.toContain("Private admin content");
});

test("keeps content hidden on a check failure and retries on request", async () => {
  audit.getSkillMarketAdminMe
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ isMarketAdmin: true });
  await render();
  expect(container.textContent).toContain("Could not check admin access");
  expect(container.textContent).not.toContain("Private admin content");

  await act(async () => {
    container.querySelector("button")?.click();
  });
  expect(audit.getSkillMarketAdminMe).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Private admin content");
});

test("an admin sees every section in the navigation, with the current one marked", async () => {
  audit.getSkillMarketAdminMe.mockResolvedValue({ isMarketAdmin: true });
  await render();
  const links = [...container.querySelectorAll("nav a")];
  expect(
    links.map((link) => [link.textContent, link.getAttribute("href")]),
  ).toEqual([
    ["MCP review", "/dashboard/admin/market/mcp-review"],
    ["Skill review", "/dashboard/admin/market/skill-review"],
    ["Reports", "/dashboard/admin/market/reports"],
    ["All skills", "/dashboard/admin/market/skills"],
    ["Collections", "/dashboard/admin/market/collections"],
    ["Blog", "/dashboard/admin/blog"],
    ["Market settings", "/dashboard/admin/market/settings"],
    ["Back to app", "/dashboard"],
  ]);
  expect(
    links
      .filter((link) => link.getAttribute("aria-current") === "page")
      .map((link) => link.textContent),
  ).toEqual(["Skill review"]);
});

test("moving to another section keeps the page up while access is checked again", async () => {
  audit.getSkillMarketAdminMe.mockResolvedValueOnce({ isMarketAdmin: true });
  await render();
  expect(container.textContent).toContain("Private admin content");

  audit.getSkillMarketAdminMe.mockReturnValue(new Promise(() => {}));
  navigation.pathname = "/dashboard/admin/blog";
  await render();
  expect(audit.getSkillMarketAdminMe).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Private admin content");
});

test("an admin who loses access is sent away on the next section", async () => {
  audit.getSkillMarketAdminMe.mockResolvedValueOnce({ isMarketAdmin: true });
  await render();
  audit.getSkillMarketAdminMe.mockResolvedValueOnce({ isMarketAdmin: false });
  navigation.pathname = "/dashboard/admin/blog";
  await render();
  expect(navigation.replace).toHaveBeenCalledWith("/dashboard");
});
