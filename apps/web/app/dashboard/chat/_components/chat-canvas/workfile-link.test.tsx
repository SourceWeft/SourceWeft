// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { expect, test, vi } from "vitest";
import { resolveWorkfileLink } from "./workfile-link";
import { CitationAwareMessageResponse } from "./message-response";
import messages from "@/messages/en.json";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test("virtual workfile links reject external URLs, traversal and ambiguous encoding", () => {
  expect(resolveWorkfileLink("/files/a%20b.txt")).toBe("/files/a b.txt");
  for (const path of [
    "https://example.com/files/a.txt",
    "//example.com/files/a.txt",
    "javascript:alert(1)",
    "/files/../secret",
    "/files/%2e%2e/secret",
    "/files/%252e%252e/secret",
    "/files/a%5cb",
    "/files/%00a",
    "/files/",
    "/files/%GG",
  ]) {
    expect(resolveWorkfileLink(path)).toBeNull();
  }
});

test("real Markdown workfile links open the conversation preview and keep the link label", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const open = vi.fn();
  try {
    await act(async () =>
      root.render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <CitationAwareMessageResponse citations={[]} onWorkfileClick={open}>
            {
              "[Preview report](/files/report.html) and [External](https://example.com/files/report.html)"
            }
          </CitationAwareMessageResponse>
        </NextIntlClientProvider>,
      ),
    );
    const preview = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Preview report",
    );
    expect(preview).toBeDefined();
    await act(async () => preview!.click());
    expect(open).toHaveBeenCalledExactlyOnceWith("/files/report.html");
    expect(host.querySelector('a[href="/files/report.html"]')).toBeNull();
    expect(
      host.querySelector('a[href="https://example.com/files/report.html"]'),
    ).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

test("same-origin absolute links open private preview without changing the SSR element", async () => {
  const href = `${window.location.origin}/files/nested/report%20中文.txt`;
  expect(resolveWorkfileLink(href, window.location.origin)).toBe(
    "/files/nested/report 中文.txt",
  );
  expect(
    resolveWorkfileLink(
      `${window.location.origin}.example.com/files/a`,
      window.location.origin,
    ),
  ).toBeNull();
  const host = document.createElement("div");
  const root = createRoot(host);
  const open = vi.fn();
  try {
    await act(async () =>
      root.render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <CitationAwareMessageResponse
            citations={[]}
            onWorkfileClick={open}
          >{`[Report](${href})`}</CitationAwareMessageResponse>
        </NextIntlClientProvider>,
      ),
    );
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      host.querySelector("a")!.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledExactlyOnceWith(
      "/files/nested/report 中文.txt",
    );
  } finally {
    await act(async () => root.unmount());
  }
});
