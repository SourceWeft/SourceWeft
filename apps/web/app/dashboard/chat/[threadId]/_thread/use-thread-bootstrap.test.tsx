// @vitest-environment jsdom
import {
  act,
  createElement,
  StrictMode,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../../../messages/en.json";
import { useThreadBootstrap } from "./use-thread-bootstrap";

const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];
const withIntl = (node: ReactNode) => (
  <NextIntlClientProvider locale="en" messages={intlMessages}>
    {node}
  </NextIntlClientProvider>
);
import {
  setPendingThreadTurn,
  readPendingThreadTurn,
  clearPendingThreadTurn,
} from "../../_components/pending-thread-turn";

const state = vi.hoisted(() => ({
  ready: false,
  message: "Checking the computer connection…" as string | null,
}));
vi.mock("../../_components/local-conversation-status", () => ({
  useLocalConversationStatus: () => state,
}));
vi.mock("../../_components/chat-canvas", () => ({
  normalizeComposerOptionsState: (v: unknown) => v,
}));
let root: Root;
let host: HTMLDivElement;
let result: ReturnType<typeof useThreadBootstrap>;
const send = vi.fn();
const load = vi.fn();
const persist = vi.fn();
const noop = vi.fn();
function Harness({ threadId = "first" }: { threadId?: string }) {
  const bootstrappedThreadKeyRef = useRef<string | null>(null);
  const loadThreadMessagesRef = useRef(load);
  result = useThreadBootstrap({
    userId: "user",
    workspaceId: "workspace",
    threadId,
    bootstrappedThreadKeyRef,
    loadThreadMessagesRef,
    persistActiveSourceIds: persist,
    streamThreadAction: send,
    setActiveSkillIds: noop,
    setAvailableModels: noop,
    setBaseSelectedModels: noop,
    setCatalogKindEnabled: noop,
    setComposerOptions: noop,
    setHasSavedThinkingPreference: noop,
    setModelSelectionSources: noop,
    setSearchEnabled: noop,
    setSelectedByokModels: noop,
    setSelectedModels: noop,
    setStreamWithSelectedLlm: noop,
    setThinkingSettings: noop,
  });
  return null;
}
const turn = {
  content: "first message",
  sourceIds: ["source"],
  userId: "user",
  workspaceId: "workspace",
  images: [
    {
      dataUrl: "data:image/png;base64,AA==",
      mimeType: "image/png" as const,
      fileName: "test.png",
    },
  ],
};
async function render(threadId = "first") {
  await act(async () =>
    root.render(
      withIntl(
        createElement(StrictMode, null, createElement(Harness, { threadId })),
      ),
    ),
  );
}
beforeEach(() => {
  state.ready = false;
  state.message = "Checking the computer connection…";
  sessionStorage.clear();
  clearPendingThreadTurn("first");
  clearPendingThreadTurn("second");
  send.mockReset().mockImplementation(async (input) => input.onAccepted());
  load.mockReset().mockResolvedValue(undefined);
  persist.mockReset().mockResolvedValue(true);
  host = document.createElement("div");
  root = createRoot(host);
  setPendingThreadTurn("first", turn);
});
afterEach(async () => {
  await act(async () => root.unmount());
});
test("initial checking loads history without consuming payload, then sends once with current callback", async () => {
  await render();
  expect(load).toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(readPendingThreadTurn("first")?.images).toEqual(turn.images);
  state.ready = true;
  state.message = null;
  await render();
  await render();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0]).toMatchObject({
    content: turn.content,
    images: turn.images,
  });
  expect(readPendingThreadTurn("first")).toBeNull();
});
test("unavailable preserves payload and requires explicit retry after reconnect", async () => {
  state.message = "Computer offline";
  await render();
  expect(result.recovery?.message).toBe("Computer offline");
  state.ready = true;
  state.message = null;
  await render();
  expect(send).not.toHaveBeenCalled();
  await act(async () => result.retry());
  expect(send).toHaveBeenCalledTimes(1);
});
test("unconfirmed request is retained across remount and retries with the same key", async () => {
  state.ready = true;
  state.message = null;
  send.mockResolvedValue(undefined);
  await render();
  const key = send.mock.calls[0]![0].durableRunKey;
  expect(key).toMatch(/^sourceweft-web-run:/);
  expect(result.recovery).not.toBeNull();
  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
  expect(send).toHaveBeenCalledTimes(1);
  await act(async () => result.retry());
  expect(send.mock.calls[1]![0].durableRunKey).toBe(key);
  expect(readPendingThreadTurn("first")?.images).toEqual(turn.images);
});
test("source preparation failure keeps first message and exits loading through history", async () => {
  persist.mockResolvedValue(false);
  state.ready = true;
  await render();
  expect(load).toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(result.recovery?.turn.content).toBe(turn.content);
});
test("late preparation cannot dispatch into a different thread", async () => {
  let finish!: (v: boolean) => void;
  persist.mockImplementationOnce(
    () =>
      new Promise<boolean>((r) => {
        finish = r;
      }),
  );
  state.ready = true;
  await render();
  await render("second");
  await act(async () => finish(true));
  expect(send).not.toHaveBeenCalled();
  expect(readPendingThreadTurn("first")).not.toBeNull();
});
test("a pending turn from a different account is never sent", async () => {
  setPendingThreadTurn("first", { ...turn, userId: "someone-else" });
  state.ready = true;
  await render();
  expect(send).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalled();
});
