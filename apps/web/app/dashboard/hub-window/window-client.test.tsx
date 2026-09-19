// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubMessage, HubSnapshot } from "../chat/_components/hub-protocol";

const state = vi.hoisted(() => ({
  listener: undefined as ((message: HubMessage) => void) | undefined,
  send: vi.fn().mockResolvedValue(undefined),
  action: vi.fn().mockResolvedValue(undefined),
  error: vi.fn(),
}));
vi.mock("../../../lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: "user" } }, isPending: false }),
  },
}));
vi.mock("../../../lib/desktop-bridge", () => ({
  desktopBridge: { isAvailable: () => true },
}));
vi.mock("../../../lib/desktop-hub-bridge", () => ({
  desktopHubBridge: {
    send: state.send,
    action: state.action,
    listen: async (cb: typeof state.listener) => {
      state.listener = cb;
      return async () => {};
    },
  },
}));
vi.mock("sonner", () => ({ toast: { error: state.error } }));
vi.mock("../chat/_components/source-preview-panel", () => ({
  SourcePreviewPanel: () => null,
}));
vi.mock("../chat/_components/sources-hub", () => ({
  ArtifactPreviewPanel: () => null,
  SourcesHub: (props: {
    threadId: string;
    onActivityChange: (value: { editing: boolean; busy: boolean }) => void;
    onSelectionChange: (ids: string[]) => void;
  }) =>
    createElement(
      "div",
      { "data-thread": props.threadId },
      createElement(
        "button",
        {
          onClick: () => props.onActivityChange({ editing: true, busy: false }),
          "data-action": "edit",
        },
        "Edit",
      ),
      createElement(
        "button",
        {
          onClick: () =>
            props.onActivityChange({ editing: false, busy: false }),
          "data-action": "finish",
        },
        "Finish",
      ),
      createElement(
        "button",
        {
          onClick: () => props.onActivityChange({ editing: true, busy: true }),
          "data-action": "upload",
        },
        "Upload",
      ),
      createElement(
        "button",
        {
          onClick: () => props.onSelectionChange(["source"]),
          "data-action": "select",
        },
        "Select",
      ),
    ),
}));
import { DesktopHubWindow } from "./window-client";

