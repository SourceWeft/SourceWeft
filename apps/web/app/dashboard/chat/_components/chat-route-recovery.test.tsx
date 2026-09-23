// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, expect, test, vi } from "vitest";
import messages from "@/messages/en.json";
const api = vi.hoisted(() => ({ getActiveThreadRun: vi.fn(), stop: vi.fn() }));
vi.mock("@/lib/sdk", () => ({
  contentClient: { getActiveThreadRun: api.getActiveThreadRun },
}));
vi.mock("@/lib/stop-thread-run", () => ({ requestThreadRunStop: api.stop }));
vi.mock("@/lib/auth-client", () => ({ authClient: {} }));
vi.mock("../../_components/dashboard-chat-state", () => ({
  useDashboardChatState: vi.fn(),
}));
import { RecoveryRunControl } from "./chat-route-recovery";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => vi.resetAllMocks());
async function mount() {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <RecoveryRunControl workspaceId="w" threadId="t" userId="me" />
      </NextIntlClientProvider>,
    ),
  );
  return {
    host,
    close: () => act(async () => root.unmount()),
    button: (label: string) =>
      Array.from(host.querySelectorAll("button")).find(
        (button) => button.textContent === label,
      ),
  };
}
test("recovery stops the exact owned durable run once, without resending a prompt", async () => {
  api.getActiveThreadRun.mockResolvedValue({
    threadRun: { userId: "me", idempotencyKey: "run-key", status: "running" },
  });
  api.stop.mockResolvedValue({ ok: true });
  const view = await mount();
  try {
    expect(api.getActiveThreadRun).toHaveBeenCalledWith("w", "t");
    await act(async () => {
      view.button("Stop generation")!.click();
      view.button("Stop generation")?.click();
    });
    expect(api.stop).toHaveBeenCalledExactlyOnceWith("w", "t", "run-key");
    expect(view.host.textContent).toContain("Generation stopped.");
    expect(view.button("Stop generation")).toBeUndefined();
  } finally {
    await view.close();
  }
});
test("another participant's run cannot be stopped from recovery", async () => {
  api.getActiveThreadRun.mockResolvedValue({
    threadRun: {
      userId: "other",
      idempotencyKey: "run-key",
      status: "running",
    },
  });
  const view = await mount();
  try {
    expect(view.button("Stop generation")).toBeUndefined();
    expect(api.stop).not.toHaveBeenCalled();
  } finally {
    await view.close();
  }
});
test("stop failure keeps an actionable retry and does not claim success", async () => {
  api.getActiveThreadRun.mockResolvedValue({
    threadRun: { userId: "me", idempotencyKey: "run-key", status: "running" },
  });
  api.stop.mockResolvedValue({ ok: false });
  const view = await mount();
  try {
    await act(async () => view.button("Stop generation")!.click());
    expect(view.host.textContent).toContain("Unable to stop generation");
    expect(view.button("Stop generation")?.disabled).toBe(false);
  } finally {
    await view.close();
  }
});
test("status failure permits another check and a finished run offers no stop", async () => {
  api.getActiveThreadRun
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ threadRun: null });
  const view = await mount();
  try {
    expect(view.host.textContent).toContain(
      "Unable to check generation status",
    );
    await act(async () => view.button("Check generation status")!.click());
    expect(view.host.textContent).not.toContain("Unable to check");
    expect(view.button("Stop generation")).toBeUndefined();
  } finally {
    await view.close();
  }
});
