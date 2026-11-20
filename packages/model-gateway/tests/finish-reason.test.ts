import assert from "node:assert/strict";
import test from "node:test";
import { truncatedToolCallMessageError } from "../src/bridge/stream-guards";
import { finishReasonFromResponseMetadata } from "../src/index";

test("a chat/completions finish reason is returned as reported, in either spelling", () => {
  for (const reason of ["stop", "length", "tool_calls", "content_filter"]) {
    assert.equal(
      finishReasonFromResponseMetadata({ finish_reason: reason }),
      reason,
    );
    assert.equal(
      finishReasonFromResponseMetadata({ finishReason: reason }),
      reason,
    );
  }
  // A reported reason wins over a Responses status on the same record.
  assert.equal(
    finishReasonFromResponseMetadata({
      finish_reason: "tool_calls",
      object: "response",
      status: "completed",
    }),
    "tool_calls",
  );
});

test("a Responses API status is named the way LangChain names it", () => {
  const response = (fields: Record<string, unknown>) => ({
    object: "response",
    ...fields,
  });
  assert.equal(
    finishReasonFromResponseMetadata(response({ status: "completed" })),
    "stop",
  );
  for (const reason of ["max_output_tokens", "content_filter"]) {
    assert.equal(
      finishReasonFromResponseMetadata(
        response({ status: "incomplete", incomplete_details: { reason } }),
      ),
      "length",
    );
  }
  for (const status of ["in_progress", "queued", "failed", "cancelled", 1]) {
    assert.equal(
      finishReasonFromResponseMetadata(response({ status })),
      undefined,
    );
  }
});

test("a status on anything other than a Responses API reply is not a finish reason", () => {
  assert.equal(
    finishReasonFromResponseMetadata({ status: "incomplete" }),
    undefined,
  );
  assert.equal(
    finishReasonFromResponseMetadata({
      object: "chat.completion",
      status: "completed",
    }),
    undefined,
  );
  for (const value of [undefined, null, "length", ["length"], {}]) {
    assert.equal(finishReasonFromResponseMetadata(value), undefined);
  }
});

test("a Responses API reply cut in the middle of a tool call is a truncated tool call", () => {
  const target = { provider: "p", providerModel: "m" };
  const cut = {
    response_metadata: {
      object: "response",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    },
  };
  assert.equal(
    truncatedToolCallMessageError(
      { ...cut, tool_calls: [{ id: "c", name: "lookup", args: { q: "x" } }] },
      target,
    )?.code,
    "OUTPUT_TRUNCATED",
  );
  assert.equal(
    truncatedToolCallMessageError(
      { ...cut, invalid_tool_calls: [{ name: "lookup", args: '{"q' }] },
      target,
    )?.code,
    "OUTPUT_TRUNCATED",
  );
  // Cut text is delivered; a completed reply with a tool call is not cut.
  assert.equal(
    truncatedToolCallMessageError({ ...cut, content: "cut sho" }, target),
    undefined,
  );
  assert.equal(
    truncatedToolCallMessageError(
      {
        response_metadata: { object: "response", status: "completed" },
        tool_calls: [{ id: "c", name: "lookup", args: { q: "x" } }],
      },
      target,
    ),
    undefined,
  );
});
