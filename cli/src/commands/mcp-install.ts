import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { McpInspectError, UsageError } from "../errors";
import { renameWithRetry } from "../install/write";
import { boundInspectedTools, boundServerInfo } from "../mcp/bound";
import {
  buildMcpClientConfig,
  customHeaderNames,
  ENV_VAR_NAME,
  MCP_CLIENT_IDS,
  REMOTE_TRANSPORTS,
  mcpClientConfigKey,
  type McpClientConfig,
  type McpClientId,
} from "../mcp/client-config";
import { createHttpTransport } from "../mcp/http";
import { inspectServer, type InspectResult } from "../mcp/inspect";
import { createCredentialedFetch } from "../mcp/oauth/guard";
import { printable, redactSecrets } from "../mcp/oauth/redact";
import { isPrivateHost, isLoopbackHost } from "../mcp/oauth/trust";
import {
  RegistryError,
  type RegistryClient,
} from "../registry/client";
import type { McpManifestView } from "../registry/schema";
import { confirm, truncate } from "../ui";
import {
  inspectWithOAuth,
  type McpInspectContext,
} from "./mcp";

/**
 * `sourceweft mcp install` and `sourceweft mcp test`: the consumer side of the
 * catalog. Both read one public manifest from the registry and act on what it
 * says — and nothing else: no page is fetched, no field is guessed, and a
 * server whose manifest has no remote endpoint gets an explicit "unsupported"
 * instead of an invented launch command.
 *
 * A credential never travels in an argument. `install` writes a reference to
 * an environment variable the user names (the CLI does not read it); `test`
 * reads the key from standard input and sends it only to the endpoint the
 * manifest pins, after the user has agreed to that origin.
 */

const MAX_IDENTIFIER_CHARS = 300;
const MAX_KEY_BYTES = 16 * 1024;
/** The site's address when the registry is SourceWeft's own. */
const DEFAULT_REGISTRY_ORIGIN = "https://api.sourceweft.com";
const DEFAULT_SITE = "https://sourceweft.com";

/** Where `--write` puts the config of each client, relative to the project. */
const PROJECT_CONFIG_FILES: Record<McpClientId, string | null> = {
  "claude-code": ".mcp.json",
  cursor: ".cursor/mcp.json",
  generic: null,
};

export function parseClient(value: string | undefined): McpClientId {
  const client = value ?? "generic";
  if (!(MCP_CLIENT_IDS as readonly string[]).includes(client)) {
    throw new UsageError(
      `--client must be one of ${MCP_CLIENT_IDS.join(", ")}.`,
    );
  }
  return client as McpClientId;
}

function checkIdentifier(identifier: string): string {
  // eslint-disable-next-line no-control-regex
  if (!identifier.trim() || identifier.length > MAX_IDENTIFIER_CHARS || /[\u0000-\u001f\u007f]/u.test(identifier)) {
    throw new UsageError("Pass the server's identifier, for example com.notion/mcp.");
  }
  return identifier;
}

/** The registry's answer for one identifier, 404 as "no such entry". */
async function loadManifest(
  client: RegistryClient,
  identifier: string,
): Promise<McpManifestView> {
  try {
    const { manifest } = await client.getMcpManifest(identifier);
    if (manifest.identifier !== identifier) {
      throw new McpInspectError(
        `The registry answered with ${printable(manifest.identifier, 120)} when asked for ${identifier}; nothing was done.`,
      );
    }
    return manifest;
  } catch (error) {
    if (error instanceof RegistryError && error.status === 404) {
      throw new McpInspectError(`No catalog entry ${identifier}.`);
    }
    throw error;
  }
}

function siteLink(registry: string, identifier: string): string | null {
  return registry === DEFAULT_REGISTRY_ORIGIN
    ? `${DEFAULT_SITE}/mcp/${encodeURIComponent(identifier)}`
    : null;
}

export type McpInstallContext = {
  client: RegistryClient;
  /** The registry's address, as `normalizeRegistry` returned it. */
  registry: string;
  out: (line: string) => void;
  /** Guidance for the person at the terminal; stderr. */
  notice: (line: string) => void;
  cwd?: string;
};

