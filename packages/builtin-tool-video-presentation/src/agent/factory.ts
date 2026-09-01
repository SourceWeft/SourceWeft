import type { ModelGateway } from "@sourceweft/model-gateway";
import type {
  AgentToolHostServices,
  AgentToolTurnContext,
  AgentToolSandboxServices,
} from "@sourceweft/contracts/agent-tools";
import {
  createLoadVideoPresentationTool,
  LOAD_VIDEO_PRESENTATION_TOOL_NAME,
} from "./load-tool";
import { createGenerateVideoAssetsTool } from "./asset-tool";
import { createGenerateVideoNarrationTool } from "./narration-tool";
import { createValidateVideoPresentationTool } from "./validation-tool";
import { createPublishVideoPresentationTool } from "./publication-tool";
import {
  GENERATE_VIDEO_ASSETS_TOOL_NAME,
  GENERATE_VIDEO_NARRATION_TOOL_NAME,
  VALIDATE_VIDEO_PRESENTATION_TOOL_NAME,
  PUBLISH_VIDEO_PRESENTATION_TOOL_NAME,
} from "./agent-tool-defs";
import { readVideoModelTurnState } from "./preflight";
import type { VideoPresentationRenderPort } from "./render-port";

type VideoModelSurface = Pick<ModelGateway, "chat" | "images" | "tts">;

export type VideoPresentationFactoryInput = {
  readonly toolIds?: readonly string[];
  readonly context?: Partial<AgentToolTurnContext>;
  /** Capability-local seam for deterministic render adapter tests. */
  readonly renderPort?: VideoPresentationRenderPort;
  readonly services?: Partial<
    Pick<
      AgentToolHostServices<VideoModelSurface>,
      | "artifactVersions"
      | "currentRunArtifacts"
      | "media"
      | "modelGateway"
      | "operationCache"
      | "receipts"
      | "sandbox"
      | "storage"
      | "workBlobs"
    >
  >;
};

type VideoPresentationTool =
  | ReturnType<typeof createLoadVideoPresentationTool>
  | ReturnType<typeof createGenerateVideoAssetsTool>
  | ReturnType<typeof createGenerateVideoNarrationTool>
  | ReturnType<typeof createValidateVideoPresentationTool>
  | ReturnType<typeof createPublishVideoPresentationTool>;

function includes(input: VideoPresentationFactoryInput, name: string) {
  return (
    (!input.toolIds || input.toolIds.includes(name)) &&
    input.context?.isToolDenied?.(name) !== true &&
    input.context?.shouldBindAgentTool?.(name) === true
  );
}

function requiredSandbox(
  value: AgentToolSandboxServices | undefined,
): value is Required<AgentToolSandboxServices> {
  return Boolean(
    value?.ensureCurrentSession &&
    value.uploadCurrentFiles &&
    value.listCurrentFiles &&
    typeof (value as { downloadCurrentFile?: unknown }).downloadCurrentFile ===
      "function" &&
    value.executeCurrent &&
    value.captureCurrentTree,
  );
}

export function createVideoPresentationTools(
  input: VideoPresentationFactoryInput,
) {
  const context = input.context;
  const services = input.services;
  if (
    !context?.workspaceId ||
    !services?.storage ||
    !services.modelGateway ||
    !requiredSandbox(services.sandbox)
  ) {
    return [];
  }
  const tools: Array<{
    tool: VideoPresentationTool;
    categories: readonly ["artifact"];
  }> = [];
  if (
    includes(input, LOAD_VIDEO_PRESENTATION_TOOL_NAME) &&
    services.artifactVersions &&
    services.operationCache &&
    services.receipts
  ) {
    tools.push({
      tool: createLoadVideoPresentationTool({
        workspaceId: context.workspaceId,
        services: {
          artifactVersions: services.artifactVersions,
          operationCache: services.operationCache,
          receipts: services.receipts,
          sandbox: services.sandbox,
          storage: services.storage,
        },
      }),
      categories: ["artifact"] as const,
    });
  }
  const assetState = readVideoModelTurnState(
    context.turnState,
    GENERATE_VIDEO_ASSETS_TOOL_NAME,
  );
  if (
    includes(input, GENERATE_VIDEO_ASSETS_TOOL_NAME) &&
    assetState &&
    services.operationCache &&
    services.workBlobs
  ) {
    tools.push({
      tool: createGenerateVideoAssetsTool({
        profile: assetState.profile,
        execution: assetState.execution,
        traceId: context.traceId,
        services: {
          modelGateway: services.modelGateway,
          operationCache: services.operationCache,
          sandbox: services.sandbox,
          workBlobs: services.workBlobs,
        },
      }),
      categories: ["artifact"] as const,
    });
  }
  const narrationState = readVideoModelTurnState(
    context.turnState,
    GENERATE_VIDEO_NARRATION_TOOL_NAME,
  );
  if (
    includes(input, GENERATE_VIDEO_NARRATION_TOOL_NAME) &&
    narrationState &&
    services.operationCache &&
    services.workBlobs &&
    services.media
  ) {
    tools.push({
      tool: createGenerateVideoNarrationTool({
        profile: narrationState.profile,
        execution: narrationState.execution,
        traceId: context.traceId,
        services: {
          media: services.media,
          modelGateway: services.modelGateway,
          operationCache: services.operationCache,
          sandbox: services.sandbox,
          workBlobs: services.workBlobs,
        },
      }),
      categories: ["artifact"] as const,
    });
  }
  const validationState = readVideoModelTurnState(
    context.turnState,
    VALIDATE_VIDEO_PRESENTATION_TOOL_NAME,
  );
  if (
    includes(input, VALIDATE_VIDEO_PRESENTATION_TOOL_NAME) &&
    validationState &&
    services.operationCache &&
    services.workBlobs &&
    services.receipts &&
    services.media
  ) {
    tools.push({
      tool: createValidateVideoPresentationTool({
        profile: validationState.profile,
        execution: validationState.execution,
        traceId: context.traceId,
        ...(input.renderPort ? { renderPort: input.renderPort } : {}),
        services: {
          media: services.media,
          modelGateway: services.modelGateway,
          operationCache: services.operationCache,
          receipts: services.receipts,
          sandbox: services.sandbox,
          workBlobs: services.workBlobs,
        },
      }),
      categories: ["artifact"] as const,
    });
  }
  if (
    includes(input, PUBLISH_VIDEO_PRESENTATION_TOOL_NAME) &&
    services.currentRunArtifacts &&
    services.operationCache &&
    services.receipts &&
    services.workBlobs
  ) {
    tools.push({
      tool: createPublishVideoPresentationTool({
        workspaceId: context.workspaceId,
        services: {
          currentRunArtifacts: services.currentRunArtifacts,
          operationCache: services.operationCache,
          receipts: services.receipts,
          sandbox: services.sandbox,
          storage: services.storage,
          workBlobs: services.workBlobs,
        },
      }),
      categories: ["artifact"] as const,
    });
  }
  return tools;
}
