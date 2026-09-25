// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

type SessionState = {
  data: { user: { id: string }; session: { id: string } } | null;
  isPending: boolean;
};

// better-auth's `useSession` reads its atom for both the client and the
// server snapshot, so hydration sees whatever the atom already holds.
const auth = vi.hoisted(() => ({
  state: { data: null, isPending: true } as SessionState,
  getSession: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("../../lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ ...auth.state, refetch: auth.refetch }),
    getSession: auth.getSession,
  },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/chat",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock("../../lib/register-builtin-agent-tools", () => ({
  registerBuiltinAgentTools: () => {},
}));
vi.mock("../../lib/local-host-session", () => ({
  synchronizeLocalHostScope: () => Promise.resolve(),
}));
vi.mock("../../lib/desktop-bridge", () => ({
  desktopBridge: { isAvailable: () => false },
}));
vi.mock("../../lib/desktop-hub-bridge", () => ({ desktopHubBridge: {} }));
vi.mock("../../lib/hub-skill-memory", () => ({
  hubSkillMemory: { clear: () => {} },
}));

const { passthrough, empty } = vi.hoisted(() => ({
  passthrough: ({ children }: { children?: ReactNode }) => children,
  empty: () => null,
}));
vi.mock("@sourceweft/ui-web/components/ui/sidebar", () => ({
  SidebarProvider: passthrough,
}));
vi.mock("./chat/_components/chat-hub-context", () => ({
  ChatHubProvider: passthrough,
}));
vi.mock("./_components/dashboard-chat-state", () => ({
  DashboardChatStateProvider: passthrough,
}));
vi.mock("./_components/dashboard-mobile-nav-state", () => ({
  DashboardMobileNavProvider: passthrough,
}));
vi.mock("./_components/dashboard-workspace-layout", () => ({
  DashboardWorkspaceLayout: passthrough,
}));
vi.mock("./_components/dashboard-mobile-content", () => ({
  DashboardMobileContent: passthrough,
}));
vi.mock("./_components/dashboard-sidebar", () => ({ DashboardSidebar: empty }));
vi.mock("./_components/dashboard-mobile-bottom-nav", () => ({
  DashboardMobileBottomNav: empty,
}));
vi.mock("./_components/dashboard-page-navigation", () => ({
  DashboardPageNavigation: empty,
}));
vi.mock("../_components/dashboard-loading-skeleton", () => ({
  DashboardShellRouteSkeleton: () => <section data-testid="shell-skeleton" />,
}));

import { DashboardLayoutClient } from "./dashboard-layout-client";

const signedIn: SessionState = {
  data: { user: { id: "user-1" }, session: { id: "session-1" } },
  isPending: false,
};

const tree = (
  <DashboardLayoutClient>
    <p>Chat page</p>
  </DashboardLayoutClient>
);

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  auth.state = { data: null, isPending: true };
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
});

test("hydrates the server's skeleton even when the session resolved first", async () => {
  container.innerHTML = renderToString(tree);
  expect(container.querySelector("[data-testid=shell-skeleton]")).not.toBeNull();

  // Another subscriber fetched the session before this subtree hydrated.
  auth.state = signedIn;
  const recoverableErrors: unknown[] = [];
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  await act(async () => {
    root = hydrateRoot(container, tree, {
      onRecoverableError: (error) => recoverableErrors.push(error),
    });
  });

  expect(recoverableErrors).toEqual([]);
  expect(consoleError).not.toHaveBeenCalled();
  expect(container.querySelector("[data-testid=shell-skeleton]")).toBeNull();
  expect(container.querySelector("main")?.textContent).toBe("Chat page");
});

test("a client-side mount with a known session skips the skeleton", async () => {
  auth.state = signedIn;
  root = createRoot(container);
  const mounted = root;

  // Inspect the first commit before any effect-driven re-render.
  flushSync(() => mounted.render(tree));

  expect(container.querySelector("[data-testid=shell-skeleton]")).toBeNull();
  expect(container.querySelector("main")?.textContent).toBe("Chat page");
});
