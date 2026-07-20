import type { ModelGateway } from "@sourceweft/model-gateway";
import type {
  AgentToolHostServices,
  AgentToolTurnContext,
} from "@sourceweft/contracts/agent-tools";
import {
  createGenerateImageTool,
  imageRuntimePromptProvider,
  type ImageToolRuntimeDeps,
} from "./tool-runtime";
import { readGenerateImageTurnState } from "./turn-preflight";

/**
 * The kinds of model this capability calls, which is what it binds the host's
 * gateway surface to. The host exposes every kind its gateway has; naming only
 * `images` here is how this package states its actual dependency, and how a
 * host that stopped serving image generation would break its build rather than
 * this tool at runtime.
 */
type ImageModelSurface = Pick<ModelGateway, "images">;

/**
 * What this capability asks of the host, taken out of the shared contract.
 * `context` is `Partial` because tests and older hosts pass a fraction of it;
 * every field below is still checked against the one declaration the host is
 * annotated with.
 */
type CapabilityAgentToolFactoryInput = {
  readonly toolIds?: readonly string[];
  readonly context?: Partial<
    Pick<
      AgentToolTurnContext,
      | "turnState"
      | "isToolDenied"
      | "parentSpanId"
      | "runtimeTools"
      | "teamId"
      | "threadId"
      | "traceId"
      | "userId"
      | "userMessageId"
      | "workspaceId"
    >
  >;
  readonly services?: Partial<
    Pick<AgentToolHostServices<ImageModelSurface>, "artifacts" | "modelGateway">
  >;
};

const GENERATE_IMAGE_TOOL_ID = "generate_image";

/**
 * The label this capability's model spend settles under.
 *
 * It is passed to the host with every client request because the host cannot
 * know it: it once hardcoded this exact string, which meant any other
 * capability's generation would have been billed as an image artifact.
 */
const GENERATE_IMAGE_BILLING_FEATURE = "artifact.image";

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
          const client = await modelGateway.getClient({
            gatewayConfigId: profile.gatewayConfigId,
            feature: GENERATE_IMAGE_BILLING_FEATURE,
          });
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
