// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";

const isAvailable = vi.fn();
const info = vi.fn();
const openExternalUrl = vi.fn();

vi.mock("../../../../lib/desktop-bridge", () => ({
  desktopBridge: {
    isAvailable: () => isAvailable(),
    info: () => info(),
    openExternalUrl: (url: string) => openExternalUrl(url),
  },
}));

vi.mock("../../../../lib/app-version", () => ({
  BUILD_SHA: "9d3154a4c0ffee0000000000000000000000beef",
  BUILD_TIME: "2026-09-17T10:00:00Z",
  SHORT_BUILD_SHA: "9d3154a",
}));

vi.mock("../../../_landing/components/sourceweft-brand", () => ({
  SourceWeftBrandMark: () => null,
}));

import { AboutPanel } from "./about-panel";
import { mountWithIntl, unmountAll } from "@/test/react";

async function render() {
  const { container } = await mountWithIntl(createElement(AboutPanel));
  return container;
}

beforeEach(() => {
  isAvailable.mockReset();
  info.mockReset();
  openExternalUrl.mockReset();
  openExternalUrl.mockResolvedValue(undefined);
});

afterEach(async () => {
  await unmountAll();
  delete window.__SOURCEWEFT_CONFIG__;
});

test("web shows a shortened build sha and the changelog link", async () => {
  isAvailable.mockReturnValue(false);
  const element = await render();
  const text = element.textContent ?? "";
  assert.match(text, /build 9d3154a/);
  assert.doesNotMatch(text, /c0ffee/);
  assert.match(text, /2026-09-17/);
  assert.ok(element.querySelector('a[href="/changelog"]'));
});

test("desktop shows the native app version instead of the build sha", async () => {
  isAvailable.mockReturnValue(true);
  info.mockResolvedValue({
    isDesktop: true,
    platform: "macos",
    arch: "aarch64",
    appName: "SourceWeft",
    appVersion: "0.2.0-rc.2",
    tauriVersion: "2.0.0",
  });
  const element = await render();
  const text = element.textContent ?? "";
  assert.match(text, /0\.2\.0-rc\.2/);
  assert.match(text, /macos aarch64/);
  assert.doesNotMatch(text, /build 9d3154a/);
});

test("desktop opens the changelog in the system browser, not in the app window", async () => {
  isAvailable.mockReturnValue(true);
  info.mockResolvedValue({
    isDesktop: true,
    platform: "macos",
    arch: "aarch64",
    appName: "SourceWeft",
    appVersion: "0.2.0-rc.2",
    tauriVersion: "2.0.0",
  });
  const element = await render();
  // An in-app link would be bounced back to chat by the native navigation guard.
  assert.equal(element.querySelector('a[href="/changelog"]'), null);
  const trigger = [...element.querySelectorAll("button")].find((node) =>
    node.textContent?.includes("View changelog"),
  );
  assert.ok(trigger);
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  assert.equal(openExternalUrl.mock.calls.length, 1);
  assert.match(String(openExternalUrl.mock.calls[0]?.[0]), /\/changelog$/);
});

test("a denied desktop bridge call degrades instead of hanging on a loader", async () => {
  isAvailable.mockReturnValue(true);
  info.mockRejectedValue(new Error("DESKTOP_ACCESS_DENIED"));
  const element = await render();
  const text = element.textContent ?? "";
  assert.match(text, /Unavailable/);
  assert.doesNotMatch(text, /Loading/);
});
test("published recovery replaces broken updater UI and stays available after dismissal", async () => {
  const { serverPublicRuntimeConfig } =
    await import("../../../../lib/public-runtime-config");
  window.__SOURCEWEFT_CONFIG__ = {
    ...serverPublicRuntimeConfig(),
    desktopRecoveryRelease: {
      version: "0.3.1",
      affectedVersions: ["0.3.0-rc.3"],
      downloads: {
        "macos-aarch64":
          "https://download.sourceweft.com/releases/v0.3.1/app.dmg",
      },
    },
  };
  isAvailable.mockReturnValue(true);
  info.mockResolvedValue({
    isDesktop: true,
    platform: "macos",
    arch: "aarch64",
    appVersion: "0.3.0-rc.3",
    updaterProtocolVersion: 1,
  });
  const element = await render();
  assert.match(element.textContent ?? "", /Download the repair version/);
  assert.doesNotMatch(element.textContent ?? "", /Loading update settings/);
});
