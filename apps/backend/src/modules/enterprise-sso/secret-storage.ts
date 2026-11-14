import type {
  BetterAuthPlugin,
  DBTransactionAdapter,
  Where,
} from "better-auth";
import { parseSecretPayload } from "../../shared/secrets";
import { decryptTeamSecret, encryptTeamSecret } from "../../shared/team-secrets";

/**
 * Transparent per-team encryption for the OIDC `clientSecret` the SSO plugin
 * persists inside `ssoProvider.oidcConfig`.
 *
 * The `@better-auth/sso` plugin serializes `oidcConfig` to a JSON string and
 * writes it straight through the better-auth adapter; better-auth's
 * `databaseHooks` do not cover plugin tables, so the only place to intercept
 * is the adapter itself. {@link ssoSecretStoragePlugin} wraps the adapter so
 * that, for model `ssoProvider`, the `clientSecret` is sealed with the owning
 * team's envelope key on the way in (`create` / `update`) and opened again on
 * the way out (`findOne` / `findMany`), including the plugin's transactional
 * paths (`runWithTransaction` / `getCurrentAdapter`), which run against the
 * same wrapped adapter.
 *
 * The sealed value is the team-secrets ciphertext with a `swenc:` prefix. A
 * value without that prefix is treated as legacy plaintext: `open` returns it
 * verbatim, and `seal` is idempotent, so such a row is re-sealed the next time
 * it is written. `organizationId` is the team id; a provider with a
 * `clientSecret` but no organization fails closed (team-secrets refuses an
 * empty team id) rather than storing plaintext.
 */
export const SEALED_SECRET_PREFIX = "swenc:";

const SSO_PROVIDER_MODEL = "ssoProvider";

// team-secrets seals with its `v2` envelope payload (`encryptTeamSecret`), so a
// sealed clientSecret is `swenc:` + a well-formed `v2:iv:tag:ct` payload.
const TEAM_SECRET_ENVELOPE_PREFIX = "v2";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The clientSecret of a parsed OIDC config, when it is a non-empty string. */
function clientSecretOf(config: Record<string, unknown>): string | null {
  const secret = config.clientSecret;
  return typeof secret === "string" && secret.length > 0 ? secret : null;
}

/**
 * Whether a clientSecret value is one we actually sealed: the `swenc:` prefix
 * followed by a structurally valid team-secrets envelope payload. A plaintext
 * secret that merely starts with `swenc:` (e.g. `"swenc:not-a-real-payload"`)
 * fails the payload parse and is therefore treated as plaintext, so it gets
 * sealed rather than mistaken for existing ciphertext.
 */
function isSealedClientSecret(value: string): boolean {
  if (!value.startsWith(SEALED_SECRET_PREFIX)) {
    return false;
  }
  try {
    parseSecretPayload(
      value.slice(SEALED_SECRET_PREFIX.length),
      TEAM_SECRET_ENVELOPE_PREFIX,
    );
    return true;
  } catch {
    return false;
  }
}

/** Drop the `clientSecret` field from an OIDC config JSON string, if present. */
function stripOidcClientSecret(oidcConfigJson: string): string {
  const parsed = JSON.parse(oidcConfigJson) as unknown;
  if (!isRecord(parsed) || !("clientSecret" in parsed)) {
    return oidcConfigJson;
  }
  const { clientSecret: _clientSecret, ...rest } = parsed;
  return JSON.stringify(rest);
}

/**
 * Seal the `clientSecret` inside an OIDC config JSON string with the team's
 * envelope key. Idempotent: an already-sealed secret (or a config without a
 * `clientSecret`, e.g. `private_key_jwt`) is returned unchanged, so re-sealing
 * never double-encrypts. Every other field is preserved.
 */
