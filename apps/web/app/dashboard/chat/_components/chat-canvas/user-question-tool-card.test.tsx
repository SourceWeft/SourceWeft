import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { AssistantToolCard } from "./assistant-tool-card";
import { getAssistantToolTitle } from "./assistant-tool-display";
import type { ToolCallRecord } from "./types";

const questions = [{ question: "Which format?", type: "text" as const }];
const interrupt = JSON.stringify([
  {
    id: "internal-interrupt-id",
    value: {
      type: "ask_user",
      toolCallId: "question-1",
      questions,
    },
  },
]);

function questionCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: "question-1",
    tool: "askUser",
    status: "approval_requested",
    input: { questions },
    latencyMs: 0,
    error: interrupt,
    output: {
      type: "user_question_request",
      schemaVersion: 1,
      id: "internal-request-id",
      toolCallId: "question-1",
      questions,
    },
    ...overrides,
  };
}
function render(toolCall: ToolCallRecord) {
  return renderToStaticMarkup(
    createElement(AssistantToolCard, { toolCall, defaultOpen: true }),
  );
}

test("a pending question uses neutral question copy and readable content instead of approval/error internals", () => {
  const html = render(questionCall());
  assert.match(html, /Asking question/);
  assert.match(html, /Waiting for your answer/);
  assert.match(html, /Which format\?/);
  for (const hidden of [
    "AskUser",
    "Needs approval",
    "approval_requested",
    "internal-interrupt-id",
    "internal-request-id",
    "text-destructive",
    "text-amber",
    "0ms",
  ]) {
    assert.ok(!html.includes(hidden), `should not render ${hidden}`);
  }
});

test("the transient GraphInterrupt error is a neutral pause only for the matching question", () => {
  const paused = render(questionCall({ status: "error", output: null }));
  assert.match(paused, /Waiting for your answer/);
  assert.ok(!paused.includes("text-destructive"));
  const failed = render(
    questionCall({ id: "different-call", status: "error", output: null }),
  );
  assert.match(failed, /text-destructive/);
  assert.ok(!failed.includes("Waiting for your answer"));
});

test("a saved Command answer renders the question transcript and completed Codex-style summary", () => {
  const toolCall = questionCall({
    status: "completed",
    error: null,
    output: {
      lg_name: "Command",
      update: {
        messages: [
          {
            lc: 1,
            type: "constructor",
            kwargs: {
              tool_call_id: "question-1",
              name: "askUser",
              content: "Q: Which format?\nA: PDF",
            },
          },
        ],
      },
      goto: [],
    },
  });
  const html = render(toolCall);
  assert.equal(getAssistantToolTitle(toolCall), "Asked 1 question");
  assert.match(html, /Asked 1 question/);
  assert.match(html, /Q: Which format\?/);
  assert.match(html, /A: PDF/);
  for (const hidden of [
    "Waiting for your answer",
    "lg_name",
    "tool_call_id",
    "text-destructive",
  ])
    assert.ok(!html.includes(hidden));
});

test("multiple and unanswered questions use readable neutral history labels", () => {
  const toolCall = questionCall({
    status: "completed",
    error: null,
    input: {
      questions: [...questions, { question: "Which language?", type: "text" }],
    },
    output:
      "Q: Which format?\nA: (cancelled)\n\nQ: Which language?\nA: (cancelled)",
  });
  const html = render(toolCall);
  assert.match(html, /Asked 2 questions/);
  assert.match(html, /No answer provided/);
  assert.ok(!html.includes("text-destructive"));
  assert.ok(!html.includes("(cancelled)"));
});

test("an actual question failure remains visible as a failure", () => {
  const html = render(
    questionCall({
      status: "error",
      output: null,
      error: "Question delivery failed",
    }),
  );
  assert.match(html, /Question delivery failed/);
  assert.match(html, /text-destructive/);
  assert.ok(!html.includes("Waiting for your answer"));
});
