// @vitest-environment jsdom
import assert from "node:assert/strict";
import {
  act,
  createElement,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, test, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../../messages/en.json";
vi.mock("../../_components/dashboard-chat-state", () => ({
  useDashboardChatState: () => ({
    setWorkTarget: mocks.setWorkTarget,
    workspaceId: "workspace",
  }),
}));
const mocks = vi.hoisted(() => ({
  setWorkTarget: vi.fn(),
  query: new URLSearchParams(),
  push: vi.fn(),
  replace: vi.fn(),
  native: vi.fn(),
  isDesktop: vi.fn(),
  request: vi.fn(),
}));
vi.mock("../../../../lib/desktop-bridge", () => ({
  desktopBridge: { isAvailable: mocks.isDesktop },
}));
vi.mock("../../../../lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { id: "draft-owner" }, session: { id: "session" } },
    }),
  },
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => mocks.query,
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
}));
vi.mock("../../../../lib/local-host-session", () => ({
  ensureLocalHostSession: mocks.native,
}));
vi.mock("../../../../lib/local-execution", () => ({
  localRequest: mocks.request,
}));
import {
  useChatCreationContext,
  ChatWorkContext,
  type ChatCreationContext,
} from "./chat-work-context";

const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];
const withIntl = (node: ReactNode) => (
  <NextIntlClientProvider locale="en" messages={intlMessages}>
    {node}
  </NextIntlClientProvider>
);
let root: Root, container: HTMLDivElement, context: ChatCreationContext;
function Harness() {
  context = useChatCreationContext();
  return createElement(
    "output",
    null,
    JSON.stringify({
      target: context.target,
      error: context.error,
      ready: context.ready,
    }),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.query = new URLSearchParams();
  mocks.native.mockReset().mockResolvedValue(null);
  mocks.isDesktop.mockReset().mockReturnValue(false);
  mocks.request.mockReset().mockResolvedValue({
    devices: [
      { id: "a", name: "Mac A", online: true, connected: true },
      { id: "b", name: "Mac B", online: false, connected: true },
    ],
  });
  mocks.push.mockClear();
  mocks.replace.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
test("Web defaults to cloud; a native bootstrap selects this computer", async () => {
  await act(async () => root.render(withIntl(createElement(Harness))));
  assert.deepEqual(context.target, { kind: "cloud" });
  await act(async () => root.unmount());
  root = createRoot(container);
  mocks.native.mockResolvedValue({ deviceId: "b" });
  mocks.isDesktop.mockReturnValue(true);
  await act(async () => root.render(withIntl(createElement(Harness))));
  assert.deepEqual(context.target, { kind: "local", deviceId: "b" });
});
test("native initialization failure never creates an implicit cloud context", async () => {
  mocks.isDesktop.mockReturnValue(true);
  mocks.native.mockRejectedValue(new Error("KEYCHAIN_DENIED"));
  await act(async () => root.render(withIntl(createElement(Harness))));
  assert.equal(context.target, null);
  assert.equal(context.ready, false);
  assert.equal(context.error, "KEYCHAIN_DENIED");
});
test("explicit URL choice survives refresh; changing computers clears only that folder selection", async () => {
  mocks.query = new URLSearchParams("computer=b&folder=folder-b");
  await act(async () => root.render(withIntl(createElement(Harness))));
  assert.deepEqual(context.target, {
    kind: "local",
    deviceId: "b",
    folderId: "folder-b",
  });
  await act(async () => context.select("a"));
  assert.equal(
    new URL(mocks.push.mock.lastCall?.[0], "http://localhost").searchParams.get(
      "computer",
    ),
    "a",
  );
  mocks.query = new URLSearchParams("computer=a");
  await act(async () => root.render(withIntl(createElement(Harness))));
  await act(async () => context.select("b"));
  const restored = new URL(mocks.push.mock.lastCall?.[0], "http://localhost");
  assert.equal(restored.searchParams.get("computer"), "b");
  assert.equal(restored.searchParams.get("folder"), "folder-b");
  assert.ok(restored.searchParams.get("draft"));
  assert.equal(
    sessionStorage.getItem("sourceweft.local.execution-target"),
    null,
  );
});
test("removed device stays invalid rather than selecting another online host", async () => {
  mocks.query = new URLSearchParams("computer=removed");
  await act(async () => root.render(withIntl(createElement(Harness))));
  assert.deepEqual(context.target, { kind: "local", deviceId: "removed" });
  assert.ok(context.error);
});
test("existing conversation shows its bound host without a target switcher", async () => {
  mocks.request.mockResolvedValue({
    executionTarget: { kind: "local", deviceId: "a" },
    target: { deviceId: "a", name: "Mac A", online: true },
  });
  await act(async () =>
    root.render(
      withIntl(
        createElement(ChatWorkContext, {
          workspaceId: "w",
          threadId: "thread-a",
        }),
      ),
    ),
  );
  assert.match(container.textContent ?? "", /Mac A/);
  assert.equal(
    container.querySelector('[aria-label="Choose cloud or computer"]'),
    null,
  );
  assert.equal(container.textContent?.includes("执行位置"), false);
});

test("explicit cloud remains available when this PC cannot initialize", async () => {
  mocks.query = new URLSearchParams("computer=cloud");
  mocks.native.mockRejectedValue(new Error("KEYCHAIN_DENIED"));
  await act(async () => root.render(withIntl(createElement(Harness))));
  assert.deepEqual(context.target, { kind: "cloud" });
  assert.equal(context.ready, true);
  assert.equal(context.error, null);
  assert.equal(mocks.native.mock.calls.length, 0);
});

test("web defaults to cloud when computer discovery is unavailable", async () => {
  mocks.request.mockRejectedValue(new Error("Internal server error"));
  await act(async () => root.render(withIntl(createElement(Harness))));
  assert.deepEqual(context.target, { kind: "cloud" });
  assert.equal(context.ready, true);
  assert.equal(context.error, null);
  assert.equal(mocks.request.mock.calls.length, 0);
  assert.equal(mocks.native.mock.calls.length, 0);
  await act(async () => {
    await context.refresh();
  });
  assert.equal(context.ready, true);
  assert.equal(context.error, null);
  assert.equal(context.devicesError, "Internal server error");
});

test("explicit cloud is ready while computer discovery remains pending", async () => {
  mocks.query = new URLSearchParams("computer=cloud");
  mocks.request.mockImplementation(() => new Promise(() => {}));
  await act(async () => root.render(withIntl(createElement(Harness))));
  assert.equal(context.ready, true);
  assert.equal(mocks.request.mock.calls.length, 0);
  await act(async () => {
    void context.refresh();
  });
  assert.equal(context.ready, true);
  assert.equal(context.devicesLoading, true);
  assert.deepEqual(context.target, { kind: "cloud" });
});

test("computer discovery failure blocks a selected local target without switching to cloud", async () => {
  mocks.query = new URLSearchParams("computer=a");
  mocks.request.mockRejectedValue(new Error("Internal server error"));
  await act(async () => root.render(withIntl(createElement(Harness))));
  assert.equal(context.ready, false);
  assert.equal(context.target, null);
  assert.equal(context.error, "Internal server error");
  mocks.request.mockResolvedValue({ devices: [{ id: "a", connected: true }] });
  await act(async () => {
    await context.refresh();
  });
  assert.equal(context.error, null);
  assert.deepEqual(context.target, { kind: "local", deviceId: "a" });
});

test("an offline bound computer retains its identity without offering another execution target", async () => {
  mocks.request.mockResolvedValue({
    executionTarget: { kind: "local", deviceId: "b" },
    target: { deviceId: "b", name: "Mac B", online: false },
  });
  await act(async () =>
    root.render(
      withIntl(
        createElement(ChatWorkContext, {
          workspaceId: "w",
          threadId: "thread-b",
        }),
      ),
    ),
  );
  assert.match(container.textContent ?? "", /Mac B · Status unavailable/);
  assert.equal(
    document.querySelector('[aria-label="Choose cloud or computer"]'),
    null,
  );
  assert.equal(
    document.body.textContent?.includes("Connect a computer…"),
    false,
  );
});

test("an unavailable status endpoint is shown as an error, not an offline or cloud target", async () => {
  mocks.request.mockRejectedValue(new Error("Status service unavailable"));
  await act(async () =>
    root.render(
      withIntl(
        createElement(ChatWorkContext, {
          workspaceId: "w",
          threadId: "thread-b",
        }),
      ),
    ),
  );
  assert.match(container.textContent ?? "", /Computer unavailable/);
  assert.equal(container.textContent?.includes("Offline"), false);
  assert.equal(container.textContent?.includes("Cloud"), false);
});

test("selected directory remains visible after creation and survives an offline reload", async () => {
  const info = {
    executionTarget: {
      kind: "local",
      deviceId: "a",
      folderId: "picked-folder",
    },
    workingDirectory: "/Users/example/Projects/selected-directory",
    target: { deviceId: "a", name: "Mac A", online: true },
  };
  mocks.request.mockResolvedValue(info);
  const render = () =>
    root.render(
      withIntl(
        createElement(ChatWorkContext, {
          workspaceId: "w",
          threadId: "selected-thread",
        }),
      ),
    );
  await act(async () => render());
  assert.equal(
    container.querySelector('[data-testid="thread-working-directory"]')
      ?.textContent,
    "selected-directory",
  );
  assert.ok(
    container
      .querySelector('[aria-label="Conversation details"]')
      ?.getAttribute("title")
      ?.includes(info.workingDirectory),
  );
  assert.equal(
    container.querySelector('[aria-label="Choose cloud or computer"]'),
    null,
  );
  await act(async () => root.unmount());
  root = createRoot(container);
  mocks.request.mockResolvedValue({
    ...info,
    target: { ...info.target, online: false },
  });
  await act(async () => render());
  assert.match(container.textContent ?? "", /Status unavailable/);
  assert.equal(
    container.querySelector('[data-testid="thread-working-directory"]')
      ?.textContent,
    "selected-directory",
  );
});

test("desktop cloud discovery retains native identity and includes native proof", async () => {
  mocks.isDesktop.mockReturnValue(true);
  mocks.native.mockResolvedValue({ deviceId: "a" });
  await act(async () => root.render(withIntl(createElement(Harness))));
  assert.equal(context.nativeId, "a");
  mocks.query = new URLSearchParams("computer=cloud");
  await act(async () => root.render(withIntl(createElement(Harness))));
  assert.equal(context.ready, true);
  await act(async () => {
    await context.refresh();
  });
  assert.equal(context.nativeId, "a");
  assert.deepEqual(mocks.request.mock.lastCall, [
    "/v1/local-devices",
    undefined,
    { localProof: true },
  ]);
  assert.equal(
    context.devices.some((d) => d.id === "a" && d.connected),
    true,
  );
});

test("native discovery failure in cloud is reported without blocking cloud", async () => {
  mocks.isDesktop.mockReturnValue(true);
  mocks.query = new URLSearchParams("computer=cloud");
  mocks.native.mockRejectedValue(new Error("KEYCHAIN_DENIED"));
  await act(async () => root.render(withIntl(createElement(Harness))));
  await act(async () => {
    await context.refresh();
  });
  assert.equal(context.ready, true);
  assert.equal(context.error, null);
  assert.equal(context.devicesError, "KEYCHAIN_DENIED");
});
