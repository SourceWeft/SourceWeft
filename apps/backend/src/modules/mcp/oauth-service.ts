import {
  auth,
  discoverOAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { config } from "../../shared/config";
import { McpError } from "./errors";
import { McpOAuthClientProvider } from "./oauth-provider";
import {
  clearMcpOAuthTransient,
  createDbMcpOAuthStore,
  findMcpOAuthSessionByState,
  getMcpOAuthStatus,
  type McpOAuthScope,
} from "./oauth-repository";
import { requireMcpWorkspace } from "./permissions";
import { findWorkspaceMcpInstall } from "./repository";
import { assertSafeMcpEndpoint } from "./security";
import { createMcpRequestScope } from "./network";

/**
 * The OAuth flow fetches URLs the tool-execution path never touches — the
 * endpoint's well-known documents, the authorization-server metadata, and the
 * token endpoint — so it needs the same SSRF discipline as
 * buildLangChainToolsForTurn: validate the stored endpoint at use time AND
 * validate the issuer the (untrusted) endpoint's metadata declares, or a
 * malicious server could steer our discovery/token fetches at internal or
 * cloud-metadata addresses.
 */
async function assertSafeOAuthUrl(value: string) {
  await assertSafeMcpEndpoint(value, {
    enforceAddressChecks: config.endpointAddressChecksEnabled,
    allowedInternalOrigins: config.mcpAllowedInternalOrigins,
  });
}

/**
 * Resolve the authorization-server issuer for an MCP endpoint: prefer the
 * protected-resource metadata (RFC 9728), else fall back to the endpoint origin
 * for servers that host their own authorization endpoints. The declared issuer
 * is attacker-influenced (it comes from the endpoint's own metadata), so it is
 * SSRF-validated before anything fetches from it.
 */
async function discoverIssuer(
  endpointUrl: string,
  requests: ReturnType<typeof createMcpRequestScope>,
): Promise<string> {
  try {
    const metadata = await discoverOAuthProtectedResourceMetadata(
      endpointUrl,
      undefined,
      requests.fetch,
    );
    const issuer = metadata?.authorization_servers?.[0];
    if (issuer) {
      await assertSafeOAuthUrl(issuer);
      return issuer;
    }
  } catch (error) {
    requests.throwIfDenied();
    if (error instanceof McpError) {
      // The declared issuer failed SSRF validation — refuse, don't fall back.
      throw error;
    }
    // No protected-resource metadata document; fall through.
  }
  return new URL(endpointUrl).origin;
}

function buildProvider(
  scope: McpOAuthScope,
  issuer: string,
  onRedirect?: (url: URL) => void,
) {
  return new McpOAuthClientProvider({
    redirectUrl: config.mcpOAuth.redirectUrl,
    clientName: config.mcpOAuth.clientName,
    issuer,
    configuredClients: config.mcpOAuth.clients,
    store: createDbMcpOAuthStore(scope, issuer),
    onRedirect,
  });
}

/**
 * Begin the OAuth authorization-code flow for an install: discover the issuer,
 * (dynamically) register or select a client, generate PKCE, and return the
 * authorization URL to send the user to. Returns "connected" if valid tokens
 * already exist.
 */
export async function startMcpOAuthAuthorization(input: {
  workspaceId: string;
  userId: string;
  installId: string;
}): Promise<
  { status: "redirect"; authorizationUrl: string } | { status: "connected" }
> {
  const { workspace } = await requireMcpWorkspace({
    workspaceId: input.workspaceId,
    userId: input.userId,
    permission: "mcp.manage",
  });
  const install = await findWorkspaceMcpInstall({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    installId: input.installId,
  });
  if (!install) {
    throw new McpError(404, "MCP_INSTALL_NOT_FOUND", "MCP install not found");
  }
  if (install.authType !== "oauth") {
    throw new McpError(
      400,
      "MCP_OAUTH_NOT_APPLICABLE",
      "This MCP server is not configured for OAuth",
    );
  }
  if (!install.endpointUrl) {
    throw new McpError(
      400,
      "MCP_ENDPOINT_REQUIRED",
      "MCP endpoint is required",
    );
  }
  // Execution-time SSRF re-check, mirroring the tool path: the stored endpoint
  // may have been repointed (DNS or re-install) since install time.
  await assertSafeOAuthUrl(install.endpointUrl);

  const scope: McpOAuthScope = {
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    installId: install.id,
    userId: input.userId,
  };
  if ((await getMcpOAuthStatus(scope)).connected) {
    return { status: "connected" };
  }

  const requests = createMcpRequestScope();
  try {
    const issuer = await discoverIssuer(install.endpointUrl, requests);
    let authorizationUrl: string | null = null;
    const provider = buildProvider(scope, issuer, (url) => {
      authorizationUrl = url.toString();
    });

    const result = await auth(provider, {
      serverUrl: install.endpointUrl,
      fetchFn: requests.fetch,
    });
    requests.throwIfDenied();
    if (result === "AUTHORIZED") {
      // The SDK found still-valid tokens and skipped the redirect.
      return { status: "connected" };
    }
    if (!authorizationUrl) {
      throw new McpError(
        502,
        "MCP_OAUTH_NO_REDIRECT",
        "Authorization server did not produce a redirect URL",
      );
    }
    await assertSafeOAuthUrl(authorizationUrl);
    return { status: "redirect", authorizationUrl };
  } catch (error) {
    requests.throwIfDenied();
    throw error;
  } finally {
    await requests.close();
  }
}

/**
 * Finish the flow from the OAuth redirect: the `state` nonce both authenticates
 * the callback (CSRF) and identifies the (install, user); exchange the code for
 * tokens and clear the single-use PKCE/state.
 */
export async function completeMcpOAuthCallback(input: {
  code: string;
  state: string;
}): Promise<{ workspaceId: string; installId: string }> {
  const session = await findMcpOAuthSessionByState(input.state);
  if (!session) {
    throw new McpError(
      400,
      "MCP_OAUTH_STATE_INVALID",
      "Invalid or expired authorization state",
    );
  }
  const { scope } = session;
  const install = await findWorkspaceMcpInstall({
    teamId: scope.teamId,
    workspaceId: scope.workspaceId,
    installId: scope.installId,
  });
  if (!install?.endpointUrl) {
    throw new McpError(404, "MCP_INSTALL_NOT_FOUND", "MCP install not found");
  }
  await assertSafeOAuthUrl(install.endpointUrl);

  const requests = createMcpRequestScope();
  try {
    const issuer =
      session.issuer ?? (await discoverIssuer(install.endpointUrl, requests));
    if (session.issuer) {
      // A stored issuer is validated again at use time for the same reason.
      await assertSafeOAuthUrl(session.issuer);
    }
    const provider = buildProvider(scope, issuer);
    const result = await auth(provider, {
      serverUrl: install.endpointUrl,
      authorizationCode: input.code,
      fetchFn: requests.fetch,
    });
    requests.throwIfDenied();
    if (result !== "AUTHORIZED") {
      throw new McpError(
        502,
        "MCP_OAUTH_EXCHANGE_FAILED",
        "Token exchange did not complete",
      );
    }
    await clearMcpOAuthTransient(scope);
    // Credential status is now derived per-user (from this user's token-bearing
    // OAuth session), NOT written install-level: flipping the shared install flag
    // to "configured" here would make every other member appear connected. The
    // token we just stored is what a per-user overlay reads to report "configured"
    // for this user only.
    return { workspaceId: scope.workspaceId, installId: scope.installId };
  } catch (error) {
    requests.throwIfDenied();
    throw error;
  } finally {
    await requests.close();
  }
}
