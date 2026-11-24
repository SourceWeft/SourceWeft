// @vitest-environment jsdom
import { createElement, type ComponentProps } from "react";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { mountWithIntl, unmountAll, withIntl } from "@/test/react";
import { ChatCanvas } from "./chat-canvas-root";

type ComposerProps = {
  onStopStreaming?: () => void;
  stopPending?: boolean;
  submitDisabled?: boolean;
};

const composerProps = vi.hoisted(() => ({
  current: null as ComposerProps | null,
}));

vi.mock("./composer", () => ({
  Composer: (props: ComposerProps) => {
    composerProps.current = props;
    return null;
  },
}));
// The new-chat page renders its composer through EmptyState with the same
// run-control props; capture them there (its layout needs a real browser).
vi.mock("./empty-state", () => ({
  EmptyState: (props: ComposerProps) => {
    composerProps.current = props;
    return null;
  },
}));
const listProps = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));
vi.mock("./message-list", () => ({
  MessageList: (props: Record<string, unknown>) => {
    listProps.current = props;
    return null;
  },
}));
const barItems = vi.hoisted(() => ({
  tool: undefined as unknown,
  question: undefined as unknown,
}));
vi.mock("./tool-confirmation", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ToolInterventionBar: (props: { items?: unknown }) => {
    barItems.tool = props.items;
    return null;
  },
}));
vi.mock("./user-question-panel", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  UserQuestionInterventionBar: (props: { items?: unknown }) => {
    barItems.question = props.items;
    return null;
  },
}));
vi.mock("../local-conversation-status", () => ({
  useLocalOperationStatus: () => ({ blocked: false }),
}));
vi.mock("../../../../../lib/analytics-events", () => ({
  trackChatMessageSent: vi.fn(),
  trackSkillSelected: vi.fn(),
  trackSourceAttached: vi.fn(),
}));

beforeEach(() => {
  composerProps.current = null;
  listProps.current = null;
  barItems.tool = undefined;
  barItems.question = undefined;
});
afterEach(unmountAll);

const stop = vi.fn();
const threadProps: ComponentProps<typeof ChatCanvas> = {
  mode: "thread",
  sourcesVisible: true,
  threadTitle: "Research",
  workspaceId: "workspace",
  onSendMessage: vi.fn(),
  onStopStreaming: stop,
};
const ourRun = {
  idempotencyKey: "run-key",
  status: "running" as const,
  userId: "user-1",
};

function composer() {
  assert.ok(composerProps.current, "composer rendered");
  return composerProps.current;
}

test("the thread composer shows a pending Stop and blocks submit while the active run is unknown", async () => {
  const view = await mountWithIntl(
    createElement(ChatCanvas, {
      ...threadProps,
      activeRunLookupPending: true,
      chatExecutionState: "idle",
    }),
  );
  assert.equal(composer().stopPending, true);
  // The pending Stop is inert: no stop handler, and Send stays blocked.
  assert.equal(composer().onStopStreaming, undefined);
  assert.equal(composer().submitDisabled, true);

  // Lookup found our run: the pending Stop becomes the real Stop.
  await view.render(
    withIntl(
      createElement(ChatCanvas, {
        ...threadProps,
        activeRunLookupPending: false,
        activeThreadRun: ourRun,
        chatExecutionState: "executing",
      }),
    ),
  );
  assert.equal(composer().stopPending, false);
  assert.equal(composer().onStopStreaming, stop);
  assert.equal(composer().submitDisabled, false);
});

test("the thread composer offers Send once the lookup finds no active run", async () => {
  await mountWithIntl(
    createElement(ChatCanvas, {
      ...threadProps,
      activeRunLookupPending: false,
      chatExecutionState: "idle",
    }),
  );
  assert.equal(composer().stopPending, false);
  assert.equal(composer().onStopStreaming, undefined);
  assert.equal(composer().submitDisabled, false);
});

test("another member's run is followed without a Stop, as before", async () => {
  await mountWithIntl(
    createElement(ChatCanvas, {
      ...threadProps,
      activeRunLookupPending: false,
      activeThreadRun: { ...ourRun, userId: "user-2" },
      chatExecutionState: "executing",
      otherUserRunActive: true,
    }),
  );
  assert.equal(composer().stopPending, false);
  assert.equal(composer().onStopStreaming, undefined);
  assert.equal(composer().submitDisabled, false);
});

test("the new-chat composer has no lookup and offers Send immediately", async () => {
  await mountWithIntl(
    createElement(ChatCanvas, {
      ...threadProps,
      mode: "new",
    }),
  );
  assert.equal(composer().stopPending ?? false, false);
  assert.equal(composer().onStopStreaming, undefined);
  assert.equal(composer().submitDisabled, false);
});

test("a conversation that takes no messages shows its notice instead of the composer", async () => {
  const view = await mountWithIntl(
    createElement(ChatCanvas, {
      ...threadProps,
      activeRunLookupPending: false,
      chatExecutionState: "idle",
      composerNotice: createElement("p", { "data-testid": "notice" }, "No"),
    }),
  );
  assert.equal(composerProps.current, null);
  assert.ok(view.container.querySelector('[data-testid="notice"]'));
  // Every other way to start a turn is withdrawn too: the server refuses
  // them all in such a conversation.
  assert.ok(listProps.current);
  assert.equal(listProps.current.onContinueAgentRun, undefined);
  assert.equal(listProps.current.onRefreshLatest, undefined);
  assert.equal(listProps.current.onRestartFromMessage, undefined);
  // ...and the Edit prompt pencil is not even shown.
  assert.equal(listProps.current.readOnly, true);
  assert.deepEqual(barItems.tool, []);
  assert.deepEqual(barItems.question, []);
});

test("an ordinary conversation keeps continue, refresh and restart", async () => {
  await mountWithIntl(
    createElement(ChatCanvas, {
      ...threadProps,
      activeRunLookupPending: false,
      chatExecutionState: "idle",
      onRefreshLatest: vi.fn(),
      onRestartFromMessage: vi.fn(),
    }),
  );
  assert.ok(listProps.current);
  assert.equal(typeof listProps.current.onContinueAgentRun, "function");
  assert.equal(typeof listProps.current.onRefreshLatest, "function");
  assert.equal(typeof listProps.current.onRestartFromMessage, "function");
  assert.equal(listProps.current.readOnly, false);
});
