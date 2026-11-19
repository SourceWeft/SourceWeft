import assert from "node:assert/strict";
import { test } from "vitest";
import { joinDictationText } from "./join-text";

test.each([
  ["", "你好。", false, "你好。"],
  ["。", "接着说", false, "接着说"],
  ["d", "next", false, " next"],
  [".", "Next one.", false, " Next one."],
  ["。", "Next", false, "Next"],
  ["a", "中文", false, "中文"],
  ["文", "abc", false, "abc"],
  ["3", "4 items", false, " 4 items"],
  ["", "  padded  ", false, "padded"],
  ["", "被切断了。", true, "被切断了"],
  ["", "cut here.", true, "cut here"],
  ["", "   ", false, ""],
])(
  "after %j, %j (hardCut %s) inserts %j",
  (previousTail, next, hardCut, expected) => {
    assert.equal(
      joinDictationText(previousTail, next, { hardCut }),
      expected,
    );
  },
);
