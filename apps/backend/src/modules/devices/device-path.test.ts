import { describe, expect, test } from "vitest";
import {
  deviceBasename,
  deviceRelative,
  hasParentSegment,
  isDeviceAbsolutePath,
  joinDevicePath,
  trimDeviceTrailingSlash,
} from "./device-path";

describe("isDeviceAbsolutePath", () => {
  test.each([
    "/",
    "/home/me",
    "/Users/me/Library/Application Support/app/task-workspaces/x/files",
    "/a//b",
    "/a/..b/c",
    "/a/b..",
    "/tmp/odd\\name",
    "C:/",
    "C:/Users/me",
    "c:/users/me/AppData/Roaming/app/task-workspaces/id/files",
    "Z:/a b/c",
  ])("accepts %j", (path) => {
    expect(isDeviceAbsolutePath(path)).toBe(true);
  });

  test.each([
    "",
    "relative/path",
    ".",
    "~/x",
    "C:",
    "C:foo",
    "C:\\Users\\me",
    "C:/Users\\me",
    "\\\\server\\share",
    "\\\\?\\C:\\x",
    "//server/share",
    "//",
    "C://x",
    "1:/x",
    "CC:/x",
    "/a/../b",
    "/..",
    "/a/..",
    "C:/a/../b",
    "C:/..",
    "http://x",
    "file:///x",
  ])("rejects %j", (path) => {
    expect(isDeviceAbsolutePath(path)).toBe(false);
  });

  test("rejects non-strings", () => {
    expect(isDeviceAbsolutePath(undefined as unknown as string)).toBe(false);
    expect(isDeviceAbsolutePath(null as unknown as string)).toBe(false);
  });
});

describe("hasParentSegment", () => {
  test.each([
    ["..", true],
    ["a/../b", true],
    ["a/..", true],
    ["../a", true],
    ["a/..b", false],
    ["a..", false],
    ["...", false],
    ["a/b", false],
  ])("%j -> %s", (path, expected) => {
    expect(hasParentSegment(path)).toBe(expected);
  });
});

describe("deviceRelative", () => {
  test("POSIX roots keep the exact, case-sensitive behaviour", () => {
    const root = "/Users/me/ws/files";
    expect(deviceRelative(root, root)).toBe(".");
    expect(deviceRelative(root, `${root}/a/b.txt`)).toBe("a/b.txt");
    expect(deviceRelative(root, `${root}/`)).toBe("");
    expect(deviceRelative(root, `${root}x/a`)).toBeNull();
    expect(deviceRelative(root, "/Users/me/ws")).toBeNull();
    expect(deviceRelative(root, "/USERS/ME/WS/FILES/a")).toBeNull();
    expect(deviceRelative(root, "a/b")).toBeNull();
  });

  test("Windows drive roots match case-insensitively and keep the remainder as given", () => {
    const root = "C:/Users/Me/AppData/Roaming/app/task-workspaces/id/files";
    expect(deviceRelative(root, root)).toBe(".");
    expect(deviceRelative(root, root.toLowerCase())).toBe(".");
    expect(deviceRelative(root, `${root}/Src/A.ts`)).toBe("Src/A.ts");
    expect(
      deviceRelative(
        root,
        `c:/users/me/appdata/roaming/app/task-workspaces/id/files/Src/A.ts`,
      ),
    ).toBe("Src/A.ts");
    expect(deviceRelative(root, `${root}x/a`)).toBeNull();
    expect(
      deviceRelative(
        root,
        "D:/Users/Me/AppData/Roaming/app/task-workspaces/id/files/a",
      ),
    ).toBeNull();
  });
});

describe("joinDevicePath", () => {
  test("joins with forward slashes exactly like a template literal", () => {
    expect(joinDevicePath("/ws/files", "a", "b.txt")).toBe("/ws/files/a/b.txt");
    expect(joinDevicePath("C:/ws/files", ".sourceweft-skills")).toBe(
      "C:/ws/files/.sourceweft-skills",
    );
    expect(joinDevicePath("/ws")).toBe("/ws");
    expect(joinDevicePath("/ws", "x")).toBe(`${"/ws"}/${"x"}`);
  });
});

describe("deviceBasename", () => {
  test("is the last slash-separated segment", () => {
    expect(deviceBasename("/a/b/report.pdf")).toBe("report.pdf");
    expect(deviceBasename("C:/a/b/report.pdf")).toBe("report.pdf");
    expect(deviceBasename("/a/b/")).toBe("");
    expect(deviceBasename("")).toBe("");
  });
});

describe("trimDeviceTrailingSlash", () => {
  test("removes exactly one trailing slash", () => {
    expect(trimDeviceTrailingSlash("/ws/files/")).toBe("/ws/files");
    expect(trimDeviceTrailingSlash("C:/ws/files/")).toBe("C:/ws/files");
    expect(trimDeviceTrailingSlash("/ws/files//")).toBe("/ws/files/");
    expect(trimDeviceTrailingSlash("/ws/files")).toBe("/ws/files");
    expect(trimDeviceTrailingSlash("/")).toBe("");
  });
});
