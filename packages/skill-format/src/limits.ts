/**
 * One set of limits for ingest AND for running: a skill that can be indexed can
 * be staged. They used to disagree (64 MiB per repository on the way in, 2 MB
 * per skill into the sandbox), so a skill could install cleanly and then fail
 * every turn that had a sandbox.
 */
export const SKILL_STORAGE_LIMITS = Object.freeze({
  maxFiles: 20_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxBundleBytes: 256 * 1024 * 1024,
});
