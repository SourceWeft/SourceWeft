import type { ApiErrorResponse } from "@polyer/contracts";

export type HttpClientOptions = {
  baseUrl: string;
  getToken?: () => string | undefined | Promise<string | undefined>;
  credentials?: RequestCredentials;
};

function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Record<string, unknown>;
  return typeof maybe.code === "string" && typeof maybe.message === "string";
}

function toObjectDetails(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

export class HttpClientError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(input: {
    message: string;
    status: number;
    statusText: string;
    code: string;
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "HttpClientError";
    this.status = input.status;
    this.statusText = input.statusText;
    this.code = input.code;
    this.details = input.details;
  }
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly getToken?: () =>
    | string
    | undefined
    | Promise<string | undefined>;
  private readonly credentials?: RequestCredentials;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.getToken = options.getToken;
    this.credentials = options.credentials;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        "content-type": "application/json",
      },
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const token = await this.getToken?.();
    const headers = new Headers(init.headers);
    if (token) {
      headers.set("authorization", `Bearer ${token}`);
    }

    const response = await fetch(url, {
      ...init,
      headers,
      credentials: this.credentials,
    });

    if (!response.ok) {
      throw await this.toHttpError(response);
    }

    return (await response.json()) as T;
  }

  private async toHttpError(response: Response): Promise<HttpClientError> {
    let payload: unknown;
    let rawText = "";

    try {
      rawText = await response.text();
      payload = rawText ? (JSON.parse(rawText) as unknown) : undefined;
    } catch {
      payload = undefined;
    }

    if (isApiErrorResponse(payload)) {
      return new HttpClientError({
        status: response.status,
        statusText: response.statusText,
        code: payload.code,
        message: payload.message,
        details: payload.details,
      });
    }

    const fallbackMessage =
      rawText ||
      response.statusText ||
      `Request failed with status ${response.status}`;

    return new HttpClientError({
      status: response.status,
      statusText: response.statusText,
      code: "HTTP_ERROR",
      message: fallbackMessage,
      details: toObjectDetails(payload),
    });
  }
}
