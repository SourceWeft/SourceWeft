import { billingService } from "../billing";
import { ContentThreadStreamService } from "./stream/service";
import { ContentThreadTurnService } from "./turn/service";

// Thread services
export * from "./model-settings";
export * from "./service";
export { contentThreadService } from "./service";

// Stream
export * from "./stream/service";
export * from "./stream/types";
export { ContentThreadStreamService, ContentThreadTurnService };
export { toSseData } from "./stream/helpers";

// Pre-configured stream service instance (with billing wired in)
export const contentThreadStreamService = new ContentThreadStreamService(
  new ContentThreadTurnService(billingService),
  undefined,
  undefined,
  undefined,
  billingService,
);

// Durable run
export { durableChatRunService } from "./durable/service";
export { processThreadChatRunJob } from "./durable/runner";
export { findChatThreadRunById } from "./durable/repository";
export { getRunApprovalPauseState } from "./durable/service";
export { parseDurableChatRunKey } from "./durable/constants";
export type { ChatThreadRunMode } from "./durable/types";

// Thread
export { findThreadRecord } from "./thread/repository";
export { generateThreadTitle, applyGeneratedThreadTitle, buildFallbackThreadTitle } from "./thread/title-generation";

// Turn
export * from "./turn/context";
export type { CommandSuccessCriteria } from "./turn/command-registry";
export * from "./turn/service";
export type {
  ReasoningTracePart,
  StepTracePart,
  ToolTracePart,
  TracePart,
} from "./turn/trace-parts";
export type {
  AgentCheckpointMetadata,
  AgentCheckpointRef,
  FinalizeThreadTurnCommand,
  MessageRenderBlock,
  ModelReasoningSegmentTrace,
  PreparedThreadTurn,
  RetrievalCallTrace,
  StreamThreadEventInput,
  ThreadToolsSelection,
  ThinkingStepTrace,
  ToolCallStatus,
  ToolCallTrace,
} from "./turn/types";
export type { EditThreadInput, RefreshThreadInput, ResumeThreadInput } from "./stream/types";

// Agent
export { agentSandboxService } from "./agent/sandbox-service/service";
export { extractReasoningFromMessageChunk } from "./agent/turn/content";
export { createThreadAgent } from "./agent";
