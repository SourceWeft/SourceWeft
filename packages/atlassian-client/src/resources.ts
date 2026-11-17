// The accessible-sites list and identity lookup, both plain `api.atlassian.com`
// endpoints shared by Jira and Confluence (see Global Constraints / task brief).

import { AtlassianApiError } from "./errors";
import { atlassianApiGet, isCloudId, type AtlassianClientConfig } from "./http";

export type AtlassianSite = {
  cloudId: string;
  url: string;
  name: string;
  scopes: string[];
};

type AccessibleResource = {
  id?: string;
  url?: string;
  name?: string;
  scopes?: string[];
};

/** `GET /oauth/token/accessible-resources`, mapped, with entries whose id is
 * not a well-formed cloud id dropped, sorted by cloudId (R3 / R6: callers rely
 * on a stable site order). */
export async function listAccessibleResources(
  config: AtlassianClientConfig,
  accessToken: string,
): Promise<AtlassianSite[]> {
  const payload = (await atlassianApiGet(
    config,
    "/oauth/token/accessible-resources",
    accessToken,
  )) as AccessibleResource[];
  return payload
    .filter(
      (item): item is AccessibleResource & { id: string } =>
        typeof item.id === "string" && isCloudId(item.id),
    )
    .map((item) => ({
      cloudId: item.id,
      url: item.url ?? "",
      name: item.name ?? "",
      scopes: item.scopes ?? [],
    }))
    .sort((a, b) => a.cloudId.localeCompare(b.cloudId));
}

export type AtlassianIdentity = {
  accountId: string;
  email: string | null;
  name: string | null;
};

type MePayload = {
  account_id?: string;
  email?: string;
  name?: string;
};

/** `GET /me`. A response without `account_id` means the token cannot identify
 * the user, so it is treated the same as an expired/revoked token. */
export async function getMe(
  config: AtlassianClientConfig,
  accessToken: string,
): Promise<AtlassianIdentity> {
  const payload = (await atlassianApiGet(config, "/me", accessToken)) as MePayload;
  if (typeof payload.account_id !== "string" || payload.account_id.length === 0) {
    throw new AtlassianApiError(
      401,
      `${config.errorPrefix}_REAUTH_REQUIRED`,
      "Atlassian identity is missing an account id",
    );
  }
  return {
    accountId: payload.account_id,
    email: payload.email ?? null,
    name: payload.name ?? null,
  };
}
