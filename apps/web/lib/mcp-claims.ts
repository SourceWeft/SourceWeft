import type {
  McpClaimOverview,
  McpOwnerOverrides,
  McpOwnerOverridesInput,
  RevokeMcpClaimResponse,
  StartMcpClaimRequest,
  StartMcpClaimResponse,
  VerifyMcpClaimResponse,
} from "@sourceweft/contracts";
import { HttpClient } from "@sourceweft/sdk";
import type { useTranslations } from "next-intl";

import { apiBaseUrl } from "./api-base-url";

/**
 * A publisher claiming a catalog MCP server (Issue #367, W7) and, once
 * verified, correcting what its public page shows. Every route acts as the
 * signed-in member; the owner-override routes answer only a verified owner.
 */
const http = new HttpClient({ baseUrl: apiBaseUrl, credentials: "include" });

// Identifiers carry a slash (`com.notion/mcp`): one path segment, encoded.
function entryPath(identifier: string) {
  return `/v1/market/mcp/${encodeURIComponent(identifier)}`;
}

function claimPath(claimId: string) {
  return `/v1/market/mcp-claims/${encodeURIComponent(claimId)}`;
}

/** Where the entry stands for the viewer: claimed, by whom, and how to claim. */
export function getMcpClaimOverview(identifier: string) {
  return http.get<McpClaimOverview>(`${entryPath(identifier)}/claim`);
}

/**
 * GitHub is decided at once (verified, or the request fails). A domain
 * method comes back pending with `instructions`, shown once: the token is
 * not retrievable later.
 */
export function startMcpClaim(identifier: string, input: StartMcpClaimRequest) {
  return http.post<StartMcpClaimResponse>(
    `${entryPath(identifier)}/claims`,
    input,
  );
}

/** Looks the published token up now. */
export function verifyMcpClaim(claimId: string) {
  return http.post<VerifyMcpClaimResponse>(`${claimPath(claimId)}/verify`, {});
}

/** The owner gives the claim up. */
export function revokeMcpClaim(claimId: string) {
  return http.post<RevokeMcpClaimResponse>(`${claimPath(claimId)}/revoke`, {});
}

export function getMcpOwnerOverrides(identifier: string) {
  return http.get<McpOwnerOverrides>(`${entryPath(identifier)}/owner-overrides`);
}

/** Replaces the whole set: send every field the form shows, null to clear. */
export function setMcpOwnerOverrides(
  identifier: string,
  values: McpOwnerOverridesInput,
) {
  return http.put<McpOwnerOverrides>(
    `${entryPath(identifier)}/owner-overrides`,
    values,
  );
}

/** Drops the owner-submitted tool list (submitted from the CLI, not here). */
export function clearMcpOwnerTools(identifier: string) {
  return http.delete<McpOwnerOverrides>(
    `${entryPath(identifier)}/owner-overrides/tools`,
  );
}

/** Where "Claim this server" and "Manage this listing" go. */
export function mcpClaimHref(identifier: string) {
  return `/dashboard/mcp/claim?identifier=${encodeURIComponent(identifier)}`;
}

/**
 * The member-facing message for a failed claim request. `t` is the
 * `dashboardMcpClaim` translator; an unknown code gets the fallback.
 */
export function mcpClaimErrorMessage(
  error: unknown,
  t: ReturnType<typeof useTranslations>,
  fallback: string = t("errors.fallback"),
): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (
    typeof code === "string" &&
    /^[A-Z_]+$/.test(code) &&
    t.has(`errors.${code}`)
  ) {
    return t(`errors.${code}`);
  }
  return fallback;
}
