// @vitest-environment jsdom
import assert from "node:assert/strict";
import {
  act,
  createElement,
  type ReactElement,
  type ReactNode,
} from "react";
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
  isDesktop: vi.fn(),
  request: vi.fn(),
  taskFolder: vi.fn(),
  desktopInfo: vi.fn(),
  reveal: vi.fn(),
  chooseLocalFolder: vi.fn(),
  hostStatus: vi.fn(),
}));
vi.mock("../../../../lib/desktop-bridge", () => ({
  desktopBridge: {
    isAvailable: mocks.isDesktop,
    localHostStatus: mocks.hostStatus,
    getTaskFolder: mocks.taskFolder,
    info: mocks.desktopInfo,
    revealLocalDirectory: mocks.reveal,
    chooseLocalFolder: mocks.chooseLocalFolder,
  },
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
// An opened Radix popover never settles under jsdom. This disclosure keeps the trigger and
// everything inside the content real; placement and focus remain browser acceptance.
vi.mock("@sourceweft/ui-web/components/ui/popover", async () => {
  const React = await import("react");
  type Disclosure = { open: boolean; toggle: () => void };
  const Context = React.createContext<Disclosure>({
    open: false,
    toggle: () => {},
  });
  return {
    Popover({
      open,
      onOpenChange,
      children,
    }: {
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
      children: ReactNode;
    }) {
      const [own, setOwn] = React.useState(false);
      const shown = open ?? own;
      const toggle = () => {
        setOwn(!shown);
        onOpenChange?.(!shown);
      };
      return React.createElement(
        Context.Provider,
        { value: { open: shown, toggle } },
        children,
      );
    },
    PopoverTrigger({
      children,
    }: {
      children: ReactElement<{ onClick?: () => void }>;
    }) {
      const { toggle } = React.useContext(Context);
      return React.cloneElement(children, { onClick: toggle });
    },
    PopoverContent({ children }: { children: ReactNode }) {
      return React.useContext(Context).open
        ? React.createElement("div", null, children)
        : null;
    },
  };
});
import {
  useChatCreationContext,
  ChatWorkContext,
  WorkingFolderPicker,
  type ChatCreationContext,
} from "./chat-work-context";
import { subscribeDashboardSettingsOpen } from "../../_components/dashboard-settings-open";
import type { SandboxReadiness } from "../../../../lib/desktop-bridge";
import {
  button,
  buttons,
  click,
  flush,
  mountWithIntl,
  type Mounted,
  unmountAll,
  withIntl,
} from "@/test/react";


let view: Mounted | null = null;
let container: HTMLDivElement, context: ChatCreationContext;
/** First call mounts; later calls re-render into the same root. */
async function render(node: ReactNode) {
  if (view) return view.render(withIntl(node));
  view = await mountWithIntl(node);
  container = view.container;
}
/** Unmount so the next render starts from a fresh root. */
async function reset() {
  await unmountAll();
  view = null;
}
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
  mocks.isDesktop.mockReset().mockReturnValue(false);
  mocks.request.mockReset().mockResolvedValue({
    devices: [
      { id: "a", name: "Mac A", online: true, connected: true },
      { id: "b", name: "Mac B", online: false, connected: true },
    ],
  });
  mocks.push.mockClear();
  mocks.replace.mockClear();
  mocks.taskFolder.mockReset().mockResolvedValue({
    path: "/Users/me/SourceWeft",
    defaultPath: "/Users/me/SourceWeft",
    isDefault: true,
  });
  mocks.desktopInfo.mockReset().mockResolvedValue({ platform: "macos" });
  mocks.reveal.mockReset().mockResolvedValue(undefined);
  mocks.chooseLocalFolder.mockReset();
  // A desktop build that reports no readiness, as v0.3.0-rc.8 does.
  mocks.hostStatus.mockReset().mockResolvedValue({
    deviceId: null,
    connected: false,
  });
});
afterEach(async () => {
  await reset();
  vi.useRealTimers();
});
test("Web defaults to cloud; a native bootstrap selects this computer", async () => {
  await render(createElement(Harness));
  assert.deepEqual(context.target, { kind: "cloud" });
  await reset();
  mocks.native.mockResolvedValue({ deviceId: "b" });
  mocks.isDesktop.mockReturnValue(true);
  await render(createElement(Harness));
  assert.deepEqual(context.target, { kind: "local", deviceId: "b" });
});
test("native initialization failure never creates an implicit cloud context", async () => {
  mocks.isDesktop.mockReturnValue(true);
  mocks.native.mockRejectedValue(new Error("KEYCHAIN_DENIED"));
  await render(createElement(Harness));
  assert.equal(context.target, null);
  assert.equal(context.ready, false);
  assert.equal(context.error, "KEYCHAIN_DENIED");
});
test("explicit URL choice survives refresh; changing computers clears only that folder selection", async () => {
  mocks.query = new URLSearchParams("computer=b&folder=folder-b");
  await render(createElement(Harness));
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
  await render(createElement(Harness));
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
  await render(createElement(Harness));
  assert.deepEqual(context.target, { kind: "local", deviceId: "removed" });
  assert.ok(context.error);
});
test("existing conversation shows its bound host without a target switcher", async () => {
  mocks.request.mockResolvedValue({
    executionTarget: { kind: "local", deviceId: "a" },
    target: { deviceId: "a", name: "Mac A", online: true },
  });
  await render(
    createElement(ChatWorkContext, {
      workspaceId: "w",
      threadId: "thread-a",
    }),
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
  await render(createElement(Harness));
  assert.deepEqual(context.target, { kind: "cloud" });
  assert.equal(context.ready, true);
  assert.equal(context.error, null);
  assert.equal(mocks.native.mock.calls.length, 0);
});

test("web defaults to cloud when computer discovery is unavailable", async () => {
  mocks.request.mockRejectedValue(new Error("Internal server error"));
  await render(createElement(Harness));
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
  await render(createElement(Harness));
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
  await render(createElement(Harness));
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
  await render(
    createElement(ChatWorkContext, {
      workspaceId: "w",
      threadId: "thread-b",
    }),
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
  await render(
    createElement(ChatWorkContext, {
      workspaceId: "w",
      threadId: "thread-b",
    }),
  );
  assert.match(container.textContent ?? "", /Computer unavailable/);
  assert.equal(container.textContent?.includes("Offline"), false);
  assert.equal(container.textContent?.includes("Cloud"), false);
});

test("a conversation whose status is still loading shows progress, not an unavailable computer", async () => {
  let settle!: (info: unknown) => void;
  mocks.request.mockReturnValue(
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  await render(
    createElement(ChatWorkContext, {
      workspaceId: "w",
      threadId: "thread-loading",
    }),
  );
  assert.match(container.textContent ?? "", /Connecting…/);
  assert.equal(container.textContent?.includes("Computer unavailable"), false);
  assert.ok(container.querySelector(".animate-spin"));
  await act(async () => {
    settle({
      executionTarget: { kind: "local", deviceId: "a" },
      availability: { ready: true },
      target: { deviceId: "a", name: "Mac A", online: true },
    });
  });
  assert.match(container.textContent ?? "", /Mac A/);
  assert.equal(container.querySelector(".animate-spin"), null);
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
  const thread = () =>
    createElement(ChatWorkContext, {
      workspaceId: "w",
      threadId: "selected-thread",
    });
  await render(thread());
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
  await reset();
  mocks.request.mockResolvedValue({
    ...info,
    target: { ...info.target, online: false },
  });
  await render(thread());
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
  await render(createElement(Harness));
  assert.equal(context.nativeId, "a");
  mocks.query = new URLSearchParams("computer=cloud");
  await render(createElement(Harness));
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
  await render(createElement(Harness));
  await act(async () => {
    await context.refresh();
  });
  assert.equal(context.ready, true);
  assert.equal(context.error, null);
  assert.equal(context.devicesError, "KEYCHAIN_DENIED");
});

const grantedFolders = [
  { id: "g1", name: "proj", path: "/Users/me/work/proj" },
  { id: "g2", name: "proj", path: "/Users/me/work/proj" },
  { id: "g3", name: "notes", path: "/Users/me/notes" },
];
/** The slice of the creation context the folder picker reads. */
function pickerCreation(
  overrides: Partial<
    Pick<ChatCreationContext, "target" | "nativeId" | "selectedDevice">
  > = {},
) {
  return {
    target: { kind: "local" as const, deviceId: "a" },
    nativeId: "a",
    selectedDevice: {
      id: "a",
      name: "Mac A",
      online: true,
      connected: true,
      remoteEnabled: false,
    },
    setFolder: vi.fn(),
    ...overrides,
  };
}
const folderTrigger = () =>
  container.querySelector<HTMLButtonElement>(
    '[data-testid="working-folder-trigger"]',
  )!;
async function openFolderPicker() {
  await click(folderTrigger());
  await flush(4);
}
/** The text of every alert on the page: comparing nodes would dump the whole DOM on failure. */
const alerts = () =>
  [...document.querySelectorAll('[role="alert"]')]
    .map((node) => node.textContent)
    .join("\n");
const folderEntries = () => [
  ...document.querySelectorAll<HTMLButtonElement>(
    '[data-testid="working-folder-list"] button',
  ),
];

test("the folder trigger shows the automatic task folder, then the chosen folder", async () => {
  mocks.request.mockResolvedValue({ folders: grantedFolders });
  await render(
    createElement(WorkingFolderPicker, { creation: pickerCreation() }),
  );
  await flush(4);
  assert.equal(folderTrigger().textContent, "Task folder");
  assert.equal(
    folderTrigger().title,
    "Will be created in /Users/me/SourceWeft",
  );
  await render(
    createElement(WorkingFolderPicker, {
      creation: pickerCreation({
        target: { kind: "local", deviceId: "a", folderId: "g3" },
      }),
    }),
  );
  await flush(4);
  assert.equal(folderTrigger().textContent, "notes");
  assert.equal(folderTrigger().title, "/Users/me/notes");
  assert.equal(document.body.textContent?.includes("Choose existing"), false);
});

test("a chosen folder that is no longer listed keeps a neutral trigger label", async () => {
  mocks.request.mockResolvedValue({ folders: [] });
  await render(
    createElement(WorkingFolderPicker, {
      creation: pickerCreation({
        target: { kind: "local", deviceId: "a", folderId: "revoked" },
      }),
    }),
  );
  await flush(4);
  assert.equal(folderTrigger().textContent, "Selected folder");
  await openFolderPicker();
  assert.equal(folderEntries().length, 0);
  assert.equal(document.body.textContent?.includes("Folders"), false);
});

test("the folder list shows each directory once and keeps the selected grant", async () => {
  mocks.request.mockResolvedValue({ folders: grantedFolders });
  const creation = pickerCreation({
    target: { kind: "local", deviceId: "a", folderId: "g2" },
  });
  await render(createElement(WorkingFolderPicker, { creation }));
  await flush(4);
  await openFolderPicker();
  const entries = folderEntries();
  assert.deepEqual(
    entries.map((entry) => entry.textContent),
    ["notes~", "proj~/work"],
  );
  assert.deepEqual(
    entries.map((entry) => entry.getAttribute("aria-current")),
    [null, "true"],
  );
  assert.equal(
    entries[1]!.querySelector("[title]")?.getAttribute("title"),
    "/Users/me/work/proj",
  );
  await click(entries[1]!);
  assert.deepEqual(creation.setFolder.mock.calls, [["g2"]]);
});

test("the automatic choice is checked when no folder is chosen and selects the task folder", async () => {
  mocks.request.mockResolvedValue({ folders: grantedFolders });
  const creation = pickerCreation();
  await render(createElement(WorkingFolderPicker, { creation }));
  await flush(4);
  await openFolderPicker();
  assert.equal(folderEntries().length, 2);
  assert.ok(
    folderEntries().every((entry) => !entry.hasAttribute("aria-current")),
  );
  const automatic = [...document.querySelectorAll("button")].find((node) =>
    node.textContent?.startsWith("New task folder"),
  )!;
  assert.equal(automatic.getAttribute("aria-current"), "true");
  await click(automatic);
  assert.deepEqual(creation.setFolder.mock.calls, [[""]]);
});

test("the task folder location is shown only for the computer the app runs on", async () => {
  mocks.request.mockResolvedValue({ folders: [] });
  await render(
    createElement(WorkingFolderPicker, { creation: pickerCreation() }),
  );
  await flush(4);
  await openFolderPicker();
  assert.match(
    document.body.textContent ?? "",
    /New task folderWill be created in ~\/SourceWeft/,
  );
  assert.ok(button("Choose a different folder…"));
  await reset();

  mocks.taskFolder.mockClear();
  await render(
    createElement(WorkingFolderPicker, {
      creation: pickerCreation({ nativeId: "another-computer" }),
    }),
  );
  await flush(4);
  assert.equal(folderTrigger().title, "Task folder");
  await openFolderPicker();
  assert.match(
    document.body.textContent ?? "",
    /New task folderCreated automatically on that computer/,
  );
  assert.equal(document.body.textContent?.includes("SourceWeft"), false);
  assert.equal(mocks.taskFolder.mock.calls.length, 0);
  assert.equal(buttons("Choose a different folder…").length, 0);
});

test("an app version without the task folder command shows no guessed location", async () => {
  mocks.request.mockResolvedValue({ folders: [] });
  mocks.taskFolder.mockRejectedValue(
    new Error("Command get_task_folder not found"),
  );
  await render(
    createElement(WorkingFolderPicker, { creation: pickerCreation() }),
  );
  await flush(4);
  assert.equal(folderTrigger().title, "Task folder");
  await openFolderPicker();
  assert.match(
    document.body.textContent ?? "",
    /New task folderCreated automatically on that computer/,
  );
  assert.equal(alerts(), "");
  assert.ok(button("Choose a different folder…"));
});

const selectedThread = {
  availability: { ready: true, code: null, message: null },
  executionTarget: { kind: "local", deviceId: "a", folderId: "picked-folder" },
  workingDirectory: "/Users/example/Projects/selected-directory",
  target: { deviceId: "a", name: "Mac A", online: true },
};
/** An existing conversation's header, as the chat page mounts it. */
async function openConversationDetails(threadId: string, nativeId: string | null) {
  await render(
    createElement(ChatWorkContext, {
      workspaceId: "w",
      threadId,
      creation: { nativeId, devices: [], error: null } as never,
    }),
  );
  await click(
    container.querySelector<HTMLButtonElement>(
      '[aria-label="Conversation details"]',
    )!,
  );
  await flush(4);
}

test("conversation details shorten the working directory and reveal it on this computer", async () => {
  mocks.request.mockResolvedValue(selectedThread);
  await openConversationDetails("details-native", "a");
  const path = document.querySelector('[data-testid="working-directory-path"]');
  assert.equal(path?.textContent, "~/Projects/selected-directory");
  assert.equal(path?.getAttribute("title"), selectedThread.workingDirectory);
  assert.ok(button("Copy path"));
  assert.equal(buttons("Show in file manager").length, 0);
  await click(button("Show in Finder"));
  assert.deepEqual(mocks.reveal.mock.calls, [
    [selectedThread.workingDirectory],
  ]);
  assert.equal(alerts(), "");
});

test("the file manager is named generically off macOS and a refusal is shown", async () => {
  mocks.request.mockResolvedValue(selectedThread);
  mocks.desktopInfo.mockResolvedValue({ platform: "windows" });
  mocks.reveal.mockRejectedValue(
    new Error("WORKSPACE_MISSING: The directory does not exist yet or was replaced."),
  );
  await openConversationDetails("details-windows", "a");
  assert.equal(buttons("Show in Finder").length, 0);
  await click(button("Show in file manager"));
  await flush(2);
  assert.match(
    document.querySelector('[role="alert"]')?.textContent ?? "",
    /WORKSPACE_MISSING/,
  );
});

test("a conversation on another computer offers copying the path but no reveal action", async () => {
  mocks.request.mockResolvedValue(selectedThread);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  try {
    await openConversationDetails("details-remote", "another-computer");
    assert.equal(buttons("Show in Finder").length, 0);
    assert.equal(buttons("Show in file manager").length, 0);
    assert.equal(mocks.desktopInfo.mock.calls.length, 0);
    await click(button("Copy path"));
    await flush(2);
    assert.deepEqual(writeText.mock.calls, [
      [selectedThread.workingDirectory],
    ]);
    assert.ok(button("Copied"));
    assert.equal(buttons("Copy path").length, 0);
  } finally {
    Reflect.deleteProperty(navigator, "clipboard");
  }
});

test("conversation details without a working directory offer no path actions", async () => {
  mocks.request.mockResolvedValue({
    executionTarget: { kind: "local", deviceId: "a" },
    workingDirectory: null,
    target: { deviceId: "a", name: "Mac A", online: true },
  });
  await openConversationDetails("details-pending", "a");
  assert.match(
    document.body.textContent ?? "",
    /The working directory will be connected when first used\./,
  );
  assert.equal(buttons("Copy path").length, 0);
  assert.equal(buttons("Show in Finder").length, 0);
});

/** A new chat's run-location control, driven by the real creation context. */
function RunLocation() {
  context = useChatCreationContext();
  return createElement(ChatWorkContext, {
    workspaceId: "workspace",
    creation: context,
  });
}
async function openRunLocationMenu() {
  await render(createElement(RunLocation));
  await click(
    container.querySelector<HTMLButtonElement>(
      '[aria-label="Choose cloud or computer"]',
    )!,
  );
  await flush(8);
}
const setupRow = () =>
  container.querySelector<HTMLElement>('[data-testid="this-computer-setup"]');
const needsSetup = (remedy: string, code = "bundleMissing"): SandboxReadiness =>
  ({
    state: "needsSetup",
    code,
    reason: "host wording that the menu does not repeat",
    remedy,
  }) as SandboxReadiness;
/** This computer cannot run anything yet, so the native bootstrap yields no session. */
function desktopReports(
  readiness: SandboxReadiness,
  deviceId: string | null = null,
) {
  mocks.isDesktop.mockReturnValue(true);
  mocks.native.mockResolvedValue(null);
  mocks.hostStatus.mockResolvedValue({ deviceId, connected: false, readiness });
}

test("a computer that needs its sandbox runtime is listed with the reason and opens its settings", async () => {
  desktopReports(needsSetup("downloadRuntime"));
  const requests: string[] = [];
  const unsubscribe = subscribeDashboardSettingsOpen((tab) => {
    requests.push(tab);
    return true;
  });
  try {
    await openRunLocationMenu();
    const row = setupRow()!;
    assert.equal(row.tagName, "BUTTON");
    assert.match(row.textContent ?? "", /This computer/);
    assert.match(row.textContent ?? "", /Needs setup/);
    assert.match(
      row.textContent ?? "",
      /The sandbox runtime needs to be installed\. Open Settings to install it\./,
    );
    // The trigger keeps saying where the conversation will run.
    assert.equal(
      container
        .querySelector('[aria-label="Choose cloud or computer"]')
        ?.textContent?.trim(),
      "Cloud",
    );
    mocks.push.mockClear();
    await click(row);
    assert.deepEqual(requests, ["local"]);
    // Choosing the row is not a run-location choice, and the menu closes behind it.
    assert.equal(mocks.push.mock.calls.length, 0);
    assert.deepEqual(context.target, { kind: "cloud" });
    assert.equal(setupRow(), null);
  } finally {
    unsubscribe();
  }
});

test.each([
  [
    "an install already running",
    needsSetup("none", "installing"),
    "The sandbox runtime is being installed…",
  ],
  [
    "an app that must be updated first",
    needsSetup("updateApp", "bundleNewer"),
    "SourceWeft needs an update first. Open Settings for details.",
  ],
  [
    "an administrator step",
    needsSetup("privilegedSetup", "userNamespaceRestricted"),
    "One-time setup is not finished. Open Settings to complete it.",
  ],
  [
    "a remedy this web app does not know",
    needsSetup("somethingNewer", "sandboxFailed"),
    "One-time setup is not finished. Open Settings to complete it.",
  ],
])("the setup row explains %s", async (_case, readiness, reason) => {
  desktopReports(readiness);
  await openRunLocationMenu();
  const text = setupRow()?.textContent ?? "";
  assert.match(text, /Needs setup/);
  assert.equal(text.includes(reason), true, text);
});

test("an unsupported computer is listed as such and cannot be chosen", async () => {
  desktopReports({ state: "unsupported" });
  const requests: string[] = [];
  const unsubscribe = subscribeDashboardSettingsOpen((tab) => {
    requests.push(tab);
    return true;
  });
  try {
    await openRunLocationMenu();
    const row = setupRow()!;
    assert.notEqual(row.tagName, "BUTTON");
    assert.equal(row.querySelector("button"), null);
    assert.match(row.textContent ?? "", /This computer/);
    assert.match(row.textContent ?? "", /Not supported/);
    assert.match(
      row.textContent ?? "",
      /Local execution is not available on this computer/,
    );
    await click(row);
    assert.deepEqual(requests, []);
    assert.equal(mocks.push.mock.calls.length, 0);
  } finally {
    unsubscribe();
  }
});

test("a ready computer is listed as before, without a setup row", async () => {
  mocks.isDesktop.mockReturnValue(true);
  mocks.native.mockResolvedValue({ deviceId: "a" });
  mocks.hostStatus.mockResolvedValue({
    deviceId: "a",
    connected: true,
    readiness: { state: "ready" },
  });
  await openRunLocationMenu();
  assert.equal(setupRow(), null);
  assert.equal(buttons("This computer · Mac AOnline", container).length, 1);
  assert.equal(container.textContent?.includes("Needs setup"), false);
});

test("a desktop build that reports no readiness gets the menu it always had", async () => {
  mocks.isDesktop.mockReturnValue(true);
  mocks.native.mockResolvedValue({ deviceId: "a" });
  await openRunLocationMenu();
  assert.equal(setupRow(), null);
  assert.equal(buttons("This computer · Mac AOnline", container).length, 1);
  assert.equal(buttons("Mac BOffline", container).length, 1);
});

test("a browser never asks for the host status and shows no setup row", async () => {
  await openRunLocationMenu();
  assert.equal(mocks.hostStatus.mock.calls.length, 0);
  assert.equal(setupRow(), null);
  assert.equal(buttons("Mac AOnline", container).length, 1);
  assert.equal(container.textContent?.includes("This computer"), false);
});

test("a computer that needs setup appears once even when it is also a connected computer", async () => {
  desktopReports(needsSetup("downloadRuntime"), "a");
  await openRunLocationMenu();
  assert.ok(setupRow());
  assert.equal(
    (container.textContent ?? "").split("This computer").length - 1,
    1,
  );
  // The listed entry for the same computer gives way to the row that explains it.
  assert.equal(
    [...container.querySelectorAll("button")].some((node) =>
      node.textContent?.includes("Mac A"),
    ),
    false,
  );
  assert.equal(buttons("Mac BOffline", container).length, 1);
});

test("a host status that cannot be read leaves the menu unchanged", async () => {
  mocks.isDesktop.mockReturnValue(true);
  mocks.native.mockResolvedValue({ deviceId: "a" });
  mocks.hostStatus.mockRejectedValue(new Error("IPC unavailable"));
  await openRunLocationMenu();
  assert.equal(setupRow(), null);
  assert.equal(buttons("This computer · Mac AOnline", container).length, 1);
});
