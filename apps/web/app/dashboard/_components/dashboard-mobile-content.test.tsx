// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard/chat" }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("./dashboard-mobile-me", () => ({ DashboardMobileMe: () => null }));
vi.mock("../../_components/route-loading-skeleton", () => ({
  ObservabilityRouteSkeleton: () => null,
}));
// The real page's root is a `flex-1` column that only fills a flex parent.
vi.mock("../observability/page", () => ({
  default: () => (
    <main
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="observability-page"
    />
  ),
}));

import { DashboardMobileContent } from "./dashboard-mobile-content";
import {
  DashboardMobileNavProvider,
  useDashboardMobileNav,
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
  return null;
}

async function eventually(check: () => boolean) {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

test("the phone's Observe view gives the page a flex column to fill, so its list scrolls", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <DashboardMobileNavProvider>
        <Probe />
        <DashboardMobileContent>
          <div />
        </DashboardMobileContent>
      </DashboardMobileNavProvider>,
    ),
  );

  await act(async () => nav?.openObservability());
  await eventually(
    () => document.querySelector('[data-testid="observability-page"]') !== null,
  );

  const page = document.querySelector('[data-testid="observability-page"]');
  const body = document.querySelector(
    '[data-testid="mobile-observability-body"]',
  );
  expect(page?.parentElement).toBe(body);
  expect(body?.classList).toContain("flex");
  expect(body?.classList).toContain("flex-col");
  expect(body?.classList).toContain("min-h-0");
});
