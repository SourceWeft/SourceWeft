import type {
  StudyModelPort,
  StudyOperation,
} from "@sourceweft/contracts/study-capability";
import type { ContentBillingPort } from "../content/billing-port";
import {
  createGroundedModelPort,
  describeDefaultChatModel,
} from "../grounded-generation/model-port";
import type { completeStructuredWithDefaultChat } from "../../shared/model-gateway/index";

/** The default chat model, or `MODEL_UNAVAILABLE`; never another profile. */
export const describeStudyModel = describeDefaultChatModel;

/** `StudyModelPort` over the shared grounded model port. */
export function createStudyModelPort(input: {
  billing: ContentBillingPort;
  /** The organization the payer's usage is settled against. */
  teamId: string;
  workspaceId: string;
  actorUserId: string;
  /** The queue job id: the billing scope of every call in this run. */
  scopeId: string;
  complete?: typeof completeStructuredWithDefaultChat;
}): StudyModelPort {
  return createGroundedModelPort<StudyOperation>({ ...input, subject: "study artifact" });
}
