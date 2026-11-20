import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { FRAMED_PAGE_CLASS, FRAMED_PAGE_SCRIPT } from "./framed-page";

function runScript(framed: boolean, topThrows = false) {
  const classes = new Set<string>();
  const self = {};
  const window = {
    self,
    get top() {
      if (topThrows) throw new Error("cross-origin");
      return framed ? {} : self;
    },
  };
  runInNewContext(FRAMED_PAGE_SCRIPT, {
    window,
    document: {
      documentElement: { classList: { add: (c: string) => classes.add(c) } },
    },
  });
  return classes;
}

describe("framed page script", () => {
  it("marks a page shown inside a frame", () => {
    expect(runScript(true).has(FRAMED_PAGE_CLASS)).toBe(true);
  });

  it("leaves a top-level page alone", () => {
    expect(runScript(false).size).toBe(0);
  });

  it("treats an unreadable parent as a frame", () => {
    expect(runScript(true, true).has(FRAMED_PAGE_CLASS)).toBe(true);
  });
});
