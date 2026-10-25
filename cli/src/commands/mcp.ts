import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  MarketMcpInspectFile,
  SubmitMarketMcpOwnerToolsRequest,
} from "@sourceweft/market-contracts";
import { McpInspectError, McpUnauthorizedError, UsageError } from "../errors";
import {
  boundInspectedTools,
  boundServerInfo,
  reduceTargetUrl,
} from "../mcp/bound";
import { inspectFileSchema, submitToolsRequestSchema } from "../mcp/contract";
import { createHttpTransport } from "../mcp/http";
import { inspectServer, type InspectResult } from "../mcp/inspect";
import { createCredentialedFetch } from "../mcp/oauth/guard";
import {
  authorize,
  type Authorization,
  type AuthorizeMode,
} from "../mcp/oauth/flow";
import { redactSecrets } from "../mcp/oauth/redact";
import {
  createFileStore,
  defaultStoreDirectory,
  resourceKey,
  type McpOAuthStore,
} from "../mcp/oauth/store";
import { createStdioTransport } from "../mcp/stdio";
import { RegistryError, type RegistryClient } from "../registry/client";
import { truncate } from "../ui";

/**
 * `sourceweft mcp inspect` runs where the owner's credentials already are:
 * their machine. It connects to their server, lists its tools and writes a
 * file that holds the tools, the endpoint without its query string (or the
 * command) and the server's self-description. No header value and nothing
 * from the environment is written or printed. `submit-tools` uploads that
 * file under the owner's SourceWeft API key.
 */

export const DEFAULT_INSPECT_OUT = "mcp-tools.json";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type McpInspectContext = {
  out: (line: string) => void;
  /** The CLI's version, recorded as `generatedBy`. */
  version: string;
  /** Where relative `--out` paths resolve; the process's directory otherwise. */
  cwd?: string;
  /** Replaceable in tests. */
  fetchImpl?: typeof fetch;
  /** Progress for the person at the terminal; stderr, so `--json` stays clean. */
  notice?: (line: string) => void;
  /** Where `--oauth` keeps its sign-in; the CLI's config directory otherwise. */
  oauthStore?: McpOAuthStore;
  /** Replaceable in tests; true when a browser was started. */
  launchBrowser?: (url: string) => Promise<boolean>;
  /** How long `--oauth` waits for the browser; five minutes otherwise. */
  oauthTimeoutMs?: number;
  /** Time limit of each sign-in request; fifteen seconds otherwise. */
  oauthRequestTimeoutMs?: number;
};

/** The name a server's consent page shows for this CLI. */
export const DEFAULT_OAUTH_CLIENT_NAME = "SourceWeft CLI";

export type McpInspectInput = {
  url?: string;
  /** `Name: value` lines, sent on every HTTP request. */
  headers?: string[];
  stdio?: string;
  /** Sign in with the MCP OAuth flow instead of sending `--header`. */
  oauth?: boolean;
  clientName?: string;
  out?: string;
  force: boolean;
  json: boolean;
};

function oauthStoreOf(ctx: McpInspectContext): McpOAuthStore {
  return ctx.oauthStore ?? createFileStore(defaultStoreDirectory());
}

/** `Name: value` → `[name, value]`; a line without both is a usage error. */
export function parseHeaderOption(line: string): [string, string] {
  const colon = line.indexOf(":");
  const name = colon === -1 ? "" : line.slice(0, colon).trim();
  const value = colon === -1 ? "" : line.slice(colon + 1).trim();
  if (!name || !value || !/^[\w-]+$/u.test(name)) {
    throw new UsageError(
      `--header expects "Name: value", for example --header "Authorization: Bearer <token>".`,
    );
  }
  return [name, value];
}

/** An MCP endpoint: https, or http for a local development server only. */
export function validateInspectUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UsageError(`'${input}' is not a valid URL`);
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))
  ) {
    throw new UsageError(
      "--url must be an https:// URL (http:// is accepted for localhost only)",
    );
  }
  return url.toString();
}

