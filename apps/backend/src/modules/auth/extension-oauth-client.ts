import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

const EXTENSION_CLIENT_NAME = "SourceWeft Browser Extension";
const EXTENSION_CLIENT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
] as const;
const EXTENSION_CLIENT_GRANTS = [
  "authorization_code",
  "refresh_token",
] as const;
const EXTENSION_CLIENT_RESPONSES = ["code"] as const;
const EXTENSION_CLIENT_METADATA = {
  managedBy: "sourceweft",
  purpose: "browser-extension",
} as const;

export type ExtensionOAuthClientInput = {
  clientId: string;
  redirectUri: string;
  resource: string;
};

type OAuthClientRow = {
  clientId: string;
  clientSecret: string | null;
  clientDiscoveryId: string | null;
  disabled: boolean | null;
  skipConsent: boolean | null;
  enableEndSession: boolean | null;
  subjectType: string | null;
  scopes: unknown;
  clientCredentialsScopes: unknown;
  userId: string | null;
  name: string | null;
  redirectUris: unknown;
  postLogoutRedirectUris: unknown;
  backchannelLogoutUri: string | null;
  backchannelLogoutSessionRequired: boolean | null;
  tokenEndpointAuthMethod: string | null;
  applicationType: string | null;
  jwks: string | null;
  jwksUri: string | null;
  grantTypes: unknown;
  responseTypes: unknown;
  requirePKCE: boolean | null;
  dpopBoundAccessTokens: boolean | null;
  referenceId: string | null;
  metadata: unknown;
};

function sortedStrings(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }

  return [...value].sort();
}

function sameStringSet(value: unknown, expected: readonly string[]) {
  const actual = sortedStrings(value);
  if (!actual) {
    return false;
  }

  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((item, index) => item === sortedExpected[index])
  );
}

function sameMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const metadata = value as Record<string, unknown>;
  return (
    Object.keys(metadata).length === 2 &&
    metadata.managedBy === EXTENSION_CLIENT_METADATA.managedBy &&
    metadata.purpose === EXTENSION_CLIENT_METADATA.purpose
  );
}

export function extensionOAuthClientMismatches(
  row: OAuthClientRow,
  input: ExtensionOAuthClientInput,
) {
  const mismatches: string[] = [];
  const expect = (matches: boolean, field: string) => {
    if (!matches) {
      mismatches.push(field);
    }
  };

  expect(row.clientId === input.clientId, "clientId");
  expect(row.clientSecret === null, "clientSecret");
  expect(row.clientDiscoveryId === null, "clientDiscoveryId");
  expect(row.disabled === false, "disabled");
  expect(row.skipConsent === false, "skipConsent");
  expect(row.enableEndSession === false, "enableEndSession");
  expect(row.subjectType === "public", "subjectType");
  expect(sameStringSet(row.scopes, EXTENSION_CLIENT_SCOPES), "scopes");
  expect(
    sameStringSet(row.clientCredentialsScopes, []),
    "clientCredentialsScopes",
  );
  expect(row.userId === null, "userId");
  expect(row.name === EXTENSION_CLIENT_NAME, "name");
  expect(sameStringSet(row.redirectUris, [input.redirectUri]), "redirectUris");
  expect(row.postLogoutRedirectUris === null, "postLogoutRedirectUris");
  expect(row.backchannelLogoutUri === null, "backchannelLogoutUri");
  expect(
    row.backchannelLogoutSessionRequired === false,
    "backchannelLogoutSessionRequired",
  );
  expect(row.tokenEndpointAuthMethod === "none", "tokenEndpointAuthMethod");
  expect(row.applicationType === "web", "applicationType");
  expect(row.jwks === null, "jwks");
  expect(row.jwksUri === null, "jwksUri");
  expect(sameStringSet(row.grantTypes, EXTENSION_CLIENT_GRANTS), "grantTypes");
  expect(
    sameStringSet(row.responseTypes, EXTENSION_CLIENT_RESPONSES),
    "responseTypes",
  );
  expect(row.requirePKCE === true, "requirePKCE");
  expect(row.dpopBoundAccessTokens === false, "dpopBoundAccessTokens");
  expect(row.referenceId === null, "referenceId");
  expect(sameMetadata(row.metadata), "metadata");

  return mismatches;
}

