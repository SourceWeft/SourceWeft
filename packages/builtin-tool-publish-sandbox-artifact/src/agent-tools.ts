import { randomUUID } from "node:crypto";
import { tool, type ToolRuntime } from "langchain";
import { PUBLISH_SANDBOX_ARTIFACT_TOOL_NAME } from "./agent-tool-defs";
import { buildArtifactPreviewUrl } from "./artifact-urls";
import {
  PublishSandboxArtifactInputSchema,
  PptxOutputError,
  type PublishSandboxArtifactInput,
  type PublishSandboxArtifactSuccessOutput,
} from "./schemas";
import { validatePptxPackage } from "./sandbox-output";

const PUBLISH_SANDBOX_ARTIFACT_TOOL_ID = "publish_sandbox_artifact";
const MAX_PPTX_BYTES = 100 * 1024 * 1024;
const PPTX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

type SlidesArtifactRecord = {
  artifactId: string;
  versionId: string;
};

type CapabilityAgentToolFactoryInput = {
  readonly toolIds?: readonly string[];
  readonly context?: {
    readonly isToolDenied?: (toolName: string) => boolean;
    readonly runtimeTools?: Readonly<
      Record<
        string,
        {
          readonly enabled?: boolean;
          readonly options?: unknown;
          readonly selection?: unknown;
        }
      >
    >;
    readonly shouldBindAgentTool?: (toolName: string) => boolean;
    readonly teamId?: string;
    readonly threadId?: string;
    readonly userId?: string;
    readonly userMessageId?: string;
    readonly workspaceId?: string;
  };
  readonly services?: {
    readonly artifacts?: {
      readonly createSlidesArtifactRecord: (input: {
        artifactId: string;
        teamId: string;
        workspaceId: string;
        threadId: string;
        userId: string;
        title: string;
        prompt: string;
        payload: Record<string, unknown>;
        storageBucket: string;
        storageKey: string;
      }) => Promise<SlidesArtifactRecord>;
    };
    readonly sandbox?: {
      readonly downloadCurrentFile: (input: {
        sandboxPath: string;
      }) => Promise<Buffer>;
    };
    readonly storage?: {
      readonly buildArtifactStorageKey: (input: {
        workspaceId: string;
        artifactId: string;
        fileName: string;
      }) => string;
      readonly getContentStorageBucketName: () => string;
      readonly uploadArtifactObject: (input: {
        key: string;
        body: Buffer;
        contentType: string;
      }) => Promise<unknown>;
    };
    readonly logger?: {
      info: (msg: string, meta?: Record<string, unknown>) => void;
      warn: (msg: string, meta?: Record<string, unknown>) => void;
      error: (msg: string, meta?: Record<string, unknown>) => void;
    };
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

function sanitizeFileBase(value: string) {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    .slice(0, 120);
  return normalized.length > 0 ? normalized : "presentation";
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
      context.runtimeTools?.[PUBLISH_SANDBOX_ARTIFACT_TOOL_ID];
    const hasExplicitRuntimeTool = Boolean(canonicalRuntimeTool);
    if (hasExplicitRuntimeTool && canonicalRuntimeTool?.enabled !== true) {
      return [];
    }
    return [
      "Use `publish_sandbox_artifact` only after the output file has already been generated and QA has passed.",
      "For PPT Deck, publish with `artifactType=slides`, `source.kind=sandbox_path`, and the actual generated `.pptx` path.",
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

function toRecoverablePublishErrorOutput(error: PptxOutputError) {
  return {
    ok: false,
    type: "presentation_artifact_error" as const,
    status: "failed" as const,
    code: error.code,
    message: error.details ?? error.message,
    recoverable: true as const,
  };
}

type PublishSandboxArtifactFromSandboxInput = {
  readonly context: {
    readonly teamId: string;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly userId: string;
  };
  readonly services: {
    readonly artifacts: NonNullable<
      CapabilityAgentToolFactoryInput["services"]
    >["artifacts"];
    readonly sandbox: NonNullable<
      CapabilityAgentToolFactoryInput["services"]
    >["sandbox"];
    readonly storage: NonNullable<
      CapabilityAgentToolFactoryInput["services"]
    >["storage"];
  };
  readonly input: PublishSandboxArtifactInput;
  readonly toolCallId?: string;
};

async function readSourceBytes(input: {
  parsed: PublishSandboxArtifactInput;
  sandbox?: CapabilityAgentToolFactoryInput["services"] extends infer Services
    ? Services extends { sandbox?: infer Sandbox }
      ? Sandbox
      : never
    : never;
}) {
  const source = input.parsed.source;
  if (!source.path.toLowerCase().endsWith(".pptx")) {
    throw new PptxOutputError(
      "PPTX_OUTPUT_INVALID_EXTENSION",
      `path must end with .pptx: ${source.path}`,
    );
  }
  if (source.kind === "work_file") {
    throw new PptxOutputError(
      "PPTX_SOURCE_UNSUPPORTED",
      "work_file publishing is not available for binary PPTX files yet; use sandbox_path",
    );
  }
  if (!input.sandbox?.downloadCurrentFile) {
    throw new PptxOutputError(
      "SANDBOX_UNAVAILABLE",
      "sandbox download service is not available",
    );
  }
  let buffer: Buffer;
  try {
    buffer = await input.sandbox.downloadCurrentFile({
      sandboxPath: source.path,
    });
  } catch (error) {
    throw new PptxOutputError(
      "PPTX_OUTPUT_NOT_FOUND",
      `sandbox download failed for ${source.path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (buffer.byteLength === 0) {
    throw new PptxOutputError("PPTX_PACKAGE_INVALID", "file is empty");
  }
  if (buffer.byteLength > MAX_PPTX_BYTES) {
    throw new PptxOutputError(
      "PPTX_OUTPUT_TOO_LARGE",
      `${buffer.byteLength} bytes exceeds limit of ${MAX_PPTX_BYTES} bytes`,
    );
  }
  validatePptxPackage(buffer);
  return buffer;
}

export async function publishSandboxArtifactFromSandbox(
  input: PublishSandboxArtifactFromSandboxInput,
): Promise<PublishSandboxArtifactSuccessOutput> {
  const parsed = PublishSandboxArtifactInputSchema.parse(input.input);
  return publishSlidesArtifactFromSandbox({
    ...input,
    input: parsed,
  });
}

async function publishSlidesArtifactFromSandbox(
  input: Omit<PublishSandboxArtifactFromSandboxInput, "input"> & {
    readonly input: PublishSandboxArtifactInput;
  },
): Promise<PublishSandboxArtifactSuccessOutput> {
  const parsed = input.input;
  const fileName = `${sanitizeFileBase(parsed.title)}.pptx`;
  const buffer = await readSourceBytes({
    parsed,
    sandbox: input.services.sandbox,
  });

  const artifactId = randomUUID();
  const storageKey = input.services.storage!.buildArtifactStorageKey({
    workspaceId: input.context.workspaceId,
    artifactId,
    fileName,
  });
  await input.services.storage!.uploadArtifactObject({
    key: storageKey,
    body: buffer,
    contentType: PPTX_MIME_TYPE,
  });
  const storageBucket = input.services.storage!.getContentStorageBucketName();
  await input.services.artifacts!.createSlidesArtifactRecord({
    artifactId,
    teamId: input.context.teamId,
    workspaceId: input.context.workspaceId,
    threadId: input.context.threadId,
    userId: input.context.userId,
    title: parsed.title,
    prompt: parsed.description ?? parsed.title,
    storageBucket,
    storageKey,
    payload: {
      artifactType: "slides",
      byteLength: buffer.byteLength,
      description: parsed.description,
      fileName,
      mimeType: PPTX_MIME_TYPE,
      qa: parsed.qa ?? null,
      source: parsed.source,
      storageKey,
      title: parsed.title,
      toolCallId: input.toolCallId,
    },
  });

  const artifactUrl = buildArtifactPreviewUrl({
    artifactId,
    workspaceId: input.context.workspaceId,
  });
  return {
    ok: true,
    type: "presentation_artifact_result",
    status: "ready",
    artifactId,
    artifact_id: artifactId,
    artifactType: "slides",
    title: parsed.title,
    artifactUrl,
    artifact_url: artifactUrl,
    pptx_url: artifactUrl,
    byteLength: buffer.byteLength,
    byte_length: buffer.byteLength,
    editable: true,
    fileName,
    file_name: fileName,
    generation_mode: "editable_native",
    qaWarnings: parsed.qa?.warnings ?? [],
  };
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
    toolId: PUBLISH_SANDBOX_ARTIFACT_TOOL_ID,
  });
  const shouldBind =
    shouldBindCanonical &&
    hasRequiredContext(input) &&
    Boolean(services?.storage) &&
    Boolean(services?.artifacts) &&
    Boolean(services?.sandbox?.downloadCurrentFile);

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
        args: PublishSandboxArtifactInput,
        runtime: ToolRuntime,
      ): Promise<string> => {
        const parsed = PublishSandboxArtifactInputSchema.parse(args);
        const toolCallId = langchainToolCallIdFromRuntime(runtime);

        log.info("publish_sandbox_artifact called", {
          artifactType: parsed.artifactType,
          title: parsed.title,
          sourceKind: parsed.source.kind,
          sourcePath: parsed.source.path,
          qaWarnings: parsed.qa?.warnings ?? [],
        });

        try {
          const output = await publishSandboxArtifactFromSandbox({
            context: {
              teamId: requiredContext.teamId,
              workspaceId: requiredContext.workspaceId,
              threadId: requiredContext.threadId,
              userId: requiredContext.userId,
            },
            services: {
              artifacts,
              sandbox: requiredServices.sandbox,
              storage,
            },
            input: parsed,
            toolCallId,
          });

          return JSON.stringify(output);
        } catch (error) {
          if (error instanceof PptxOutputError) {
            log.warn("publish_sandbox_artifact recoverable failure", {
              code: error.code,
              details: error.details,
              sourcePath: parsed.source.path,
            });
            return JSON.stringify(toRecoverablePublishErrorOutput(error));
          }
          throw error;
        }
      },
      {
        name: PUBLISH_SANDBOX_ARTIFACT_TOOL_NAME,
        description:
          "Publish an existing sandbox-generated file as a SourceWeft artifact. For slides, pass artifactType=slides and a sandbox .pptx path after QA has passed.",
        schema: PublishSandboxArtifactInputSchema,
      },
    ),
    categories: ["artifact"] as const,
  });

  return {
    promptProviders: [pptxArtifactRuntimePromptProvider],
    tools,
  };
}
