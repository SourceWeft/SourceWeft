/**
 * How a capability turns the user's per-turn options into its tool input.
 *
 * Every other host→capability hook runs *after* something was produced —
 * `presentation` describes a call, `artifactProgress` reads a job, the view and
 * write handlers render or persist a result. Nothing covered the other end of
 * the turn: the moment before the agent runs, when a raw selection record sent
 * by the client has to become the arguments this tool will actually see.
 *
 * Without this hook that step had nowhere to live but the generic turn
 * pipeline, which then had to name capabilities to dispatch. The vocabulary of
 * a selection — which fields exist, which values are legal, what a direct
 * invocation should force — belongs to the capability that consumes it. The
 * pipeline only knows there is a record keyed by tool name and hands it over.
 *
 * Types stay inside the capability on purpose: `normalize` takes `unknown` and
 * returns `unknown` because the host has no use for the narrowed shape. It
 * stores the result under the tool's name and passes it back to the same
 * capability at bind time.
 */

export type AgentToolTurnSelectionContext = {
  /**
   * Per-skill runtime config submitted with this turn, keyed by the skill id
   * the client used. Capabilities that also ship a skill can read their own
   * entry here instead of the host composing skill ids on their behalf — the
   * host does not know which skill belongs to which tool, and should not learn.
   */
  readonly skillRuntimeConfig: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
};

export type AgentToolTurnSelection = {
  /**
   * Regularize the raw selection for this tool into its tool input.
   *
   * Returns `undefined` when the turn carries nothing meaningful for this tool,
   * which the host reads as "leave the selection alone". Any other value is
   * stored verbatim under the tool's name.
   */
  normalize(
    raw: unknown,
    context: AgentToolTurnSelectionContext,
  ): unknown;

  /**
   * Fields forced onto the selection when the user invoked this tool directly —
   * a slash command, a prompt marker, or a tool-kind command — as opposed to
   * the tool being pulled in as a workflow default. Applied over whatever the
   * user already selected, so a capability can express "an explicit invocation
   * means you really want the thing done" without the host knowing which field
   * carries that meaning.
   */
  readonly directInvokeDefaults?: Readonly<Record<string, unknown>>;
};
