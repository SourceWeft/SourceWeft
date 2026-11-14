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

test("where nothing may be sold, Usage stays and Billing goes", () => {
  expect(isSettingsTabAvailable("usage", true, false)).toBe(true);
  expect(resolveSettingsTab("usage", true, false)).toBe("usage");
  expect(isSettingsTabAvailable("billing", true, false)).toBe(false);
  expect(resolveSettingsTab("billing", true, false)).toBe("account");
  // Without billing at all, the host makes no difference.
  for (const tab of ["billing", "usage"])
    expect(isSettingsTabAvailable(tab, false, false)).toBe(false);
  for (const tab of ["account", "team", "approvals", "local"])
    expect(isSettingsTabAvailable(tab, true, false)).toBe(true);
});
