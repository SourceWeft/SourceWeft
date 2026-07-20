import { tool, type ToolRuntime } from "langchain";
import type {
  AgentToolArtifactServices,
  AgentToolHostServices,
  AgentToolTurnContext,
} from "@sourceweft/contracts/agent-tools";
import { PUBLISH_ARTIFACT_TOOL_NAME } from "./agent-tool-defs";
import { publishArtifact, type PublishArtifactServices } from "./publisher";
import {
  ArtifactPublishError,
  isRecoverableArtifactPublishErrorCode,
  PublishArtifactInputSchema,
  PublishArtifactToolInputSchema,
  PptxOutputError,
  type PublishArtifactInput,
  type PublishArtifactSuccessOutput,
  type PublishArtifactToolInput,
} from "./schemas";

const PUBLISH_ARTIFACT_TOOL_ID = "publish_artifact";

/** What this capability asks of the host, taken out of the shared contract. */
type CapabilityAgentToolFactoryInput = {
  readonly toolIds?: readonly string[];
  readonly context?: Partial<
    Pick<
      AgentToolTurnContext,
      | "isToolDenied"
      | "runtimeTools"
      | "shouldBindAgentTool"
      | "teamId"
      | "threadId"
      | "userId"
      | "userMessageId"
      | "workspaceId"
    >
  >;
  readonly services?: {
    /** One member of the artifact port: this tool publishes, nothing else. */
    readonly artifacts?: Pick<AgentToolArtifactServices, "publishArtifact">;
    readonly sandbox?: AgentToolHostServices["sandbox"];
    readonly filesystem?: AgentToolHostServices["filesystem"];
    readonly storage?: AgentToolHostServices["storage"];
    readonly logger?: AgentToolHostServices["logger"];
  };
};

function includesTool(
  input: CapabilityAgentToolFactoryInput,
  toolId: string,
): boolean {
  return !input.toolIds || input.toolIds.includes(toolId);
}

function hasRequiredContext(input: CapabilityAgentToolFactoryInput) {
  const ctx = input.context;
  return Boolean(
    ctx?.teamId &&
      ctx.workspaceId &&
      ctx.threadId &&
      ctx.userId &&
      ctx.userMessageId,
  );
}

const pptxArtifactRuntimePromptProvider = {
  buildLines(context: {
    runtimeTools?: Readonly<
      Record<
        string,
        { enabled?: boolean; options?: unknown; selection?: unknown }
      >
    >;
  }) {
    const canonicalRuntimeTool =
      context.runtimeTools?.[PUBLISH_ARTIFACT_TOOL_ID];
    const hasExplicitRuntimeTool = Boolean(canonicalRuntimeTool);
    if (hasExplicitRuntimeTool && canonicalRuntimeTool?.enabled !== true) {
      return [];
    }
    return [
      "Use `publish_artifact` only after the output file has already been generated; for slides, content QA plus visual QA must have passed.",
      "For PPT Deck, publish with `artifactType=slides`, a structured `source` object, and the actual generated `.pptx` path.",
      "For PPT Deck preview thumbnails, `previewImage` is required. Use the `PREVIEW_IMAGE_PATH` printed by final visual QA as `previewImage.source.path`, with `previewImage.source.kind='sandbox_path'` for sandbox files.",
      "Optional preview alt text goes in `previewImage.altText`; do not place preview metadata in `source`, `qa`, or a manifest file.",
      "`publish_artifact` does not search the QA directory automatically; pass the exact `PREVIEW_IMAGE_PATH` from the skill QA output.",
      "For generic downloadable files, publish with `artifactType=file` and the actual generated file path.",
      "For PPT Deck visual QA, first render the actual PPTX to PDF with LibreOffice, then render slide JPG files with pdftoppm, print QA_IMAGE_COUNT and PREVIEW_IMAGE_PATH, inspect the rendered slide images, and include a visible visual QA summary before publishing.",
      "After publishing a PPT Deck, the final response must report the rendered slide image count and visual QA result, not only placeholder/content checks.",
      "Supported source kinds in this phase are `sandbox_path` for sandbox files and `work_file` for SourceWeft workfiles.",
      "`/workfiles` is text-oriented working memory and is not the fallback destination for binary sandbox outputs; publish binary outputs as artifacts instead.",
      "Do not create artifact manifest JSON files or move files only to satisfy a fixed output directory.",
    ];
  },
};