export async function mcpInspectCommand(
  ctx: McpInspectContext,
  input: McpInspectInput,
): Promise<MarketMcpInspectFile> {
  if ((input.url === undefined) === (input.stdio === undefined)) {
    throw new UsageError(
      "Pass exactly one of --url <url> or --stdio \"<command>\".",
    );
  }
  if (input.headers?.length && input.url === undefined) {
    throw new UsageError("--header applies to --url only.");
  }
  if (input.stdio !== undefined && !input.stdio.trim()) {
    throw new UsageError("--stdio needs the command that starts the server.");
  }
  if (input.oauth && input.url === undefined) {
    throw new UsageError("--oauth applies to --url only.");
  }
  if (input.oauth && input.headers?.length) {
    throw new UsageError(
      "--oauth and --header are two ways to authenticate; pass one of them.",
    );
  }
  if (input.clientName !== undefined && !input.oauth) {
    throw new UsageError("--client-name applies to --oauth only.");
  }
  if (input.clientName !== undefined && !input.clientName.trim()) {
    throw new UsageError("--client-name needs a name.");
  }

  const outPath = resolve(ctx.cwd ?? process.cwd(), input.out ?? DEFAULT_INSPECT_OUT);
  if (!input.force && existsSync(outPath)) {
    throw new McpInspectError(
      `${outPath} already exists. Pass --force to overwrite it, or --out <file> to write elsewhere.`,
    );
  }

  let target: MarketMcpInspectFile["target"];
  let listed: InspectResult;
  const client = { name: "sourceweft-cli", version: ctx.version };
  if (input.url !== undefined) {
    const url = validateInspectUrl(input.url);
    target = { kind: "url", url: reduceTargetUrl(url) };
    if (input.oauth) {
      listed = await inspectWithOAuth(ctx, url, client, input.clientName);
    } else {
      const headers = Object.fromEntries(
        (input.headers ?? []).map(parseHeaderOption),
      );
      listed = await inspectServer(
        createHttpTransport(url, headers, {
          ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
        }),
        client,
      );
    }
  } else {
    const command = (input.stdio ?? "").trim();
    target = { kind: "stdio", command };
    listed = await inspectServer(
      createStdioTransport(command, { ...(ctx.cwd ? { cwd: ctx.cwd } : {}) }),
      client,
    );
  }
  const bounded = boundInspectedTools(listed.tools);
  const truncated = listed.truncated || bounded.truncated;
  const serverInfo = boundServerInfo(listed.serverInfo);

  const file = inspectFileSchema.parse({
    schemaVersion: 1,
    generatedBy: `sourceweft-cli/${ctx.version}`,
    generatedAt: new Date().toISOString(),
    target,
    ...(listed.protocolVersion !== undefined
      ? { protocolVersion: listed.protocolVersion }
      : {}),
    ...(serverInfo !== undefined ? { serverInfo } : {}),
    tools: bounded.tools,
  } satisfies MarketMcpInspectFile);

  const text = `${JSON.stringify(file, null, 2)}\n`;
  await writeFile(outPath, text, { flag: input.force ? "w" : "wx" });

  if (input.json) {
    ctx.out(text.trimEnd());
  } else {
    for (const tool of file.tools) {
      ctx.out(
        tool.description
          ? `${tool.name} — ${truncate(tool.description, 80)}`
          : tool.name,
      );
    }
  }
  ctx.out(
    `Wrote ${file.tools.length} tool${file.tools.length === 1 ? "" : "s"} to ${outPath}${
      truncated ? ` (the server lists more; the first ${file.tools.length} were kept)` : ""
    }`,
  );
  ctx.out(
    "The file holds the tool list and the endpoint's origin only; no path, header, token or environment variable is in it.",
  );
  ctx.out(
    `Submit it with: sourceweft mcp submit-tools <identifier> ${
      input.out ?? DEFAULT_INSPECT_OUT
    } --api-key <key>`,
  );
  return file;
}

/**
 * `--oauth`: the sign-in a server's own OAuth supports, run here. A stored
 * token is used while it is valid and refreshed when it is not; when the
 * server refuses what is stored, one step further up is tried (refresh, then
 * the browser). The token goes to the endpoint's origin only.
 */
