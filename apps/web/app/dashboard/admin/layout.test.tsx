// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import messages from "../../../messages/en.json";

const auth = vi.hoisted(() => ({ userId: "user-1" as string | undefined }));
const audit = vi.hoisted(() => ({ getSkillMarketAdminMe: vi.fn() }));
const navigation = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("../../../lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: auth.userId ? { user: { id: auth.userId } } : null,
      isPending: false,
    }),
  },
}));
vi.mock("../../../lib/skill-market-audit", () => audit);
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/admin/market",
  useSearchParams: () => new URLSearchParams("tab=skills"),
  useRouter: () => navigation,
}));

import AdminLayout from "./layout";

const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  auth.userId = "user-1";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

async function render() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={intlMessages}>
        <AdminLayout>
          <div>Private admin content</div>
        </AdminLayout>
      </NextIntlClientProvider>,
    );
  });
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
    "/auth/sign-in?redirectTo=%2Fdashboard%2Fadmin%2Fmarket%3Ftab%3Dskills",
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