export type McpInstallInput = {
  identifier: string;
  client: McpClientId;
  /** The name of the environment variable that holds the key. */
  keyEnv?: string;
  write: boolean;
  force: boolean;
  json: boolean;
};

export type McpInstallResult =
  | { action: "printed"; key: string }
  | {
      action: "created" | "added" | "replaced" | "unchanged";
      key: string;
      path: string;
    };

type ConfigFile = { mcpServers?: Record<string, unknown> } & Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merges one server into a client's JSON config file and writes the result
 * in one rename, so a failure leaves the file as it was. Other servers and
 * other settings are kept; a file that is not plain JSON, or a symbolic link,
 * is never touched; a different server under the same key is replaced only
 * with `force`; the same one makes this a no-op.
 */
export async function mergeClientConfig(
  path: string,
  config: McpClientConfig,
  force: boolean,
): Promise<"created" | "added" | "replaced" | "unchanged"> {
  const [key, server] = Object.entries(config.mcpServers)[0]!;
  let existing: ConfigFile = {};
  let existed = false;
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw new McpInspectError(
        `${path} is a symbolic link; edit the file it points to by hand.`,
      );
    }
    if (!stat.isFile()) {
      throw new McpInspectError(`${path} is not a regular file.`);
    }
    existed = true;
  } catch (error) {
    if (error instanceof McpInspectError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existed) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new McpInspectError(
        `${path} is not plain JSON (comments and trailing commas are not accepted), so it was left alone. Add the server by hand: run the command again without --write.`,
      );
    }
    if (!isPlainObject(parsed)) {
      throw new McpInspectError(`${path} does not hold a JSON object, so it was left alone.`);
    }
    existing = parsed as ConfigFile;
  }
  const servers = existing.mcpServers;
  if (servers !== undefined && !isPlainObject(servers)) {
    throw new McpInspectError(
      `"mcpServers" in ${path} is not an object, so the file was left alone.`,
    );
  }
  const current = servers?.[key];
  if (current !== undefined && isDeepStrictEqual(current, server)) {
    return "unchanged";
  }
  if (current !== undefined && !force) {
    throw new McpInspectError(
      `${path} already has a server named "${key}" that differs from this one. Pass --force to replace it, or add this one under another name by hand.`,
    );
  }
  const next: ConfigFile = {
    ...existing,
    mcpServers: { ...(servers ?? {}), [key]: server },
  };
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await renameWithRetry(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return current === undefined ? (existed ? "added" : "created") : "replaced";
}

