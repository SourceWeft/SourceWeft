import {
  auth,
  discoverOAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { config } from "../../shared/config";
import { McpError } from "./errors";
import { McpOAuthClientProvider, type McpOAuthStore } from "./oauth-provider";
import {
  beginMcpOAuthAttempt,
  consumeMcpOAuthAttempt,
  createDbMcpOAuthStore,
  getMcpOAuthStatus,
  recordMcpOAuthCompletion,
  type McpOAuthScope,
} from "./oauth-repository";
import { parseMcpReturnTo } from "./oauth-return-to";
import { mcpInstallAllowsOAuth } from "./auth-methods";
import { requireMcpWorkspace } from "./permissions";
import {
  deleteWorkspaceMcpCredential,
  findWorkspaceMcpInstall,
} from "./repository";
import { assertSafeMcpEndpoint } from "./security";
import {
  createMcpRequestScope,
  MCP_OAUTH_EXCHANGE_DEADLINE_MS,
  MCP_OAUTH_START_DEADLINE_MS,
  withMcpRequestDeadline,
} from "./network";

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
  fetchFn: typeof globalThis.fetch,
): Promise<string> {
  try {
    const metadata = await discoverOAuthProtectedResourceMetadata(
      endpointUrl,
      undefined,
      fetchFn,
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
    // A deadline abort must end the attempt, not fall through to the origin.
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    // No protected-resource metadata document; fall through.
  }
  return new URL(endpointUrl).origin;
}

function buildProvider(
  scope: McpOAuthScope,
  issuer: string,
  options: { store?: McpOAuthStore; onRedirect?: (url: URL) => void } = {},
) {
  return new McpOAuthClientProvider({
    redirectUrl: config.mcpOAuth.redirectUrl,
    clientName: config.mcpOAuth.clientName,
    issuer,
    configuredClients: config.mcpOAuth.clients,
    store: options.store ?? createDbMcpOAuthStore(scope, issuer),
    onRedirect: options.onRedirect,
  });
}

/**
 * Begin the OAuth authorization-code flow for an install: discover the issuer,
 * (dynamically) register or select a client, generate PKCE and a fresh state,
 * record them as the pending attempt with its destination, and return the
 * authorization URL to send the user to. Returns "connected" if valid tokens
 * already exist. Everything before the redirect runs under one deadline that
 * aborts the in-flight requests (MCP_OAUTH_TIMEOUT).
 */
export async function startMcpOAuthAuthorization(input: {
  workspaceId: string;
  userId: string;
  installId: string;
  returnTo?: string;
}): Promise<
  { status: "redirect"; authorizationUrl: string } | { status: "connected" }
> {
  let returnTo: string | null = null;
  if (input.returnTo !== undefined) {
    returnTo = parseMcpReturnTo(input.returnTo);
    if (!returnTo) {
      throw new McpError(
        400,
        "MCP_OAUTH_RETURN_INVALID",
        "The return destination is not allowed",
      );
    }
  }
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
  if (!mcpInstallAllowsOAuth(install)) {
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
  const endpointUrl = install.endpointUrl;
  // Execution-time SSRF re-check, mirroring the tool path: the stored endpoint
  // may have been repointed (DNS or re-install) since install time.
  await assertSafeOAuthUrl(endpointUrl);

  const scope: McpOAuthScope = {
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    installId: install.id,
    userId: input.userId,
  };
  if ((await getMcpOAuthStatus(scope)).connected) {
    await deleteWorkspaceMcpCredential(scope);
    return { status: "connected" };
  }

  const requests = createMcpRequestScope();
  try {
    return await withMcpRequestDeadline(
      requests,
      {
        ms: MCP_OAUTH_START_DEADLINE_MS,
        timeoutError: () =>
          new McpError(
            504,
            "MCP_OAUTH_TIMEOUT",
            "The MCP server's sign-in did not answer in time",
          ),
      },
      async (fetchFn) => {
        const issuer = await discoverIssuer(endpointUrl, requests, fetchFn);
        let authorizationUrl: string | null = null;
        // PKCE verifier and state are captured in memory so each attempt gets a
        // fresh state (a persisted one would be reused across attempts) and the
        // whole attempt is stored atomically once the redirect is known.
        let state: string | null = null;
        let codeVerifier: string | null = null;
        const persistent = createDbMcpOAuthStore(scope, issuer);
        const provider = buildProvider(scope, issuer, {
          store: {
            ...persistent,
            loadState: async () => state ?? undefined,
            saveState: async (value) => {
              state = value;
            },
            loadCodeVerifier: async () => codeVerifier ?? undefined,
            saveCodeVerifier: async (value) => {
              codeVerifier = value;
            },
          },
          onRedirect: (url) => {
            authorizationUrl = url.toString();
          },
        });

        const result = await auth(provider, {
          serverUrl: endpointUrl,
          fetchFn,
        });
        requests.throwIfDenied();
        if (result === "AUTHORIZED") {
          // The SDK found still-valid tokens and skipped the redirect.
          await deleteWorkspaceMcpCredential(scope);
          return { status: "connected" as const };
        }
        if (!authorizationUrl) {
          throw new McpError(
            502,
            "MCP_OAUTH_NO_REDIRECT",
            "Authorization server did not produce a redirect URL",
          );
        }
        if (!state || !codeVerifier) {
          throw new McpError(
            502,
            "MCP_OAUTH_NO_REDIRECT",
            "Authorization server did not produce a redirect URL",
          );
        }
        await assertSafeOAuthUrl(authorizationUrl);
        await beginMcpOAuthAttempt(scope, {
          issuer,
          state,
          codeVerifier,
          returnTo,
        });
        return { status: "redirect" as const, authorizationUrl };
      },
    );
  } catch (error) {
    requests.throwIfDenied();
    throw error;
  } finally {
    await requests.close();
  }
}

export type McpOAuthCallbackOutcome =
  | {
      outcome: "connected";
      returnTo: string | null;
      completionRef: string;
    }
  | {
      outcome: "denied" | "failed";
      returnTo: string | null;
      /** A fixed, non-secret reason the destination page can show. */
      reason: "denied" | "timeout" | "failed";
    }
  | { outcome: "invalid" };

/**
 * Finish the flow from the OAuth redirect. The `state` is consumed first,
 * atomically and exactly once, so a replay, an expired attempt or an unknown
 * value ends at `invalid` and nothing else is read from the request. The
 * consumed attempt (user, workspace, install, issuer, PKCE verifier,
 * destination) is the only context used: membership and the install are
 * rechecked, the code is exchanged under a deadline, and success returns a
 * non-secret completion reference. A provider error or denial is handled
 * through the same bound attempt.
 */
export async function completeMcpOAuthCallback(input: {
  state: string;
  code?: string;
  providerError?: string;
}): Promise<McpOAuthCallbackOutcome> {
  const attempt = await consumeMcpOAuthAttempt(input.state);
  if (!attempt) {
    return { outcome: "invalid" };
  }
  const { scope, returnTo } = attempt;
  const failed = (
    reason: "denied" | "timeout" | "failed",
  ): McpOAuthCallbackOutcome => ({
    outcome: reason === "denied" ? "denied" : "failed",
    returnTo,
    reason,
  });
  if (input.providerError || !input.code) {
    return failed(input.providerError === "access_denied" ? "denied" : "failed");
  }

  let endpointUrl: string;
  try {
    // The member may have lost access, or the install been removed or
    // repointed, since the attempt started.
    const { workspace } = await requireMcpWorkspace({
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      permission: "mcp.manage",
    });
    if (workspace.organizationId !== scope.teamId) {
      return failed("failed");
    }
    const install = await findWorkspaceMcpInstall({
      teamId: scope.teamId,
      workspaceId: scope.workspaceId,
      installId: scope.installId,
    });
    if (!install?.endpointUrl || !mcpInstallAllowsOAuth(install)) {
      return failed("failed");
    }
    endpointUrl = install.endpointUrl;
    await assertSafeOAuthUrl(endpointUrl);
    // A stored issuer is validated again at use time for the same reason.
    if (attempt.issuer) {
      await assertSafeOAuthUrl(attempt.issuer);
    }
  } catch {
    return failed("failed");
  }

  const requests = createMcpRequestScope();
  try {
    await withMcpRequestDeadline(
      requests,
      {
        ms: MCP_OAUTH_EXCHANGE_DEADLINE_MS,
        timeoutError: () =>
          new McpError(
            504,
            "MCP_OAUTH_TIMEOUT",
            "The MCP server's sign-in did not answer in time",
          ),
      },
      async (fetchFn) => {
        const issuer =
          attempt.issuer ?? (await discoverIssuer(endpointUrl, requests, fetchFn));
        const persistent = createDbMcpOAuthStore(scope, issuer);
        const provider = buildProvider(scope, issuer, {
          // The verifier was consumed with the state; hand it to the exchange
          // in memory instead of leaving it stored.
          store: {
            ...persistent,
            loadCodeVerifier: async () => attempt.codeVerifier ?? undefined,
          },
        });
        const result = await auth(provider, {
          serverUrl: endpointUrl,
          authorizationCode: input.code,
          fetchFn,
        });
        requests.throwIfDenied();
        if (result !== "AUTHORIZED") {
          throw new McpError(
            502,
            "MCP_OAUTH_EXCHANGE_FAILED",
            "Token exchange did not complete",
          );
        }
      },
    );
  } catch (error) {
    return failed(
      error instanceof McpError && error.code === "MCP_OAUTH_TIMEOUT"
        ? "timeout"
        : "failed",
    );
  } finally {
    await requests.close();
  }

  // One connection method per member: OAuth replaces THIS member's static
  // credential for the install (e.g. an API key saved earlier), no one else's.
  await deleteWorkspaceMcpCredential(scope);
  // Credential status is derived per-user (from this user's token-bearing
  // OAuth session), NOT written install-level: flipping the shared install flag
  // to "configured" here would make every other member appear connected.
  const completionRef = await recordMcpOAuthCompletion(scope);
  return { outcome: "connected", returnTo, completionRef };
}
