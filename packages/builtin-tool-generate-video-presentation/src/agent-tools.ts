import {
  createGenerateVideoPresentationTool,
  videoPresentationRuntimePromptProvider,
  type VideoPresentationToolRuntimeDeps,
} from "./tool-runtime";

type CapabilityAgentToolFactoryInput = {
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
    readonly artifacts?: {
      readonly createPendingVideoPresentationArtifactRecord: VideoPresentationToolRuntimeDeps["artifacts"]["createPending"];
      readonly findReusableVideoPresentationArtifactRecord: VideoPresentationToolRuntimeDeps["artifacts"]["findReusable"];
    };
    readonly queue?: {
      readonly enqueueVideoPresentationRenderJob: VideoPresentationToolRuntimeDeps["queue"]["enqueueRender"];
    };
  };
};

const GENERATE_VIDEO_PRESENTATION_TOOL_ID = "generate_video_presentation";

function runtimeToolOptions(input: CapabilityAgentToolFactoryInput) {
  const runtimeTool = input.context?.runtimeTools?.[GENERATE_VIDEO_PRESENTATION_TOOL_ID];
  const options = runtimeTool?.options ?? runtimeTool?.selection;
  return options && typeof options === "object" && !Array.isArray(options)
    ? (options as { readonly narration?: { readonly enabled?: boolean } })
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
          },
          {
            artifacts: {
              findReusable:
                services.artifacts.findReusableVideoPresentationArtifactRecord,
              createPending:
                services.artifacts.createPendingVideoPresentationArtifactRecord,
            },
            queue: {
              enqueueRender: services.queue.enqueueVideoPresentationRenderJob,
            },
          },
        ),
        categories: ["artifact"] as const,
      },
    ],
  };
}
