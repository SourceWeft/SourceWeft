import { LOCALE_IDS } from "@sourceweft/i18n/locales";
// Import the subpath, not the barrel: the barrel transitively pulls
// market-contracts (a build-step package), which is irrelevant to this check.
import { userLanguageSchema } from "@sourceweft/contracts/user-settings";
import { describe, expect, it } from "vitest";

// The `language` user setting is a literal enum in the contracts package (which
// must stay dependency-light), so this test is the guard that keeps it aligned
// with the i18n package's source of truth. Adding a locale in one place without
// the other fails here.
describe("user language setting alignment", () => {
  it("offers exactly the supported locales plus 'system'", () => {
    const options = [...userLanguageSchema.options].sort();
    const expected = ["system", ...LOCALE_IDS].sort();
    expect(options).toEqual(expected);
  });
});
