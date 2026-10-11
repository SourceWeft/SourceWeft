// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  button,
  click,
  flush,
  mountWithIntl,
  typeInto,
  unmountAll,
} from "@/test/react";

const api = vi.hoisted(() => ({ submitMcp: vi.fn() }));
vi.mock("../../../../lib/market-submit", () => api);
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const analytics = vi.hoisted(() => ({ trackBadgeSnippetCopied: vi.fn() }));
vi.mock("../../../../lib/analytics-events", () => analytics);

import { SubmitMcpDialog } from "./submit-mcp-dialog";

const writeText = vi.fn();
const badge = () =>
  document.body.querySelector('[data-testid="catalog-badge"]');
const dialog = () => document.body.querySelector('[role="dialog"]');

beforeEach(() => {
  window.__SOURCEWEFT_CONFIG__ = {
    analytics: {},
    apiBaseUrl: "https://api.sourceweft.test",
    googleOneTapClientId: "",
    googleOneTapEnabled: false,
    googleOneTapFedCmEnabled: false,
    webBaseUrl: "https://sourceweft.test",
  };
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});
afterEach(async () => {
  await unmountAll();
  vi.resetAllMocks();
  delete window.__SOURCEWEFT_CONFIG__;
});

const PUBLISHED = {
  flags: [],
  identifier: "io.github.o/weather",
  status: "published",
  version: "1.0.0",
};

async function startSubmission() {
  await mountWithIntl(<SubmitMcpDialog />);
  await click(button("Submit MCP"));
  typeInto(
    document.body.querySelector<HTMLInputElement>("input")!,
    " https://github.com/o/weather ",
  );
  await click(button("Submit", dialog()!));
}

async function submit(result: Record<string, unknown>) {
  api.submitMcp.mockResolvedValue(result);
  await startSubmission();
  await flush(2);
  expect(api.submitMcp).toHaveBeenCalledWith("https://github.com/o/weather");
}

async function expectFreshFormOnOpen() {
  await click(button("Submit MCP"));
  expect(badge()).toBeNull();
  expect(document.body.querySelector<HTMLInputElement>("input")?.value).toBe(
    "",
  );
}

test("keeps the dialog open on a published server, with its README badge", async () => {
  await submit({
    flags: [],
    identifier: "io.github.o/weather",
    status: "published",
    version: "1.0.0",
  });
  expect(dialog()?.textContent).toContain("Published: io.github.o/weather");
  expect(toast.success).not.toHaveBeenCalled();
  expect(badge()?.textContent).toContain(
    "Add this badge to your repository's README",
  );
  expect(badge()?.querySelector("code")?.textContent).toBe(
    "[![Listed on SourceWeft](https://sourceweft.test/badge/mcp/io.github.o%2Fweather.svg)](https://sourceweft.test/mcp/io.github.o%2Fweather?utm_source=readme&utm_medium=badge)",
  );

  await click(button("Copy", badge()!));
  await flush();
  expect(analytics.trackBadgeSnippetCopied).toHaveBeenCalledWith({
    kind: "mcp",
    method: "markdown",
    surface: "mcp_submit",
  });

  await click(button("Done", dialog()!));
  await flush();
  expect(dialog()).toBeNull();

  // Opened again, it is a fresh form.
  await expectFreshFormOnOpen();
});

test("shows the published server through the close animation, and opens again on a fresh form", async () => {
  // Radix keeps closing content mounted until its exit animation ends. Give
  // the content one, so the frames shown while it closes can be inspected.
  const style = document.createElement("style");
  style.textContent = [
    '[data-slot="dialog-content"][data-state="open"] { animation-name: sw-in; }',
    '[data-slot="dialog-content"][data-state="closed"] { animation-name: sw-out; }',
  ].join("\n");
  document.head.append(style);
  // Radix notices the exit animation through a live computed style, as a
  // browser returns; jsdom returns a snapshot, so read through to a fresh one.
  const snapshot = globalThis.getComputedStyle;
  const liveStyle = vi.spyOn(globalThis, "getComputedStyle").mockImplementation(
    (element, pseudo) =>
      new Proxy({} as CSSStyleDeclaration, {
        get(_, key) {
          const current = snapshot(element, pseudo);
          const value = Reflect.get(current, key);
          return typeof value === "function" ? value.bind(current) : value;
        },
      }),
  );
  try {
    await submit(PUBLISHED);
    await click(button("Done", dialog()!));

    const closing = dialog();
    expect(closing?.getAttribute("data-state")).toBe("closed");
    expect(closing?.textContent).toContain("Published: io.github.o/weather");
    expect(closing?.querySelector("input")).toBeNull();

    // Radix matches the ended animation by `CSS.escape`, which jsdom lacks;
    // "sw-out" needs no escaping.
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    const ended = new Event("animationend");
    Object.defineProperty(ended, "animationName", { value: "sw-out" });
    await act(async () => closing!.dispatchEvent(ended));
    expect(dialog()).toBeNull();

    await expectFreshFormOnOpen();
  } finally {
    vi.unstubAllGlobals();
    liveStyle.mockRestore();
    style.remove();
  }
});

test("still reports a server published after its dialog was closed", async () => {
  let resolve!: (value: unknown) => void;
  api.submitMcp.mockReturnValue(
    new Promise((settle) => {
      resolve = settle;
    }),
  );
  await startSubmission();
  await click(button("Close", dialog()!));
  expect(dialog()).toBeNull();

  await act(async () => resolve(PUBLISHED));
  await flush(2);
  expect(toast.success).toHaveBeenCalledWith("Published: io.github.o/weather");
  // The badge waits on the server's page; the dialog does not reopen for it.
  expect(dialog()).toBeNull();

  await expectFreshFormOnOpen();
});

test("closes on a submission sent to review, with no badge to offer yet", async () => {
  await submit({
    flags: ["remote-script"],
    identifier: "io.github.o/weather",
    status: "reviewing",
    version: "1.0.0",
  });
  expect(toast.success).toHaveBeenCalledWith(
    "Submitted io.github.o/weather, queued for manual review (1 item to confirm).",
  );
  expect(dialog()).toBeNull();
  expect(badge()).toBeNull();
});
