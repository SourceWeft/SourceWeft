import { isPersonalOrganization } from "@sourceweft/contracts/organization-metadata";
import type { BillingOrg } from "./types";
export function resolveBillingTeamId(input: {
  activeOrg?: BillingOrg | null;
  orgs?: BillingOrg[] | null;
}) {
  if (input.activeOrg?.id) {
    return input.activeOrg.id;
  }

  const personalOrg = input.orgs?.find(isPersonalOrganization);
  return personalOrg?.id ?? null;
}

export function isPersonalBillingOrg(org?: BillingOrg | null) {
  return !org || Boolean(isPersonalOrganization(org));
}
