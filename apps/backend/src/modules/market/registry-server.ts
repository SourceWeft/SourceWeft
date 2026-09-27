import type {
  RegistryInput,
  RegistryPackage,
  RegistryRemote,
  RegistryServerJson,
} from "./types";

/**
 * The part of an upstream `server.json` (a registry entry, or the file a
 * submitted repository ships) that is kept in the version's provenance as
 * `registryServer`: its packages and remotes. The manifest has neither, and
 * they are the only record of the settings a server asks for — which is what
 * its AI overview (`overview/input.ts`) needs to say what it requires.
 *
 * Only what those entries ARE is kept: registry type, package identifier and
 * version, runtime hint, transport type, a remote's endpoint without its query,
 * and for every environment variable and header its NAME, description and
 * required/secret flags. A registry input can carry `value` or `default` — a
 * placeholder, or a real value pasted by mistake — so those, `placeholder`,
 * `valueHint`, `choices`, nested `variables` and the argument lists are never
 * copied. Strings are trimmed and capped, lists bounded.
 */
export type RegistryServerProvenance = Pick<
  RegistryServerJson,
  "packages" | "remotes"
>;

export const REGISTRY_SERVER_PROVENANCE_LIMITS = {
  packages: 10,
  remotes: 10,
  inputs: 50,
  nameChars: 128,
  descriptionChars: 500,
  tokenChars: 64,
  identifierChars: 200,
} as const;

const LIMITS = REGISTRY_SERVER_PROVENANCE_LIMITS;

/** The packages and remotes of `server`, or undefined when it has neither. */
export function registryServerProvenance(
  server: unknown,
): RegistryServerProvenance | undefined {
  if (!isRecord(server)) return undefined;
  const packages = arrayOf(server.packages)
    .flatMap((entry) => {
      const kept = keptPackage(entry);
      return kept ? [kept] : [];
    })
    .slice(0, LIMITS.packages);
  const remotes = arrayOf(server.remotes)
    .flatMap((entry) => {
      const kept = keptRemote(entry);
      return kept ? [kept] : [];
    })
    .slice(0, LIMITS.remotes);
  if (packages.length === 0 && remotes.length === 0) return undefined;
  return {
    ...(packages.length > 0 ? { packages } : {}),
    ...(remotes.length > 0 ? { remotes } : {}),
  };
}

function keptPackage(entry: unknown): RegistryPackage | undefined {
  if (!isRecord(entry)) return undefined;
  const transport = isRecord(entry.transport) ? entry.transport : null;
  const headers = keptInputs(transport?.headers);
  const environmentVariables = keptInputs(entry.environmentVariables);
  const kept: RegistryPackage = withoutEmpty({
    registryType: text(entry.registryType, LIMITS.tokenChars),
    identifier: text(entry.identifier, LIMITS.identifierChars),
    version: text(entry.version, LIMITS.tokenChars),
    runtimeHint: text(entry.runtimeHint, LIMITS.tokenChars),
    transport: transport
      ? withoutEmpty({
          type: text(transport.type, LIMITS.tokenChars),
          headers,
        })
      : undefined,
    environmentVariables,
  });
  return Object.keys(kept).length > 0 ? kept : undefined;
}

function keptRemote(entry: unknown): RegistryRemote | undefined {
  if (!isRecord(entry)) return undefined;
  const kept: RegistryRemote = withoutEmpty({
    type: text(entry.type, LIMITS.tokenChars),
    url: endpoint(entry.url),
    headers: keptInputs(entry.headers),
  });
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** Name, description and flags of each input with a name; nothing else. */
function keptInputs(value: unknown): RegistryInput[] | undefined {
  const inputs = arrayOf(value)
    .flatMap((entry): RegistryInput[] => {
      if (!isRecord(entry)) return [];
      const name = text(entry.name, LIMITS.nameChars);
      if (!name) return [];
      return [
        withoutEmpty({
          name,
          description: text(entry.description, LIMITS.descriptionChars),
          format: text(entry.format, LIMITS.tokenChars),
          isRequired: entry.isRequired === true ? true : undefined,
          isSecret: entry.isSecret === true ? true : undefined,
        }),
      ];
    })
    .slice(0, LIMITS.inputs);
  return inputs.length > 0 ? inputs : undefined;
}

/**
 * An http(s) endpoint without credentials, query or fragment; undefined
 * otherwise. A templated one ("https://{tenant}.example.com/mcp") is not a
 * URL to the parser, and is kept the same way as long as it has no
 * credentials part.
 */
function endpoint(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const raw = value.trim();
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username || url.password) return undefined;
    return `${url.origin}${url.pathname}`.slice(0, LIMITS.identifierChars);
  } catch {
    const withoutQuery = raw.split(/[?#]/)[0]!;
    return /^https?:\/\/[^\s@/]+(?:\/[^\s]*)?$/i.test(withoutQuery)
      ? withoutQuery.slice(0, LIMITS.identifierChars)
      : undefined;
  }
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return Array.from(trimmed).slice(0, max).join("");
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutEmpty<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, item]) =>
        item !== undefined &&
        !(isRecord(item) && Object.keys(item).length === 0),
    ),
  ) as T;
}
