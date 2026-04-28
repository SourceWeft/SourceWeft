import type { Context } from "hono";
import { ApiError } from "../../response/api-response";

export function requireRouteParam(c: Context, name: string) {
  const value = c.req.param(name);
  if (!value) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      `${name} route parameter is required`,
    );
  }

  return value;
}

export function ensureObjectBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw ApiError.invalidJson();
  }

  return value;
}

export function createSseResponse(stream: AsyncGenerator<string>) {
  const bodyStream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          controller.enqueue(chunk);
        }
        controller.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Stream failed";
        controller.enqueue(
          `data: ${JSON.stringify({ type: "error", error: message })}\n\n`,
        );
        controller.close();
      }
    },
  });

  return bodyStream;
}
