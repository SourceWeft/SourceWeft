import { expect, test } from "vitest";
import { isSettingsTabAvailable, resolveSettingsTab } from "./visibility";

test("commercial settings are unavailable until explicitly enabled by capabilities", () => {
  for (const tab of ["billing", "usage"]) {
    expect(isSettingsTabAvailable(tab)).toBe(false);
    expect(isSettingsTabAvailable(tab, false)).toBe(false);
    expect(resolveSettingsTab(tab, false)).toBe("account");
    expect(isSettingsTabAvailable(tab, true)).toBe(true);
    expect(resolveSettingsTab(tab, true)).toBe(tab);
  }
  for (const tab of ["account", "team", "approvals", "local"])
    expect(isSettingsTabAvailable(tab, false)).toBe(true);
});
