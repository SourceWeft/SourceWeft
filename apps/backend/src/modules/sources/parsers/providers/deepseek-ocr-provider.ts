import { getAnydocFormatByMimeType } from "@sourceweft/builtin-document-parsers/formats";
import type { DocumentParseMode } from "../../../content/types";
import { normalizeImageForPdf2Markdown } from "./image-normalizer";
import type { DocumentParseProvider, ProviderParseInput } from "./types";
import { buildParsedDocument, isSupportedImageMimeType } from "./utils";

/**
 * DeepSeek's first-party OCR (`POST /v1/tools/ocr`).
 *
 * Unlike pdf2markdown this is synchronous: the server holds the connection open
 * with keep-alive newlines and finishes with one JSON object, so `start` returns
 * a completed document and there is nothing to resume.
 *
 * Limits come from the DeepSeek OCR guide: 100 MiB, 180 s of processing and 15
 * concurrent recognitions per account. Anything over the size cap is rejected
 * here instead of being uploaded just to be refused with a 413.
 */
const DEFAULT_BASE_URL = "https://api.deepseek.com";
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 200_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_AFTER_MS = 10_000;
// The account allows 15. The rest is headroom for other workers sharing it.
const DEFAULT_MAX_CONCURRENT = 12;
const RETRYABLE_STATUSES = new Set([429, 503]);
const PURPOSE = "text_recognition";

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
  // Converted to PNG before upload.
  "image/avif",
]);

type OcrPage = { index?: number; text?: string; finish_reason?: string };
type OcrResponse = {
  id?: string;
  page_count?: number;
  pages?: OcrPage[];
  error?: { message?: string };
};

export type DeepSeekOcrProviderOptions = {
  /** Read per call so a missing key fails the call, not module load. */
  readonly apiKey: () => string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly requestTimeoutMs?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly maxConcurrent?: number;
};

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

function sleep(ms: number) {
  return ms > 0
    ? new Promise<void>((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();
}

function parseJson(text: string): unknown {
  // Keep-alive newlines precede the JSON object while recognition runs.
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function errorMessageOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return error.slice(0, 200);
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message.slice(0, 200);
  }
  return undefined;
}

function failure(status: number, message: string | undefined) {
  if (status === 402) {
    return new Error(
      "DeepSeek OCR failed: 402 insufficient balance on the DeepSeek account.",
    );
  }
  return new Error(
    `DeepSeek OCR failed: ${status}${message ? ` ${message}` : ""}`,
  );
}

function isTimeout(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function retryAfterMs(response: Response, fallback: number) {
  const seconds = Number(response.headers.get("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  return fallback;
}

export function createDeepSeekOcrProvider(
  options: DeepSeekOcrProviderOptions,
): DocumentParseProvider {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const semaphore = new Semaphore(
    Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT),
  );

  async function recognize(form: FormData, apiKey: string): Promise<OcrResponse> {
    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      let text: string;
      try {
        ({ response, text } = await semaphore.run(async () => {
          const res = await fetchImpl(`${baseUrl}/v1/tools/ocr`, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            body: form,
            signal: AbortSignal.timeout(timeoutMs),
          });
          return { response: res, text: await res.text() };
        }));
      } catch (error) {
        if (isTimeout(error)) {
          throw new Error(`DeepSeek OCR timed out after ${timeoutMs}ms.`);
        }
        throw error;
      }

      const body = parseJson(text);
      if (response.ok) {
        const embedded = errorMessageOf(body);
        if (embedded) throw failure(response.status, embedded);
        if (body === null) {
          throw new Error("DeepSeek OCR returned an unreadable response.");
        }
        return body as OcrResponse;
      }
      if (RETRYABLE_STATUSES.has(response.status) && attempt < maxAttempts) {
        await sleep(retryAfterMs(response, retryDelayMs * attempt));
        continue;
      }
      throw failure(response.status, errorMessageOf(body));
    }
  }

  return {
    id: "deepseek",
    supports(mimeType) {
      const lower = mimeType.toLowerCase();
      return (
        getAnydocFormatByMimeType(lower)?.format === "pdf" ||
        (isSupportedImageMimeType(lower) && SUPPORTED_IMAGE_MIME_TYPES.has(lower))
      );
    },
    async start(input: ProviderParseInput) {
      const apiKey = options.apiKey().trim();
      if (!apiKey) {
        throw new Error(
          "DeepSeek OCR provider is not configured: DEEPSEEK_API_KEY is missing",
        );
      }
      if (Math.max(input.fileSize, input.content.byteLength) > MAX_FILE_BYTES) {
        throw new Error("DeepSeek OCR accepts files up to 100 MiB.");
      }

      const normalized = await normalizeImageForPdf2Markdown({
        content: input.content,
        fileName: input.fileName,
        mimeType: input.mimeType,
      });
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(normalized.content)], {
          type: normalized.mimeType,
        }),
        normalized.fileName,
      );
      form.append("purpose", PURPOSE);

      const result = await recognize(form, apiKey);
      const pages = [...(result.pages ?? [])].sort(
        (a, b) => (a.index ?? 0) - (b.index ?? 0),
      );
      if (pages.length === 0) {
        throw new Error("DeepSeek OCR returned no pages.");
      }

      const truncatedPages = pages
        .filter((page) => page.finish_reason === "length")
        .map((page) => (page.index ?? 0) + 1);
      const declared = result.page_count;
      const pageCount =
        typeof declared === "number" && Number.isSafeInteger(declared) && declared > 0
          ? declared
          : undefined;
      const mode: DocumentParseMode = isSupportedImageMimeType(input.mimeType)
        ? "image_ocr"
        : "ocr_pdf";

      const document = await buildParsedDocument({
        parseInput: {
          fileName: input.fileName,
          mimeType: input.mimeType,
          fileSize: input.fileSize,
          content: input.content,
          config: input.config,
        },
        content: pages.map((page) => page.text ?? "").join("\n\n"),
        pages: pages.map((page) => ({
          pageNumber: (page.index ?? 0) + 1,
          content: page.text ?? "",
        })),
        metadata: {
          ...(pageCount !== undefined ? { pageCount } : {}),
          // Explicit unknown keeps a synthetic logical page from becoming physical.
          pageCountSource: pageCount !== undefined ? "ocr" : "unknown",
          documentParseProviderResolved: "deepseek",
          documentParseProvider: "deepseek",
          documentParseBackend: "deepseek",
          documentParseMode: mode,
          providerStatus: "completed",
          providerUpdatedAt: new Date().toISOString(),
          providerInputMimeType: normalized.mimeType,
          ...(normalized.originalMimeType
            ? {
                providerOriginalMimeType: normalized.originalMimeType,
                providerOriginalFileName: normalized.originalFileName,
              }
            : {}),
          ...(result.id ? { providerRequestId: result.id } : {}),
          ...(truncatedPages.length > 0
            ? { providerTruncatedPages: truncatedPages }
            : {}),
        },
      });

      return {
        kind: "completed",
        document,
        diagnostics: { metadata: document.metadata },
      };
    },
  };
}
