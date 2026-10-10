// @vitest-environment jsdom
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { act } from "react";
import { mountWithIntl, unmountAll, button, click } from "@/test/react";
import {
  recoveryDismissalKey,
  localCalendarDate,
} from "../../../lib/desktop-recovery";
import type { DesktopInfo } from "../../../lib/desktop-bridge";
const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  available: vi.fn(),
  open: vi.fn(),
  config: vi.fn(),
}));
vi.mock("../../../lib/desktop-bridge", () => ({
  desktopBridge: {
    info: mocks.info,
    isAvailable: mocks.available,
    openExternalUrl: mocks.open,
  },
}));
vi.mock("../../../lib/public-runtime-config", () => ({
  publicRuntimeConfig: mocks.config,
}));
import { DesktopRecovery } from "./desktop-recovery";
const info = {
  isDesktop: true,
  appVersion: "0.3.0-rc.3",
  platform: "macos",
  arch: "aarch64",
} as DesktopInfo;
const url = "https://download.sourceweft.com/releases/v0.3.1/app.dmg";
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  history.replaceState({}, "", "/dashboard/chat");
  mocks.available.mockReturnValue(true);
  mocks.info.mockResolvedValue(info);
  mocks.open.mockResolvedValue(undefined);
  mocks.config.mockReturnValue({
    desktopRecoveryRelease: {
      version: "0.3.1",
      affectedVersions: [info.appVersion],
      downloads: { "macos-aarch64": url },
    },
  });
});
afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
});
test("startup prompts known affected versions even without updater commands", async () => {
  await mountWithIntl(<DesktopRecovery />);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await click(button("Download the repair version"));
  const opened = new URL(mocks.open.mock.calls[0]![0]);
  expect(opened.origin).toBe(window.location.origin);
  expect(opened.pathname).toBe("/api/desktop-recovery");
  expect(opened.searchParams.get("target")).toBe("macos-aarch64");
  expect(opened.searchParams.get("version")).toBe("0.3.1");
});
test("closed release gate does not even query native host", async () => {
  mocks.config.mockReturnValue({});
  await mountWithIntl(<DesktopRecovery />);
  expect(mocks.info).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
test("later persists across remounts today, settings remain available, tomorrow prompts", async () => {
  await mountWithIntl(<DesktopRecovery />);
  await click(button("Later today — do not remind again"));
  expect(localStorage.getItem(recoveryDismissalKey(info))).toBe(
    localCalendarDate(),
  );
  await unmountAll();
  await mountWithIntl(<DesktopRecovery />);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await mountWithIntl(<DesktopRecovery panel />);
  expect(button("Download the repair version")).toBeDefined();
  await unmountAll();
  localStorage.setItem(recoveryDismissalKey(info), "2026-01-01");
  await mountWithIntl(<DesktopRecovery />);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});
test("close button also persists today's dismissal", async () => {
  await mountWithIntl(<DesktopRecovery />);
  await click(button("Close"));
  expect(localStorage.getItem(recoveryDismissalKey(info))).toBe(
    localCalendarDate(),
  );
});
test("Escape also persists today's dismissal", async () => {
  await mountWithIntl(<DesktopRecovery />);
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(localStorage.getItem(recoveryDismissalKey(info))).toBe(
    localCalendarDate(),
  );
});
test("browser does not query desktop and download failure does not dismiss", async () => {
  mocks.available.mockReturnValue(false);
  await mountWithIntl(<DesktopRecovery />);
  expect(mocks.info).not.toHaveBeenCalled();
  await unmountAll();
  mocks.available.mockReturnValue(true);
  mocks.open.mockRejectedValue(new Error("IPC denied"));
  await mountWithIntl(<DesktopRecovery />);
  await click(button("Download the repair version"));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not open",
  );
  expect(localStorage.getItem(recoveryDismissalKey(info))).toBeNull();
});
test("storage write failure stays visible with actionable error", async () => {
  await mountWithIntl(<DesktopRecovery />);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  await click(button("Later today — do not remind again"));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not save",
  );
});
test.each(["/dashboard/hub-window", "/dashboard/preview-window"])(
  "auxiliary window %s never prompts",
  async (path) => {
    history.replaceState({}, "", path);
    await mountWithIntl(<DesktopRecovery />);
    expect(mocks.info).not.toHaveBeenCalled();
  },
);
test("repaired versions and native discovery failures never prompt", async () => {
  mocks.info.mockResolvedValue({ ...info, appVersion: "0.3.1" });
  await mountWithIntl(<DesktopRecovery />);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await unmountAll();
  mocks.info.mockRejectedValue(new Error("network unavailable"));
  await mountWithIntl(<DesktopRecovery />);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
