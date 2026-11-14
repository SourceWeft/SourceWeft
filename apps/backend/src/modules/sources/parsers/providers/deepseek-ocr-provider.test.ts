import assert from "node:assert/strict";
import { test } from "vitest";
import { resolvePhysicalPageCount } from "../../billing-pages";
import {
  createDeepSeekOcrProvider,
  type DeepSeekOcrProviderOptions,
} from "./deepseek-ocr-provider";
import type { ProviderParseInput } from "./types";

type Call = { url: string; init: RequestInit; form: FormData };

function ocrBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "ocr-1",
    object: "ocr.result",
    created: 1762790000,
    purpose: "text_recognition",
    page_count: 2,
    pages: [
      { index: 0, text: "First page", finish_reason: "stop" },
      { index: 1, text: "Second page", finish_reason: "stop" },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
}

function createFetch(
  handler: (call: Call, index: number) => Response | Promise<Response>,
) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      init: init ?? {},
      form: init?.body as FormData,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function build(
  fetchImpl: typeof fetch,
  options: Partial<DeepSeekOcrProviderOptions> = {},
) {
  return createDeepSeekOcrProvider({
    apiKey: () => "test-key",
    fetchImpl,
    retryDelayMs: 0,
    ...options,
  });
}

function input(overrides: Partial<ProviderParseInput> = {}): ProviderParseInput {
  const content = overrides.content ?? Buffer.from("%PDF-1.7 fixture");
  return {
    sourceId: "source-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    fileName: "scan.pdf",
    mimeType: "application/pdf",
    fileSize: content.byteLength,
    content,
    config: { chunkSize: 512, parserVersion: "test" },
    ...overrides,
  };
}

test("supports PDFs and the image types DeepSeek accepts, nothing else", () => {
  const provider = build(createFetch(() => json(ocrBody())).fetchImpl);
  assert.equal(provider.id, "deepseek");
  for (const mimeType of [
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/bmp",
    "image/tiff",
    "image/avif",
  ]) {
    assert.equal(provider.supports(mimeType), true, mimeType);
  }
  assert.equal(provider.supports("text/plain"), false);
  assert.equal(provider.supports("audio/wav"), false);
});

test("posts the file and text_recognition purpose with a bearer key", async () => {
  const { calls, fetchImpl } = createFetch(() => json(ocrBody()));
  await build(fetchImpl).start(input());

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.deepseek.com/v1/tools/ocr");
  assert.equal(calls[0]?.init.method, "POST");
  const headers = new Headers(calls[0]?.init.headers);
  assert.equal(headers.get("authorization"), "Bearer test-key");
  assert.equal(calls[0]?.form.get("purpose"), "text_recognition");
  const file = calls[0]?.form.get("file") as File;
  assert.equal(file.name, "scan.pdf");
  assert.equal(file.type, "application/pdf");
  assert.equal(file.size, 16);
});

test("returns a completed document with per-page content and an ocr page count", async () => {
  const { fetchImpl } = createFetch(() => json(ocrBody()));
  const outcome = await build(fetchImpl).start(input());

  assert.equal(outcome.kind, "completed");
  if (outcome.kind !== "completed") return;
  assert.deepEqual(
    outcome.document.pages.map((page) => [page.pageNumber, page.content]),
    [
      [1, "First page"],
      [2, "Second page"],
    ],
  );
  assert.match(outcome.document.content, /First page[\s\S]*Second page/);
  const metadata = outcome.document.metadata;
  assert.equal(metadata.pageCount, 2);
  assert.equal(metadata.pageCountSource, "ocr");
  assert.equal(metadata.documentParseBackend, "deepseek");
  assert.equal(metadata.documentParseProvider, "deepseek");
  assert.equal(metadata.documentParseProviderResolved, "deepseek");
  assert.equal(metadata.documentParseMode, "ocr_pdf");
  assert.equal(metadata.providerRequestId, "ocr-1");
  assert.equal(
    resolvePhysicalPageCount({ mimeType: "application/pdf", metadata }),
    2,
  );
});

test("an image is image_ocr and counts as one physical page", async () => {
  const { fetchImpl } = createFetch(() =>
    json(ocrBody({ page_count: 1, pages: [{ index: 0, text: "Receipt", finish_reason: "stop" }] })),
  );
  const outcome = await build(fetchImpl).start(
    input({ fileName: "r.png", mimeType: "image/png" }),
  );
  assert.equal(outcome.kind, "completed");
  if (outcome.kind !== "completed") return;
  assert.equal(outcome.document.metadata.documentParseMode, "image_ocr");
  assert.equal(
    resolvePhysicalPageCount({
      mimeType: "image/png",
      metadata: outcome.document.metadata,
    }),
    1,
  );
});

