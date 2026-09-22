# Skill AI Analysis Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent tasks; review spec compliance and code quality before completion.

**Goal:** Make tri-language AI overviews and AI classification reliable and automatic.
**Architecture:** Existing BullMQ worker and billed gateway produce a versioned analysis. A durable per-version job state coordinates regeneration; a transaction publishes all locale rows and eligible non-manual categories. Legacy overview content remains available until replacement succeeds.
**Tech Stack:** TypeScript, Drizzle/PostgreSQL, BullMQ, Hono, React/next-intl, Vitest.

- [x] Prompt/output: update overview-prompt.ts and tests; three required locales, independent classification, strict category validation, bounded section extraction. Remove OpenCC generation dependency.
- [x] Persistence: add skill_version_analysis state/result schema and migration; request/claim/result compare-and-set; current-version and administrator guards; safe cache identity and complete-locale requirement.
- [x] Pipeline: update overview-generate.ts, overview-queue.ts, overviews.ts and worker; keep old rows; force bypass; durable failures and bounded retry.
- [x] Classification: listing.ts no keyword calls; pending first listing; explicit AI re-inference, manual protection and audit; common transaction writer.
- [x] Admin/API: contracts and routes expose source/status/errors, bulk preview and enqueue; UI state/retry and localized text; no changes to unrelated i18n workflows.
- [ ] Evaluation: reproducible 100-case labeled evaluation data and runner, source evidence, baseline comparison, review status; do not fabricate human review or model results.
- [ ] Verification: focused Vitest tests, backend/contracts/web type checks, isolated PostgreSQL integration tests, real gateway evaluation if configured. Record actual results and blockers. No production migration before quality gate.

Focused command: `pnpm --filter @sourceweft/backend test src/modules/skills/market/overview-prompt.test.ts src/modules/skills/market/overviews.test.ts`.
Type command: `pnpm --filter @sourceweft/backend check-types`.
Database command uses `RUN_SKILL_DB_TESTS=1` and an isolated database after applying repository migrations; never mutate developer or production data for tests.

## Execution evidence

Implemented in the managed skill-ai-analysis worktree. Independent spec and code reviews completed; findings about original-source evidence, stale UI polls, legacy bulk gate bypass, cache snapshot consistency, request ID collision and pricing-only fingerprint invalidation were corrected.

Completed checks before final formatting: backend unit tests 33 passed; UI tests 13 passed; PostgreSQL integration tests 57 passed across five suites, each run used isolated databases and cleaned them; backend and Web type checks passed. Additional gate/primary-order tests are included in the final verification run.

Live evaluation blocked: read-only export from the original local backend .env database found zero eligible public source cases on 2026-09-22. No substituted/synthetic evaluation or fake reviewer labels were used. Asked user for dataset/database location. Evaluation tool is ready, but >=100 human-reviewed real cases and real gateway evaluation remain outstanding. Bulk migration stays gated; no production migration, release or deployment was performed.

Final verification: additional two PostgreSQL tests passed (59 unique DB tests total); 33 backend unit + 13 UI = 105 related tests. Backend, Web and evaluation CLI type checks passed. Web lint had one effect-ref warning, corrected before the final check. No business data migrated.
