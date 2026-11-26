// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, test, vi } from "vitest";

vi.mock("./client", () => ({
  startAnalytics: vi.fn(),
  markDestinationReady: vi.fn(),
}));

import { flush, mount, unmountAll } from "@/test/react";
import { resetNativeHostForTests } from "../native-host";
import { AnalyticsScripts } from "./analytics-scripts";

const scriptUrl = "https://umami.example/script.js";
const tagManagerScript = () =>
  document.querySelector('script[src*="googletagmanager.com/gtm.js"]');

type Bridge = NonNullable<Window["__SOURCEWEFT_NATIVE__"]>;

function mobileBridge(platform: string): Bridge {
  return {
    kind: "mobile",
    platform,
    capabilities: [],
    invoke: (async () => ({})) as Bridge["invoke"],
    listen: async () => async () => {},
  };
}

afterEach(async () => {
  await unmountAll();
  document.querySelectorAll("script").forEach((script) => script.remove());
  delete window.__SOURCEWEFT_NATIVE__;
  delete window.dataLayer;
  resetNativeHostForTests();
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

// Google Analytics and Microsoft Clarity are tags inside the container, so the
// container's own script is the one switch for both.
//
// next/script adds a script with a given id or src once per page, so these two
// run in this order: the browser case afterwards shows the container's script
// had not been added before, and would have been in the iOS app if allowed.
test("Google Tag Manager stays out of the iOS app while Umami still loads", async () => {
  const iosUmamiUrl = "https://umami.example/ios-script.js";
  window.__SOURCEWEFT_NATIVE__ = mobileBridge("ios");
  await mount(
    createElement(AnalyticsScripts, {
      config: {
        gtmId: "GTM-TEST",
        umami: { scriptUrl: iosUmamiUrl, websiteId: "site-1" },
      },
    }),
  );
  await flush();

  assert.equal(tagManagerScript(), null);
  assert.ok(document.querySelector(`script[src="${iosUmamiUrl}"]`));
});

test("Google Tag Manager loads in a browser", async () => {
  await mount(
    createElement(AnalyticsScripts, { config: { gtmId: "GTM-TEST" } }),
  );
  await flush();

  assert.ok(tagManagerScript(), "the tag manager script was not added");
});
