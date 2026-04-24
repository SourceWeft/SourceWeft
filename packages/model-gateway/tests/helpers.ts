export function createJsonResponse(
  body: unknown,
  init?: ResponseInit,
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

export function createSseResponse(
  events: string[],
  init?: ResponseInit,
): Response {
  const encoder = new TextEncoder();
  let index = 0;

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = events[index];
      if (next === undefined) {
        controller.close();
        return;
      }

      controller.enqueue(encoder.encode(next));
      index += 1;
    },
  });

  return new Response(body, {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "text/event-stream",
      ...(init?.headers ?? {}),
    },
  });
}
