import { billingService } from "../billing";
import { ContentService } from "./service";

export { ContentError } from "./errors";
export { ContentService } from "./service";
export type { ChunkSpec, MessageRecord } from "./types";

export const contentService = new ContentService(billingService);
