import { buildRequestHeaders } from "../config";
import {
  createHttpGatewayError,
  isRetryableError,
  normalizeGatewayError,
} from "../errors";
import {
  logRequestFailure,
  logRequestRetry,
  logRequestStart,
  logRequestSuccess,
} from "../middleware/logging";
import { buildTracingHeaders, createSpanIds } from "../middleware/tracing";
import type { RequestOptions, ResolvedRequestConfig } from "../types";
import { safeJsonParse } from "../utils/object";

export interface HttpRequestInput {
  path: string;
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  query?: Record<string, string>;
  options?: RequestOptions;
}

function joinUrl(baseUrl: string, path: string, query?: Record<string, string>): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${baseUrl}${normalizedPath}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function buildRetryDelay(attempt: number): number {
  const base = 200;
  const max = 5_000;
  const exp = Math.min(max, base * 2 ** attempt);
  const jitter = Math.floor(Math.random() * 100);
  return exp + jitter;
}

function observeScopeAttributes(options: RequestOptions | undefined) {
  const metadata = options?.metadata ?? {};
  return {
    ...(typeof metadata.teamId === "string" ? { teamId: metadata.teamId } : {}),
    ...(typeof metadata.team_id === "string" ? { team_id: metadata.team_id } : {}),
    ...(typeof metadata.workspaceId === "string" ? { workspaceId: metadata.workspaceId } : {}),
    ...(typeof metadata.workspace_id === "string" ? { workspace_id: metadata.workspace_id } : {}),
    ...(typeof metadata.userId === "string" ? { userId: metadata.userId } : {}),
    ...(typeof metadata.user_id === "string" ? { user_id: metadata.user_id } : {}),
    ...(typeof metadata.threadId === "string" ? { threadId: metadata.threadId } : {}),
    ...(typeof metadata.thread_id === "string" ? { thread_id: metadata.thread_id } : {}),
    ...(typeof metadata.messageId === "string" ? { messageId: metadata.messageId } : {}),
    ...(typeof metadata.message_id === "string" ? { message_id: metadata.message_id } : {}),
    ...(typeof metadata.feature === "string" ? { feature: metadata.feature } : {}),
    ...(typeof metadata.operation === "string" ? { operation: metadata.operation } : {}),
    ...(typeof metadata.executionMode === "string" ? { executionMode: metadata.executionMode } : {}),
    ...(typeof metadata.keySource === "string" ? { keySource: metadata.keySource } : {}),
    ...(typeof metadata.provider === "string" ? { provider: metadata.provider } : {}),
    ...(typeof metadata.routeStrategy === "string" ? { routeStrategy: metadata.routeStrategy } : {}),
  };
}

function observeParentSpanId(options: RequestOptions | undefined) {
  const metadata = options?.metadata ?? {};
  return typeof metadata.parentSpanId === "string"
    ? metadata.parentSpanId
    : typeof metadata.parent_span_id === "string"
      ? metadata.parent_span_id
      : undefined;
}

