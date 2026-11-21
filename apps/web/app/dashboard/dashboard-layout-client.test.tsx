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
const host = vi.hoisted(() => ({
  pathname: "/dashboard/chat",
  installAutomatically: vi.fn(),
}));

vi.mock("../../lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ ...auth.state, refetch: auth.refetch }),
    getSession: auth.getSession,
  },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => host.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("../../lib/register-builtin-agent-tools", () => ({
  registerBuiltinAgentTools: () => {},
}));
vi.mock("../../lib/local-host-session", () => ({
  synchronizeLocalHostScope: () => Promise.resolve(),
}));
vi.mock("../../lib/sandbox-runtime-install", () => ({
  installSandboxRuntimeAutomatically: host.installAutomatically,
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
  host.pathname = "/dashboard/chat";
  host.installAutomatically.mockReset().mockResolvedValue(undefined);
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

async function mountLayout() {
  root = createRoot(container);
  const mounted = root;
  await act(async () => mounted.render(tree));
}

test("the signed-in dashboard asks for the sandbox runtime as soon as it opens", async () => {
  auth.state = signedIn;
  await mountLayout();
  expect(host.installAutomatically).toHaveBeenCalledTimes(1);
});

test("nothing is asked for while the session is unknown or absent", async () => {
  await mountLayout();
  expect(host.installAutomatically).not.toHaveBeenCalled();
  await act(async () => root?.unmount());
  auth.state = { data: null, isPending: false };
  await mountLayout();
  expect(host.installAutomatically).not.toHaveBeenCalled();
});

test.each(["/dashboard/hub-window", "/dashboard/preview-window"])(
  "the auxiliary window %s leaves the sandbox runtime to the main window",
  async (pathname) => {
    auth.state = signedIn;
    host.pathname = pathname;
    await mountLayout();
    expect(host.installAutomatically).not.toHaveBeenCalled();
  },
);
