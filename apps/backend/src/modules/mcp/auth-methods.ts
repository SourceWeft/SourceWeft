import { z } from "zod";
import {
  marketMcpAuthMethodSchema,
  type MarketMcpAuthMethod,
  type McpAuthType,
} from "@sourceweft/market-sdk";
import type { WorkspaceMcpInstallRecord } from "./types";

export type McpHeaderAuthMethod = Extract<
  MarketMcpAuthMethod,
  { type: "header" }
>;

const authMethodsSchema = z.array(marketMcpAuthMethodSchema);

/** Auth types whose credential is a stored secret sent as request headers. */
export const STATIC_MCP_AUTH_TYPES = [
  "bearer",
  "api_key_header",
  "custom_headers",
] as const satisfies readonly McpAuthType[];

export function isStaticMcpAuthType(authType: McpAuthType) {
  return (STATIC_MCP_AUTH_TYPES as readonly McpAuthType[]).includes(authType);
}

function manifestAuth(
  install: Pick<WorkspaceMcpInstallRecord, "manifestJson">,
) {
  const auth = install.manifestJson.auth;
  return auth && typeof auth === "object" && !Array.isArray(auth)
    ? (auth as Record<string, unknown>)
    : {};
}

/**
 * The ways a member may connect to an install. Read from the manifest's
 * `auth.methods`; manifests written before methods existed (or with a
 * malformed list) derive them from the install's own auth type, which never
 * allows more than that type did before.
 */
export function mcpInstallAuthMethods(
  install: Pick<WorkspaceMcpInstallRecord, "authType" | "manifestJson">,
): { methods: MarketMcpAuthMethod[]; declared: boolean } {
  const auth = manifestAuth(install);
  const declared = authMethodsSchema.safeParse(auth.methods);
  if (auth.methods !== undefined && declared.success) {
    return { methods: declared.data, declared: true };
  }
  if (install.authType === "oauth") {
    return { methods: [{ type: "oauth" }], declared: false };
  }
  if (install.authType === "bearer") {
    return {
      methods: [{ type: "header", name: "Authorization", scheme: "bearer" }],
      declared: false,
    };
  }
  const headerName =
    typeof auth.headerName === "string" ? auth.headerName.trim() : "";
  if (install.authType === "api_key_header" && headerName) {
    return {
      methods: [{ type: "header", name: headerName }],
      declared: false,
    };
  }
  return { methods: [], declared: false };
}

/** Whether a member may connect this install with their own OAuth session. */
export function mcpInstallAllowsOAuth(
  install: Pick<WorkspaceMcpInstallRecord, "authType" | "manifestJson">,
) {
  return (
    install.authType === "oauth" ||
    mcpInstallAuthMethods(install).methods.some(
      (method) => method.type === "oauth",
    )
  );
}

/**
 * Whether a member's stored static credential may be sent to this install:
 * the install's own type is static, or it accepts a header method.
 */
export function mcpInstallAllowsStaticCredential(
  install: Pick<WorkspaceMcpInstallRecord, "authType" | "manifestJson">,
) {
  return (
    isStaticMcpAuthType(install.authType) ||
    mcpInstallAuthMethods(install).methods.some(
      (method) => method.type === "header",
    )
  );
}

/**
 * The declared header method a credential save of `authType` maps to: a
 * `scheme: "bearer"` method is saved as `bearer`, any other header method as
 * `api_key_header`. Legacy (derived) methods are not returned, so an install
 * without declared methods keeps saving exactly as its own type did.
 */
export function declaredMcpHeaderMethodFor(
  install: Pick<WorkspaceMcpInstallRecord, "authType" | "manifestJson">,
  authType: McpAuthType,
): McpHeaderAuthMethod | null {
  const { methods, declared } = mcpInstallAuthMethods(install);
  if (!declared) {
    return null;
  }
  for (const method of methods) {
    if (method.type !== "header") {
      continue;
    }
    if (authType === "bearer" && method.scheme === "bearer") {
      return method;
    }
    if (authType === "api_key_header" && method.scheme !== "bearer") {
      return method;
    }
  }
  return null;
}
