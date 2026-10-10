import { expect, test } from "vitest";
import {
  parseDesktopRecoveryRelease,
  recoveryDownload,
  localCalendarDate,
} from "./desktop-recovery";
import type { DesktopInfo } from "./desktop-bridge";

const release = {
  published: true,
  version: "0.3.1",
  affectedVersions: ["0.3.0-rc.3"],
  downloads: {
    "macos-aarch64":
      "https://download.sourceweft.com/releases/v0.3.1/SourceWeft-aarch64.dmg",
  },
};
const info = {
  isDesktop: true,
  appVersion: "0.3.0-rc.3",
  platform: "macos",
  arch: "aarch64",
} as DesktopInfo;
test("release gate defaults closed and requires publication attestation", () => {
  expect(parseDesktopRecoveryRelease("")).toBeUndefined();
  for (const raw of [
    "{",
    "null",
    "{}",
    JSON.stringify({ ...release, published: false }),
    JSON.stringify({ ...release, downloads: {} }),
  ])
    expect(() => parseDesktopRecoveryRelease(raw)).toThrow(
      "PUBLIC_DESKTOP_RECOVERY_RELEASE",
    );
});
test("only allowlisted desktop versions with a matching installer qualify", () => {
  const parsed = parseDesktopRecoveryRelease(JSON.stringify(release));
  expect(recoveryDownload(parsed, info)).toBe(
    release.downloads["macos-aarch64"],
  );
  for (const change of [
    { appVersion: "0.3.1" },
    { appVersion: "0.3.2" },
    { appVersion: "unknown" },
    { platform: "windows" },
    { isDesktop: false },
  ])
    expect(recoveryDownload(parsed, { ...info, ...change })).toBeNull();
});
test.each([
  "https://evil.example/releases/v0.3.1/a.dmg",
  "http://download.sourceweft.com/releases/v0.3.1/a.dmg",
  "https://download.sourceweft.com/releases/v0.3.0/a.dmg",
  "https://download.sourceweft.com/releases/v0.3.1/a.exe",
  "https://user:pass@download.sourceweft.com/releases/v0.3.1/a.dmg",
  "https://download.sourceweft.com/releases/v0.3.1/a.dmg?redirect=elsewhere",
])("reject untrusted or mismatched installer %s", (url) => {
  expect(() =>
    parseDesktopRecoveryRelease(
      JSON.stringify({ ...release, downloads: { "macos-aarch64": url } }),
    ),
  ).toThrow();
});
test("repair version cannot be its own affected version", () => {
  expect(() =>
    parseDesktopRecoveryRelease(
      JSON.stringify({ ...release, affectedVersions: [release.version] }),
    ),
  ).toThrow();
});
test("dismissal day uses local calendar fields, including around midnight", () => {
  expect(localCalendarDate(new Date(2026, 9, 10, 23, 59))).toBe("2026-10-10");
  expect(localCalendarDate(new Date(2026, 9, 11, 0, 1))).toBe("2026-10-11");
});
