import { describe, expect, test } from "vitest";
import { skillUpdateSignal } from "./repository";

describe("skillUpdateSignal", () => {
  test("the installed version being current means no update", () => {
    expect(
      skillUpdateSignal({ installedVersionId: "v1", currentVersionId: "v1" }),
    ).toEqual({ currentVersionId: "v1", updateAvailable: false });
  });

  test("a different published current version is an update", () => {
    expect(
      skillUpdateSignal({ installedVersionId: "v1", currentVersionId: "v2" }),
    ).toEqual({ currentVersionId: "v2", updateAvailable: true });
  });

  test("no published current version is never an update", () => {
    // The newest version is under review, or the current one was revoked with
    // nothing to take over: there is nothing to move to.
    expect(
      skillUpdateSignal({ installedVersionId: "v1", currentVersionId: null }),
    ).toEqual({ currentVersionId: null, updateAvailable: false });
  });
});