async function provisionInTransaction(
  client: PoolClient,
  input: ExtensionOAuthClientInput,
) {
  const resourceResult = await client.query<{
    identifier: string;
    disabled: boolean | null;
  }>(
    `
      select "identifier", "disabled"
      from "oauthResource"
      where "identifier" = $1
      for share
    `,
    [input.resource],
  );
  const resource = resourceResult.rows[0];
  if (!resource) {
    throw new Error(
      `Extension OAuth resource is not seeded: ${input.resource}`,
    );
  }
  if (resource.disabled !== false) {
    throw new Error(`Extension OAuth resource is disabled: ${input.resource}`);
  }

  const existingResult = await client.query<OAuthClientRow>(
    `
      select
        "clientId",
        "clientSecret",
        "clientDiscoveryId",
        "disabled",
        "skipConsent",
        "enableEndSession",
        "subjectType",
        "scopes",
        "clientCredentialsScopes",
        "userId",
        "name",
        "redirectUris",
        "postLogoutRedirectUris",
        "backchannelLogoutUri",
        "backchannelLogoutSessionRequired",
        "tokenEndpointAuthMethod",
        "applicationType",
        "jwks",
        "jwksUri",
        "grantTypes",
        "responseTypes",
        "requirePKCE",
        "dpopBoundAccessTokens",
        "referenceId",
        "metadata"
      from "oauthClient"
      where "clientId" = $1
      for update
    `,
    [input.clientId],
  );
  const existing = existingResult.rows[0];

  if (existing) {
    const mismatches = extensionOAuthClientMismatches(existing, input);
    if (mismatches.length > 0) {
      throw new Error(
        `Extension OAuth client configuration mismatch: ${mismatches.join(", ")}`,
      );
    }
  } else {
    const now = new Date();
    await client.query(
      `
        insert into "oauthClient" (
          "id",
          "clientId",
          "clientSecret",
          "clientDiscoveryId",
          "disabled",
          "skipConsent",
          "enableEndSession",
          "subjectType",
          "scopes",
          "clientCredentialsScopes",
          "userId",
          "createdAt",
          "updatedAt",
          "name",
          "redirectUris",
          "postLogoutRedirectUris",
          "backchannelLogoutUri",
          "backchannelLogoutSessionRequired",
          "tokenEndpointAuthMethod",
          "applicationType",
          "jwks",
          "jwksUri",
          "grantTypes",
          "responseTypes",
          "requirePKCE",
          "dpopBoundAccessTokens",
          "referenceId",
          "metadata"
        ) values (
          $1, $2, null, null, false, false, false, 'public',
          $3::jsonb, '[]'::jsonb, null, $4, $4, $5, $6::jsonb,
          null, null, false, 'none', 'web', null, null, $7::jsonb,
          $8::jsonb, true, false, null, $9::jsonb
        )
      `,
      [
        randomUUID(),
        input.clientId,
        JSON.stringify(EXTENSION_CLIENT_SCOPES),
        now,
        EXTENSION_CLIENT_NAME,
        JSON.stringify([input.redirectUri]),
        JSON.stringify(EXTENSION_CLIENT_GRANTS),
        JSON.stringify(EXTENSION_CLIENT_RESPONSES),
        JSON.stringify(EXTENSION_CLIENT_METADATA),
      ],
    );
  }

  const linksResult = await client.query<{ resourceId: string }>(
    `
      select "resourceId"
      from "oauthClientResource"
      where "clientId" = $1
      order by "resourceId"
      for update
    `,
    [input.clientId],
  );
  const links = linksResult.rows.map((row) => row.resourceId);
  if (links.length === 0) {
    await client.query(
      `
        insert into "oauthClientResource" (
          "id", "clientId", "resourceId", "metadata", "createdAt"
        ) values ($1, $2, $3, null, $4)
      `,
      [randomUUID(), input.clientId, input.resource, new Date()],
    );
    return { createdClient: !existing, createdLink: true };
  }

  if (links.length !== 1 || links[0] !== input.resource) {
    throw new Error(
      `Extension OAuth client resource mismatch: ${links.join(", ")}`,
    );
  }

  return { createdClient: !existing, createdLink: false };
}

export async function provisionExtensionOAuthClient(
  pool: Pool,
  input: ExtensionOAuthClientInput,
) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await provisionInTransaction(client, input);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
