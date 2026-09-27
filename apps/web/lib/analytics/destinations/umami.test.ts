import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

import { createUmamiDestination, toUmamiData } from "./umami";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("items become item_ids and undefined is dropped", () => {
  assert.deepEqual(
    toUmamiData({
      value: 96,
      seat_count: undefined,
      plan: null,
      items: [
        { item_id: "team_yearly", item_name: "Team yearly" },
        { item_id: "pro_monthly", item_name: "Pro monthly" },
      ],
    }),
    { value: 96, item_ids: "team_yearly,pro_monthly" },
  );
});

test("not ready until window.umami.track exists", () => {
  const win: { umami?: { track: () => void } } = {};
  vi.stubGlobal("window", win);
  const umami = createUmamiDestination();
  assert.equal(umami.isReady(), false);
  win.umami = { track: () => {} };
  assert.equal(umami.isReady(), true);
});

test("track forwards the converted data", () => {
  const track = vi.fn();
  vi.stubGlobal("window", { umami: { track } });
  createUmamiDestination().track("source_added", {
    kind: "file",
    source_count: 2,
    platform: "web",
  });
  assert.deepEqual(track.mock.calls[0], [
    "source_added",
    { kind: "file", source_count: 2, platform: "web" },
  ]);
});

test("setContext calls identify without app_version on web", () => {
  const identify = vi.fn();
  vi.stubGlobal("window", { umami: { track: vi.fn(), identify } });
  createUmamiDestination().setContext({ platform: "web" });
  assert.deepEqual(identify.mock.calls[0], [{ platform: "web" }]);
});

test("setContext tolerates Umami versions without identify", () => {
  vi.stubGlobal("window", { umami: { track: vi.fn() } });
  createUmamiDestination().setContext({ platform: "web" });
});
