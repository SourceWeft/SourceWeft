import assert from "node:assert/strict";
import { test } from "vitest";

import type { MessageRenderState } from "./message-render-state";
import {
  isRunErrorCoveredByToolCard,
  shouldShowRunErrorBanner,
} from "./run-error-display";

type RunErrorState = Pick<MessageRenderState, "error" | "activityItems">;

function toolItem(input: { status: string; error?: string | null }) {
  return {
    id: "call-1",
    key: "call-1",
    order: 0,
    type: "tool" as const,
    toolCall: {
      id: "call-1",
      tool: "run_sandbox",
      status: input.status,
      error: input.error ?? null,
    },
  };
}

function renderState(input: {
  error?: RunErrorState["error"];
  activityItems?: unknown[];
}): RunErrorState {
  return {
    error: input.error ?? null,
    activityItems: (input.activityItems ??
      []) as RunErrorState["activityItems"],
  };
}

test("no banner when there is no error", () => {
  assert.equal(
    shouldShowRunErrorBanner({
      hasActiveRunOnThisGroup: false,
      isStreamingThisVersion: false,
      renderState: renderState({ error: null }),
    }),
    false,
  );
});

test("shows banner for a terminal error with no covering tool card", () => {
  assert.equal(
    shouldShowRunErrorBanner({
      hasActiveRunOnThisGroup: false,
      isStreamingThisVersion: false,
      renderState: renderState({ error: { message: "Model error" } }),
    }),
    true,
  );
});

test("suppresses banner while this version is still streaming (no red flash)", () => {
  assert.equal(
    shouldShowRunErrorBanner({
      hasActiveRunOnThisGroup: false,
      isStreamingThisVersion: true,
      renderState: renderState({ error: { message: "Model error" } }),
    }),
    false,
  );
});

test("suppresses banner while a new run is in flight on this group", () => {
  assert.equal(
    shouldShowRunErrorBanner({
      hasActiveRunOnThisGroup: true,
      isStreamingThisVersion: false,
      renderState: renderState({ error: { message: "Stale error" } }),
    }),
    false,
  );
});

test("suppresses banner when a failed tool card already shows the error", () => {
  const state = renderState({
    error: { message: "Sandbox command failed" },
    activityItems: [
      toolItem({ status: "error", error: "Sandbox command failed" }),
    ],
  });
  assert.equal(isRunErrorCoveredByToolCard(state), true);
  assert.equal(
    shouldShowRunErrorBanner({
      hasActiveRunOnThisGroup: false,
      isStreamingThisVersion: false,
      renderState: state,
    }),
    false,
  );
});

test("still shows banner when the failed tool error differs from the run error", () => {
  const state = renderState({
    error: { message: "The model stopped unexpectedly" },
    activityItems: [toolItem({ status: "error", error: "File not found" })],
  });
  assert.equal(isRunErrorCoveredByToolCard(state), false);
  assert.equal(
    shouldShowRunErrorBanner({
      hasActiveRunOnThisGroup: false,
      isStreamingThisVersion: false,
      renderState: state,
    }),
    true,
  );
});

test("does not treat a succeeded tool call (no error) as covering the run error", () => {
  const state = renderState({
    error: { message: "Sandbox command failed" },
    activityItems: [toolItem({ status: "done", error: null })],
  });
  assert.equal(isRunErrorCoveredByToolCard(state), false);
});

test("covers a failed deliverable tool that carries the error despite non-error status", () => {
  // Deliverable tools fail via generation status, not toolCall.status, but the
  // pipeline/card still shows the same message off toolCall.error.
  const state = renderState({
    error: {
      message:
        "Generated Remotion project dependency install failed: pnpm not found",
    },
    activityItems: [
      toolItem({
        status: "completed",
        error:
          "Generated Remotion project dependency install failed: pnpm not found",
      }),
    ],
  });
  assert.equal(isRunErrorCoveredByToolCard(state), true);
  assert.equal(
    shouldShowRunErrorBanner({
      hasActiveRunOnThisGroup: false,
      isStreamingThisVersion: false,
      renderState: state,
    }),
    false,
  );
});