let root: Root;
let container: HTMLDivElement;
function snapshot(id: string, revision = 1): HubSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "session",
    accountId: "user",
    contextKey: id,
    revision,
    title: `Conversation ${id}`,
    phase: "active",
    data: {
      threadId: id,
      mode: "thread",
      workspaceId: "ws",
      workspaceName: "Workspace",
      activeCitationIndex: null,
      activeCitationMessageId: null,
      displayedCitations: [],
      threadCitations: [],
      artifactsRefreshKey: 0,
      workfilesRefreshKey: 0,
      initialSources: [],
      initialSourcesLoaded: true,
      activeSourceIds: [],
      activeSkillIds: [],
      activeMcpInstallIds: [],
      activeMcpToolIds: [],
      availableSkills: [],
      hubSkills: [],
      capabilityCatalog: null,
      disabledToolNames: [],
      previewArtifact: null,
    },
  };
}
async function emit(message: HubMessage) {
  await act(async () => state.listener?.(message));
}
async function click(action: string) {
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!
      .click();
  });
}
beforeEach(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(DesktopHubWindow)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it("registers the listener before requesting a snapshot and only shows the native window after applying it", async () => {
  expect(state.send).toHaveBeenCalledWith({
    kind: "ready",
    accountId: "user",
    protocolVersion: 1,
  });
  expect(state.action).not.toHaveBeenCalledWith("show");
  await emit({ kind: "snapshot", snapshot: snapshot("A") });
  expect(
    container.querySelector("[data-thread]")?.getAttribute("data-thread"),
  ).toBe("A");
  expect(state.action).toHaveBeenCalledWith("show");
  expect(state.send).toHaveBeenCalledWith({
    kind: "applied",
    sessionId: "session",
    contextKey: "A",
    revision: 1,
  });
});

it("uses one close control and returns Hub to main before destroying its window", async () => {
  await emit({ kind: "snapshot", snapshot: snapshot("A") });
  expect(
    container.querySelector('[aria-label="Return to conversation"]'),
  ).toBeNull();
  const closeButton = container.querySelector<HTMLButtonElement>(
    '[aria-label="Close Hub window"]',
  )!;
  expect(closeButton.title).toContain("return Hub to main window");
  await act(async () => closeButton.click());
  expect(state.send.mock.calls.some(([m]) => m.kind === "dock")).toBe(true);
  expect(state.action).not.toHaveBeenCalledWith("docked");
  await emit({ kind: "dock-applied", sessionId: "session" });
  expect(state.action).toHaveBeenCalledWith("docked");
});

it("follows a new conversation without keeping old content under the new title", async () => {
  await emit({ kind: "snapshot", snapshot: snapshot("A") });
  await emit({
    kind: "snapshot",
    snapshot: { ...snapshot("B", 2), phase: "transition" },
  });
  expect(container.querySelector("[data-thread]")).toBeNull();
  await emit({ kind: "snapshot", snapshot: snapshot("B", 3) });
  expect(
    container.querySelector("[data-thread]")?.getAttribute("data-thread"),
  ).toBe("B");
  await emit({ kind: "snapshot", snapshot: snapshot("A", 1) });
  expect(
    container.querySelector("[data-thread]")?.getAttribute("data-thread"),
  ).toBe("B");
});

it("retains the editing context until the form finishes, then follows the latest target", async () => {
  await emit({ kind: "snapshot", snapshot: snapshot("A") });
  await click("edit");
  await emit({ kind: "snapshot", snapshot: snapshot("B", 2) });
  await emit({ kind: "snapshot", snapshot: snapshot("C", 3) });
  expect(
    container.querySelector("[data-thread]")?.getAttribute("data-thread"),
  ).toBe("A");
  expect(container.textContent).toContain("Following paused");
  // Real dialogs render in portals outside the inert list; complete their form.
  const finish = container.querySelector<HTMLButtonElement>(
    '[data-action="finish"]',
  )!;
  await act(async () => {
    finish.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(
    container.querySelector("[data-thread]")?.getAttribute("data-thread"),
  ).toBe("C");
});

it("does not destroy a window whose upload is still in progress", async () => {
  await emit({ kind: "snapshot", snapshot: snapshot("A") });
  await click("upload");
  await emit({ kind: "close-requested" });
  expect(state.action).not.toHaveBeenCalledWith("close");
  expect(state.error).toHaveBeenCalled();
});

it("hides the old form immediately when the destination workspace starts loading", async () => {
  await emit({ kind: "snapshot", snapshot: snapshot("A") });
  await click("edit");
  await emit({
    kind: "snapshot",
    snapshot: {
      ...snapshot("B", 2),
      phase: "transition",
      targetWorkspaceId: "other-workspace",
    },
  });
  expect(document.documentElement.dataset.hubHidden).toBe("true");
  expect(
    container.querySelector("[data-thread]")?.closest("[hidden]"),
  ).not.toBeNull();
});

it("allows explicitly discarding an old-workspace form without allowing edits to that workspace", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await emit({ kind: "snapshot", snapshot: snapshot("A") });
  await click("edit");
  const destination = snapshot("B", 2);
  destination.data.workspaceId = "other-workspace";
  await emit({ kind: "snapshot", snapshot: destination });
  expect(document.documentElement.dataset.hubHidden).toBe("true");
  const discard = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Discard and follow",
  )!;
  await act(async () => discard.click());
  expect(
    container.querySelector("[data-thread]")?.getAttribute("data-thread"),
  ).toBe("B");
  expect(document.documentElement.dataset.hubHidden).toBeUndefined();
});

it("reports unconfirmed selections to the composer barrier and clears them only on acknowledgment", async () => {
  await emit({ kind: "snapshot", snapshot: snapshot("A") });
  await click("select");
  const sent = state.send.mock.calls
    .map(([m]) => m)
    .find((m) => m.kind === "command");
  expect(sent.command.contextKey).toBe("A");
  await emit({ kind: "barrier", id: "send-1" });
  expect(state.send).toHaveBeenLastCalledWith({
    kind: "barrier-result",
    id: "send-1",
    pending: true,
  });
  await emit({ kind: "result", id: sent.command.id });
  await emit({ kind: "barrier", id: "send-2" });
  expect(state.send).toHaveBeenLastCalledWith({
    kind: "barrier-result",
    id: "send-2",
    pending: false,
  });
});

it("removes all content when the peer snapshot has another account", async () => {
  await emit({ kind: "snapshot", snapshot: snapshot("A") });
  await emit({
    kind: "snapshot",
    snapshot: { ...snapshot("B", 2), accountId: "other" },
  });
  expect(container.querySelector("[data-thread]")).toBeNull();
  expect(container.textContent).toContain("account does not match");
});
