// @vitest-environment jsdom
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

async function submit(result: Record<string, unknown>) {
  api.submitMcp.mockResolvedValue(result);
  await mountWithIntl(<SubmitMcpDialog />);
  await click(button("Submit MCP"));
  typeInto(
    document.body.querySelector<HTMLInputElement>("input")!,
    " https://github.com/o/weather ",
  );
  await click(button("Submit", dialog()!));
  await flush(2);
  expect(api.submitMcp).toHaveBeenCalledWith("https://github.com/o/weather");
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
  await click(button("Submit MCP"));
  expect(badge()).toBeNull();
  expect(document.body.querySelector<HTMLInputElement>("input")?.value).toBe(
    "",
  );
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