/** `sourceweft mcp install <identifier>` */
export async function mcpInstallCommand(
  ctx: McpInstallContext,
  input: McpInstallInput,
): Promise<McpInstallResult> {
  const identifier = checkIdentifier(input.identifier);
  if (input.keyEnv !== undefined && !ENV_VAR_NAME.test(input.keyEnv)) {
    throw new UsageError(
      "--key-env takes the NAME of an environment variable in upper case, such as MCP_API_KEY — not the key itself.",
    );
  }
  if (input.write && PROJECT_CONFIG_FILES[input.client] === null) {
    throw new UsageError(
      "--write needs --client claude-code or cursor; the generic config is printed for you to place.",
    );
  }
  if (input.force && !input.write) {
    throw new UsageError("--force applies to --write only.");
  }
  if (input.keyEnv !== undefined && input.client === "generic") {
    throw new UsageError(
      "--key-env needs --client claude-code or cursor: the generic config keeps placeholders, since clients spell variable references differently.",
    );
  }

  const manifest = await loadManifest(ctx.client, identifier);
  const authType = manifest.auth.type;
  const needsKey =
    authType === "bearer" ||
    authType === "api_key_header" ||
    authType === "custom_headers";
  if (manifest.transport === "stdio") {
    throw new McpInspectError(
      `${printable(manifest.name, 80)} runs as a local process, and the catalog does not record the command that starts it, so there is no config to print.${
        manifest.repoUrl
          ? ` Follow the launch instructions at ${printable(manifest.repoUrl, 200)}.`
          : ""
      }`,
    );
  }
  if (!REMOTE_TRANSPORTS.has(manifest.transport)) {
    throw new McpInspectError(
      `This CLI does not know the transport "${printable(manifest.transport, 40)}" of ${identifier}; update @sourceweft/cli.`,
    );
  }
  if (!manifest.endpointUrl) {
    throw new McpInspectError(`The catalog records no endpoint for ${identifier}.`);
  }
  if (input.keyEnv !== undefined && !needsKey) {
    throw new UsageError(
      authType === "oauth"
        ? "This server signs in with OAuth; it takes no key, so --key-env does not apply."
        : "This server takes no key, so --key-env does not apply.",
    );
  }
  if (input.keyEnv !== undefined && authType === "custom_headers") {
    const names = customHeaderNames(manifest.auth);
    if (names.length !== 1) {
      throw new UsageError(
        "This server takes several different headers, and one variable cannot hold them all. Print the config without --key-env and fill the values in by hand.",
      );
    }
  }
  if (input.write && needsKey && input.keyEnv === undefined) {
    throw new UsageError(
      "--write needs --key-env NAME for a server that takes a key, so the file refers to your variable instead of holding a placeholder.",
    );
  }

  const config = buildMcpClientConfig(manifest, {
    client: input.client,
    ...(input.keyEnv !== undefined ? { keyEnv: input.keyEnv } : {}),
  });
  if (!config) {
    throw new McpInspectError(`The catalog records no usable endpoint for ${identifier}.`);
  }
  const key = mcpClientConfigKey(manifest);

  const guidance: string[] = [];
  if (needsKey) {
    guidance.push(
      input.keyEnv !== undefined
        ? `The config refers to the environment variable ${input.keyEnv}; set it in the environment your client starts from. The key is never written to the file.`
        : "The config holds placeholders. Put the key in an environment variable and use --key-env NAME so the config refers to it; do not paste the key into the file or a command.",
    );
  } else if (authType === "oauth") {
    const link = siteLink(ctx.registry, identifier);
    guidance.push(
      "This server signs in with OAuth: the config holds no key, and your client opens the server's sign-in the first time it connects (in Claude Code, run /mcp).",
      ...(link ? [`To connect it through SourceWeft instead, open ${link}.`] : []),
    );
  }

  if (!input.write) {
    ctx.out(JSON.stringify(config, null, 2));
    for (const line of guidance) ctx.notice(line);
    return { action: "printed", key };
  }

  const file = PROJECT_CONFIG_FILES[input.client]!;
  const path = resolve(ctx.cwd ?? process.cwd(), file);
  const action = await mergeClientConfig(path, config, input.force);
  ctx.out(
    input.json
      ? JSON.stringify({ action, key, path })
      : action === "unchanged"
        ? `"${key}" is already in ${path}; nothing changed.`
        : `${{ created: "Created", added: "Added", replaced: "Replaced" }[action]} "${key}" in ${path}`,
  );
  for (const line of guidance) ctx.notice(line);
  return { action, key, path };
}

// --- mcp test ---------------------------------------------------------------

export type McpTestContext = McpInspectContext & {
  client: RegistryClient;
  registry: string;
  /** Reads the key from standard input; replaceable in tests. */
  readStdin?: () => Promise<string>;
  /** True when standard input is a terminal; replaceable in tests. */
  stdinIsTty?: boolean;
  /** The user has agreed to send the credential to the endpoint. */
  yes: boolean;
};

export type McpTestInput = {
  identifier: string;
  keyStdin: boolean;
  oauth: boolean;
  clientName?: string;
  json: boolean;
};

export type McpTestResult = {
  identifier: string;
  endpoint: string;
  protocolVersion?: string;
  serverInfo?: Record<string, unknown>;
  tools: { name: string; title?: string; description?: string }[];
  truncated: boolean;
};

/**
 * The endpoint a manifest pins, as a URL the CLI may contact: https, no
 * credentials in it, and not a private or local address — unless the registry
 * itself is local, which is a development setup. A registry entry is
 * third-party data; it does not get to point the user's key at their own
 * network.
 */
