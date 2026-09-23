import { expect, test } from "vitest";
import { parseSystemSubmitCommand } from "./arguments";
test("system CLI has no tenant arguments and refuses old or unknown invocation", () => {
  expect(parseSystemSubmitCommand(["submit"])).toBe("submit");
  expect(parseSystemSubmitCommand(["status"])).toBe("status");
  for (const args of [
    [],
    ["other"],
    ["submit", "--team", "t", "--workspace", "w"],
    ["status", "--unknown"],
  ]) {
    expect(() => parseSystemSubmitCommand(args)).toThrow(/System imports/);
  }
});