function loggableError(input: { code: string; statusCode?: number; requestId?: string }) {
  return {
    code: input.code,
    statusCode: input.statusCode,
    requestId: input.requestId,
  };
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
    timeoutController.abort(new Error("Model gateway request timed out"));
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

async function emitObserveSpan(input: {
  config: ResolvedRequestConfig;
  options: RequestOptions | undefined;
  name: string;
  startedAtMs: number;
  status: "ok" | "error";
  attempt: number;
  attributes?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}) {
  const sink = input.config.observeSink;
  if (!sink?.onSpan) {
    return;
  }

  const ids = createSpanIds(input.options);
  try {
    await sink.onSpan({
      traceId: ids.traceId,
      spanId: ids.spanId,
      parentSpanId: observeParentSpanId(input.options),
      name: input.name,
      startedAt: new Date(input.startedAtMs).toISOString(),
      endedAt: new Date().toISOString(),
      status: input.status,
      attributes: {
        ...observeScopeAttributes(input.options),
        attempt: input.attempt,
        latencyMs: Date.now() - input.startedAtMs,
        ...(input.attributes ?? {}),
      },
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    });
  } catch (error) {
    input.config.logger.warn?.("model-gateway.observe.span.failed", {
      name: input.name,
      status: input.status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function requestJson<T>(
  config: ResolvedRequestConfig,
  input: HttpRequestInput,
): Promise<T> {
  const options = input.options;
  const timeoutMs = options?.timeoutMs ?? config.timeoutMs;
  const maxRetries = options?.maxRetries ?? config.maxRetries;
  const url = joinUrl(config.baseUrl, input.path, input.query);

  let attempt = 0;
  let lastError: unknown;
  const startedAtMs = Date.now();

  while (attempt <= maxRetries) {
    const headers = {
      ...buildRequestHeaders(config, options),
      ...buildTracingHeaders(options),
    };

    logRequestStart(config.logger, "model-gateway.request.start", {
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
        throw createHttpGatewayError({
          statusCode: response.status,
          body,
          requestId: response.headers.get("x-request-id") ?? undefined,
        });
      }

      const parsed = await parseResponseBody(response);
      if (typeof parsed === "string") {
        throw createHttpGatewayError({
          statusCode: 502,
          body: {
            message: "Expected JSON response from model gateway",
            raw: parsed,
          },
        });
      }

      logRequestSuccess(config.logger, "model-gateway.request.success", {
        method: input.method ?? "POST",
        attempt,
      });

      await emitObserveSpan({
        config,
        options,
        name: "http.request",
        startedAtMs,
        status: "ok",
        attempt,
        attributes: {
          method: input.method ?? "POST",
        },
      });

      return parsed as T;
    } catch (error) {
      const normalized = normalizeGatewayError(error);
      lastError = normalized;

      if (!isRetryableError(normalized) || attempt >= maxRetries) {
        logRequestFailure(config.logger, "model-gateway.request.failure", {
          method: input.method ?? "POST",
          attempt,
          ...loggableError(normalized),
        });

        await emitObserveSpan({
          config,
          options,
          name: "http.request",
          startedAtMs,
          status: "error",
          attempt,
          attributes: {
            method: input.method ?? "POST",
            statusCode: normalized.statusCode,
          },
          errorCode: normalized.code,
          errorMessage: normalized.message,
        });

        throw normalized;
      }

      const delayMs = buildRetryDelay(attempt);
      logRequestRetry(config.logger, "model-gateway.request.retry", {
        method: input.method ?? "POST",
        attempt,
        delayMs,
        code: normalized.code,
      });

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
    }
  }

  throw normalizeGatewayError(lastError);
}

export async function requestStream(
  config: ResolvedRequestConfig,
  input: HttpRequestInput,
): Promise<Response> {
  const options = input.options;
  const timeoutMs = options?.timeoutMs ?? config.timeoutMs;
  const maxRetries = options?.maxRetries ?? config.maxRetries;
  const url = joinUrl(config.baseUrl, input.path, input.query);

  let attempt = 0;
  let lastError: unknown;
  const startedAtMs = Date.now();

  while (attempt <= maxRetries) {
    const headers = {
      ...buildRequestHeaders(config, options),
      ...buildTracingHeaders(options),
    };

    logRequestStart(config.logger, "model-gateway.stream.start", {
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
        throw createHttpGatewayError({
          statusCode: response.status,
          body,
          requestId: response.headers.get("x-request-id") ?? undefined,
        });
      }

      logRequestSuccess(config.logger, "model-gateway.stream.success", {
        method: input.method ?? "POST",
        attempt,
      });

      await emitObserveSpan({
        config,
        options,
        name: "http.stream",
        startedAtMs,
        status: "ok",
        attempt,
        attributes: {
          method: input.method ?? "POST",
        },
      });

      return response;
    } catch (error) {
      const normalized = normalizeGatewayError(error);
      lastError = normalized;

      if (!isRetryableError(normalized) || attempt >= maxRetries) {
        logRequestFailure(config.logger, "model-gateway.stream.failure", {
          method: input.method ?? "POST",
          attempt,
          ...loggableError(normalized),
        });

        await emitObserveSpan({
          config,
          options,
          name: "http.stream",
          startedAtMs,
          status: "error",
          attempt,
          attributes: {
            method: input.method ?? "POST",
            statusCode: normalized.statusCode,
          },
          errorCode: normalized.code,
          errorMessage: normalized.message,
        });

        throw normalized;
      }

      const delayMs = buildRetryDelay(attempt);
      logRequestRetry(config.logger, "model-gateway.stream.retry", {
        method: input.method ?? "POST",
        attempt,
        delayMs,
      });

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
    }
  }

  throw normalizeGatewayError(lastError);
}
