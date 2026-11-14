/**
 * Which billing tabs the settings center shows.
 *
 * Usage is a read-only account of credits and activity, shown wherever billing
 * exists. Billing is where a plan is bought, changed or managed, so it also
 * needs a host where purchases are allowed: the iOS app is not one.
 */
export function isSettingsTabAvailable(
  tab: string,
  billingAvailable = false,
  purchasesAllowed = true,
): boolean {
  if (tab === "billing") {
    return billingAvailable && purchasesAllowed;
  }
  if (tab === "usage") {
    return billingAvailable;
  }
  return true;
}
export function resolveSettingsTab<T extends string>(
  tab: T,
  billingAvailable = false,
  purchasesAllowed = true,
): T | "account" {
  return isSettingsTabAvailable(tab, billingAvailable, purchasesAllowed)
    ? tab
    : "account";
}