export async function sealOidcConfig(
  oidcConfigJson: string,
  organizationId: string,
): Promise<string> {
  if (!oidcConfigJson) {
    return oidcConfigJson;
  }
  const parsed = JSON.parse(oidcConfigJson) as unknown;
  if (!isRecord(parsed)) {
    return oidcConfigJson;
  }
  const clientSecret = clientSecretOf(parsed);
  if (!clientSecret || isSealedClientSecret(clientSecret)) {
    return oidcConfigJson;
  }
  const sealed = `${SEALED_SECRET_PREFIX}${await encryptTeamSecret(
    clientSecret,
    organizationId,
  )}`;
  return JSON.stringify({ ...parsed, clientSecret: sealed });
}

/**
 * Reverse {@link sealOidcConfig}: decrypt a `swenc:`-prefixed `clientSecret`
 * with the team's envelope key. A value without the prefix is legacy plaintext
 * and is returned verbatim. Opening a sealed secret with the wrong team id
 * fails (team-secrets rejects the authentication), which is the intended
 * cross-team isolation.
 */
export async function openOidcConfig(
  oidcConfigJson: string,
  organizationId: string,
): Promise<string> {
  if (!oidcConfigJson) {
    return oidcConfigJson;
  }
  const parsed = JSON.parse(oidcConfigJson) as unknown;
  if (!isRecord(parsed)) {
    return oidcConfigJson;
  }
  const clientSecret = parsed.clientSecret;
  if (typeof clientSecret !== "string" || !isSealedClientSecret(clientSecret)) {
    return oidcConfigJson;
  }
  const opened = await decryptTeamSecret(
    clientSecret.slice(SEALED_SECRET_PREFIX.length),
    organizationId,
  );
  return JSON.stringify({ ...parsed, clientSecret: opened });
}

/** Whether a config JSON string carries a clientSecret that still needs sealing. */
function hasUnsealedSecret(oidcConfigJson: unknown): boolean {
  if (typeof oidcConfigJson !== "string" || !oidcConfigJson) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(oidcConfigJson);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) {
    return false;
  }
  const clientSecret = clientSecretOf(parsed);
  return Boolean(clientSecret && !isSealedClientSecret(clientSecret));
}

type AdapterRow = Record<string, unknown>;

/** Read a row's `organizationId` (the team id), when present as a string. */
function organizationIdOf(row: AdapterRow | null | undefined): string {
  const organizationId = row?.organizationId;
  return typeof organizationId === "string" ? organizationId : "";
}

/** Open the `oidcConfig` of an `ssoProvider` row read out of the adapter. */
async function openRow(row: AdapterRow): Promise<AdapterRow> {
  const { oidcConfig } = row;
  if (typeof oidcConfig !== "string" || !oidcConfig) {
    return row;
  }
  return {
    ...row,
    oidcConfig: await openOidcConfig(oidcConfig, organizationIdOf(row)),
  };
}

/**
 * The subset of adapter methods this wrapper rewrites, typed loosely so the
 * same closures serve both the top-level adapter and a transaction adapter
 * without fighting better-auth's generic method signatures.
 */
type LooseAdapter = {
  create: (args: {
    model: string;
    data: AdapterRow;
    select?: string[];
  }) => Promise<AdapterRow>;
  update: (args: {
    model: string;
    where: Where[];
    update: AdapterRow;
  }) => Promise<AdapterRow | null>;
  findOne: (args: {
    model: string;
    where: Where[];
    select?: string[];
  }) => Promise<AdapterRow | null>;
  findMany: (args: { model: string }) => Promise<AdapterRow[]>;
  transaction?: <R>(
    callback: (trx: DBTransactionAdapter) => Promise<R>,
  ) => Promise<R>;
};

/**
 * Wrap a better-auth adapter so that `ssoProvider` secrets are sealed on write
 * and opened on read, leaving every other model and method untouched. A
 * `Proxy` is used so unrelated adapter methods — the ones every other auth
 * table depends on — pass straight through, and so a transaction adapter is
 * re-wrapped recursively (the plugin runs secret mutations inside
 * `runWithTransaction`, whose transaction adapter must seal too).
 */
