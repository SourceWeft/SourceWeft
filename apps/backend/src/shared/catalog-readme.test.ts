import { expect, test } from "vitest";
import {
  MAX_README_BYTES,
  README_PATH,
  byReadmePreference,
} from "./catalog-readme";

test("the README size limit is 512 KB", () => {
  expect(MAX_README_BYTES).toBe(512 * 1024);
});

test("a README is a Markdown file named README, in any case, with an optional variant", () => {
  for (const name of [
    "README.md",
    "readme.md",
    "Readme.MD",
    "README.zh-CN.md",
    "README.fr.md",
  ]) {
    expect(README_PATH.test(name), name).toBe(true);
  }
  for (const name of [
    "README",
    "README.rst",
    "README.txt",
    "README.markdown",
    "docs/README.md",
    "README.zh_CN.md",
    "NOT-README.md",
  ]) {
    expect(README_PATH.test(name), name).toBe(false);
  }
});

test("README.md is preferred, then another casing of it, then variants by path", () => {
  const ordered = [
    { path: "README.zh-CN.md" },
    { path: "readme.md" },
    { path: "README.fr.md" },
    { path: "README.md" },
  ].sort(byReadmePreference);
  expect(ordered.map((file) => file.path)).toEqual([
    "README.md",
    "readme.md",
    "README.fr.md",
    "README.zh-CN.md",
  ]);
});
