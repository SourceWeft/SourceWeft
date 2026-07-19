import {
  createGenerateImageTool,
  imageRuntimePromptProvider,
  type ImageToolRuntimeDeps,
} from "./tool-runtime";
import type { ArtifactImageConfig } from "./image-types";

type CapabilityAgentToolFactoryInput = {
  readonly toolIds?: readonly string[];
  readonly context?: {
    readonly artifactIntent?: {
      readonly shouldInjectTool?: boolean;
      readonly config?: ArtifactImageConfig;
    };
    readonly imageProfile?: {
      readonly profile?: {
        readonly gatewayConfigId: string;
        readonly profileAlias: string;
        readonly modelAlias: string;
      };
    };
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
      readonly createImageArtifactRecord: ImageToolRuntimeDeps["artifacts"]["createRecord"];
    };
    readonly modelGateway?: {
      readonly getClient: (
        gatewayConfigId: string,
      ) => Promise<ImageToolRuntimeDeps["modelGateway"]>;
    };
    readonly storage?: {
      readonly buildArtifactStorageKey: ImageToolRuntimeDeps["storage"]["buildStorageKey"];
      readonly getContentStorageBucketName: ImageToolRuntimeDeps["storage"]["getBucketName"];
      readonly uploadArtifactObject: ImageToolRuntimeDeps["storage"]["upload"];
    };
  };
};

const GENERATE_IMAGE_TOOL_ID = "generate_image";

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
  const profile = context?.imageProfile?.profile;
  const config = context?.artifactIntent?.config;
  const options = runtimeToolOptions(input);
  if (
    !includesTool(input, GENERATE_IMAGE_TOOL_ID) ||
    context?.isToolDenied?.(GENERATE_IMAGE_TOOL_ID) === true ||
    context?.artifactIntent?.shouldInjectTool !== true ||
    !profile ||
    !config ||
    !hasRequiredContext(input) ||
    !services?.modelGateway ||
    !services.storage ||
    !services.artifacts
  ) {
    return {
      promptProviders: [imageRuntimePromptProvider],
      tools: [],
    };
  }

  const modelGateway = services.modelGateway;
  const deps: ImageToolRuntimeDeps = {
    modelGateway: {
      images: {
        generate: async (request, opts) => {
          const client = await modelGateway.getClient(profile.gatewayConfigId);
          return client.images.generate(request, opts);
        },
      },
    },
    storage: {
      buildStorageKey: services.storage.buildArtifactStorageKey,
      getBucketName: services.storage.getContentStorageBucketName,
      upload: services.storage.uploadArtifactObject,
    },
    artifacts: {
      createRecord: services.artifacts.createImageArtifactRecord,
    },
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
