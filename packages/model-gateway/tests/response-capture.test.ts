import assert from "node:assert/strict";
import test from "node:test";
import {
  captureProviderResponseFetch,
  createProviderResponseCapture,
  runWithProviderResponseCapture,
} from "../src/observation/response-capture";

const encoder = new TextEncoder();

function sseLine(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** An SSE response whose body arrives in exactly the given byte pieces. */
function sseResponse(pieces: Uint8Array[]) {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const piece = pieces[index];
      index += 1;
      if (piece === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(piece);
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

async function readAll(response: Response) {
  const chunks: Uint8Array[] = [];
  const reader = response.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const usage = {
  prompt_tokens: 18929,
  completion_tokens: 2,
  total_tokens: 18931,
  estimated_cost: 0.00006698104,
  prompt_tokens_details: { cached_tokens: 18816 },
  completion_tokens_details: { reasoning_tokens: 0 },
};

const contentChunk = (text: string) => ({
  id: "c1",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  usage: null,
});

const usageOnlyChunk = { id: "c1", choices: [], usage };

test("captures the usage of a trailing usage-only SSE chunk and leaves the bytes untouched", async () => {
  const text =
    sseLine(contentChunk("你好，")) +
    sseLine(contentChunk("world")) +
    sseLine(usageOnlyChunk) +
    "data: [DONE]\n\n";
  const bytes = encoder.encode(text);
  // Cut inside a multi-byte character and inside the usage line.
  const usageAt = text.indexOf('"usage":{');
  const cutInsideUsage = encoder.encode(text.slice(0, usageAt + 20)).length;
  const pieces = [
    bytes.slice(0, 80),
    bytes.slice(80, 81),
    bytes.slice(81, cutInsideUsage),
    bytes.slice(cutInsideUsage),
  ];

  const capture = createProviderResponseCapture();
  const wrapped = captureProviderResponseFetch(async () => sseResponse(pieces));
  const received = await runWithProviderResponseCapture(capture, async () =>
    readAll(await wrapped("https://provider.example/v1/chat/completions")),
  );

  assert.equal(received, text);
  assert.deepEqual(capture.usage, usage);
  assert.equal(capture.statusCode, 200);
  assert.equal(
    capture.headers?.get("content-type"),
    "text/event-stream; charset=utf-8",
  );
});

test("the last usage object wins when a provider reports usage on several chunks", async () => {
  const first = { ...usage, completion_tokens: 1, total_tokens: 18930 };
  const text =
    sseLine({ ...contentChunk("a"), usage: first }) +
    sseLine({ ...contentChunk("b"), usage }) +
    "data: [DONE]\n\n";
  const capture = createProviderResponseCapture();
  const wrapped = captureProviderResponseFetch(async () =>
    sseResponse([encoder.encode(text)]),
  );
  await runWithProviderResponseCapture(capture, async () =>
    readAll(await wrapped("https://provider.example/v1/chat/completions")),
  );
  assert.deepEqual(capture.usage, usage);
});

test("a stream without usage captures none", async () => {
  const text = sseLine(contentChunk("a")) + "data: [DONE]\n\n";
  const capture = createProviderResponseCapture();
  const wrapped = captureProviderResponseFetch(async () =>
    sseResponse([encoder.encode(text)]),
  );
  const received = await runWithProviderResponseCapture(capture, async () =>
    readAll(await wrapped("https://provider.example/v1/chat/completions")),
  );
  assert.equal(received, text);
  assert.equal(capture.usage, undefined);
});

test("a later request in the same capture forgets the earlier request's usage", async () => {
  const withUsage = sseLine(usageOnlyChunk) + "data: [DONE]\n\n";
  const withoutUsage = sseLine(contentChunk("a")) + "data: [DONE]\n\n";
  const bodies = [withUsage, withoutUsage];
  const capture = createProviderResponseCapture();
  const wrapped = captureProviderResponseFetch(async () =>
    sseResponse([encoder.encode(bodies.shift()!)]),
  );
  await runWithProviderResponseCapture(capture, async () => {
    await readAll(await wrapped("https://provider.example/one"));
    assert.deepEqual(capture.usage, usage);
    await readAll(await wrapped("https://provider.example/two"));
  });
  assert.equal(capture.usage, undefined);
});

test("a JSON response is returned as is", async () => {
  const original = new Response(JSON.stringify({ usage }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const capture = createProviderResponseCapture();
  const wrapped = captureProviderResponseFetch(async () => original);
  const response = await runWithProviderResponseCapture(capture, () =>
    wrapped("https://provider.example/v1/chat/completions"),
  );
  assert.equal(response, original);
  assert.equal(capture.usage, undefined);
  assert.equal(capture.statusCode, 200);
});

test("outside a capture the response is returned as is", async () => {
  const original = sseResponse([encoder.encode(sseLine(usageOnlyChunk))]);
  const wrapped = captureProviderResponseFetch(async () => original);
  assert.equal(await wrapped("https://provider.example/x"), original);
});

test("cancelling the wrapped body cancels the provider's stream", async () => {
  let cancelled = false;
  // A provider stream that is still open: one event sent, more to come.
  const open = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseLine(contentChunk("a"))));
    },
    cancel() {
      cancelled = true;
    },
  });
  const capture = createProviderResponseCapture();
  const wrapped = captureProviderResponseFetch(
    async () =>
      new Response(open, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  );
  await runWithProviderResponseCapture(capture, async () => {
    const response = await wrapped("https://provider.example/x");
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
  });
  assert.equal(cancelled, true);
});

test("the wrapped response keeps status, headers and url", async () => {
  const original = sseResponse([encoder.encode("data: [DONE]\n\n")]);
  Object.defineProperty(original, "url", {
    value: "https://provider.example/v1/chat/completions",
  });
  const capture = createProviderResponseCapture();
  const wrapped = captureProviderResponseFetch(async () => original);
  const response = await runWithProviderResponseCapture(capture, () =>
    wrapped("https://provider.example/v1/chat/completions"),
  );
  assert.equal(response.status, 200);
  assert.equal(response.ok, true);
  assert.equal(
    response.headers.get("content-type"),
    "text/event-stream; charset=utf-8",
  );
  assert.equal(response.url, "https://provider.example/v1/chat/completions");
  await readAll(response);
});
