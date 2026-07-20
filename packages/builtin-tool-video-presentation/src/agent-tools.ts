import {
  VIDEO_PRESENTATION_PIPELINE_JOB_NAME,
  videoPresentationReusableArtifactQuery,
} from "./artifact-records";
import { VIDEO_PRESENTATION_ARTIFACT_TYPE } from "./artifact-view";
import {
  createGenerateVideoPresentationTool,
  type VideoPresentationToolArtifacts,
  type VideoPresentationToolLlmExecutionConfig,
  type VideoPresentationToolContext,
  videoPresentationRuntimePromptProvider,
  type VideoPresentationToolRuntimeDeps,
} from "./tool-runtime";

/**
 * Host-side artifact primitives, as this capability consumes them: generic,
 * type-parameterised, named after no capability. Which artifact type they
 * address and what makes a row reusable are supplied below, from this
 * package's own descriptors.
 */
type HostArtifactServices = {
  readonly createPendingArtifact: (
    artifactType: string,
    input: Parameters<VideoPresentationToolArtifacts["createPending"]>[0],
  ) => Promise<unknown>;
  readonly findArtifact: VideoPresentationToolArtifacts["findStatus"];
  readonly findReusableArtifact: (query: {
    readonly teamId: string;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly artifactType: string;
    readonly statuses: readonly string[];
    readonly requestKey?: string;
  }) => ReturnType<VideoPresentationToolArtifacts["findReusable"]>;
};

/** Host-side deliverable dispatch: the job name comes from our manifest. */
type HostQueueServices = {
  readonly enqueueDeliverableJob: (input: {
    readonly jobName: string;
    readonly jobId: string;
    readonly payload: Record<string, unknown>;
  }) => Promise<unknown>;
};

type CapabilityAgentToolFactoryInput = {
  readonly manifest?: unknown;
  readonly toolIds?: readonly string[];
  readonly context?: {
    readonly isToolDenied?: (toolName: string) => boolean;
    readonly parentSpanId?: string;
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
    readonly sourceUserMessageId?: string;
    readonly teamId?: string;
    readonly threadId?: string;
    readonly traceId?: string;
    readonly userId?: string;
    readonly userMessageId?: string;
    readonly workspaceId?: string;
  };
  readonly services?: {
    readonly artifacts?: HostArtifactServices;
    readonly queue?: HostQueueServices;
    readonly llm?: VideoPresentationToolLlmExecutionConfig;
  };
};

/**
 * The pipeline job name this capability declared, read back out of the
 * manifest the host hands us. `VIDEO_PRESENTATION_PIPELINE_JOB_NAME` is the
 * literal that built that manifest entry, so it is the correct fallback when a
 * host passes no manifest (tests, older callers).
 */
function resolvePipelineJobName(manifest: unknown): string {
  const tools = (
    manifest as
      | {
          contributes?: {
            tools?: ReadonlyArray<{
              runtime?: { pipeline?: { jobName?: unknown } };
            }>;
          };
        }
      | undefined
  )?.contributes?.tools;
  for (const tool of tools ?? []) {
    const jobName = tool?.runtime?.pipeline?.jobName;
    if (typeof jobName === "string" && jobName.length > 0) {
      return jobName;
    }
  }
  return VIDEO_PRESENTATION_PIPELINE_JOB_NAME;
}

function createRuntimeDeps(
  artifacts: HostArtifactServices,
  queue: HostQueueServices,
  jobName: string,
): Pick<VideoPresentationToolRuntimeDeps, "artifacts" | "queue"> {
  return {
    artifacts: {
      findReusable: (input) =>
        artifacts.findReusableArtifact({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          ...videoPresentationReusableArtifactQuery(input),
        }),
      createPending: (input) =>
        artifacts
          .createPendingArtifact(VIDEO_PRESENTATION_ARTIFACT_TYPE, input)
          .then(() => undefined),
      findStatus: artifacts.findArtifact,
    },
    queue: {
      enqueueRender: async (payload) => {
        await queue.enqueueDeliverableJob({
          jobName,
          jobId: payload.jobId,
          payload: payload as unknown as Record<string, unknown>,
        });
      },
    },
  };
}

const GENERATE_VIDEO_PRESENTATION_TOOL_ID = "generate_video_presentation";

function runtimeToolOptions(input: CapabilityAgentToolFactoryInput) {
  const runtimeTool = input.context?.runtimeTools?.[GENERATE_VIDEO_PRESENTATION_TOOL_ID];
  const options = runtimeTool?.options ?? runtimeTool?.selection;
  return options && typeof options === "object" && !Array.isArray(options)
    ? (options as VideoPresentationToolContext["defaultRequest"] & {
        readonly narration?: { readonly enabled?: boolean };
      })
    : undefined;
}

function hasRequiredContext(input: CapabilityAgentToolFactoryInput) {
  const context = input.context;
  return Boolean(
    context?.teamId &&
      context.workspaceId &&
      context.threadId &&
      context.userId &&
      context.userMessageId,
  );
}

function includesTool(input: CapabilityAgentToolFactoryInput, toolId: string) {
  return !input.toolIds || input.toolIds.includes(toolId);
}

export function createCapabilityAgentTools(
  input: CapabilityAgentToolFactoryInput,
) {
  const context = input.context;
  const services = input.services;
  const runtimeTool = context?.runtimeTools?.[GENERATE_VIDEO_PRESENTATION_TOOL_ID];
  const options = runtimeToolOptions(input);
  if (
    !includesTool(input, GENERATE_VIDEO_PRESENTATION_TOOL_ID) ||
    context?.isToolDenied?.(GENERATE_VIDEO_PRESENTATION_TOOL_ID) === true ||
    context?.shouldBindAgentTool?.(GENERATE_VIDEO_PRESENTATION_TOOL_ID) !==
      true ||
    runtimeTool?.enabled === false ||
    !hasRequiredContext(input) ||
    !services?.artifacts ||
    !services.queue
  ) {
    return {
      promptProviders: [videoPresentationRuntimePromptProvider],
      tools: [],
    };
  }

  return {
    promptProviders: [videoPresentationRuntimePromptProvider],
    tools: [
      {
        tool: createGenerateVideoPresentationTool(
          {
            defaultNarration: options?.narration,
            teamId: context.teamId!,
            workspaceId: context.workspaceId!,
            threadId: context.threadId!,
            userId: context.userId!,
            userMessageId: context.userMessageId!,
            sourceUserMessageId: context.sourceUserMessageId,
            traceId: context.traceId,
            parentSpanId: context.parentSpanId,
            defaultRequest: options,
            llm: services.llm,
          },
          {
            ...createRuntimeDeps(
              services.artifacts,
              services.queue,
              resolvePipelineJobName(input.manifest),
            ),
            // Follow the render pipeline until it reaches a terminal state so
            // progress streams through the single chat SSE (runtime.writer →
            // tool-call-event). There is no wall-clock cap here: per-stage time
            // budgets and retries live inside the pipeline itself, which is the
            // sole authority on failure. The wait only bails out on lost
            // liveness (no generation updates for the stall window → worker
            // died) or an abort signal, degrading to a processing_result.
            // The render job runs on the separate deliverables queue, so
            // blocking here cannot deadlock the primary worker.
            wait: {},
          },
        ),
        categories: ["artifact"] as const,
      },
    ],
  };
}
