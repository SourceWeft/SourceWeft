// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";

const hook = vi.hoisted(() => ({ useScheduledRunForThread: vi.fn() }));
vi.mock("../../../../../lib/scheduled-tasks", () => hook);
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));

import { ScheduledRunNotice, runProblem } from "./scheduled-run-notice";
import { mountWithIntl, unmountAll } from "@/test/react";

const run = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  status: "succeeded",
  detail: null,
  ...over,
});

afterEach(async () => {
  await unmountAll();
  vi.clearAllMocks();
});

test("a run that ended badly is named in plain words and a good one is not", () => {
  expect(runProblem(run({ status: "failed" }) as never)).toBe("failed");
  expect(
    runProblem(run({ status: "failed", detail: "timed_out" }) as never),
  ).toBe("timedOut");
  expect(
    runProblem(run({ status: "queued", detail: "needs_approval" }) as never),
  ).toBe("needsApproval");
  expect(runProblem(run({ status: "cancelled" }) as never)).toBe("cancelled");
  expect(runProblem(run() as never)).toBeNull();
});

test("a failed run shows an alert with the task name and a link to the task", async () => {
  hook.useScheduledRunForThread.mockReturnValue({
    data: {
      run: run({ status: "failed" }),
      task: { id: "t1", name: "Digest" },
    },
  });
  await mountWithIntl(
    <ScheduledRunNotice workspaceId="ws_1" threadId="th_1" />,
  );
  const alert = document.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("This scheduled run did not finish.");
  expect(alert.textContent).toContain("Digest");
  expect(alert.querySelector("a")!.getAttribute("href")).toBe(
    "/dashboard/scheduled/t1",
  );
});

test("a finished run only says where it came from, and nothing shows before it loads", async () => {
  hook.useScheduledRunForThread.mockReturnValue({
    data: { run: run(), task: { id: "t1", name: "Digest" } },
  });
  await mountWithIntl(
    <ScheduledRunNotice workspaceId="ws_1" threadId="th_1" />,
  );
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.querySelector('[role="status"]')!.textContent).toContain(
    "Digest",
  );
  await unmountAll();
  hook.useScheduledRunForThread.mockReturnValue({ data: undefined });
  await mountWithIntl(
    <ScheduledRunNotice workspaceId="ws_1" threadId="th_1" />,
  );
  expect(document.body.textContent).toBe("");
});
