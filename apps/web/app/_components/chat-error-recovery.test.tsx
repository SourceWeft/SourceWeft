// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { expect, it, vi } from "vitest";
import { MessageRenderBoundary } from "./chat-error-recovery";
import messages from "../../messages/en.json";

it("isolates a render failure, retries without replacing sibling controls, and recovers on conversation change", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let broken = true;
  function Messages() {
    if (broken)
      throw new Error("private message must not appear in recovery UI");
    return <p>Conversation loaded</p>;
  }
  const render = (id: string) => (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <MessageRenderBoundary key={id}>
        <Messages />
      </MessageRenderBoundary>
      <textarea aria-label="Draft" defaultValue="Keep my draft" />
      <button>Stop</button>
    </NextIntlClientProvider>
  );
  try {
    await act(async () => root.render(render("a")));
    const draft = host.querySelector("textarea");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain("private message");
    expect(host.textContent).toContain("Stop");
    broken = false;
    await act(async () => host.querySelector("button")!.click());
    expect(host.textContent).toContain("Conversation loaded");
    expect(host.querySelector("textarea")).toBe(draft);
    expect(draft?.value).toBe("Keep my draft");
    broken = true;
    await act(async () => root.render(render("a")));
    broken = false;
    await act(async () => root.render(render("b")));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain("Conversation loaded");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    log.mockRestore();
  }
});
