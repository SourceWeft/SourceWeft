// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ArtifactPreviewPanelSkeleton,
  DashboardSkeletonContentForPath,
  SettingsStandaloneRouteSkeleton,
} from "./route-loading-skeleton";
import { DashboardLoadingSkeleton } from "./dashboard-loading-skeleton";
import {
  CatalogRouteSkeleton,
  McpSkeletonGrid,
  SkillsCatalogSkeletonGrid,
} from "./catalog-loading-skeleton";
import { SettingsCenterPanelSkeleton } from "../dashboard/_components/dashboard-settings-center-modal-skeleton";

import { AuthLoadingCard } from "./auth-loading-skeleton";
import { OrganizationInvitationRowSkeleton } from "./auth/organization/organization-invitation-row-skeleton";
import { OrganizationMemberRowSkeleton } from "./auth/organization/organization-member-row-skeleton";
vi.mock("./auth/user/user-view", () => ({ UserView: () => <div /> }));

const route = vi.hoisted(() => ({ pathname: "/dashboard" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("../../lib/billing-edition/capabilities", () => ({
  useBillingAvailable: () => true,
}));

function parse(element: React.ReactNode) {
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(element);
  return root;
}

describe("dashboard loading boundaries", () => {
  it("keeps the route fallback inside the existing shell", () => {
    route.pathname = "/dashboard";
    const root = parse(<DashboardLoadingSkeleton />);
    expect(root.querySelector("header")).not.toBeNull();
    expect(
      root.querySelector("aside, nav, [data-workspace-layout]"),
    ).toBeNull();
  });

  it.each(["skills", "mcp"] as const)(
    "uses the same %s catalog for session and route loading",
    (kind) => {
      expect(
        renderToStaticMarkup(
          <DashboardSkeletonContentForPath pathname={`/dashboard/${kind}`} />,
        ),
      ).toBe(renderToStaticMarkup(<CatalogRouteSkeleton kind={kind} />));
      const grid = renderToStaticMarkup(
        kind === "skills" ? <SkillsCatalogSkeletonGrid /> : <McpSkeletonGrid />,
      );
      expect(
        renderToStaticMarkup(<CatalogRouteSkeleton kind={kind} />),
      ).toContain(grid);
    },
  );

  it.each([
    null,
    "/dashboard/admin/market",
    "/dashboard/skills/claim",
    "/dashboard/connectors/oauth/complete",
  ])("does not fabricate a homepage for %s", (pathname) => {
    const root = parse(<DashboardSkeletonContentForPath pathname={pathname} />);
    expect(root.querySelector("header, article, aside")).toBeNull();
  });

  it("keeps resource and preview windows independent of the homepage", () => {
    const hub = parse(
      <DashboardSkeletonContentForPath pathname="/dashboard/hub-window" />,
    );
    expect(hub.querySelector("aside")).not.toBeNull();
    const preview = renderToStaticMarkup(
      <DashboardSkeletonContentForPath pathname="/dashboard/preview-window" />,
    );
    expect(preview).toBe(
      renderToStaticMarkup(<ArtifactPreviewPanelSkeleton />),
    );
    expect(
      parse(<ArtifactPreviewPanelSkeleton />).querySelector("aside"),
    ).toBeNull();
  });

  it("distinguishes checkout from payment confirmation", () => {
    const success = renderToStaticMarkup(
      <DashboardSkeletonContentForPath pathname="/dashboard/billing" />,
    );
    const checkout = renderToStaticMarkup(
      <DashboardSkeletonContentForPath pathname="/dashboard/billing/checkout" />,
    );
    expect(success).not.toBe(checkout);
    expect(
      parse(
        <DashboardSkeletonContentForPath pathname="/dashboard/billing" />,
      ).querySelector("section")?.className,
    ).not.toContain("border");
  });

  it("uses the current eleven-column trace table", () => {
    const root = parse(
      <DashboardSkeletonContentForPath pathname="/dashboard/observability" />,
    );
    expect(root.querySelectorAll("thead th")).toHaveLength(11);
    expect(root.textContent).toContain("table.columns.traceId");
    expect(root.textContent).toContain("table.columns.obs");
  });
});

describe("settings loading", () => {
  it("uses tabs instead of the removed standalone navigation sidebar", () => {
    const root = parse(<SettingsStandaloneRouteSkeleton />);
    expect(root.querySelector("nav, aside")).toBeNull();
    expect(root.querySelectorAll('[data-slot="card"]')).toHaveLength(3);
  });

  it.each(["approvals", "about", "local"] as const)(
    "does not show the account panel while %s loads",
    (activeTab) => {
      const account = renderToStaticMarkup(
        <SettingsCenterPanelSkeleton activeTab="account" />,
      );
      expect(
        renderToStaticMarkup(
          <SettingsCenterPanelSkeleton activeTab={activeTab} />,
        ),
      ).not.toBe(account);
    },
  );
});

describe("native auth and configurable organization tables", () => {
  it("keeps browser, desktop and mobile auth layouts distinct", () => {
    const layouts = [null, "desktop", "mobile"].map((kind) =>
      renderToStaticMarkup(
        <AuthLoadingCard kind={kind as "desktop" | "mobile" | null} />,
      ),
    );
    expect(new Set(layouts).size).toBe(3);
    expect(
      parse(<AuthLoadingCard kind="mobile" />).querySelector(
        '[data-slot="card"]',
      ),
    ).toBeNull();
  });
  it.each([false, true])(
    "preserves invitation column visibility with selection=%s",
    (showSelection) => {
      const root = parse(
        <table>
          <tbody>
            <OrganizationInvitationRowSkeleton
              showSelection={showSelection}
              showCreatedAt={false}
              showRole={false}
            />
          </tbody>
        </table>,
      );
      expect(root.querySelectorAll("td")).toHaveLength(
        3 + Number(showSelection),
      );
    },
  );
  it.each([false, true])(
    "preserves member column visibility with teams=%s",
    (showTeams) => {
      const root = parse(
        <table>
          <tbody>
            <OrganizationMemberRowSkeleton
              showSelection
              showRole={false}
              showTeams={showTeams}
            />
          </tbody>
        </table>,
      );
      expect(root.querySelectorAll("td")).toHaveLength(3 + Number(showTeams));
    },
  );
});