function langchainToolCallIdFromRuntime(runtime: ToolRuntime) {
  const runtimeRecord = runtime as ToolRuntime & {
    config?: { toolCall?: { id?: unknown } };
    toolCall?: { id?: unknown };
    toolCallId?: unknown;
  };
  const candidate =
    runtimeRecord.toolCallId ??
    runtimeRecord.toolCall?.id ??
    runtimeRecord.config?.toolCall?.id;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

function toPublishErrorOutput(error: PptxOutputError) {
  return {
    ok: false as const,
    type: "presentation_artifact_error" as const,
    status: "failed" as const,
    code: error.code,
    message: error.details ?? error.message,
    // Infrastructure failures are reported as unrecoverable so the agent stops
    // retrying instead of hammering a dependency that is down.
    recoverable: isRecoverableArtifactPublishErrorCode(error.code),
  };
}

function toRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeParseJsonObject(value: string) {
  try {
    return toRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function sourceShapeSummary(value: unknown) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") {
    return value.trim().startsWith("{") ? "json_string" : "string";
  }
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") {
    return `object keys: ${Object.keys(value as Record<string, unknown>).join(",") || "(none)"}`;
  }
  return typeof value;
}

function receivedSourceShapeSummary(value: unknown) {
  const record = toRecord(value);
  if (!record) {
    return `received input: ${sourceShapeSummary(value)}`;
  }
  return [
    `received source: ${sourceShapeSummary(record.source)}`,
    `sourceKind: ${sourceShapeSummary(record.sourceKind)}`,
    `sourcePath: ${sourceShapeSummary(record.sourcePath)}`,
  ].join("; ");
}

function normalizePublishToolInput(value: unknown) {
  const record = toRecord(value);
  if (!record) {
    return value;
  }

  const normalized: Record<string, unknown> = { ...record };
  const normalizeSource = (sourceValue: unknown) =>
    typeof sourceValue === "string"
      ? (safeParseJsonObject(sourceValue) ?? sourceValue)
      : sourceValue;
  const source = normalizeSource(normalized.source);

  if (toRecord(source)) {
    normalized.source = source;
  } else if (
    typeof normalized.sourceKind === "string" ||
    typeof normalized.sourcePath === "string"
  ) {
    normalized.source = {
      kind: normalized.sourceKind,
      path: normalized.sourcePath,
    };
  } else {
    normalized.source = source;
  }

  const previewImage = toRecord(normalized.previewImage);
  if (previewImage) {
    normalized.previewImage = {
      ...previewImage,
      source: normalizeSource(previewImage.source),
    };
  }

  return normalized;
}

function collectPublishInputShapeIssues(value: unknown) {
  const record = toRecord(value);
  if (!record) {
    return ["input must be an object"];
  }

  const issues: string[] = [];
  if (
    typeof record.artifactType !== "string" ||
    record.artifactType.trim().length === 0
  ) {
    issues.push(
      record.artifactType === undefined
        ? "artifactType is required"
        : "artifactType must be a non-empty string",
    );
  }
  if (typeof record.title !== "string" || record.title.trim().length === 0) {
    issues.push(
      record.title === undefined
        ? "title is required"
        : "title must be a non-empty string",
    );
  }

  const source = toRecord(record.source);
  if (!source) {
    issues.push(
      record.source === undefined
        ? "source is required"
        : `source must be an object (received ${sourceShapeSummary(record.source)})`,
    );
    return issues;
  }
  if (source.kind !== "sandbox_path" && source.kind !== "work_file") {
    issues.push(
      source.kind === undefined
        ? "source.kind is required"
        : "source.kind must be sandbox_path or work_file",
    );
  }
  if (typeof source.path !== "string" || source.path.trim().length === 0) {
    issues.push(
      source.path === undefined
        ? "source.path is required"
        : "source.path must be a non-empty string",
    );
  }

  return issues;
}

function formatPublishInputValidationMessage(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}) {
  const messages = error.issues.map((issue) => {
    const path =
      issue.path.length > 0 ? issue.path.map(String).join(".") : "input";
    const reason = issue.message === "Required" ? "is required" : issue.message;
    return `${path} ${reason}`;
  });
  return [...new Set(messages)].join("; ");
}

type PublishArtifactFromSourceInput = {
  readonly context: {
    readonly teamId: string;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly userId: string;
  };
  readonly services: {
    readonly artifacts: PublishArtifactServices["artifacts"];
    readonly sandbox?: PublishArtifactServices["sandbox"];
    readonly filesystem?: PublishArtifactServices["filesystem"];
    readonly storage: PublishArtifactServices["storage"];
  };
  readonly input: PublishArtifactInput;
  readonly toolCallId?: string;
};

export async function publishArtifactFromSource(
  input: PublishArtifactFromSourceInput,
): Promise<PublishArtifactSuccessOutput> {
  const parsed = PublishArtifactInputSchema.parse(input.input);
  return publishArtifact({
    context: input.context,
    input: parsed,
    services: {
      artifacts: input.services.artifacts,
      sandbox: input.services.sandbox,
      filesystem: input.services.filesystem,
      storage: input.services.storage,
    },
    toolCallId: input.toolCallId,
  });
}

