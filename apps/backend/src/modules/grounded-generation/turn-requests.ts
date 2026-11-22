import type { AgentToolGroundedArtifactReceipt } from "@sourceweft/contracts/agent-tools";
import {
  STUDY_ARTIFACT_TYPES,
  studyGenerateRequestSchema,
  type StudyKind,
} from "@sourceweft/contracts/study";
import { tableGenerateRequestSchema } from "@sourceweft/contracts/table";
import { ContentError } from "../content/errors";
import { requestStudyArtifact } from "../study/requests";
import { requestTableArtifact } from "../tables/requests";

/**
 * Grounded generation requested from inside a chat turn (an agent tool), by
 * artifact type.
 *
 * Each entry is the same request function the app's HTTP route calls, so a
 * tool gets exactly the route's authorization (thread and workspace access for
 * the turn's actor), payer (that actor), running limit and dedupe. The only
 * difference is where the request comes from: the thread is the turn's, never
 * one named in the request, and the request is validated here against the
 * type's contract because a model wrote it.
 *
 * A type without an entry has no grounded generation and is refused.
 *
 * None of this calls a model, so nothing a tool starts here is billed to the
 * chat turn: the queued job bills the actor on its own (`worker-job`) scope.
 */

export type GroundedTurnRequest = {
  readonly workspaceId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly uiLocale: string;
  readonly request: Readonly<Record<string, unknown>>;
};

type GroundedTurnRequester = (
  input: GroundedTurnRequest,
) => Promise<AgentToolGroundedArtifactReceipt>;

function invalidRequest(artifactType: string, details: unknown): never {
  throw new ContentError(422, "VALIDATION_ERROR", `Invalid ${artifactType} request`, {
    details,
    recoverable: false,
  });
}

/** The narrow receipt: where the artifact stands, never its visibility. */
function receiptOf(result: {
  artifactId: string;
  versionNo: number;
  artifactStatus: AgentToolGroundedArtifactReceipt["status"];
  reused: boolean;
}): AgentToolGroundedArtifactReceipt {
  return {
    artifactId: result.artifactId,
    versionNo: result.versionNo,
    status: result.artifactStatus,
    reused: result.reused,
  };
}

/**
 * One requester per study type. The type is the one the host was asked for:
 * a request naming another type cannot open it under this one.
 */
function studyTurnRequester(artifactType: StudyKind): GroundedTurnRequester {
  return async (input) => {
    const parsed = studyGenerateRequestSchema.safeParse({
      ...input.request,
      artifactType,
      threadId: input.threadId,
    });
    if (!parsed.success) invalidRequest(artifactType, parsed.error.flatten());
    const result = await requestStudyArtifact({
      workspaceId: input.workspaceId,
      userId: input.userId,
      uiLocale: input.uiLocale,
      request: parsed.data,
    });
    return receiptOf(result);
  };
}

const GROUNDED_TURN_REQUESTERS: Readonly<Record<string, GroundedTurnRequester>> = {
  table: async (input) => {
    const parsed = tableGenerateRequestSchema.safeParse({
      ...input.request,
      threadId: input.threadId,
    });
    if (!parsed.success) invalidRequest("table", parsed.error.flatten());
    const result = await requestTableArtifact({
      workspaceId: input.workspaceId,
      userId: input.userId,
      uiLocale: input.uiLocale,
      request: parsed.data,
    });
    return receiptOf(result);
  },
  ...Object.fromEntries(
    STUDY_ARTIFACT_TYPES.map((artifactType) => [artifactType, studyTurnRequester(artifactType)]),
  ),
};

export function requestGroundedArtifactForTurn(
  input: GroundedTurnRequest & { readonly artifactType: string },
): Promise<AgentToolGroundedArtifactReceipt> {
  const requester = Object.hasOwn(GROUNDED_TURN_REQUESTERS, input.artifactType)
    ? GROUNDED_TURN_REQUESTERS[input.artifactType]
    : undefined;
  if (!requester) {
    throw new ContentError(
      400,
      "UNSUPPORTED_ARTIFACT_TYPE",
      `There is no grounded generation for artifact type "${input.artifactType}"`,
      { recoverable: false },
    );
  }
  const { artifactType: _artifactType, ...request } = input;
  return requester(request);
}