async function inspectWithOAuth(
  ctx: McpInspectContext,
  url: string,
  client: { name: string; version: string },
  clientName: string | undefined,
): Promise<InspectResult> {
  const notice = ctx.notice ?? (() => {});
  const store = oauthStoreOf(ctx);
  const abort = new AbortController();
  const onInterrupt = () => abort.abort();
  process.once("SIGINT", onInterrupt);
  try {
    let mode: AuthorizeMode = "reuse";
    for (;;) {
      const authorization: Authorization = await authorize({
        url,
        clientName: clientName?.trim() || DEFAULT_OAUTH_CLIENT_NAME,
        store,
        mode,
        notice,
        signal: abort.signal,
        ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
        ...(ctx.launchBrowser ? { launchBrowser: ctx.launchBrowser } : {}),
        ...(ctx.oauthTimeoutMs !== undefined
          ? { callbackTimeoutMs: ctx.oauthTimeoutMs }
          : {}),
        ...(ctx.oauthRequestTimeoutMs !== undefined
          ? { requestTimeoutMs: ctx.oauthRequestTimeoutMs }
          : {}),
      });
      const transport = createHttpTransport(
        url,
        { authorization: `Bearer ${authorization.accessToken}` },
        {
          fetchImpl: createCredentialedFetch([new URL(url).origin], {
            ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
            signal: abort.signal,
          }),
          unauthorizedMessage: (status, method) =>
            status === 401
              ? `The server refused the signed-in token (HTTP 401) on ${method}.`
              : `The server accepted the sign-in but refused ${method} (HTTP ${status}): the account or the granted scope is not enough for this server. Signing in again would not change that; check the account and the permissions the consent page asked for.`,
        },
      );
      try {
        return await inspectServer(transport, client);
      } catch (error) {
        const next: AuthorizeMode | undefined =
          error instanceof McpUnauthorizedError && error.retryable
            ? authorization.source === "stored"
              ? "renew"
              : authorization.source === "refreshed"
                ? "login"
                : undefined
            : undefined;
        if (next === undefined) {
          if (error instanceof McpInspectError) {
            throw new McpInspectError(
              redactSecrets(error.message, authorization.secrets),
              error.details.map((line) =>
                redactSecrets(line, authorization.secrets),
              ),
            );
          }
          throw error;
        }
        mode = next;
        notice(
          next === "renew"
            ? "The server refused the stored token; renewing it."
            : "The server refused the renewed token; signing in again.",
        );
      }
    }
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

export type McpOAuthLogoutContext = {
  out: (line: string) => void;
  oauthStore?: McpOAuthStore;
};

/** `sourceweft mcp oauth-logout --url`: forgets what `--oauth` stored for an endpoint. */
export async function mcpOAuthLogoutCommand(
  ctx: McpOAuthLogoutContext,
  input: { url: string },
): Promise<number> {
  const url = validateInspectUrl(input.url);
  const store = ctx.oauthStore ?? createFileStore(defaultStoreDirectory());
  const removed = await store.deleteResource(resourceKey(url));
  ctx.out(
    removed > 0
      ? `Removed the stored sign-in for ${new URL(url).origin}. The token itself stays valid at the server until it expires or you revoke it there.`
      : `No stored sign-in for ${new URL(url).origin}.`,
  );
  return removed;
}

export type McpSubmitContext = {
  client: RegistryClient;
  json: boolean;
  out: (line: string) => void;
  cwd?: string;
};

/** Reads an inspect file; anything but a valid one is refused with the reasons. */
export async function readInspectFile(
  path: string,
): Promise<MarketMcpInspectFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new McpInspectError(
      `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new McpInspectError(`${path} is not JSON.`);
  }
  const parsed = inspectFileSchema.safeParse(data);
  if (!parsed.success) {
    throw new McpInspectError(
      `${path} is not a file written by \`sourceweft mcp inspect\`.`,
      parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  return parsed.data;
}

/**
 * The request body: the file's tools, when they were listed and what the
 * server called itself — never its `target` (the endpoint or command the
 * owner inspected, which may carry a secret).
 */
export function toSubmitRequest(
  file: MarketMcpInspectFile,
): SubmitMarketMcpOwnerToolsRequest {
  return submitToolsRequestSchema.parse({
    tools: file.tools,
    generatedAt: file.generatedAt,
    ...(file.serverInfo !== undefined ? { serverInfo: file.serverInfo } : {}),
  });
}

function describeDetails(details: unknown): string[] {
  if (typeof details !== "object" || details === null) return [];
  const lines: string[] = [];
  const fieldErrors = (details as { fieldErrors?: unknown }).fieldErrors;
  if (typeof fieldErrors === "object" && fieldErrors !== null) {
    for (const [field, messages] of Object.entries(fieldErrors)) {
      if (Array.isArray(messages)) {
        lines.push(`${field}: ${messages.map(String).join("; ")}`);
      }
    }
  }
  const formErrors = (details as { formErrors?: unknown }).formErrors;
  if (Array.isArray(formErrors)) {
    lines.push(...formErrors.map(String));
  }
  if (lines.length === 0) lines.push(JSON.stringify(details));
  return lines.slice(0, 10);
}

export async function mcpSubmitToolsCommand(
  ctx: McpSubmitContext,
  input: { identifier: string; file: string; apiKey: string },
): Promise<void> {
  const path = resolve(ctx.cwd ?? process.cwd(), input.file);
  const file = await readInspectFile(path);
  const body = toSubmitRequest(file);

  let result;
  try {
    result = await ctx.client.submitMcpOwnerTools(
      input.identifier,
      body,
      input.apiKey,
    );
  } catch (error) {
    if (error instanceof RegistryError) {
      if (error.status === 401) {
        throw new McpInspectError(
          "The API key was not accepted. Create a user API key in SourceWeft → Settings → API keys and pass it with --api-key.",
        );
      }
      if (error.status === 403) {
        throw new McpInspectError(
          `This account holds no verified claim on ${input.identifier}. Claim the server on its catalog page first, with the account the API key belongs to.`,
        );
      }
      if (error.status === 404) {
        throw new McpInspectError(`No catalog entry ${input.identifier}.`);
      }
      if (error.status === 400 && error.code === "VALIDATION_ERROR") {
        throw new McpInspectError(
          `The registry refused the tool list: ${error.message}`,
          describeDetails(error.details),
        );
      }
    }
    throw error;
  }

  if (ctx.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return;
  }
  const count = result.tools?.count ?? body.tools.length;
  ctx.out(
    `Submitted ${count} tool${count === 1 ? "" : "s"} for ${result.identifier}`,
  );
}
