/**
 * Tool input/output normalization for a turn, split by the tool family each
 * helper speaks for.
 *
 * This file is a barrel and nothing more: every caller keeps importing
 * `turn/output-normalizer`, while the helpers live in `output-normalizer/`
 * beside the family they normalize. `output-normalizer/shared.ts` holds the
 * private helpers two of those modules both need and is deliberately not
 * re-exported here.
 */
export * from "./output-normalizer/json";
export * from "./output-normalizer/filesystem";
export * from "./output-normalizer/web";
export * from "./output-normalizer/sandbox";
export * from "./output-normalizer/connector";
export * from "./output-normalizer/artifact-progress";
export * from "./output-normalizer/generated-image";
export * from "./output-normalizer/tool-input";
export * from "./output-normalizer/observability";
