import type { GuidePayerPorts } from "../sources/guide-payer";
import { workspaceService } from "../workspace";

/**
 * The workspace lookups behind "who pays for work done on someone's behalf
 * outside a chat turn" — a source guide, a study artifact. Shared so both
 * resolve the payer the same way.
 */
export const defaultPayerPorts: GuidePayerPorts = {
  resolveAccess: (input) => workspaceService.resolveAccess(input),
  resolveResponsibleUserId: (input) =>
    workspaceService.resolveResponsibleUserId(input),
  resolveBillingOrganizationId: (input) =>
    workspaceService.resolveBillingOrganizationId(input),
};
