/**
 * How this capability's tool output is read back for display.
 *
 * The stage names, the aspect-ratio fields and the title fallbacks below are
 * `generate_image`'s own wire vocabulary — they are decoded here, beside the
 * tool that writes them, so no generic renderer ever has to know them.
 *
 * React-free on purpose: the message-stream block, the preview panel and the
 * plain tool-card label all share these readers.
 */

export type GeneratedImageArtifactRef = {
  artifactId: string | null;
  artifactUrl: string | null;
  title: string | null;
};

/** Reads one scalar field out of a tool call's output, however it arrived. */
export type ToolOutputFieldReader = (key: string) => string | null;

const GENERATED_IMAGE_DEFAULT_ASPECT_RATIO = "4 / 3";

/** Ordered stages `generate_image` streams; the index drives the progress meter. */
const GENERATED_IMAGE_STAGE_INDEX: Record<string, number> = {
  preparing: 0,
  generating: 1,
  saving: 2,
  billing: 3,
  ready: 4,
};

function getRecordValue(
  record: Record<string, unknown> | undefined,
  key: string,
) {
  return record ? record[key] : undefined;
}

function outputRecord(output: unknown) {
  return output && typeof output === "object"
    ? (output as Record<string, unknown>)
    : undefined;
}

function compactText(value: string, maxLength = 160) {
  const compacted = value.replace(/\s+/g, " ").trim();
  return compacted.length > maxLength
    ? `${compacted.slice(0, maxLength - 1)}…`
    : compacted;
}

export function parseAspectRatio(value: unknown) {
  if (typeof value !== "string" || value === "auto") {
    return null;
  }

  const match = value.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) {
    return null;
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) {
    return null;
  }

  return `${width} / ${height}`;
}

export type GeneratedImageToolCallView = {
  readonly input: Record<string, unknown>;
  readonly output: unknown;
};

export function getGeneratedImageStatus(toolCall: GeneratedImageToolCallView) {
  const output = outputRecord(toolCall.output);
  const input = toolCall.input;
  const stage = getRecordValue(output, "stage");
  const normalizedStage =
    typeof stage === "string" && stage.trim().length > 0 ? stage.trim() : null;
  const outputWidth = getRecordValue(output, "width");
  const outputHeight = getRecordValue(output, "height");
  const width =
    typeof outputWidth === "number" && Number.isFinite(outputWidth)
      ? outputWidth
      : null;
  const height =
    typeof outputHeight === "number" && Number.isFinite(outputHeight)
      ? outputHeight
      : null;
  const aspectRatio =
    width && height && height > 0
      ? `${width} / ${height}`
      : (parseAspectRatio(getRecordValue(output, "aspectRatio")) ??
        parseAspectRatio(getRecordValue(input, "aspectRatio")) ??
        GENERATED_IMAGE_DEFAULT_ASPECT_RATIO);

  // Display label lives on the capability (generateImagePresentation); this
  // helper only feeds the progress meter's aspect ratio and step index.
  return {
    aspectRatio,
    progress:
      normalizedStage && normalizedStage in GENERATED_IMAGE_STAGE_INDEX
        ? GENERATED_IMAGE_STAGE_INDEX[normalizedStage]
        : null,
    stage: normalizedStage,
  };
}

export function getGeneratedImageTitle(toolCall: GeneratedImageToolCallView) {
  const output = outputRecord(toolCall.output);
  const outputTitle = getRecordValue(output, "title");
  if (typeof outputTitle === "string" && outputTitle.trim().length > 0) {
    return outputTitle.trim();
  }

  const inputTitle = getRecordValue(toolCall.input, "title");
  if (typeof inputTitle === "string" && inputTitle.trim().length > 0) {
    return inputTitle.trim();
  }

  const prompt = getRecordValue(toolCall.input, "prompt");
  return typeof prompt === "string" && prompt.trim().length > 0
    ? compactText(prompt, 72)
    : null;
}

export function getGeneratedImagePrompt(toolCall: GeneratedImageToolCallView) {
  const prompt = getRecordValue(toolCall.input, "prompt");
  if (typeof prompt === "string" && prompt.trim().length > 0) {
    return prompt.trim();
  }

  const output = outputRecord(toolCall.output);
  const outputPrompt = getRecordValue(output, "prompt");
  return typeof outputPrompt === "string" && outputPrompt.trim().length > 0
    ? outputPrompt.trim()
    : null;
}

/**
 * The artifact reference `generate_image` publishes in its tool output. The
 * caller supplies the transport-level field reader (host facility) and any
 * trace-step metadata that already carries the ids; the *key names* are this
 * capability's business.
 */
export function resolveGeneratedImageArtifactRef(input: {
  readField: ToolOutputFieldReader;
  metadata?: Record<string, unknown> | undefined;
}): GeneratedImageArtifactRef | null {
  const metadata = input.metadata;
  const artifactId =
    (typeof metadata?.artifactId === "string"
      ? metadata.artifactId.trim()
      : "") || input.readField("artifact_id");
  const artifactUrl =
    (typeof metadata?.artifactUrl === "string"
      ? metadata.artifactUrl.trim()
      : "") ||
    input.readField("artifact_url") ||
    input.readField("preview_url");
  const title = input.readField("title");

  if (!artifactId && !artifactUrl) {
    return null;
  }

  return {
    artifactId: artifactId || null,
    artifactUrl: artifactUrl || null,
    title,
  };
}
