// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mountWithIntl, unmountAll, click, button, flush } from "@/test/react";

const host = vi.hoisted(() => ({
  available: false,
  platform: "macos",
  fail: false,
  billing: true,
}));
vi.mock("../../../lib/desktop-bridge", () => ({
  desktopBridge: {
    isAvailable: () => host.available,
    info: async () => {
      if (host.fail) throw new Error("IPC unavailable");
      return { isDesktop: true, platform: host.platform };
    },
  },
}));
vi.mock("../../../lib/billing-edition/capabilities", () => ({
  useBillingAvailable: () => host.billing,
}));
vi.mock("../../../lib/local-host-session", () => ({
  disconnectLocalHostSession: vi.fn(),
}));
vi.mock("../../../lib/auth-client", () => ({ authClient: {} }));
vi.mock("@better-auth-ui/react", () => ({
  useAuthenticate: () => ({ data: { user: { name: "Test User" } } }),
}));
vi.mock("./dashboard-team-selector-shared", () => ({
  DashboardTeamDisplay: () => null,
  useDashboardTeamSelector: () => ({
    activeOrg: null,
    currentItem: null,
    items: [],
    orgList: [],
    switchTeam: vi.fn(),
    user: {},
  }),
}));
vi.mock("./dashboard-shortcuts", () => ({
  dispatchDashboardShortcutsOpen: vi.fn(),
}));
vi.mock("@sourceweft/ui-web/components/ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: false }),
  SidebarMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
// Keep menu actions mounted; exercise actual entry handlers and shared dialog.
vi.mock("@sourceweft/ui-web/components/ui/dropdown-menu", () => {
  const Wrap = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    ...Object.fromEntries(
      [
        "DropdownMenu",
        "DropdownMenuContent",
        "DropdownMenuGroup",
        "DropdownMenuLabel",
        "DropdownMenuSub",
        "DropdownMenuSubContent",
        "DropdownMenuSubTrigger",
        "DropdownMenuTrigger",
      ].map((name) => [name, Wrap]),
    ),
    DropdownMenuSeparator: () => null,
    DropdownMenuItem: ({
      children,
      onClick,
    }: {
      children: ReactNode;
      onClick: () => void;
    }) => <button onClick={onClick}>{children}</button>,
  };
});
vi.mock("./dashboard-settings-center/account-panel", () => ({
  AccountPanel: () => <h2>Profile content</h2>,
}));
vi.mock("./dashboard-settings-center/about-panel", () => ({
  AboutPanel: () => <h2>About content</h2>,
}));
vi.mock("./dashboard-settings-center/local-host-panel", () => ({
  LocalHostPanel: () => <h2>Local computer content</h2>,
}));
vi.mock("./dashboard-settings-center/team-panel", () => ({
  TeamPanel: () => null,
}));
vi.mock("./dashboard-settings-center/billing-panel", () => ({
  BillingPanel: () => null,
}));
vi.mock("./dashboard-settings-center/usage-panel", () => ({
  UsagePanel: () => null,
}));
vi.mock("./dashboard-settings-center/trust-rules-panel", () => ({
  TrustRulesPanel: () => null,
}));
vi.mock("./dashboard-settings-center-modal", async () => ({
  DashboardSettingsCenterModal: (
    await import("./dashboard-settings-center/settings-center-shell")
  ).DashboardSettingsCenterModal,
}));

import { DashboardAccountMenu } from "./dashboard-account-menu";
import { DashboardSettingsCenterModal } from "./dashboard-settings-center/settings-center-shell";

beforeEach(() => {
  host.available = false;
  host.platform = "macos";
  host.fail = false;
  host.billing = true;
});
afterEach(unmountAll);
async function settings() {
  await mountWithIntl(
    createElement(DashboardSettingsCenterModal, {
      open: true,
      onOpenChange: () => {},
      initials: "TU",
      initialTab: "account",
    }),
  );
  return document.querySelector('[role="dialog"]')!;
}

test("Web uses Settings for the center entry, keeps Profile as a panel, and has no gear", async () => {
  const { container } = await mountWithIntl(<DashboardAccountMenu />);
  expect(container.querySelector('button[aria-label="Settings"]')).toBeNull();
  expect(button("Settings", container)).toBeTruthy();
  expect(button("Profile", container)).toBeUndefined();
  await click(button("Settings", container));
  await flush(10);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "Profile content",
  );
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(
    "Desktop app",
  );
});

test("desktop gear and account menu reuse a single settings dialog", async () => {
  host.available = true;
  const { container } = await mountWithIntl(<DashboardAccountMenu expanded />);
  const gear = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Settings"]',
  )!;
  expect(gear).toBeTruthy();
  await click(gear);
  await flush(10);
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "Desktop app",
  );
  await click(
    document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!,
  );
  const menuEntry = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "Settings" && !b.hasAttribute("aria-label"),
  )!;
  await click(menuEntry);
  await flush(10);
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
});

test.each(["macos", "windows", "linux"])(
  "%s groups desktop settings with platform-specific local access",
  async (platform) => {
    host.available = true;
    host.platform = platform;
    const dialog = await settings();
    expect(dialog.textContent).toContain("Account & workspace");
    expect(dialog.textContent).toContain("Desktop app");
    expect(Boolean(button("This computer", dialog))).toBe(
      platform === "macos" || platform === "linux",
    );
    await click(button("About", dialog));
    expect(dialog.textContent).toContain("About content");
    if (platform === "macos" || platform === "linux") {
      await click(button("This computer", dialog));
      expect(dialog.textContent).toContain("Local computer content");
    }
  },
);

test("Web retains About and core edition hides billing sections", async () => {
  host.billing = false;
  const dialog = await settings();
  expect(button("About", dialog)).toBeTruthy();
  expect(button("Billing", dialog)).toBeUndefined();
  expect(button("Usage", dialog)).toBeUndefined();
  expect(button("This computer", dialog)).toBeUndefined();
});

test("failed desktop discovery never exposes a local-computer panel", async () => {
  host.available = true;
  host.fail = true;
  const dialog = await settings();
  expect(button("This computer", dialog)).toBeUndefined();
  expect(button("About", dialog)).toBeTruthy();
});
