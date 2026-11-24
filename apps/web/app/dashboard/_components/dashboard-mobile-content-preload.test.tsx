// @vitest-environment jsdom
// Its own file, so the Observe page module starts unloaded.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard/chat" }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("./dashboard-mobile-me", () => ({ DashboardMobileMe: () => null }));
vi.mock("../../_components/route-loading-skeleton", () => ({
  ObservabilityRouteSkeleton: () => null,
}));
const observePage = vi.hoisted(() => ({ loaded: false }));
vi.mock("../observability/page", () => {
  observePage.loaded = true;
  return {
    default: () => <main data-testid="observability-page" />,
  };
});

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

test("Me fetches the Observe page's code before Observe is opened", async () => {
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
  expect(observePage.loaded).toBe(false);

  await act(async () => nav?.openMe());
  await eventually(() => observePage.loaded);

  expect(observePage.loaded).toBe(true);
  expect(
    document.querySelector('[data-testid="observability-page"]'),
  ).toBeNull();
});
