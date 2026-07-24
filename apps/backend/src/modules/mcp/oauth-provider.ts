import { randomUUID } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * Persistence for one MCP OAuth session, scoped by the caller to a single
 * (install, user) — and, for the DCR client record, to a single server. The
 * provider is pure logic over this store; the DB-backed implementation lives in
 * the repository layer.
 */
export interface McpOAuthStore {
  loadClientInformation(): Promise<OAuthClientInformationFull | undefined>;
  saveClientInformation(info: OAuthClientInformationFull): Promise<void>;
  loadTokens(): Promise<OAuthTokens | undefined>;
  saveTokens(tokens: OAuthTokens): Promise<void>;
  loadCodeVerifier(): Promise<string | undefined>;
  saveCodeVerifier(verifier: string): Promise<void>;
  loadState(): Promise<string | undefined>;
  saveState(state: string): Promise<void>;
}

export interface McpOAuthProviderOptions {
  /** Our callback URL, registered with confidential providers / sent on DCR. */
  redirectUrl: string;
  /** Client name advertised during registration / authorization. */
  clientName: string;
  scope?: string;
  /**
   * The discovered authorization-server issuer this provider is bound to. Used
   * to select — and strictly scope — any pre-configured client.
   */
  issuer: string;
  /**
   * Pre-configured confidential/public clients, keyed by issuer origin (from
   * config). The provider itself does the issuer match, so a secret can never
   * leak to a server whose issuer differs from the one it was registered for.
   */
  configuredClients: Record<string, { clientId: string; clientSecret?: string }>;
  store: McpOAuthStore;
  /** Captures the authorization URL so the route can redirect the user to it. */
  onRedirect?: (url: URL) => void;
}

/**
 * MCP OAuth client provider (RFC 6749/8414/9728 + PKCE) for the MCP SDK's
 * `auth()`. Prefers, in order: a config-provided client bound to this exact
 * issuer (for providers without Dynamic Client Registration, e.g. Stripe /
 * GitHub) → a previously DCR-registered client → dynamic registration. A
 * configured `client_secret` is only ever offered to its matching issuer.
 */
export class McpOAuthClientProvider implements OAuthClientProvider {
  private readonly configured?: { clientId: string; clientSecret?: string };

  constructor(private readonly opts: McpOAuthProviderOptions) {
    let origin: string | null = null;
    try {
      origin = new URL(opts.issuer).origin;
    } catch {
      origin = null;
    }
    this.configured = origin ? opts.configuredClients[origin] : undefined;
  }

  get redirectUrl(): string {
    return this.opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.opts.clientName,
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Confidential only when we actually hold a secret for this issuer;
      // otherwise a public client relying on PKCE.
      token_endpoint_auth_method: this.configured?.clientSecret
        ? "client_secret_post"
        : "none",
      ...(this.opts.scope ? { scope: this.opts.scope } : {}),
    };
  }

  async clientInformation(): Promise<
    OAuthClientInformation | OAuthClientInformationFull | undefined
  > {
    // A configured client bound to this issuer wins and is never subject to DCR.
    if (this.configured) {
      return this.configured.clientSecret
        ? {
            client_id: this.configured.clientId,
            client_secret: this.configured.clientSecret,
          }
        : { client_id: this.configured.clientId };
    }
    // Otherwise reuse a client this server previously issued us via DCR.
    return this.opts.store.loadClientInformation();
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    // Reached only on the DCR path; never overwrite a configured client.
    if (this.configured) {
      return;
    }
    await this.opts.store.saveClientInformation(info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.opts.store.loadTokens();
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.opts.store.saveTokens(tokens);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.opts.onRedirect?.(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.opts.store.saveCodeVerifier(codeVerifier);
  }

  async codeVerifier(): Promise<string> {
    const verifier = await this.opts.store.loadCodeVerifier();
    if (!verifier) {
      throw new Error("Missing PKCE code verifier for MCP OAuth flow");
    }
    return verifier;
  }

  async state(): Promise<string> {
    const existing = await this.opts.store.loadState();
    if (existing) {
      return existing;
    }
    const generated = randomUUID();
    await this.opts.store.saveState(generated);
    return generated;
  }
}
