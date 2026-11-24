// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/dashboard/mcp" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));

import {
  DashboardMobileNavProvider,
  useDashboardMobileNav,
  useDashboardMobileView,
} from "./dashboard-mobile-nav-state";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let nav: ReturnType<typeof useDashboardMobileNav> | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = "";
});

function Probe() {
  nav = useDashboardMobileNav();
  return <span data-view={nav.view} />;
}

function ViewOnly() {
  return <span data-view={useDashboardMobileView()} />;
}

const shownView = () =>
  document.querySelector("[data-view]")?.getAttribute("data-view");

test("opening another page leaves the Me page", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = () =>
    root?.render(
      <DashboardMobileNavProvider>
        <Probe />
      </DashboardMobileNavProvider>,
    );
  await act(async () => render());

  await act(async () => nav?.openMe());
  expect(shownView()).toBe("me");

  navigation.pathname = "/dashboard/skills";
  await act(async () => render());
  expect(shownView()).toBe("main");
});

test("the loading shell reads the main view without a provider", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<ViewOnly />));
  expect(shownView()).toBe("main");
});
