import type { AgentMiddleware } from "langchain";
import type { LangChainModelExecutionConfig } from "@sourceweft/model-gateway";
import type { AgentFilesystemMountCapability } from "../filesystem-capabilities";
import {
  createCommandToolChoiceMiddleware,
  type CommandExecutionPolicy,
} from "./command-tool-choice";
import { createSourceWeftContextCompressionMiddleware } from "./context-compression";
import { createKnowledgeFilesystemToolDescriptionMiddleware } from "./filesystem-descriptions";
import { createSourceWeftImageHistorySanitizerMiddleware } from "./history-sanitizer";
import {
  createSourceWeftToolObservabilityMiddleware,
  type SourceWeftToolObservabilityContext,
} from "./tool-observability";
import type { TraceContext } from "../../../llm-observability";

export type SourceWeftAgentMiddlewareStackInput = {
  chatProfileConfig?: unknown;
  commandExecutionPolicy?: CommandExecutionPolicy;
  contextCompressionReportKey?: string;
  execution?: LangChainModelExecutionConfig;
  extraMiddleware?: AgentMiddleware[];
  filesystemMounts: AgentFilesystemMountCapability[];
  gatewayConfigId?: string | null;
  modelAlias: string;
  toolObservabilityContext?: SourceWeftToolObservabilityContext;
  traceContext?: TraceContext;
};

export async function createSourceWeftAgentMiddlewareStack(
  input: SourceWeftAgentMiddlewareStackInput,
): Promise<AgentMiddleware[]> {
  const contextCompressionMiddleware =
    await createSourceWeftContextCompressionMiddleware({
      modelAlias: input.modelAlias,
      gatewayConfigId: input.gatewayConfigId,
      execution: input.execution,
      chatProfileConfig: input.chatProfileConfig,
      reportKey: input.contextCompressionReportKey,
      traceContext: input.traceContext,
    });

  return [
    createSourceWeftImageHistorySanitizerMiddleware(),
    createKnowledgeFilesystemToolDescriptionMiddleware({
      mounts: input.filesystemMounts,
    }),
    ...(input.commandExecutionPolicy
      ? [createCommandToolChoiceMiddleware(input.commandExecutionPolicy)]
      : []),
    createSourceWeftToolObservabilityMiddleware({
      context: input.toolObservabilityContext,
      traceContext: input.traceContext,
    }),
    ...contextCompressionMiddleware,
    ...(input.extraMiddleware ?? []),
  ];
}

export {
  createCommandToolChoiceMiddleware,
  forcedToolChoice,
  hasToolCallNamed,
  messageToolCalls,
  type CommandExecutionPolicy,
} from "./command-tool-choice";
export { createSourceWeftContextCompressionMiddleware } from "./context-compression";
export { createKnowledgeFilesystemToolDescriptionMiddleware } from "./filesystem-descriptions";
export {
  createSourceWeftImageHistorySanitizerMiddleware,
  sanitizeMessagesForHistory,
} from "./history-sanitizer";
export {
  createSourceWeftToolObservabilityMiddleware,
  type SourceWeftToolObservabilityContext,
} from "./tool-observability";
