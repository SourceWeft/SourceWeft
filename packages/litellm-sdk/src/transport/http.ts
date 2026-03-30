import { buildRequestHeaders } from "../config";
import {
  createHttpLiteLLMError,
  isRetryableError,
  normalizeLiteLLMError,
} from "../errors";
import {
  logRequestFailure,
  logRequestRetry,
  logRequestStart,
  logRequestSuccess,
} from "../middleware/logging";
import { buildTracingHeaders } from "../middleware/tracing";
import type { RequestOptions, ResolvedLiteLLMClientConfig } from "../types";
import { safeJsonParse } from "../utils/object";

export interface HttpRequestInput {
  path: string;
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  options?: RequestOptions;
}

function joinUrl(baseUrl: string, path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${normalizedPath}`;
}

function buildRetryDelay(attempt: number): number {
  const base = 200;
  const max = 5_000;
  const exp = Math.min(max, base * 2 ** attempt);
  const jitter = Math.floor(Math.random() * 100);
  return exp + jitter;
}

function mergeSignals(
  signalA: AbortSignal | undefined,
  signalB: AbortSignal,
): AbortSignal {
  if (!signalA) {
    return signalB;
  }

  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([signalA, signalB]);
  }

  const controller = new AbortController();

  const abort = () => {
    controller.abort();
  };

  signalA.addEventListener("abort", abort, { once: true });
  signalB.addEventListener("abort", abort, { once: true });

  return controller.signal;
}

async function withTimeout<T>(input: {
  timeoutMs: number;
  signal: AbortSignal | undefined;
  execute: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort(new Error("LiteLLM request timed out"));
  }, input.timeoutMs);

  try {
    const signal = mergeSignals(input.signal, timeoutController.signal);
    return await input.execute(signal);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }

  const parsed = safeJsonParse(text);
  return parsed !== undefined ? parsed : text;
}

export async function requestJson<T>(
  config: ResolvedLiteLLMClientConfig,
  input: HttpRequestInput,
): Promise<T> {
  const options = input.options;
  const timeoutMs = options?.timeoutMs ?? config.timeoutMs;
  const maxRetries = options?.maxRetries ?? config.maxRetries;
  const url = joinUrl(config.baseUrl, input.path);

  let attempt = 0;
  let lastError: unknown;

  while (attempt <= maxRetries) {
    const headers = {
      ...buildRequestHeaders(config, options),
      ...buildTracingHeaders(options),
    };

    logRequestStart(config.logger, "litellm.request.start", {
      url,
      method: input.method ?? "POST",
      attempt,
    });

    try {
      const response = await withTimeout({
        timeoutMs,
        signal: options?.signal,
        execute: async (signal) =>
          config.fetch(url, {
            method: input.method ?? "POST",
            headers,
            body: input.body ? JSON.stringify(input.body) : undefined,
            signal,
          }),
      });

      if (!response.ok) {
        const body = await parseResponseBody(response);
        throw createHttpLiteLLMError({
          statusCode: response.status,
          body,
          requestId: response.headers.get("x-request-id") ?? undefined,
        });
      }

      const parsed = await parseResponseBody(response);
      if (typeof parsed === "string") {
        throw createHttpLiteLLMError({
          statusCode: 502,
          body: {
            message: "Expected JSON response from LiteLLM",
            raw: parsed,
          },
        });
      }

      logRequestSuccess(config.logger, "litellm.request.success", {
        url,
        attempt,
      });

      return parsed as T;
    } catch (error) {
      const normalized = normalizeLiteLLMError(error);
      lastError = normalized;

      if (!isRetryableError(normalized) || attempt >= maxRetries) {
        logRequestFailure(config.logger, "litellm.request.failure", {
          url,
          attempt,
          code: normalized.code,
          message: normalized.message,
          statusCode: normalized.statusCode,
        });
        throw normalized;
      }

      const delayMs = buildRetryDelay(attempt);
      logRequestRetry(config.logger, "litellm.request.retry", {
        url,
        attempt,
        delayMs,
        code: normalized.code,
      });

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
    }
  }

  throw normalizeLiteLLMError(lastError);
}

export async function requestStream(
  config: ResolvedLiteLLMClientConfig,
  input: HttpRequestInput,
): Promise<Response> {
  const options = input.options;
  const timeoutMs = options?.timeoutMs ?? config.timeoutMs;
  const maxRetries = options?.maxRetries ?? config.maxRetries;
  const url = joinUrl(config.baseUrl, input.path);

  let attempt = 0;
  let lastError: unknown;

  while (attempt <= maxRetries) {
    const headers = {
      ...buildRequestHeaders(config, options),
      ...buildTracingHeaders(options),
    };

    logRequestStart(config.logger, "litellm.stream.start", {
      url,
      attempt,
    });

    try {
      const response = await withTimeout({
        timeoutMs,
        signal: options?.signal,
        execute: async (signal) =>
          config.fetch(url, {
            method: input.method ?? "POST",
            headers,
            body: input.body ? JSON.stringify(input.body) : undefined,
            signal,
          }),
      });

      if (!response.ok) {
        const body = await parseResponseBody(response);
        throw createHttpLiteLLMError({
          statusCode: response.status,
          body,
          requestId: response.headers.get("x-request-id") ?? undefined,
        });
      }

      logRequestSuccess(config.logger, "litellm.stream.success", {
        url,
        attempt,
      });
      return response;
    } catch (error) {
      const normalized = normalizeLiteLLMError(error);
      lastError = normalized;

      if (!isRetryableError(normalized) || attempt >= maxRetries) {
        logRequestFailure(config.logger, "litellm.stream.failure", {
          url,
          attempt,
          code: normalized.code,
          message: normalized.message,
        });
        throw normalized;
      }

      const delayMs = buildRetryDelay(attempt);
      logRequestRetry(config.logger, "litellm.stream.retry", {
        url,
        attempt,
        delayMs,
      });

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
    }
  }

  throw normalizeLiteLLMError(lastError);
}
