import type {
  CatalogAnalysisStatus,
  CatalogClassificationOutcome,
  CatalogOverviewJson,
  CatalogOverviewLocale,
} from "@sourceweft/db";
import type { SystemModelPurpose } from "../../shared/model-gateway/system-client";

/** The catalog kinds with AI overviews. */
export type OverviewKind = "skill" | "mcp";

/**
 * The version an overview is written for, as the engine sees it. A kind's own
 * subject type extends this with whatever its prompt and storage need.
 */
export type OverviewSubject = {
  versionId: string;
  // Public, current and of a kind overviews are written for. Checked again
  // under lock when publishing.
  eligible: boolean;
  // Identifies the input the overview is written from (a skill's bundle hash;
  // an MCP server's input hash). Stored on every overview row and part of the
  // result key.
  fingerprint: string;
};

/** The system and user messages of one overview request. */
export type OverviewPrompt = { system: string; user: string };

/** How the structured answer is requested: one call per version. */
export type OverviewOutputSpec = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  maxTokens: number;
};

/** The model's answer, checked and normalized by the kind. */
export type ParsedOverview<TClassification> = {
  overviews: Record<CatalogOverviewLocale, CatalogOverviewJson>;
  classification: TClassification;
};

/** The analysis row fields the engine reads. */
export type OverviewAnalysisState = {
  requestId: string;
  status: CatalogAnalysisStatus;
  force: boolean;
};

/** A complete, reusable earlier result for identical input. */
export type CachedOverview<TClassification> = {
  classification: TClassification;
  model: string;
  overviews: Record<CatalogOverviewLocale, CatalogOverviewJson>;
};

export type PublishOverviewInput<TSubject, TClassification> = {
  subject: TSubject;
  requestId: string;
  resultKey: string;
  modelConfigurationKey?: string;
  model: string;
  classification: TClassification;
  overviews: Record<CatalogOverviewLocale, CatalogOverviewJson>;
};

/** A reserved request whose job may never have reached the queue. */
export type InterruptedOverview = {
  versionId: string;
  // The kind's entity id (the skill's id), for the job payload.
  parentId: string;
  requestId: string;
  force: boolean;
};

/**
 * A kind's storage: its own overview and analysis tables. Usually the
 * functions of a `createCatalogOverviewRepository` (repository.ts) bound to
 * the kind's tables, plus its category rules.
 */
export interface OverviewStore<TSubject, TClassification> {
  read(versionId: string): Promise<OverviewAnalysisState | null>;
  /** Reserve a request before enqueueing; a forced one fences older workers. */
  request(
    versionId: string,
    force: boolean,
  ): Promise<OverviewAnalysisState | null>;
  /** Mark the request running; null when it is stale or finished. */
  claim(
    versionId: string,
    requestId: string,
  ): Promise<OverviewAnalysisState | null>;
  /** Record a failure for this request only; `retry` keeps it pending. */
  fail(
    versionId: string,
    requestId: string,
    error: string,
    retry: boolean,
  ): Promise<void>;
  findCached(
    resultKey: string,
    versionId: string,
  ): Promise<CachedOverview<TClassification> | null>;
  /**
   * Every locale and the classification in one transaction, fenced by the
   * request id and re-checked eligibility. False when fenced or ineligible.
   */
  publish(
    input: PublishOverviewInput<TSubject, TClassification>,
  ): Promise<boolean>;
  findInterrupted(): Promise<InterruptedOverview[]>;
}

/** How a kind's overview call is made and logged by the system model. */
export type OverviewModelSpec = {
  // The system-model purpose the call is made and logged under.
  purpose: SystemModelPurpose;
  // What the call is about in the system-model log, e.g. `skill-version:<id>`.
  subjectRef(versionId: string): string;
  output: OverviewOutputSpec;
};

/**
 * What a catalog kind supplies to the engine. The engine owns the pipeline;
 * the adapter owns everything that differs by kind. The kind's prompt and
 * taxonomy versions are part of its prompt (and so of the result key) and
 * are bound to its repository, which reuses only results written under them.
 */
export interface OverviewSubjectAdapter<
  TSubject extends OverviewSubject,
  TPrompt extends OverviewPrompt,
  TClassification extends CatalogClassificationOutcome,
  TSkip extends string = never,
> extends OverviewModelSpec {
  kind: OverviewKind;
  // Log wording: "<label> overview generated".
  label: string;
  /** The version with what the prompt reads; null when there is none. */
  loadSubject(versionId: string): Promise<TSubject | null>;
  /** Why a claimed version has nothing to describe; null when it has. */
  skipReason(subject: TSubject): TSkip | null;
  /**
   * The messages. The whole object is part of the result key, so everything
   * that changes the answer (prompt and taxonomy versions included) must be
   * in it.
   */
  buildPrompt(subject: TSubject): TPrompt;
  /**
   * Throws on output that is not a usable overview; the engine logs the
   * refusal ("<label> overview output rejected") and the job retries.
   */
  parseOutput(
    raw: unknown,
    subject: TSubject,
    prompt: TPrompt,
  ): ParsedOverview<TClassification>;
  /**
   * Extra fields for the "overview generated" and "output rejected" log
   * lines: identifiers and flags, never prompt or answer text.
   */
  logFields(subject: TSubject, prompt: TPrompt): Record<string, unknown>;
  store: OverviewStore<TSubject, TClassification>;
}

/** Calls the model for one version; the engine's default goes through the system model. */
export type OverviewModelCall<TPrompt extends OverviewPrompt> = (input: {
  prompt: TPrompt;
  versionId: string;
  // The unit of work the call belongs to: one per job try.
  scopeId: string;
}) => Promise<{ output: unknown; model: string }>;

export type OverviewSkipReason =
  | "missing-version"
  | "not-eligible"
  | "already-generated"
  | "system-model-not-ready";

export type OverviewGenerateResult<TSkip extends string = never> =
  | { status: "generated"; model: string }
  | { status: "copied"; rows: number }
  | { status: "skipped"; reason: OverviewSkipReason | TSkip };
