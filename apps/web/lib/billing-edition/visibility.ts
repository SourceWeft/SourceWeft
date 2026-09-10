export function isSettingsTabAvailable(
  tab: string,
  billingAvailable = false,
): boolean {
  return billingAvailable || (tab !== "billing" && tab !== "usage");
}
export function resolveSettingsTab<T extends string>(
  tab: T,
  billingAvailable = false,
): T | "account" {
  return isSettingsTabAvailable(tab, billingAvailable) ? tab : "account";
}
