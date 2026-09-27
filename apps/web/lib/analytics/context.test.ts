import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const native = vi.hoisted(() => ({
  detect: vi.fn<() => Promise<"desktop" | "mobile" | null>>(),
  info: vi.fn<() => Promise<{ appVersion?: string }>>(),
}));

vi.mock("../native-bridge", () => ({
  detectNativeHostKind: native.detect,
  nativeBridge: { info: native.info },
}));

import { resolveAnalyticsContext } from "./context";

afterEach(() => {
  vi.useRealTimers();
  native.detect.mockReset();
  native.info.mockReset();
});

test("no native host resolves to web without app_version", async () => {
  native.detect.mockResolvedValue(null);
  assert.deepEqual(await resolveAnalyticsContext(), { platform: "web" });
  assert.equal(native.info.mock.calls.length, 0);
});

test("desktop host resolves with app version", async () => {
  native.detect.mockResolvedValue("desktop");
  native.info.mockResolvedValue({ appVersion: "1.4.0" });
  assert.deepEqual(await resolveAnalyticsContext(), {
    platform: "desktop_app",
    app_version: "1.4.0",
  });
});

test("mobile host maps to mobile_app", async () => {
  native.detect.mockResolvedValue("mobile");
  native.info.mockResolvedValue({ appVersion: "2.0.1" });
  assert.deepEqual(await resolveAnalyticsContext(), {
    platform: "mobile_app",
    app_version: "2.0.1",
  });
});

test("info failure keeps the platform and omits app_version", async () => {
  native.detect.mockResolvedValue("desktop");
  native.info.mockRejectedValue(new Error("no bridge"));
  assert.deepEqual(await resolveAnalyticsContext(), { platform: "desktop_app" });
});

test("detection failure falls back to web", async () => {
  native.detect.mockRejectedValue(new Error("boom"));
  assert.deepEqual(await resolveAnalyticsContext(), { platform: "web" });
});

test("info that never settles times out and omits app_version", async () => {
  vi.useFakeTimers();
  native.detect.mockResolvedValue("desktop");
  native.info.mockReturnValue(new Promise(() => {}));
  const pending = resolveAnalyticsContext();
  await vi.advanceTimersByTimeAsync(1000);
  assert.deepEqual(await pending, { platform: "desktop_app" });
});
