import type { z } from "zod";
import {
  searchResponseSchema,
  skillResponseSchema,
  type SearchResponse,
  type SkillResponse,
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

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RegistryError";
    this.status = status;
    this.code = code;
  }
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

  private async get<S extends z.ZodType>(
    path: string,
    schema: S,
  ): Promise<z.infer<S>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: { accept: "application/json" },
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
      const fields =
        typeof body === "object" && body !== null
          ? (body as Record<string, unknown>)
          : {};
      throw new RegistryError(
        response.status,
        typeof fields.code === "string" ? fields.code : "HTTP_ERROR",
        typeof fields.message === "string"
          ? fields.message
          : response.statusText || "Registry request failed",
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

  listSkills(params: SearchParams = {}): Promise<SearchResponse> {
    const query = new URLSearchParams();
    if (params.query) query.set("query", params.query);
    if (params.category) query.set("category", params.category);
    if (params.sort) query.set("sort", params.sort);
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    const suffix = query.size > 0 ? `?${query}` : "";
    return this.get(`/v1/skills${suffix}`, searchResponseSchema);
  }
}

export function createRegistryClient(
  registry: string,
  fetchImpl?: typeof fetch,
): RegistryClient {
  return new RegistryClient(registry, fetchImpl);
}
