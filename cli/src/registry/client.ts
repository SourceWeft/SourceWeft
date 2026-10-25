import type { z } from "zod";
import type { SubmitMarketMcpOwnerToolsRequest } from "@sourceweft/market-contracts";
import {
  searchResponseSchema,
  referenceResponseSchema,
  type ReferenceResponse,
  skillResponseSchema,
  type SearchResponse,
  type SkillResponse,
  mcpOwnerOverridesResponseSchema,
  type McpOwnerOverridesResponse,
  mcpManifestResponseSchema,
  type McpManifestResponse,
} from "./schema";

/** The production marketplace API. `--registry` overrides it. */
export const DEFAULT_REGISTRY = "https://api.sourceweft.com";

export class RegistryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryConfigError";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The registry decides which upstream a skill is fetched from and what its
 * files must hash to, so it is trusted with what lands on the user's machine.
 * Plain http is only accepted for a local development server.
 */
export function normalizeRegistry(input: string | undefined): string {
  const raw = input ?? DEFAULT_REGISTRY;
  if (!raw) {
    throw new RegistryConfigError(
      "The registry address is empty. Pass --registry <url>, or omit it to use the default.",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RegistryConfigError(`'${raw}' is not a valid registry URL`);
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))
  ) {
    throw new RegistryConfigError("The registry must be an https:// URL");
  }
  return url.origin + url.pathname.replace(/\/+$/u, "");
}

export class RegistryUnreachableError extends Error {
  constructor(registry: string, cause: unknown) {
    super(
      `Could not reach the registry at ${registry}${
        cause instanceof Error && cause.cause instanceof Error
          ? ` (${cause.cause.message})`
          : ""
      }.`,
    );
    this.name = "RegistryUnreachableError";
  }
}

/** The registry answered with an error status. */
export class RegistryError extends Error {
  readonly status: number;
  readonly code: string;
  /** The error body's `details`, when it has them (a validation error does). */
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "RegistryError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * The fields of an error body. The API answers `{ code, message, details? }`;
 * an `{ error: { … } }` envelope is read the same way.
 */
function errorFields(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) return {};
  const outer = body as Record<string, unknown>;
  const inner = outer.error;
  return typeof inner === "object" && inner !== null && !Array.isArray(inner)
    ? (inner as Record<string, unknown>)
    : outer;
}

/** The registry answered 200 with something the CLI cannot use. */
export class RegistryResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryResponseError";
  }
}

export type SearchParams = {
  query?: string;
  category?: string;
  sort?: string;
  limit?: number;
};

export class RegistryClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private get<S extends z.ZodType>(
    path: string,
    schema: S,
  ): Promise<z.infer<S>> {
    return this.request("GET", path, {}, schema);
  }

  /**
   * One request to the registry, with the body JSON-encoded and the extra
   * headers (an API key, say) sent as given. The response is parsed with
   * `schema`; an error status becomes a `RegistryError` carrying the body's
   * code, message and details.
   */
  private async request<S extends z.ZodType>(
    method: "GET" | "PUT" | "POST",
    path: string,
    init: { body?: unknown; headers?: Record<string, string> },
    schema: S,
  ): Promise<z.infer<S>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
          ...(init.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
          ...init.headers,
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (error) {
      // A network failure surfaces from `fetch` as a bare "fetch failed".
      throw new RegistryUnreachableError(this.baseUrl, error);
    }

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      const fields = errorFields(body);
      throw new RegistryError(
        response.status,
        typeof fields.code === "string" ? fields.code : "HTTP_ERROR",
        typeof fields.message === "string"
          ? fields.message
          : response.statusText || "Registry request failed",
        fields.details,
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new RegistryResponseError("The registry did not return JSON.");
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new RegistryResponseError(
        `The registry's response is missing something the CLI needs: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".")} (${issue.message})`)
          .join("; ")}`,
      );
    }
    return parsed.data;
  }

  getSkill(slug: string): Promise<SkillResponse> {
    return this.get(
      `/v1/skills/${encodeURIComponent(slug)}`,
      skillResponseSchema,
    );
  }

  resolveSkills(
    reference: string,
    options: { skill?: string; path?: string } = {},
  ): Promise<ReferenceResponse> {
    const query = new URLSearchParams({ reference });
    if (options.skill !== undefined) query.set("skill", options.skill);
    if (options.path !== undefined) query.set("path", options.path);
    return this.get(`/v1/skills/resolve?${query}`, referenceResponseSchema);
  }

  listSkills(params: SearchParams = {}): Promise<SearchResponse> {
    const query = new URLSearchParams();
    if (params.query) query.set("query", params.query);
    if (params.category) query.set("category", params.category);
    if (params.sort) query.set("sort", params.sort);
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    const suffix = query.size > 0 ? `?${query}` : "";
    return this.get(`/v1/skills${suffix}`, searchResponseSchema);
  }

  /**
   * A public catalog server's latest manifest. The identifier holds a slash
   * (`com.notion/mcp`) and travels as one path segment.
   */
  getMcpManifest(identifier: string): Promise<McpManifestResponse> {
    return this.get(
      `/v1/mcp/${encodeURIComponent(identifier)}/manifest`,
      mcpManifestResponseSchema,
    );
  }

  /**
   * Uploads an owner's tool list for a catalog MCP server. The identifier
   * holds a slash (`com.notion/mcp`) and travels as one path segment. The key
   * goes in the `x-api-key` header and nowhere else.
   */
  submitMcpOwnerTools(
    identifier: string,
    body: SubmitMarketMcpOwnerToolsRequest,
    apiKey: string,
  ): Promise<McpOwnerOverridesResponse> {
    return this.request(
      "PUT",
      `/v1/market/mcp/${encodeURIComponent(identifier)}/owner-overrides/tools`,
      { body, headers: { "x-api-key": apiKey } },
      mcpOwnerOverridesResponseSchema,
    );
  }
}

export function createRegistryClient(
  registry: string,
  fetchImpl?: typeof fetch,
): RegistryClient {
  return new RegistryClient(registry, fetchImpl);
}
