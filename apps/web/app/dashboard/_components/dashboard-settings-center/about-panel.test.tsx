// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
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

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  const createdRoot = createRoot(container);
  root = createdRoot;
  await act(async () => {
    createdRoot.render(createElement(AboutPanel));
  });
  return container;
}

beforeEach(() => {
  isAvailable.mockReset();
  info.mockReset();
  openExternalUrl.mockReset();
  openExternalUrl.mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
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
