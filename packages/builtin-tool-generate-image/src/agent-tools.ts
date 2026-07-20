import {
  createGenerateImageTool,
  imageRuntimePromptProvider,
  type ImageToolRuntimeDeps,
} from "./tool-runtime";
import { readGenerateImageTurnState } from "./turn-preflight";

type CapabilityAgentToolFactoryInput = {
  readonly toolIds?: readonly string[];
  readonly context?: {
    /**
     * Everything the turn's preflights parked, keyed by tool name. The host
     * carries it without reading it; we take our own entry out of it here.
     */
    readonly turnState?: Readonly<Record<string, unknown>>;
    readonly isToolDenied?: (toolName: string) => boolean;
    readonly parentSpanId?: string;
    readonly runtimeTools?: Readonly<
      Record<
        string,
        {
          readonly options?: unknown;
          readonly selection?: unknown;
        }
      >
    >;
    readonly teamId?: string;
    readonly threadId?: string;
    readonly traceId?: string;
    readonly userId?: string;
    readonly userMessageId?: string;
    readonly workspaceId?: string;
  };
  readonly services?: {
    readonly artifacts?: {
      readonly publishArtifact?: ImageToolRuntimeDeps["artifacts"]["publishArtifact"];
    };
    readonly modelGateway?: {
      readonly getClient: (
        gatewayConfigId: string,
      ) => Promise<ImageToolRuntimeDeps["modelGateway"]>;
    };
  };
};

const GENERATE_IMAGE_TOOL_ID = "generate_image";

function turnState(input: CapabilityAgentToolFactoryInput) {
  return readGenerateImageTurnState(
    input.context?.turnState,
    GENERATE_IMAGE_TOOL_ID,
  );
}

function runtimeToolOptions(input: CapabilityAgentToolFactoryInput) {
  const runtimeTool = input.context?.runtimeTools?.[GENERATE_IMAGE_TOOL_ID];
  const options = runtimeTool?.options ?? runtimeTool?.selection;
  return options && typeof options === "object" && !Array.isArray(options)
    ? (options as { readonly execution?: Record<string, unknown> })
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
  const state = turnState(input);
  const profile = state?.imageProfile?.profile;
  const config = state?.artifactIntent?.config;
  const options = runtimeToolOptions(input);
  if (
    !includesTool(input, GENERATE_IMAGE_TOOL_ID) ||
    !context ||
    context?.isToolDenied?.(GENERATE_IMAGE_TOOL_ID) === true ||
    state?.artifactIntent?.shouldInjectTool !== true ||
    !profile ||
    !config ||
    !hasRequiredContext(input) ||
    !services?.modelGateway ||
    !services.artifacts?.publishArtifact
  ) {
    return {
      promptProviders: [imageRuntimePromptProvider],
      tools: [],
    };
  }

  const modelGateway = services.modelGateway;
  const publishArtifact = services.artifacts.publishArtifact;
  const deps: ImageToolRuntimeDeps = {
    modelGateway: {
      images: {
        generate: async (request, opts) => {
          const client = await modelGateway.getClient(profile.gatewayConfigId);
          return client.images.generate(request, opts);
        },
      },
    },
    artifacts: { publishArtifact },
  };

  return {
    promptProviders: [imageRuntimePromptProvider],
    tools: [
      {
        tool: createGenerateImageTool(
          {
            teamId: context.teamId!,
            workspaceId: context.workspaceId!,
            threadId: context.threadId!,
            userId: context.userId!,
            userMessageId: context.userMessageId!,
            traceId: context.traceId,
            parentSpanId: context.parentSpanId,
            profile,
            execution: options?.execution,
            config,
          },
          deps,
        ),
        categories: ["artifact"] as const,
      },
    ],
  };
}
