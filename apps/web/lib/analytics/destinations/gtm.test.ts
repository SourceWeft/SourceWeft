import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

import { createGtmDestination } from "./gtm";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("track pushes onto dataLayer even before GTM initialises", () => {
  const win: { dataLayer?: unknown[] } = {};
  vi.stubGlobal("window", win);
  createGtmDestination().track("login", { method: "email" });
  assert.deepEqual(win.dataLayer, [{ method: "email", event: "login" }]);
});

test("setContext pushes an analytics_context event", () => {
  const win: { dataLayer?: unknown[] } = { dataLayer: [] };
  vi.stubGlobal("window", win);
  createGtmDestination().setContext({
    platform: "desktop_app",
    app_version: "1.4.0",
  });
  assert.deepEqual(win.dataLayer, [
    { event: "analytics_context", platform: "desktop_app", app_version: "1.4.0" },
  ]);
});