test("AVIF is converted to PNG because DeepSeek does not accept it", async () => {
  const sharp = (await import("sharp")).default;
  const avif = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#fff" },
  })
    .avif()
    .toBuffer();
  const { calls, fetchImpl } = createFetch(() => json(ocrBody({ page_count: 1 })));
  await build(fetchImpl).start(
    input({ fileName: "photo.avif", mimeType: "image/avif", content: avif }),
  );
  const file = calls[0]?.form.get("file") as File;
  assert.equal(file.type, "image/png");
  assert.equal(file.name, "photo.png");
});

test("parses a body preceded by keep-alive newlines", async () => {
  const { fetchImpl } = createFetch(
    () =>
      new Response(`\n\n\n${JSON.stringify(ocrBody())}`, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const outcome = await build(fetchImpl).start(input());
  assert.equal(outcome.kind, "completed");
});

test("a page cut off by the length limit is reported in metadata, not hidden", async () => {
  const { fetchImpl } = createFetch(() =>
    json(
      ocrBody({
        pages: [
          { index: 0, text: "ok", finish_reason: "stop" },
          { index: 1, text: "cut", finish_reason: "length" },
        ],
      }),
    ),
  );
  const outcome = await build(fetchImpl).start(input());
  assert.equal(outcome.kind, "completed");
  if (outcome.kind !== "completed") return;
  assert.deepEqual(outcome.document.metadata.providerTruncatedPages, [2]);
});

test("an error object inside a 200 body is a failure", async () => {
  const { fetchImpl } = createFetch(() =>
    json({ error: { message: "recognition crashed" } }),
  );
  await assert.rejects(
    () => build(fetchImpl).start(input()),
    /DeepSeek OCR failed.*recognition crashed/,
  );
});

test("a result with no pages is an error, not an empty document", async () => {
  const { fetchImpl } = createFetch(() => json(ocrBody({ page_count: 0, pages: [] })));
  await assert.rejects(
    () => build(fetchImpl).start(input()),
    /DeepSeek OCR returned no pages/,
  );
});

for (const [status, pattern] of [
  [400, /400/],
  [402, /insufficient balance/i],
  [408, /408/],
  [413, /413/],
  [500, /500/],
] as const) {
  test(`HTTP ${status} fails without retrying and never leaks the key`, async () => {
    const { calls, fetchImpl } = createFetch(() =>
      json({ error: { message: "nope" } }, status),
    );
    await assert.rejects(
      () => build(fetchImpl).start(input()),
      (error: Error) => {
        assert.match(error.message, pattern);
        assert.doesNotMatch(error.message, /test-key/);
        return true;
      },
    );
    assert.equal(calls.length, 1);
  });
}

for (const status of [429, 503]) {
  test(`HTTP ${status} is retried and then succeeds`, async () => {
    const { calls, fetchImpl } = createFetch((_call, index) =>
      index === 0 ? json({ error: { message: "busy" } }, status) : json(ocrBody()),
    );
    const outcome = await build(fetchImpl).start(input());
    assert.equal(outcome.kind, "completed");
    assert.equal(calls.length, 2);
  });
}

test("HTTP 429 gives up after the attempt budget", async () => {
  const { calls, fetchImpl } = createFetch(() =>
    json({ error: { message: "busy" } }, 429),
  );
  await assert.rejects(
    () => build(fetchImpl, { maxAttempts: 3 }).start(input()),
    /429/,
  );
  assert.equal(calls.length, 3);
});

test("a file over 100 MiB is rejected before any request", async () => {
  const { calls, fetchImpl } = createFetch(() => json(ocrBody()));
  await assert.rejects(
    () =>
      build(fetchImpl).start(
        input({ fileSize: 100 * 1024 * 1024 + 1, content: Buffer.from("x") }),
      ),
    /100 MiB/,
  );
  assert.equal(calls.length, 0);
});

test("a missing key fails loudly before any request", async () => {
  const { calls, fetchImpl } = createFetch(() => json(ocrBody()));
  await assert.rejects(
    () => build(fetchImpl, { apiKey: () => "" }).start(input()),
    /DEEPSEEK_API_KEY is missing/,
  );
  assert.equal(calls.length, 0);
});

test("a request that outlives the timeout fails with a timeout error", async () => {
  const { fetchImpl } = createFetch(
    (call) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = call.init.signal as AbortSignal;
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  );
  // AbortSignal.timeout timers are unref'd and the fake has no socket, so keep
  // the loop alive for the duration of the test.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(
      () => build(fetchImpl, { requestTimeoutMs: 20 }).start(input()),
      /timed out/i,
    );
  } finally {
    clearInterval(keepAlive);
  }
});

test("never runs more recognitions at once than the concurrency bound", async () => {
  let active = 0;
  let maxActive = 0;
  const { fetchImpl } = createFetch(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return json(ocrBody());
  });
  const provider = build(fetchImpl, { maxConcurrent: 2 });
  const outcomes = await Promise.all(
    Array.from({ length: 6 }, () => provider.start(input())),
  );
  assert.equal(outcomes.every((outcome) => outcome.kind === "completed"), true);
  assert.equal(maxActive, 2);
});
