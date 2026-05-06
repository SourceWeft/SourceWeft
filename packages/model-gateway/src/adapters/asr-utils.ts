import { ModelGatewayError } from "../errors";
import type {
  AsrResponseFormat,
  AsrSegment,
  AsrTimestampGranularity,
  AsrTranscribeInput,
  AsrWord,
  UsageInfo,
} from "../types";

export const OPENAI_COMPATIBLE_ASR_AUDIO_FORMATS = [
  "flac",
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "m4a",
  "ogg",
  "wav",
  "webm",
] as const;

const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  flac: "audio/flac",
  mp3: "audio/mpeg",
  mp4: "audio/mp4",
  mpeg: "audio/mpeg",
  mpga: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  wav: "audio/wav",
  webm: "audio/webm",
};

const EXTENSIONS_BY_MIME_TYPE: Record<string, string[]> = {
  "audio/flac": ["flac"],
  "audio/mpeg": ["mp3", "mpeg", "mpga"],
  "audio/mp3": ["mp3"],
  "audio/mp4": ["mp4", "m4a"],
  "audio/m4a": ["m4a"],
  "audio/ogg": ["ogg"],
  "audio/wav": ["wav"],
  "audio/wave": ["wav"],
  "audio/x-wav": ["wav"],
  "audio/webm": ["webm"],
  "video/mp4": ["mp4"],
  "video/webm": ["webm"],
};

function normalizeExtension(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const extension = value.trim().toLowerCase().replace(/^\.+/, "");
  return extension.length > 0 ? extension : undefined;
}

function extensionFromFileName(fileName: string) {
  const lastSegment = fileName.split(/[\\/]/).at(-1) ?? fileName;
  const dotIndex = lastSegment.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === lastSegment.length - 1) {
    return undefined;
  }
  return normalizeExtension(lastSegment.slice(dotIndex + 1));
}

function extensionsFromMimeType(mimeType: string | undefined) {
  const normalized = mimeType?.split(";")[0]?.trim().toLowerCase();
  return normalized ? EXTENSIONS_BY_MIME_TYPE[normalized] : undefined;
}

function isExplicitMimeConflict(input: {
  extension: string;
  mimeType: string | undefined;
}) {
  const normalizedMime = input.mimeType?.split(";")[0]?.trim().toLowerCase();
  if (!normalizedMime || normalizedMime === "application/octet-stream") {
    return false;
  }

  const expectedMime = MIME_TYPE_BY_EXTENSION[input.extension];
  if (!expectedMime) {
    return false;
  }

  const allowedExtensions = EXTENSIONS_BY_MIME_TYPE[normalizedMime];
  if (allowedExtensions) {
    return !allowedExtensions.includes(input.extension);
  }

  return !normalizedMime.startsWith("audio/") && !normalizedMime.startsWith("video/");
}

export function resolveAsrAudioFormat(input: {
  fileName: string;
  mimeType?: string;
  supportedAudioFormats: readonly string[];
  provider: string;
  model: string;
}) {
  const supported = new Set(input.supportedAudioFormats.map((item) => item.toLowerCase()));
  const extension = extensionFromFileName(input.fileName);

  if (extension && supported.has(extension)) {
    if (isExplicitMimeConflict({ extension, mimeType: input.mimeType })) {
      throw new ModelGatewayError({
        code: "BAD_REQUEST",
        message:
          `ASR audio file '${input.fileName}' has MIME type '${input.mimeType}' ` +
          `that does not match extension '.${extension}' for provider '${input.provider}' ` +
          `model '${input.model}'`,
        retryable: false,
      });
    }
    return extension;
  }

  const mimeExtensions = extensionsFromMimeType(input.mimeType);
  const mimeFormat = mimeExtensions?.find((item) => supported.has(item));
  if (!extension && mimeFormat) {
    return mimeFormat;
  }

  throw new ModelGatewayError({
    code: "BAD_REQUEST",
    message:
      `Unsupported ASR audio format for provider '${input.provider}' model '${input.model}'. ` +
      `Supported formats: ${input.supportedAudioFormats.join(", ")}`,
    retryable: false,
  });
}

export function asrAudioInputToBlob(input: AsrTranscribeInput) {
  if (input.audio instanceof Blob) {
    return input.audio;
  }

  const type = input.mimeType?.trim() || "application/octet-stream";
  if (input.audio instanceof ArrayBuffer) {
    return new Blob([input.audio], { type });
  }

  return new Blob([input.audio.slice()], { type });
}

export function normalizeTimestampGranularities(
  value: AsrTimestampGranularity[] | undefined,
) {
  const source = value && value.length > 0 ? value : ["segment"];
  return Array.from(new Set(source));
}

export function normalizeResponseFormat(value: AsrResponseFormat | undefined) {
  return value ?? "verbose_json";
}

export function appendFormValue(form: FormData, key: string, value: unknown) {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      appendFormValue(form, `${key}[]`, item);
    }
    return;
  }

  if (typeof value === "object") {
    form.append(key, JSON.stringify(value));
    return;
  }

  form.append(key, String(value));
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeTimedTextItem(value: unknown): { start: number; end: number; text: string } | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const start = typeof record.start === "number" ? record.start : null;
  const end = typeof record.end === "number" ? record.end : null;
  const text = typeof record.text === "string" ? record.text : null;
  if (start === null || end === null || text === null) {
    return null;
  }

  return { start, end, text };
}

export function normalizeAsrSegments(raw: unknown): AsrSegment[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const segments = raw.flatMap((item) => {
    const normalized = normalizeTimedTextItem(item);
    if (!normalized) {
      return [];
    }
    const record = toRecord(item);
    return [{
      ...normalized,
      ...(typeof record?.id === "number" ? { id: record.id } : {}),
    }];
  });

  return segments.length > 0 ? segments : undefined;
}

export function normalizeAsrWords(raw: unknown): AsrWord[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const words = raw.flatMap((item) => normalizeTimedTextItem(item) ?? []);
  return words.length > 0 ? words : undefined;
}

export function normalizeAsrUsage(raw: Record<string, unknown>): UsageInfo | undefined {
  const usage = toRecord(raw.usage);
  if (usage) {
    const inputTokens = typeof usage.prompt_tokens === "number"
      ? usage.prompt_tokens
      : typeof usage.input_tokens === "number"
        ? usage.input_tokens
        : undefined;
    const outputTokens = typeof usage.completion_tokens === "number"
      ? usage.completion_tokens
      : typeof usage.output_tokens === "number"
        ? usage.output_tokens
        : undefined;
    const totalTokens = typeof usage.total_tokens === "number"
      ? usage.total_tokens
      : undefined;
    return inputTokens !== undefined ||
      outputTokens !== undefined ||
      totalTokens !== undefined
      ? { inputTokens, outputTokens, totalTokens }
      : undefined;
  }

  const inferenceStatus = toRecord(raw.inference_status);
  if (!inferenceStatus) {
    return undefined;
  }

  const inputTokens = typeof inferenceStatus.tokens_input === "number"
    ? inferenceStatus.tokens_input
    : undefined;
  const outputTokens = typeof inferenceStatus.tokens_generated === "number"
    ? inferenceStatus.tokens_generated
    : undefined;
  return inputTokens !== undefined || outputTokens !== undefined
    ? {
        inputTokens,
        outputTokens,
        totalTokens:
          inputTokens !== undefined && outputTokens !== undefined
            ? inputTokens + outputTokens
            : undefined,
      }
    : undefined;
}
