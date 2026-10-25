/**
 * Secret masking: what a `wrap` request's `secrets` are allowed to look like, and how they are
 * handed to srt's credential machinery without the real value ever leaving the sidecar.
 *
 * The model. The sandboxed command sees only a placeholder (`fake_value_<uuid>`) in the
 * environment variable the secret is bound to. srt's TLS-terminating proxy swaps the placeholder
 * for the real value inside requests to the secret's own hosts, and nowhere else. srt would
 * normally read the real value from this process's environment; the sidecar never does that,
 * because every environment variable of the sidecar is inherited by things it spawns. Instead each
 * secret is registered programmatically in srt's sentinel registry for the duration of one
 * command, and the registry is cleared at `cleanup`.
 *
 * What may reach the outside: the placeholder (`secretEnv`, returned to the host, which puts it in
 * the command's environment). What may not: the value. It is not logged, not audited, not placed
 * in argv or in `env`, and no error raised here mentions it; every message names a position in
 * the list (`secrets[2]`), never content.
 */
import { isIP } from "node:net";
import {
  isValidAllowedDomainEntry,
  splitDomainPatternPort,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js";
import type { SidecarErrorCode, WrapSecret } from "./protocol.js";

/** The most secrets one command may carry. */
const MAX_SECRETS = 20;
/** The longest secret value, in UTF-8 bytes. */
const MAX_VALUE_BYTES = 4096;
/** The most hosts one secret may be bound to. */
const MAX_HOSTS = 50;
/**
 * The most distinct hosts across all of one command's secrets (the vault counts the same way). The host adds every bound host to the
 * command's network allow list (which the sidecar caps at 500 entries), so this leaves room
 * for the user's own rules.
 */
const MAX_TOTAL_HOSTS = 200;
/** The longest environment variable name. */
const MAX_NAME_LENGTH = 128;
const NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** A secrets problem that already carries the `SidecarErrorCode` to report on the wire. */
export class SecretsError extends Error {
  constructor(
    readonly code: SidecarErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SecretsError";
  }
}

/** The part of srt's `SentinelRegistry` this module uses; tests pass the real class. */
export type SentinelRegistryLike = {
  register(name: string, realValue: string, injectHosts: readonly string[]): string;
};

const bad = (message: string): SecretsError => new SecretsError("BAD_REQUEST", message);

/**
 * A host a secret may be bound to: an exact domain name srt accepts, with no wildcard (a pattern
 * such as `*.github.io` or `*.vercel.app` would hand the secret to every tenant of a shared
 * suffix, and even a narrow one widens what a leaked placeholder can reach), no port (srt matches
 * secret hosts by name only, so a port would silently never match) and no IP literal (a
 * placeholder bound to an address cannot be told apart from its spellings).
 */
function isBindableHost(entry: string): boolean {
  if (entry.includes("*")) return false;
  if (!isValidAllowedDomainEntry(entry)) return false;
  const { hostPattern, port } = splitDomainPatternPort(entry);
  if (port !== undefined) return false;
  return isIP(hostPattern.replace(/^\[|\]$/g, "")) === 0 && !entry.startsWith("[");
}

/**
 * Validates the `secrets` of a `wrap` request: at most 20; names `[A-Z_][A-Z0-9_]*` and unique;
 * values non-empty, at most 4096 bytes and free of control characters (a value is put into an HTTP
 * header, where a line break would let it forge headers); one to 50 bound hosts (200 across all
 * the secrets) that each pass `isValidAllowedDomainEntry` and are exact names: no wildcard, no port,
 * no IP literal; and a boolean `readOnly`. Returns plain copies. Throws `BAD_REQUEST` without ever quoting a value.
 */
export function parseSecrets(value: unknown): WrapSecret[] {
  if (!Array.isArray(value)) throw bad("\"wrap\" request secrets must be an array");
  if (value.length > MAX_SECRETS) {
    throw bad(`"wrap" request secrets must have at most ${MAX_SECRETS} entries`);
  }
  const seen = new Set<string>();
  /** Distinct hosts so far, letter case ignored; the same host bound to several secrets counts once. */
  const distinctHosts = new Set<string>();
  return value.map((raw: unknown, index): WrapSecret => {
    const at = `secrets[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw bad(`${at} must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    const { envVar, value: secretValue, hosts, readOnly } = entry;
    if (typeof envVar !== "string" || envVar.length > MAX_NAME_LENGTH || !NAME_PATTERN.test(envVar)) {
      throw bad(`${at}.envVar must match ${NAME_PATTERN.source} (at most ${MAX_NAME_LENGTH} characters)`);
    }
    if (seen.has(envVar)) throw bad(`${at}.envVar repeats an earlier secret's name`);
    seen.add(envVar);
    if (typeof secretValue !== "string" || secretValue === "") {
      throw bad(`${at}.value must be a non-empty string`);
    }
    if (Buffer.byteLength(secretValue, "utf8") > MAX_VALUE_BYTES) {
      throw bad(`${at}.value must be at most ${MAX_VALUE_BYTES} bytes`);
    }
    if (/\p{Cc}/u.test(secretValue)) throw bad(`${at}.value must not contain control characters`);
    if (!Array.isArray(hosts) || hosts.length === 0 || hosts.length > MAX_HOSTS) {
      throw bad(`${at}.hosts must be an array of 1 to ${MAX_HOSTS} domain patterns`);
    }
    for (const host of hosts) {
      if (typeof host !== "string" || !isBindableHost(host)) {
        throw bad(`${at}.hosts entries must be exact domain names: no wildcard, port or IP literal`);
      }
    }
    for (const host of hosts as string[]) distinctHosts.add(host.toLowerCase());
    if (distinctHosts.size > MAX_TOTAL_HOSTS) {
      throw bad(
        `"wrap" request secrets must bind at most ${MAX_TOTAL_HOSTS} distinct hosts across all secrets`,
      );
    }
    if (typeof readOnly !== "boolean") throw bad(`${at}.readOnly must be a boolean`);
    return { envVar, value: secretValue, hosts: [...(hosts as string[])], readOnly };
  });
}

/** Throws `POLICY_INVALID` when `secrets` is non-empty but TLS termination is not active. */
export function assertSecretsAllowed(secrets: readonly WrapSecret[], tlsActive: boolean): void {
  if (secrets.length > 0 && !tlsActive) {
    // Without termination an HTTPS request is an opaque tunnel: the proxy could not substitute the
    // placeholder, so the command would send it upstream as-is. Say so now rather than run it.
    throw new SecretsError(
      "POLICY_INVALID",
      "secrets need TLS termination, but this sidecar was started without init.tls",
    );
  }
}

/**
 * Registers each secret in `registry` bound to its own hosts and returns the placeholder to put in
 * each secret's environment variable: `{ [envVar]: "fake_value_<uuid>" }`. Registering a name
 * again keeps its placeholder and replaces the value and hosts. Refuses when `tlsActive` is false.
 */
export function registerSecrets(
  registry: SentinelRegistryLike,
  secrets: readonly WrapSecret[],
  tlsActive: boolean,
): Record<string, string> {
  assertSecretsAllowed(secrets, tlsActive);
  const secretEnv: Record<string, string> = {};
  for (const secret of secrets) {
    secretEnv[secret.envVar] = registry.register(secret.envVar, secret.value, secret.hosts);
  }
  return secretEnv;
}
