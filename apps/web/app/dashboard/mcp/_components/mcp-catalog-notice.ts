import {
  isAccountSpecificGatewayHost,
  pinEndpoint,
  sameEndpoint,
} from "@sourceweft/market-contracts";
import type { WorkspaceMcpInstall } from "@sourceweft/sdk";

/**
 * Whether connecting this install could put its tool list on the public
 * catalog page (Issue #367), so the notice is shown only when it applies. It
 * mirrors the API's rules from what the dialog knows: a catalog install
 * connected at the listing's own address, not an account-specific gateway, and
 * a connection that is OAuth or sends only the listing's declared header (a
 * key under a header of the member's own choosing, or custom headers, never
 * is). The API decides in the end; this only keeps the notice honest.
 */
export function catalogNoticeApplies(
  install: WorkspaceMcpInstall | null,
  options: { declaredKeyMethod: boolean; apiKeyHeaderName: string },
): boolean {
  if (!install || install.source !== "market") return false;
  const manifestEndpoint = install.manifestJson.endpointUrl;
  if (!sameEndpoint(install.endpointUrl, manifestEndpoint)) return false;
  const pin = pinEndpoint(install.endpointUrl ?? "");
  if (!pin || isAccountSpecificGatewayHost(pin.hostname)) return false;
  if (install.authType === "custom_headers" && !options.declaredKeyMethod) {
    return false;
  }
  if (install.authType === "api_key_header" && !options.declaredKeyMethod) {
    const declared = install.manifestJson.auth.headerName?.trim().toLowerCase();
    return Boolean(declared) && declared === options.apiKeyHeaderName.trim().toLowerCase();
  }
  return true;
}
