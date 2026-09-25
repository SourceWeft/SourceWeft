import assert from "node:assert/strict";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import { beforeAll, test } from "vitest";
import { connectorAdaptersReady } from "../../../connectors";
import type { ConnectorActionExecutionCursor } from "../../../connectors/agent-tool-idempotency";
import {
  buildAutoApprovedHitlResume,
  buildAutoApprovedHitlResumeDecisions,
  commandResumeFromHitlDecisions,
  commandResumeFromToolApprovalResume,
  shouldSilenceEmptyApprovalResume,
} from "./hitl-handler";

// Connector tools register through an async import-time side effect. The
// observability normalizer keys off that registry, so without awaiting it the
// connector cases below race the registration and see an unregistered tool.
beforeAll(async () => {
  await connectorAdaptersReady();
});

test("HITL sandbox active merge does not approve different command args", () => {
  assert.equal(
    buildAutoApprovedHitlResumeDecisions({
      connectorContext: {
        sandboxActionExecutionCursor: {
          refs: [
            {
              requestJson: { command: "npm test" },
              toolCallId: "call-approved-execute",
              toolName: AGENT_TOOL_NAMES.execute,
            },
          ],
          value: 0,
        },
      },
      hitlInterrupts: [
        {
          actionRequests: [
            {
              args: { command: "npm run build" },
              name: AGENT_TOOL_NAMES.execute,
            },
          ],
          reviewConfigs: [
            {
              actionName: AGENT_TOOL_NAMES.execute,
              allowedDecisions: ["approve", "edit", "reject"],
            },
          ],
        },
      ],
    }),
    null,
  );
});

test("HITL sandbox active merge auto-approves matching persisted binding without checkpoint tool calls", () => {
  assert.deepEqual(
    buildAutoApprovedHitlResume({
      connectorContext: {
        sandboxActionExecutionCursor: {
          refs: [
            {
              requestJson: { command: "npm test" },
              toolCallId: "call-approved-execute",
              toolName: AGENT_TOOL_NAMES.execute,
            },
          ],
          value: 0,
        },
      },
      hitlInterrupts: [
        {
          actionRequests: [
            {
              args: { command: "npm test" },
              name: AGENT_TOOL_NAMES.execute,
            },
          ],
          reviewConfigs: [
            {
              actionName: AGENT_TOOL_NAMES.execute,
              allowedDecisions: ["approve", "edit", "reject"],
            },
          ],
        },
      ],
    }),
    {
      decisions: [{ type: "approve" }],
    },
  );
});

test("DeepAgents resume input excludes SourceWeft connector execution metadata", () => {
  assert.deepEqual(
    commandResumeFromToolApprovalResume({
      decisions: [{ type: "approve" }],
      sourceweft: {
        connectorActions: [
          {
            actionRunId: "action_1",
            connectorId: "connector_1",
            toolName: "create_notion_page",
          },
        ],
      },
    }),
    {
      decisions: [{ type: "approve" }],
    },
  );
});

test("DeepAgents HITL duplicate connector interrupts auto-resume from approved execution refs", () => {
  const actionExecutionCursor: ConnectorActionExecutionCursor = {
    refs: [
      {
        actionRunId: "delete-action",
        connectorId: "connector-1",
        requestJson: { pageId: "placeholder-page" },
        toolName: "delete_notion_page",
      },
    ],
    value: 0,
  };
  const context = {
    actionExecutionCursor,
  };

  assert.deepEqual(
    buildAutoApprovedHitlResumeDecisions({
      connectorContext: context,
      hitlInterrupts: [
        {
          actionRequests: [
            {
              args: { pageId: "placeholder-page" },
              name: "delete_notion_page",
            },
          ],
          reviewConfigs: [
            {
              actionName: "delete_notion_page",
              allowedDecisions: ["approve", "reject"],
            },
          ],
        },
      ],
    }),
    [{ type: "approve" }],
  );
  assert.equal(context.actionExecutionCursor.value, 0);
  assert.equal(context.actionExecutionCursor.consumedActionRunIds, undefined);
});

test("DeepAgents HITL duplicate sandbox interrupt auto-resumes each approved args ref once", () => {
  assert.deepEqual(
    buildAutoApprovedHitlResumeDecisions({
      connectorContext: {
        sandboxActionExecutionCursor: {
          refs: [
            {
              requestJson: { command: "npm test" },
              toolCallId: "call-sandbox-execute-a",
              toolName: AGENT_TOOL_NAMES.execute,
            },
            {
              requestJson: { command: "npm test" },
              toolCallId: "call-sandbox-execute-b",
              toolName: AGENT_TOOL_NAMES.execute,
            },
          ],
          value: 0,
        },
      },
      hitlInterrupts: [
        {
          actionRequests: [
            {
              args: { command: "npm test" },
              name: AGENT_TOOL_NAMES.execute,
            },
            {
              args: { command: "npm test" },
              name: AGENT_TOOL_NAMES.execute,
            },
          ],
          reviewConfigs: [
            {
              actionName: AGENT_TOOL_NAMES.execute,
              allowedDecisions: ["approve", "edit", "reject"],
            },
          ],
        },
      ],
    }),
    [{ type: "approve" }, { type: "approve" }],
  );
});

