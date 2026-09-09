import { billingUiAvailable } from "./catalog";

export function isSettingsTabAvailable(tab: string): boolean {
  return billingUiAvailable || (tab !== "billing" && tab !== "usage");
}

export function resolveSettingsTab<T extends string>(tab: T): T | "account" {
  return isSettingsTabAvailable(tab) ? tab : "account";
}