function shouldBindTool(input: {
  factoryInput: CapabilityAgentToolFactoryInput;
  toolId: string;
}) {
  const context = input.factoryInput.context;
  const runtimeTool = context?.runtimeTools?.[input.toolId];
  return (
    includesTool(input.factoryInput, input.toolId) &&
    context?.isToolDenied?.(input.toolId) !== true &&
    context?.shouldBindAgentTool?.(input.toolId) === true &&
    runtimeTool?.enabled !== false
  );
}

export function createCapabilityAgentTools(
  input: CapabilityAgentToolFactoryInput,
) {
  const context = input.context;
  const services = input.services;
  const shouldBindCanonical = shouldBindTool({
    factoryInput: input,
    toolId: PUBLISH_ARTIFACT_TOOL_ID,
  });
  const shouldBind =
    shouldBindCanonical &&
    hasRequiredContext(input) &&
    Boolean(services?.storage) &&
    Boolean(services?.artifacts) &&
    Boolean(
      services?.sandbox?.downloadCurrentFile ||
        services?.filesystem?.readRaw ||
        services?.filesystem?.downloadFiles,
    );

  if (!shouldBind) {
    return {
      promptProviders: [],
      tools: [],
    };
  }
  const requiredContext = context as NonNullable<
    CapabilityAgentToolFactoryInput["context"]
  > & {
    teamId: string;
    workspaceId: string;
    threadId: string;
    userId: string;
    userMessageId: string;
  };

  const requiredServices = {
    artifacts: services!.artifacts!,
    sandbox: services!.sandbox,
    filesystem: services!.filesystem,
    storage: services!.storage!,
    logger: services!.logger,
  };
  const log = requiredServices.logger?.info
    ? requiredServices.logger
    : { info: () => {}, warn: () => {}, error: () => {} };
  const { artifacts, storage } = requiredServices;
  const tools = [];

  tools.push({
    tool: tool(
      async (
        args: PublishArtifactToolInput,
        runtime: ToolRuntime,
      ): Promise<string> => {
        const toolCallId = langchainToolCallIdFromRuntime(runtime);
        const normalizedArgs = normalizePublishToolInput(args);
        const parsedResult =
          PublishArtifactInputSchema.safeParse(normalizedArgs);
        if (!parsedResult.success) {
          const inputShapeIssues =
            collectPublishInputShapeIssues(normalizedArgs);
          const message =
            inputShapeIssues.length > 0
              ? `${inputShapeIssues.join("; ")}; ${receivedSourceShapeSummary(args)}`
              : formatPublishInputValidationMessage(parsedResult.error);
          log.warn("publish_artifact invalid input", {
            details: message,
            sourceShape: sourceShapeSummary(toRecord(args)?.source),
            toolCallId,
          });
          return JSON.stringify(
            toPublishErrorOutput(
              new PptxOutputError("PUBLISH_INPUT_INVALID", message),
            ),
          );
        }

        const parsed = parsedResult.data;

        log.info("publish_artifact called", {
          artifactType: parsed.artifactType,
          title: parsed.title,
          sourceKind: parsed.source.kind,
          sourcePath: parsed.source.path,
          qaWarnings: parsed.qa?.warnings ?? [],
        });

        try {
          const output = await publishArtifactFromSource({
            context: {
              teamId: requiredContext.teamId,
              workspaceId: requiredContext.workspaceId,
              threadId: requiredContext.threadId,
              userId: requiredContext.userId,
            },
            services: {
              artifacts,
              sandbox: requiredServices.sandbox,
              filesystem: requiredServices.filesystem,
              storage,
            },
            input: parsed,
            toolCallId,
          });

          return JSON.stringify(output);
        } catch (error) {
          if (
            error instanceof PptxOutputError ||
            error instanceof ArtifactPublishError
          ) {
            const output = toPublishErrorOutput(error);
            log.warn("publish_artifact failure", {
              code: error.code,
              details: error.details,
              recoverable: output.recoverable,
              sourcePath: parsed.source.path,
            });
            return JSON.stringify(output);
          }
          throw error;
        }
      },
      {
        name: PUBLISH_ARTIFACT_TOOL_NAME,
        description:
          "Publish an existing file as a SourceWeft artifact. For slides, pass artifactType=slides, source.kind/source.path for the .pptx, previewImage.source.kind/previewImage.source.path using PREVIEW_IMAGE_PATH from final visual QA, and optional previewImage.altText.",
        schema: PublishArtifactToolInputSchema,
      },
    ),
    categories: ["artifact"] as const,
  });

  return {
    promptProviders: [pptxArtifactRuntimePromptProvider],
    tools,
  };
}
