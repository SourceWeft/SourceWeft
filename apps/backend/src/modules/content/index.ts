// Content shared kernel — domain types, errors, and cross-cutting utilities
// for content-domain modules (threads, sources, skills, artifacts, etc.).
//
// Domain services should be imported directly from their respective modules:
//   import { contentThreadService } from "../threads"
//   import { contentSourceService } from "../sources"
//   import { contentSkillsService } from "../skills"
//   import { contentArtifactsService } from "../artifacts"
//   import { workingFilesService } from "../working-files"
//
// Type ownership strategy:
//
//   New cross-module types (used by ≥2 modules) → @sourceweft/contracts
//   Types owned by a single module                      → that module's types.ts
//   Existing types in this file                         → keep here (migration cost
//     outweighs benefit; avoid churn)
//
// This file MUST NOT import from threads/, sources/, skills/, or artifacts/.
// Downward-only dependency direction:
//   content ← threads, sources, skills, artifacts, working-files
//   content → (none of the above)

export { ContentError, isContentError } from "./errors";
export type {
  ChunkSpec,
  MessageRecord,
  SourceRecord,
  ThreadRecord,
  WorkingFileRecord,
  SourceStatus,
  SourceType,
  SourceStatusStep,
  SourceStatusDetail,
  EmbeddingProfileRecord,
  ChunkRecord,
  SourceRevisionRecord,
  SourceDocumentRecord,
  SourceChunkRecord,
  SourceEmbeddingRecord,
  SourceDetailRecord,
  MessageRole,
  WorkingFilePurpose,
  WorkingFileRecord as WorkingFile,
  EmbeddingVectorStrategy,
} from "./types";

// Job types & enqueue helpers
export * from "./queue";

// Model gateway utilities
export type { LlmExecutionConfig, LlmThinkingConfig } from "./model-gateway-audit";
export {
  buildGatewayAuditMetadata,
  buildGatewayRequestMetadata,
  resolveGatewayObservedIdentity,
  recordGatewayOperationEvent,
} from "./model-gateway-audit";
export { toContentError } from "./model-gateway-error";

// Billing
export type { ContentBillingPort } from "./billing-port";
// meterBillableModelUsage is deliberately NOT re-exported: it is the billing
// layer's settlement primitive, reached only through the billed gateway
// wrapper. A call site that meters by hand alongside the wrapper charges the
// team twice whenever the two disagree on the idempotency key.

// Workspace & source guards (canonical locations)
//   import { requireContentWorkspace } from "../workspace"
//   import { requireContentSource } from "../sources"
//   import { normalizeContentTitle } from "../../shared/strings"