function wrapAdapter<T extends DBTransactionAdapter>(adapter: T): T {
  const base = adapter as unknown as LooseAdapter;

  const handler: ProxyHandler<T> = {
    get(target, property, receiver) {
      switch (property) {
        case "create":
          return async (args: {
            model: string;
            data: AdapterRow;
            select?: string[];
          }) => {
            if (args.model !== SSO_PROVIDER_MODEL) {
              return base.create(args);
            }
            let data = args.data;
            if (typeof data.oidcConfig === "string" && data.oidcConfig) {
              data = {
                ...data,
                oidcConfig: await sealOidcConfig(
                  data.oidcConfig,
                  organizationIdOf(data),
                ),
              };
            }
            const created = await base.create({ ...args, data });
            // The create return surfaces only in the register HTTP response (the
            // plugin reads the stored secret back via findOne, never from this
            // return), and the client secret must never be returned by the API —
            // so drop it from the echoed row.
            if (
              typeof created.oidcConfig === "string" &&
              created.oidcConfig
            ) {
              return {
                ...created,
                oidcConfig: stripOidcClientSecret(created.oidcConfig),
              };
            }
            return created;
          };
        case "update":
          return async (args: {
            model: string;
            where: Where[];
            update: AdapterRow;
          }) => {
            if (
              args.model !== SSO_PROVIDER_MODEL ||
              typeof args.update.oidcConfig !== "string" ||
              !args.update.oidcConfig
            ) {
              return base.update(args);
            }
            // organizationId is not part of an update that only touches the
            // config, so resolve it from the row — but only when a secret
            // actually needs sealing, so a scopes-only update (whose carried
            // secret is already sealed) stays a no-op and reads nothing.
            let organizationId = organizationIdOf(args.update);
            if (!organizationId && hasUnsealedSecret(args.update.oidcConfig)) {
              organizationId = organizationIdOf(
                await base.findOne({
                  model: SSO_PROVIDER_MODEL,
                  where: args.where,
                }),
              );
            }
            const oidcConfig = await sealOidcConfig(
              args.update.oidcConfig,
              organizationId,
            );
            return base.update({
              ...args,
              update: { ...args.update, oidcConfig },
            });
          };
        case "findOne":
          return async (args: {
            model: string;
            where: Where[];
            select?: string[];
          }) => {
            const row = await base.findOne(args);
            if (args.model !== SSO_PROVIDER_MODEL || !row) {
              return row;
            }
            return openRow(row);
          };
        case "findMany":
          return async (args: { model: string }) => {
            const rows = await base.findMany(args);
            if (args.model !== SSO_PROVIDER_MODEL || !Array.isArray(rows)) {
              return rows;
            }
            return Promise.all(rows.map(openRow));
          };
        case "transaction": {
          const runTransaction = base.transaction;
          if (typeof runTransaction !== "function") {
            return Reflect.get(target, property, receiver);
          }
          return <R>(
            callback: (trx: DBTransactionAdapter) => Promise<R>,
          ): Promise<R> =>
            runTransaction((trx) => callback(wrapAdapter(trx)));
        }
        default:
          return Reflect.get(target, property, receiver);
      }
    },
  };

  return new Proxy(adapter, handler);
}

/**
 * A better-auth plugin whose only job is to wrap the context adapter with
 * {@link wrapAdapter}. Registered alongside the SSO plugin, its `init` runs
 * before better-auth rebuilds `internalAdapter` from `context.adapter`, so the
 * whole stack — the SSO endpoints and the internal adapter — sees the sealing
 * wrapper. The `database` option stays a raw connection, so `auth migrate`
 * (which needs a Kysely database, not an adapter) keeps working.
 */
export function ssoSecretStoragePlugin(): BetterAuthPlugin {
  return {
    id: "sso-secret-storage",
    init(ctx) {
      return {
        context: { adapter: wrapAdapter(ctx.adapter) },
      };
    },
  };
}
