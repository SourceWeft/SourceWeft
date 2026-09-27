/**
 * The catalog overview engine: AI-written overviews of catalog entries
 * (skills today; MCP servers and agents next), shared by every kind.
 *
 * The engine owns the pipeline and everything that is the same for every
 * kind:
 * - the structured model call, always through the system model, so no team
 *   is billed (`model.ts`);
 * - the result key (input fingerprint + prompt + model) and the model
 *   configuration key: identical input already described under the same
 *   prompt, taxonomy and model is copied, not regenerated (`keys.ts`,
 *   `generate.ts`);
 * - the durable request on the analysis row: reserve before queueing, claim
 *   before working, `request_id` fencing so a stale worker never overwrites
 *   a newer run, forced regeneration, and the `ready` / `needs-review` /
 *   `failed` states (`repository.ts`, `generate.ts`);
 * - publishing every locale and the classification in one transaction, and
 *   the public reads with their English fallback (`repository.ts`);
 * - the BullMQ job: one per request with a deduplicating id, bounded retries,
 *   failure recording, recovery of requests that never reached the queue,
 *   and the scheduler's batch (`jobs.ts`);
 * - the text rules for model output every parser applies: plain text only,
 *   capped lengths, JSON read out of a text answer (`text.ts`).
 *
 * A kind plugs in with:
 * 1. Two tables in `packages/db`, built from `catalogOverviewColumns()` and
 *    `catalogAnalysisColumns()` with their constraint helpers, each with a
 *    version key column that references the kind's versions table and
 *    cascades on delete. A new kind names its fingerprint `input_sha256`.
 * 2. A repository: `createCatalogOverviewRepository({ overviews, analysis,
 *    versions, promptVersion, taxonomyVersion, lockTarget, applyCategories })`
 *    on those tables. `lockTarget` locks the kind's entity and version rows
 *    and re-checks eligibility; `applyCategories` writes the classification's
 *    categories under the kind's ownership rules (`categories_set_by`: never
 *    over `admin`).
 * 3. An `OverviewSubjectAdapter` (`types.ts`): its system-model purpose,
 *    `subjectRef` and structured output spec; `loadSubject` (its SQL, with
 *    eligibility); `skipReason`; `buildPrompt` (untrusted input quoted, with
 *    its prompt and taxonomy versions); `parseOutput` (every locale plus a
 *    classification whose evidence is checked against the input); and a
 *    `store` over the repository.
 * 4. A job: `createOverviewJobs({ name, versionKey, parentKey, ... }, store)`,
 *    whose `process` the worker registers with a run that calls
 *    `generateOverview(adapter, { ..., modelConfigurationKey:
 *    resolveOverviewModelConfigurationKey() })`; and `enqueueOverviewBatch`
 *    on the scheduler tick with the kind's candidate query.
 *
 * Kind-specific SQL stays with the kind: the subject and candidate queries,
 * `lockTarget` and `applyCategories`. The skill kind is the reference
 * (`modules/skills/market/overview-generate.ts`, `overview-store.ts`,
 * `overview-queue.ts`, `analysis-repository.ts`).
 */
export * from "./types";
export * from "./keys";
export * from "./model";
export * from "./generate";
export * from "./repository";
export * from "./jobs";
export * from "./text";