test("DeepAgents HITL auto-resume matches approved refs when replay adds undefined optional args", () => {
  assert.deepEqual(
    buildAutoApprovedHitlResumeDecisions({
      connectorContext: {
        actionExecutionCursor: {
          refs: [
            {
              actionRunId: "create-action",
              connectorId: "connector-1",
              requestJson: {
                title: "测试",
                content: "这是一个占位页面。",
                parentPageId: "367dadfc-4a0b-8026-996a-f6fd70dc6043",
              },
              toolName: "create_notion_page",
            },
          ],
          value: 0,
        },
      },
      hitlInterrupts: [
        {
          actionRequests: [
            {
              args: {
                title: "测试",
                content: "这是一个占位页面。",
                parentPageId: "367dadfc-4a0b-8026-996a-f6fd70dc6043",
                dataSourceId: undefined,
                pageId: undefined,
              },
              name: "create_notion_page",
            },
          ],
          reviewConfigs: [
            {
              actionName: "create_notion_page",
              allowedDecisions: ["approve", "reject"],
            },
          ],
        },
      ],
    }),
    [{ type: "approve" }],
  );
});

test("DeepAgents HITL resume targets the persisted interrupt id when present", () => {
  assert.deepEqual(
    commandResumeFromToolApprovalResume({
      decisions: [{ type: "approve" }],
      sourceweft: {
        hitlInterruptId: "0123456789abcdef0123456789abcdef",
      },
    }),
    {
      "0123456789abcdef0123456789abcdef": {
        decisions: [{ type: "approve" }],
      },
    },
  );
});

test("DeepAgents sandbox HITL edit resume targets the persisted interrupt id", () => {
  assert.deepEqual(
    commandResumeFromToolApprovalResume({
      decisions: [
        {
          type: "edit",
          editedAction: {
            name: AGENT_TOOL_NAMES.execute,
            args: { command: "pnpm test" },
          },
        },
      ],
      sourceweft: {
        hitlInterruptId: "sandbox-interrupt-1",
      },
    }),
    {
      "sandbox-interrupt-1": {
        decisions: [
          {
            type: "edit",
            editedAction: {
              name: AGENT_TOOL_NAMES.execute,
              args: { command: "pnpm test" },
            },
          },
        ],
      },
    },
  );
});

test("DeepAgents auto-approved HITL resume targets the interrupt id when present", () => {
  assert.deepEqual(
    commandResumeFromHitlDecisions({
      decisions: [{ type: "approve" }],
      hitlInterruptId: "0123456789abcdef0123456789abcdef",
    }),
    {
      "0123456789abcdef0123456789abcdef": {
        decisions: [{ type: "approve" }],
      },
    },
  );
});

test("DeepAgents HITL auto-resume does not approve unmatched connector args", () => {
  assert.equal(
    buildAutoApprovedHitlResumeDecisions({
      connectorContext: {
        actionExecutionCursor: {
          refs: [
            {
              actionRunId: "delete-action",
              connectorId: "connector-1",
              requestJson: { pageId: "approved-page" },
              toolName: "delete_notion_page",
            },
          ],
          value: 0,
        },
      },
      hitlInterrupts: [
        {
          actionRequests: [
            {
              args: { pageId: "different-page" },
              name: "delete_notion_page",
            },
          ],
          reviewConfigs: [
            {
              actionName: "delete_notion_page",
              allowedDecisions: ["approve", "reject"],
            },
          ],
        },
      ],
    }),
    null,
  );
});

test("rejected approval resume can silence empty continuations", () => {
  assert.equal(
    shouldSilenceEmptyApprovalResume({
      assistantMessageId: "assistant-message-1",
      hasCompletedToolOutput: false,
      toolApprovalResume: {
        decisions: [{ type: "reject", message: "User rejected the action." }],
      },
    }),
    true,
  );
});

test("approval resume silence requires reject decision and existing assistant message", () => {
  assert.equal(
    shouldSilenceEmptyApprovalResume({
      assistantMessageId: "assistant-message-1",
      hasCompletedToolOutput: false,
      toolApprovalResume: {
        decisions: [{ type: "approve" }],
      },
    }),
    false,
  );
  assert.equal(
    shouldSilenceEmptyApprovalResume({
      assistantMessageId: "assistant-message-1",
      hasCompletedToolOutput: false,
      toolApprovalResume: {
        decisions: [
          {
            type: "edit",
            editedAction: {
              name: "delete_notion_page",
              args: { pageId: "page-1" },
            },
          },
        ],
      },
    }),
    false,
  );
  assert.equal(
    shouldSilenceEmptyApprovalResume({
      assistantMessageId: null,
      hasCompletedToolOutput: false,
      toolApprovalResume: {
        decisions: [{ type: "reject" }],
      },
    }),
    false,
  );
  assert.equal(
    shouldSilenceEmptyApprovalResume({
      assistantMessageId: "assistant-message-1",
      hasCompletedToolOutput: true,
      toolApprovalResume: {
        decisions: [{ type: "reject" }],
      },
    }),
    false,
  );
});
