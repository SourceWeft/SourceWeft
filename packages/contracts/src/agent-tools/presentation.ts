/**
 * How a tool call is described to the user.
 *
 * The words belong to the capability that produces the artifact, not to the
 * generic turn pipeline. A capability declares its own titles and summaries;
 * the backend only dispatches. Adding a capability must not mean editing a
 * shared switch of English strings.
 *
 * Parsing stays generic: the host injects `readOutputField`, which understands
 * the several shapes a tool output can arrive in (plain record, JSON string,
 * LangChain `content` wrapper, XML attributes). A capability reasons about the
 * *values*, never about the wire shape.
 */

export type ToolOutputFieldReader = (
  output: unknown,
  key: string,
) => string | null;

/** Where the tool call itself is, independent of any background job. */
export type ToolCallDisplayStatus = "running" | "error" | "completed";

export type AgentToolPresentationContext = {
  readonly toolInput: Record<string, unknown>;
  readonly toolOutput?: unknown;
  readonly readOutputField: ToolOutputFieldReader;
  /** Omitted where the caller only knows the call started or ended. */
  readonly status?: ToolCallDisplayStatus;
  /**
   * State of the background job, for capabilities whose work outlives the
   * call. A completed call with a still-running job is normal.
   */
  readonly generationStatus?: ArtifactGenerationPhase | "pending" | "running" | "ready" | null;
};

/**
 * Phases a long-running artifact job reports while the turn is still streaming.
 * Shared vocabulary so one generic step builder serves every capability.
 */
export type ArtifactGenerationPhase =
  | "planning"
  | "generating"
  | "saving"
  | "repairing"
  | "completed"
  | "failed";

export type ArtifactGenerationStepCopy = {
  /** Stable step id so the client replaces the step rather than appending. */
  readonly stepId: string;
  readonly artifactType: string;
  readonly title: string;
  readonly item: string;
  readonly description: string;
};

export type AgentToolPresentation = {
  /**
   * Opaque key for the block that renders this tool's finished artifact (e.g.
   * "image", "pptx", "video"). Its only meaning is which body the web renderer
   * dispatches to — the turn pipeline treats it as a token, never branching on
   * its value. A tool that declares it produces a terminal artifact block; a
   * tool that omits it renders as a plain tool card, so nothing special is
   * created unless a capability asks for it.
   */
  readonly renderAs?: string;

  /**
   * Stream event `type` values that carry this capability's progress. The turn
   * pipeline routes an incoming progress event to a capability by asking here,
   * rather than enumerating known event-type constants.
   */
  readonly progressEventTypes?: readonly string[];

  /**
   * The tool call's title. One method rather than start/end pair: callers that
   * know only the phase pass `status`, callers that also track a background job
   * pass `generationStatus`, and the capability decides what to say.
   */
  title(context: AgentToolPresentationContext): string | null;
  /**
   * Copy for the in-turn progress step of a long-running job. Capabilities that
   * finish within the call do not implement this.
   */
  generationStep?(context: {
    readonly phase: ArtifactGenerationPhase;
    readonly error?: string | null;
  }): ArtifactGenerationStepCopy;

  /**
   * Copy for one pipeline stage, used while the turn streams progress. The
   * stage vocabulary belongs to the capability, so returning null for an
   * unknown stage is normal.
   *
   * Implementations should derive the label from the same source the pipeline
   * stage table uses — two hand-maintained label lists drift, and the user then
   * sees different words for one stage depending on which path rendered it.
   */
  stageStep?(context: { readonly stageId: string }): {
    readonly item: string;
    readonly phase: ArtifactGenerationPhase;
    readonly description?: string;
  } | null;

  /** One-line summary of what happened, shown under the title. */
  describe?(
    context: AgentToolPresentationContext & {
      readonly metadata: Record<string, unknown>;
    },
  ): string | null;
};
