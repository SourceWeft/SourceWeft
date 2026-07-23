import { config } from "../../shared/config";

/**
 * Whether a user may review/publish/reject submitted market entries. This is
 * the single choke point for market-admin authorization: today a config
 * allowlist, later swappable for a DB-backed role (e.g. better-auth admin) by
 * changing only this function — endpoints call requireMarketAdmin and never
 * inspect the mechanism directly.
 */
export function isMarketAdmin(userId: string | null | undefined): boolean {
  if (!userId) {
    return false;
  }
  return config.market.adminUserIds.includes(userId);
}
