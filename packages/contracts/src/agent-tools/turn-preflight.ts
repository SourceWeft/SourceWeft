/**
 * What a capability has to settle *before* the agent runs, once the turn's
 * facts are known.
 *
 * `turnSelection` already lets a capability regularize the raw options a client
 * sent, but it is deliberately synchronous and pure: it sees one record and
 * nothing else. Some capabilities cannot finish there. Deciding whether a
 * deliverable is even producible this turn can require the workspace's model
 * catalog, the thread's saved model choice, and the request's bring-your-own-key
 * override — all of them asynchronous host lookups.
 *
 * Without this hook that work had nowhere to live but the turn preparer, which
 * then had to import a capability, keep capability-shaped fields on its own
 * prepared-turn type, and merge a capability's execution config by hand. This
 * hook moves the whole step behind the tool's name: the pipeline runs every
 * registered preflight, replaces each tool's selection with what the preflight
 * returns, and files the rest away opaquely.
 *
 * The host injects *mechanism* only — "resolve a model profile", "mint a BYOK
 * profile" — scoped in advance to the model kind the tool declared in
 * `requirements.modelKind`. Which profile to ask for, in what order, and what to
 * conclude from the answer is the capability's business. The same split as
 * `readOutputField` in `presentation`: the host knows the plumbing, the
 * capability knows the meaning.
 */

/**
 * A model profile as a capability is allowed to see it: the alias it runs under
 * and the raw config blob the operator attached. The host passes its own richer
 * profile object through unchanged, so whatever the capability stores in `state`
 * is the very object the host will get back at bind time.
 */
export type AgentToolModelProfileView = {
  /** Which gateway config the profile routes through; empty when unrouted. */
  readonly gatewayConfigId: string;
  readonly profileAlias: string;
  readonly modelAlias: string;
  readonly configJson?: unknown;
};

export type AgentToolModelProfileRequest = {
  readonly profileAlias?: string | null;
  readonly modelAlias?: string | null;
  /**
   * Whether a missing profile is an error. Left to the capability because only
   * it knows whether this turn *needs* the model or merely prefers it.
   */
  readonly required?: boolean;
};

export type AgentToolByokModelProfileRequest = {
  readonly profileAlias: string;
  readonly modelAlias: string;
  readonly providerKind?: string | null;
};

/**
 * The whole host surface a preflight gets. Both calls are already bound to the
 * tool's declared model kind, so a capability never names one.
 */
export type AgentToolModelProfileServices = {
  /** Look up a configured profile, or null when none matches. */
  resolveProfile(
    request: AgentToolModelProfileRequest,
  ): Promise<AgentToolModelProfileView | null>;
  /**
   * Mint an ephemeral profile for a bring-your-own-key model that the workspace
   * has no configured profile for. Never persisted; it exists for the length of
   * the turn so the rest of the pipeline has something uniform to hold.
   */
  synthesizeByokProfile(
    request: AgentToolByokModelProfileRequest,
  ): AgentToolModelProfileView;
};

/** How the user reached this turn, when they named a target explicitly. */
export type AgentToolTurnPreflightCommand = {
  readonly kind: string;
  readonly toolName?: string;
};

/**
 * The parts of an enabled skill a preflight may read. Deliberately narrow: a
 * capability looks at whether the skill declares it, which model the skill
 * prefers, and the skill's default config for it — nothing about how skills are
 * stored or resolved.
 */
export type AgentToolTurnPreflightSkill = {
  readonly tools?: readonly string[];
  readonly models?: Readonly<Record<string, string | null | undefined>>;
  readonly defaultConfig?: Readonly<Record<string, unknown>>;
};

export type AgentToolTurnPreflightInput = {
  /** The name this tool is registered under, for keying its own records. */
  readonly toolName: string;
  /** The model kind this tool declared, or null when it declared none. */
  readonly modelKind: string | null;
  /** This tool's already-normalized selection for the turn. */
  readonly selection: unknown;
  readonly command: AgentToolTurnPreflightCommand | null;
  readonly enabledSkills: readonly AgentToolTurnPreflightSkill[];
  /** Whether the registry has this tool on by default. */
  readonly defaultEnabled: boolean;
  /**
   * The request-level execution override for this tool's model kind, already
   * resolved by the host (BYOK credentials looked up, provider hints filled in).
   * Opaque here: only the capability knows which of its fields matter.
   */
  readonly execution: unknown;
  /**
   * The profile alias this request asked for, for this tool's model kind.
   * `undefined` when the request said nothing; `null` when it explicitly asked
   * to fall back to the default.
   */
  readonly requestedProfileAlias?: string | null;
  /** The profile alias the thread has settled on, for this tool's model kind. */
  readonly threadProfileAlias: string | null;
  readonly services: AgentToolModelProfileServices;
};

export type AgentToolTurnPreflightResult = {
  /**
   * Replaces this tool's entry in the turn's selection. Omit to leave whatever
   * `turnSelection` produced in place.
   */
  readonly selection?: unknown;
  /**
   * Anything the capability wants back when its tool is bound. Stored verbatim
   * under the tool's name and never inspected by the host.
   */
  readonly state?: unknown;
  /**
   * Fields to record on the turn's user message metadata. Merged in as-is, so a
   * capability can keep an audit trail without the pipeline knowing its shape.
   */
  readonly messageMetadata?: Readonly<Record<string, unknown>>;
};

export type AgentToolTurnPreflight = {
  run(
    input: AgentToolTurnPreflightInput,
  ): Promise<AgentToolTurnPreflightResult | null>;
  /**
   * Seed values for this capability's own progress events, read back out of the
   * `state` it parked. A tool that reports progress while it works often has to
   * announce the shape of the result before the result exists — an image's
   * aspect ratio, a deck's slide count — and that was settled at preflight, not
   * when the call started.
   *
   * The host looks this up by the tool name it is already holding and merges
   * whatever comes back into the first progress event. It never learns which
   * keys a capability contributes; `null` means "nothing to announce".
   */
  readProgressSeed?(state: unknown): Readonly<Record<string, unknown>> | null;
};
