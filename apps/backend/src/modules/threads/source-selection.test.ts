import { describe, expect, it } from "vitest";
import {
  resolveTurnSourceSelection,
  selectedSourceAnchors,
} from "./source-selection";

describe("Source selection boundaries", () => {
  const persisted = {
    revision: 4,
    selectedSourceIds: ["selected"],
  };
  it("distinguishes omission from explicit clearing", () => {
    expect(resolveTurnSourceSelection(undefined, persisted)).toEqual([
      "selected",
    ]);
    expect(resolveTurnSourceSelection([], persisted)).toEqual([]);
    expect(
      resolveTurnSourceSelection(["selected", "selected"], persisted),
    ).toEqual(["selected"]);
    expect(persisted.selectedSourceIds).toEqual(["selected"]);
  });
  it("a turn request cannot expand the persisted selection", () => {
    expect(() => resolveTurnSourceSelection(["new"], persisted)).toThrow(
      "Add the source",
    );
  });
  it("mentions cannot expand an empty or nonempty source scope", () => {
    expect(selectedSourceAnchors([], ["mentioned"])).toEqual([]);
    expect(
      selectedSourceAnchors(["selected"], ["other", "selected", "selected"]),
    ).toEqual(["selected"]);
  });
});
