// @vitest-environment jsdom
import { createElement } from "react";
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { AgentRunStopNotice } from "./agent-run-stop-notice";
import { click, mountWithIntl, unmountAll, withIntl } from "@/test/react";

afterEach(unmountAll);
const stop = {
  reason: "step_limit",
  steps: 400,
  limit: 400,
  canContinue: true,
  summaryStatus: "completed",
} as const;

test("continuation requires an explicit enabled click and never auto-runs on render", async () => {
  const send = vi.fn();
  const view = await mountWithIntl(
    createElement(AgentRunStopNotice, { stop, onContinue: send }),
  );
  assert.equal(send.mock.calls.length, 0);
  const button = view.container.querySelector("button")!;
  assert.equal(button.textContent?.trim(), "Continue remaining work");
  await click(button);
  assert.equal(send.mock.calls.length, 1);
  await view.render(
    withIntl(
      createElement(AgentRunStopNotice, {
        stop,
        onContinue: send,
        disabled: true,
      }),
    ),
  );
  await click(view.container.querySelector("button")!);
  assert.equal(send.mock.calls.length, 1);
});

test("failed-summary and read-only states remain explicit without a delivered-success claim", async () => {
  const view = await mountWithIntl(
    createElement(AgentRunStopNotice, {
      stop: { ...stop, summaryStatus: "failed" },
    }),
  );
  assert.match(view.container.textContent ?? "", /summary failed/);
  assert.doesNotMatch(
    view.container.textContent ?? "",
    /report.*delivered|successfully completed/i,
  );
  assert.equal(view.container.querySelector("button")?.disabled, true);
});
