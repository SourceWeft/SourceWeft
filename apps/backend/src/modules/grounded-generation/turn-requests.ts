import type { AgentToolGroundedArtifactReceipt } from "@sourceweft/contracts/agent-tools";
import { tableGenerateRequestSchema } from "@sourceweft/contracts/table";
import { ContentError } from "../content/errors";
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
 * A type without an entry has no grounded generation and is refused. Study
 * artifacts add their entry here when their tool lands.
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
    return {
      artifactId: result.artifactId,
      versionNo: result.versionNo,
      status: result.status,
      reused: result.reused,
    };
  },
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
