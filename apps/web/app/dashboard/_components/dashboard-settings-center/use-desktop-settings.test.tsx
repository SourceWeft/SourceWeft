// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  isAvailable: vi.fn(),
  info: vi.fn(),
}));
vi.mock("../../../../lib/desktop-bridge", () => ({ desktopBridge: bridge }));

import { useDesktopSettings } from "./use-desktop-settings";
import { flush, mount, unmountAll } from "@/test/react";

function Probe() {
  const { isDesktop, isLocalPc } = useDesktopSettings();
  return createElement("span", null, `${isDesktop}:${isLocalPc}`);
}

async function probe(platform: string | null) {
  bridge.isAvailable.mockReturnValue(platform !== null);
  bridge.info.mockResolvedValue({ isDesktop: platform !== null, platform });
  const { container } = await mount(createElement(Probe));
  await flush(4);
  return container.textContent;
}

beforeEach(() => {
  bridge.isAvailable.mockReset();
  bridge.info.mockReset();
});
afterEach(async () => {
  await unmountAll();
});

test.each([
  ["macos", "true:true"],
  ["linux", "true:true"],
  ["windows", "true:true"],
  ["freebsd", "true:false"],
  [null, "false:false"],
])("platform %s -> desktop:localPc %s", async (platform, expected) => {
  assert.equal(await probe(platform), expected);
});