export function pinEndpoint(manifest: McpManifestView, registry: string): URL {
  let url: URL;
  try {
    url = new URL(manifest.endpointUrl ?? "");
  } catch {
    throw new McpInspectError("The catalog records no usable endpoint for this server.");
  }
  const registryIsLocal = isLoopbackHost(new URL(registry).hostname);
  if (url.username || url.password || url.hash) {
    throw new McpInspectError(
      "The catalog's endpoint carries credentials or a fragment, so it was not contacted.",
    );
  }
  if (url.protocol === "http:" && registryIsLocal && isLoopbackHost(url.hostname)) {
    return url;
  }
  if (url.protocol !== "https:") {
    throw new McpInspectError(
      `The catalog's endpoint ${url.origin} is not https, so it was not contacted.`,
    );
  }
  if (isPrivateHost(url.hostname) && !registryIsLocal) {
    throw new McpInspectError(
      `The catalog's endpoint ${url.origin} is a private or local address, so it was not contacted.`,
    );
  }
  return url;
}

async function defaultReadStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_KEY_BYTES) {
      throw new UsageError("The key on standard input is larger than 16 KiB.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The key as one visible-ASCII line, or a usage error that does not repeat it. */
export function parseKey(raw: string): string {
  const key = raw.replace(/[\r\n]+$/u, "").trim();
  if (!key) throw new UsageError("Standard input held no key.");
  if (!/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/u.test(key) || key.includes("\n")) {
    throw new UsageError(
      "The key on standard input must be one line of printable ASCII.",
    );
  }
  return key;
}

function headersFor(
  manifest: McpManifestView,
  key: string,
): Record<string, string> {
  const { auth } = manifest;
  if (auth.type === "bearer") {
    return { [auth.headerName ?? "Authorization"]: `Bearer ${key}` };
  }
  if (auth.type === "api_key_header") {
    return { [auth.headerName ?? "X-API-Key"]: key };
  }
  const names = customHeaderNames(auth);
  if (names.length !== 1) {
    throw new McpInspectError(
      'This server takes several different headers, which one key cannot fill. Use `sourceweft mcp inspect --url <url> --header "Name: value"` for each of them.',
    );
  }
  return { [names[0]!]: key };
}

/** `sourceweft mcp test <identifier>` */
export async function mcpTestCommand(
  ctx: McpTestContext,
  input: McpTestInput,
): Promise<McpTestResult> {
  const identifier = checkIdentifier(input.identifier);
  if (input.keyStdin && input.oauth) {
    throw new UsageError("--key-stdin and --oauth are two ways to authenticate; pass one of them.");
  }
  if (input.clientName !== undefined && !input.oauth) {
    throw new UsageError("--client-name applies to --oauth only.");
  }
  const notice = ctx.notice ?? (() => {});
  const manifest = await loadManifest(ctx.client, identifier);
  const authType = manifest.auth.type;
  const needsKey =
    authType === "bearer" ||
    authType === "api_key_header" ||
    authType === "custom_headers";

  if (manifest.transport === "stdio") {
    throw new McpInspectError(
      "This server runs as a local process, and the catalog does not record the command that starts it, so there is nothing to connect to. If you have the command, `sourceweft mcp inspect --stdio \"<command>\"` runs it on your machine.",
    );
  }
  if (manifest.transport !== "streamable_http") {
    throw new McpInspectError(
      `This CLI connects over Streamable HTTP only; ${identifier} is "${printable(manifest.transport, 40)}".`,
    );
  }
  if (needsKey && !input.keyStdin) {
    throw new UsageError(
      "This server needs a key. Pipe it in on standard input and pass --key-stdin; it is never accepted as an argument.",
    );
  }
  if (!needsKey && input.keyStdin) {
    throw new UsageError("This server takes no key, so --key-stdin does not apply.");
  }
  if (authType === "oauth" && !input.oauth) {
    throw new UsageError(
      "This server signs in with OAuth. Pass --oauth to sign in with your browser; the token stays on this machine.",
    );
  }
  if (authType !== "oauth" && input.oauth) {
    throw new UsageError("This server does not sign in with OAuth, so --oauth does not apply.");
  }
  if (needsKey && authType === "custom_headers" && customHeaderNames(manifest.auth).length !== 1) {
    throw new McpInspectError(
      'This server takes several different headers, which one key cannot fill. Use `sourceweft mcp inspect --url <url> --header "Name: value"` for each of them.',
    );
  }

  const url = pinEndpoint(manifest, ctx.registry);
  const endpoint = url.toString();
  const client = { name: "sourceweft-cli", version: ctx.version };
  const name = printable(manifest.name, 80);
  notice(
    `Testing ${name}${manifest.version ? ` ${printable(manifest.version, 40)}` : ""} at ${url.origin}.`,
  );

  let key: string | undefined;
  if (needsKey) {
    const stdinIsTty = ctx.stdinIsTty ?? process.stdin.isTTY === true;
    if (stdinIsTty) {
      throw new UsageError(
        "--key-stdin reads the key from a pipe, so it does not show on screen: for example `printf %s \"$KEY\" | sourceweft mcp test <identifier> --key-stdin --yes`.",
      );
    }
    key = parseKey(await (ctx.readStdin ?? defaultReadStdin)());
  }

  if (needsKey || authType === "oauth") {
    const ok = await confirm(
      needsKey
        ? `Send your key to ${url.origin}?`
        : `Sign in at ${url.origin} with your browser?`,
      { assumeYes: ctx.yes },
    );
    if (!ok) throw new McpInspectError("Cancelled; nothing was sent.");
  }

  const abort = new AbortController();
  const onInterrupt = () => abort.abort();
  process.once("SIGINT", onInterrupt);
  let listed: InspectResult;
  try {
    if (authType === "oauth") {
      listed = await inspectWithOAuth(ctx, endpoint, client, input.clientName);
    } else {
      const transport = createHttpTransport(
        endpoint,
        key !== undefined ? headersFor(manifest, key) : {},
        {
          // Credentials go to this origin only, and a redirect off it stops.
          fetchImpl: createCredentialedFetch([url.origin], {
            ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
            signal: abort.signal,
          }),
          unauthorizedMessage: (status, method) =>
            `${url.origin} refused the key (HTTP ${status}) on ${method}. Check that the key is for this server and has not expired.`,
        },
      );
      try {
        listed = await inspectServer(transport, client);
      } catch (error) {
        if (error instanceof McpInspectError && key !== undefined) {
          throw new McpInspectError(
            redactSecrets(error.message, [key]),
            error.details.map((line) => redactSecrets(line, [key])),
          );
        }
        throw error;
      }
    }
  } finally {
    process.off("SIGINT", onInterrupt);
  }

  const bounded = boundInspectedTools(listed.tools);
  const serverInfo = boundServerInfo(listed.serverInfo);
  const result: McpTestResult = {
    identifier,
    endpoint: url.origin,
    ...(listed.protocolVersion !== undefined
      ? { protocolVersion: listed.protocolVersion }
      : {}),
    ...(serverInfo !== undefined ? { serverInfo } : {}),
    tools: bounded.tools.map((tool) => ({
      name: tool.name,
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      ...(tool.description !== undefined ? { description: tool.description } : {}),
    })),
    truncated: listed.truncated || bounded.truncated,
  };

  if (input.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return result;
  }
  for (const tool of result.tools) {
    ctx.out(
      tool.description
        ? `${printable(tool.name, 128)} — ${truncate(printable(tool.description, 200), 80)}`
        : printable(tool.name, 128),
    );
  }
  ctx.out(
    result.tools.length === 0
      ? `Connected to ${url.origin}; the server lists no tools.`
      : `Connected to ${url.origin}: ${result.tools.length} tool${result.tools.length === 1 ? "" : "s"}${
          result.truncated ? " (the server lists more; the first were kept)" : ""
        }. The names and descriptions above are the server's own text.`,
  );
  return result;
}
