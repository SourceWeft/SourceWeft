import { expect, test } from "vitest";
import { nativeAbsolutePathSchema } from "./native-path";

test("device paths accept POSIX and Windows drives on any backend OS", () => {
  for (const path of [
    "/Users/test/task",
    "C:/Users/test/任务 with spaces",
    "D:/task",
  ])
    expect(nativeAbsolutePathSchema.parse(path)).toBe(path);
  for (const path of [
    "task",
    "C:task",
    "C:\\task",
    "C:/task/../outside",
    "/tmp/./task",
    "C:/task\0",
  ])
    expect(nativeAbsolutePathSchema.safeParse(path).success).toBe(false);
});
