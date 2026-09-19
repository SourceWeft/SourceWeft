import { billingRuntime as billingService } from "../../billing-host/bindings";
import { SourceIndexingService } from "./indexing-service";
import { SourceParsingService } from "./parsing-service";

// Services
export { SourceIndexingService, SourceParsingService };
export { contentSourceService } from "./service";

// Pre-configured service instances (with billing wired in)
export const sourceIndexingService = new SourceIndexingService(billingService);
export const sourceParsingService = new SourceParsingService(
  sourceIndexingService,
  billingService,
);

// Guards
export { requireContentSource } from "./guards";

// Repository (used by connectors module)
export {
  updateSourceRecord,
  updateSourceRecordForLatestRevision,
  updateSourceRecordAndInvalidateDocuments,
  findSourceRecord,
  listSourceRecords,
  findSourceRecordByConnectorExternalId,
  createSourceRecord,
} from "./repository";
export { createSourceRevisionRecord } from "./revision-repository";

// Parsers (used by content facade and others)
export { getSourceParser, listSupportedSourceMimeTypes } from "./parsers";
export type { SourceParser } from "./parsers/types";
