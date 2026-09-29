// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, test, vi } from "vitest";

vi.mock("./client", () => ({
  startAnalytics: vi.fn(),
  markDestinationReady: vi.fn(),
}));

import { flush, mount, unmountAll } from "@/test/react";
import { AnalyticsScripts } from "./analytics-scripts";

const scriptUrl = "https://umami.example/script.js";

afterEach(async () => {
  await unmountAll();
  document.querySelectorAll("script").forEach((script) => script.remove());
});

// Browsers expose each element id as a window property, and the tracker
// installs track/identify only while window.umami is unset. A tag with
// id="umami" keeps page views working but silently drops every custom
// event. Vitest's jsdom global skips named access, so check the id itself.
test("the Umami script tag does not claim window.umami", async () => {
  await mount(
    createElement(AnalyticsScripts, {
      config: { umami: { scriptUrl, websiteId: "site-1" } },
    }),
  );
  await flush();

  const script = document.querySelector(`script[src="${scriptUrl}"]`);
  assert.ok(script, "the Umami script was not added");
  assert.equal(script.getAttribute("data-website-id"), "site-1");
  assert.notEqual(script.id, "umami");
});
