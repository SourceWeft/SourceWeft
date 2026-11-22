import type {
  AgentToolGroundedArtifactReceipt,
  AgentToolGroundedArtifactServices,
  AgentToolHostServices,
  AgentToolTurnContext,
} from "@sourceweft/contracts/agent-tools";

/**
 * The shared half of every chat tool that queues a grounded artifact (a data
 * table, flashcards, a quiz, a mind map): when such a tool binds, and the one
 * request path from "the turn's sources" to the host's receipt. What each tool
 * asks for, how its contract validates the request and what it tells the agent
 * afterwards stay in its own capability package.
 *
 * These tools never call a model. The host's `groundedArtifacts` service is
 * the same request function the app's routes use: it opens the pending
 * artifact, queues the job and makes the turn's actor its payer. The job's
 * model calls are billed on the job's own scope, never on the chat turn's.
 */

/** What a grounded-artifact tool asks of the host, taken out of the shared contract. */
export type GroundedArtifactToolFactoryInput = {
  readonly toolIds?: readonly string[];
  readonly context?: Partial<
    Pick<AgentToolTurnContext, "isToolDenied" | "shouldBindAgentTool" | "threadId">
  >;
  readonly services?: Partial<Pick<AgentToolHostServices, "groundedArtifacts">>;
};

/** The turn a bound grounded-artifact tool works in. */
export type GroundedArtifactToolBinding = {
  readonly threadId: string;
  readonly grounded: AgentToolGroundedArtifactServices;
};

/**
 * Whether this turn binds `toolName`, and with what. The host hands every
 * manifest tool id to the factory; whether the turn binds the tool (a slash
 * command or a skill selected it) is the turn's call, and an unasked-for
 * binding is a host error. Without a thread or the host service there is
 * nothing to bind.
 */
export function bindGroundedArtifactTool(
  input: GroundedArtifactToolFactoryInput,
  toolName: string,
): GroundedArtifactToolBinding | null {
  const threadId = input.context?.threadId;
  const grounded = input.services?.groundedArtifacts;
  if (
    (input.toolIds && !input.toolIds.includes(toolName)) ||
    !threadId ||
    !grounded ||
    input.context?.shouldBindAgentTool?.(toolName) !== true ||
    input.context.isToolDenied?.(toolName) === true
  ) {
    return null;
  }
  return { threadId, grounded };
}

/** A Zod `safeParse` result, structurally, so this package needs no Zod. */
export type GroundedRequestParse<T> =
  | { readonly success: true; readonly data: T }
  | {
      readonly success: false;
      readonly error: {
        readonly issues: readonly {
          readonly path: readonly PropertyKey[];
          readonly message: string;
        }[];
      };
    };

function describeIssues(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
) {
  return issues
    .map((issue) => `${issue.path.map(String).join(".") || "request"}: ${issue.message}`)
    .join("; ");
}

/** The thread is the turn's and visibility follows the thread: neither is sent. */
export type GroundedToolRequest<T> = Omit<T, "threadId" | "visibility">;

export type GroundedArtifactToolOutcome<T> =
  | { readonly ok: false; readonly code: "NO_SOURCES"; readonly message: string }
  | {
      readonly ok: true;
      readonly request: GroundedToolRequest<T>;
      readonly receipt: AgentToolGroundedArtifactReceipt;
    };

/**
 * Takes the turn's sources from the host, validates the capability's request
 * against its own contract with the turn's thread, and queues it. With no
 * sources it requests nothing and says so, so the agent can ask the user to
 * pick some instead of failing silently. An invalid request throws, so the
 * model sees why and can correct its arguments.
 */
export async function requestGroundedArtifactFromTurn<
  T extends { readonly threadId: string },
>(input: {
  readonly binding: GroundedArtifactToolBinding;
  readonly artifactType: string;
  /** Names the artifact in the validation error ("table", "quiz", …). */
  readonly subject: string;
  /** The capability's contract over the full request, thread included. */
  readonly parse: (request: {
    readonly threadId: string;
    readonly sourceIds: string[];
  }) => GroundedRequestParse<T>;
  /** BCP 47; the language a mixed or untagged corpus falls back to. */
  readonly uiLocale: string;
  readonly noSourcesMessage: string;
}): Promise<GroundedArtifactToolOutcome<T>> {
  const { grounded, threadId } = input.binding;
  const sourceIds = await grounded.listTurnSourceIds();
  if (sourceIds.length === 0) {
    return { ok: false, code: "NO_SOURCES", message: input.noSourcesMessage };
  }
  const parsed = input.parse({ threadId, sourceIds: [...sourceIds] });
  if (!parsed.success) {
    throw new Error(
      `The ${input.subject} request is not valid: ${describeIssues(parsed.error.issues)}`,
    );
  }
  const {
    threadId: _thread,
    visibility: _visibility,
    ...request
  } = parsed.data as T & { readonly visibility?: unknown };
  const receipt = await grounded.requestGeneration({
    artifactType: input.artifactType,
    request,
    uiLocale: input.uiLocale,
  });
  return { ok: true, request: request as GroundedToolRequest<T>, receipt };
}
