// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, test, vi } from "vitest";
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
  request: vi.fn(),
}));
vi.mock("../../../../lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "draft-owner" } } }) },
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
  mocks.query = new URLSearchParams();
  mocks.native.mockReset().mockResolvedValue(null);
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
});
test("Web defaults to cloud; a native bootstrap selects this computer", async () => {
  await act(async () => root.render(createElement(Harness)));
  assert.deepEqual(context.target, { kind: "cloud" });
  await act(async () => root.unmount());
  root = createRoot(container);
  mocks.native.mockResolvedValue({ deviceId: "b" });
  await act(async () => root.render(createElement(Harness)));
  assert.deepEqual(context.target, { kind: "local", deviceId: "b" });
});
test("native initialization failure never creates an implicit cloud context", async () => {
  mocks.native.mockRejectedValue(new Error("KEYCHAIN_DENIED"));
  await act(async () => root.render(createElement(Harness)));
  assert.equal(context.target, null);
  assert.equal(context.ready, false);
  assert.equal(context.error, "KEYCHAIN_DENIED");
});
test("explicit URL choice survives refresh; changing computers clears only that folder selection", async () => {
  mocks.query = new URLSearchParams("computer=b&folder=folder-b");
  await act(async () => root.render(createElement(Harness)));
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
  await act(async () => root.render(createElement(Harness)));
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
  await act(async () => root.render(createElement(Harness)));
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
      createElement(ChatWorkContext, {
        workspaceId: "w",
        threadId: "thread-a",
      }),
    ),
  );
  assert.match(container.textContent ?? "", /Mac A/);
  assert.equal(container.querySelector('[aria-label="选择云端或电脑"]'), null);
  assert.equal(container.textContent?.includes("执行位置"), false);
});

test("explicit cloud remains available when this PC cannot initialize", async () => {
  mocks.query = new URLSearchParams("computer=cloud");
  mocks.native.mockRejectedValue(new Error("KEYCHAIN_DENIED"));
  await act(async () => root.render(createElement(Harness)));
  assert.deepEqual(context.target, { kind: "cloud" });
  assert.equal(context.ready, true);
  assert.equal(context.error, null);
  assert.equal(mocks.native.mock.calls.length, 0);
});
