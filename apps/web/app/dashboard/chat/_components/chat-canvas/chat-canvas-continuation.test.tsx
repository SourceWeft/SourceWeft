// @vitest-environment jsdom
import { createElement, useLayoutEffect, type ComponentProps } from "react";
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { click, mountWithIntl, unmountAll, withIntl } from "@/test/react";
import { ChatCanvas } from "./chat-canvas-root";
import type { AgentContinuationInputBuilder } from "./agent-run-continuation";

vi.mock("./composer", () => ({
  Composer: (props: {
    onRegisterContinuationInput?: (
      builder: AgentContinuationInputBuilder | null,
    ) => void;
    selectedSkillIds?: string[];
  }) => {
    const { onRegisterContinuationInput, selectedSkillIds } = props;
    useLayoutEffect(() => {
      onRegisterContinuationInput?.((content) => ({
        content,
        skillIds: selectedSkillIds,
        tools: {
          mcp: {
            enabled: true,
            installIds: ["mcp-current"],
            toolIds: ["tool-current"],
          },
        },
      }));
      return () => onRegisterContinuationInput?.(null);
    }, [onRegisterContinuationInput, selectedSkillIds]);
    return createElement("textarea", {
      defaultValue: "Unsent draft stays here",
    });
  },
}));
vi.mock("./message-list", () => ({
  MessageList: (props: {
    continuationDisabled: boolean;
    onContinueAgentRun?: () => void;
  }) =>
    createElement(
      "button",
      {
        disabled: props.continuationDisabled,
        onClick: props.onContinueAgentRun,
      },
      "continue-test",
    ),
}));
vi.mock("../local-conversation-status", () => ({
  useLocalOperationStatus: () => ({ blocked: false }),
}));
vi.mock("../../../../../lib/analytics-events", () => ({
  trackChatMessageSent: vi.fn(),
  trackSkillSelected: vi.fn(),
  trackSourceAttached: vi.fn(),
}));

afterEach(unmountAll);
test("continue sends an ordinary new message with current selections, without retry or clearing draft", async () => {
  const send = vi.fn(),
    retry = vi.fn(),
    resume = vi.fn(),
    selection = vi.fn();
  const props: ComponentProps<typeof ChatCanvas> = {
    mode: "thread",
    sourcesVisible: true,
    threadTitle: "Research",
    workspaceId: "workspace",
    onSendMessage: send,
    onRefreshLatest: retry,
    onResumeToolConfirmation: resume,
    selectedSkillIds: ["current-skill"],
    onSkillSelectionChange: selection,
  };
  const view = await mountWithIntl(createElement(ChatCanvas, props));
  assert.equal(send.mock.calls.length, 0);
  await click(view.container.querySelector("button")!);
  assert.equal(send.mock.calls.length, 1);
  const input = send.mock.calls[0]![0];
  assert.match(input.content, /unfinished work/);
  assert.deepEqual(input.skillIds, ["current-skill"]);
  assert.deepEqual(input.tools.mcp, {
    enabled: true,
    installIds: ["mcp-current"],
    toolIds: ["tool-current"],
  });
  assert.equal(input.command, undefined);
  assert.equal(input.invocation, undefined);
  assert.equal(
    retry.mock.calls.length +
      resume.mock.calls.length +
      selection.mock.calls.length,
    0,
  );
  assert.equal(
    view.container.querySelector("textarea")?.value,
    "Unsent draft stays here",
  );
  for (const patch of [
    { activeThreadRun: { idempotencyKey: "running", status: "running" as const } },
    { isStreaming: true },
    { isStopping: true },
    { isEditing: true },
    { otherUserRunActive: true },
    { onSendMessage: undefined },
  ]) {
    await view.render(
      withIntl(createElement(ChatCanvas, { ...props, ...patch })),
    );
    assert.equal(view.container.querySelector("button")?.disabled, true);
    await click(view.container.querySelector("button")!);
  }
  assert.equal(send.mock.calls.length, 1);
});
