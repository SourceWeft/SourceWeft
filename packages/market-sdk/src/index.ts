import {
  getMarketMcpManifestResponseSchema,
  getMarketMcpResponseSchema,
  listMarketCategoriesResponseSchema,
  listMarketMcpResponseSchema,
  type ListMarketMcpRequest,
} from "@sourceweft/market-contracts";

export type MarketClientOptions = {
  baseUrl: string;
  getToken?: () => string | undefined | Promise<string | undefined>;
  fetch?: typeof fetch;
};

export class MarketClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(input: {
    status: number;
    code: string;
    message: string;
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "MarketClientError";
    this.status = input.status;
    this.code = input.code;
    this.details = input.details;
  }
}

function encode(value: string) {
  return encodeURIComponent(value);
}

function appendQuery(path: string, params: URLSearchParams) {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function toObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class MarketClient {
  private readonly baseUrl: string;
  private readonly getToken?: MarketClientOptions["getToken"];
  private readonly fetchImpl: typeof fetch;

  constructor(options: MarketClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.getToken = options.getToken;
    this.fetchImpl = options.fetch ?? fetch;
  }

  listMcp(input: ListMarketMcpRequest = {}) {
    const params = new URLSearchParams();
    if (input.query) {
      params.set("query", input.query);
    }
    if (input.category) {
      params.set("category", input.category);
    }
    if (input.transport) {
      params.set("transport", input.transport);
    }
    if (typeof input.official === "boolean") {
      params.set("official", String(input.official));
    }
    if (typeof input.verified === "boolean") {
      params.set("verified", String(input.verified));
    }
    if (input.runtime) {
      params.set("runtime", input.runtime);
    }
    if (typeof input.includeDesktopOnly === "boolean") {
      params.set("includeDesktopOnly", String(input.includeDesktopOnly));
    }
    if (input.limit) {
      params.set("limit", String(input.limit));
    }
    if (input.cursor) {
      params.set("cursor", input.cursor);
    }
    return this.request(
      appendQuery("/v1/mcp", params),
      { method: "GET" },
      listMarketMcpResponseSchema,
    );
  }

  listMcpCategories() {
    return this.request(
      "/v1/mcp/categories",
      { method: "GET" },
      listMarketCategoriesResponseSchema,
    );
  }

  getMcp(identifier: string) {
    return this.request(
      `/v1/mcp/${encode(identifier)}`,
      { method: "GET" },
      getMarketMcpResponseSchema,
    );
  }

  getMcpManifest(identifier: string, input: { version?: string } = {}) {
    const params = new URLSearchParams();
    if (input.version) {
      params.set("version", input.version);
    }
    return this.request(
      appendQuery(`/v1/mcp/${encode(identifier)}/manifest`, params),
      { method: "GET" },
      getMarketMcpManifestResponseSchema,
    );
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    schema: { parse(value: unknown): T },
  ): Promise<T> {
    const headers = new Headers(init.headers);
    const token = await this.getToken?.();
    if (token) {
      headers.set("authorization", `Bearer ${token}`);
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok) {
      throw await this.toError(response);
    }

    const data = (await response.json()) as unknown;
    // Validate the response against the shared contract so schema drift between
    // the market API and this client surfaces immediately instead of leaking a
    // malformed object downstream.
    try {
      return schema.parse(data);
    } catch (error) {
      throw new MarketClientError({
        status: response.status,
        code: "MARKET_RESPONSE_INVALID",
        message:
          error instanceof Error
            ? `Market response failed schema validation: ${error.message}`
            : "Market response failed schema validation",
      });
    }
  }

  private async toError(response: Response) {
    let payload: unknown;
    let rawText = "";
    try {
      rawText = await response.text();
      payload = rawText ? (JSON.parse(rawText) as unknown) : undefined;
    } catch {
      payload = undefined;
    }

    const body = toObject(payload);
    return new MarketClientError({
      status: response.status,
      code: typeof body?.code === "string" ? body.code : "MARKET_HTTP_ERROR",
      message:
        typeof body?.message === "string"
          ? body.message
          : rawText || response.statusText || "Market request failed",
      details: toObject(body?.details),
    });
  }
}

export * from "@sourceweft/market-contracts";
