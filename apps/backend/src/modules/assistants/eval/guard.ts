/**
 * Refuses to run the P1 evaluation anywhere but a throwaway database (#692).
 * The evaluation creates organizations, members and paid model runs; pointed
 * at the shared dev database by a missing export, it would do all of that
 * there. The database name must start with `EVAL_DATABASE_PREFIX`.
 */
export const EVAL_DATABASE_PREFIX = "sw_assistant_eval_";

export function assertEvalDatabaseUrl(databaseUrl: string | undefined): void {
  if (!databaseUrl) {
    throw new Error(
      "P1 eval: DATABASE_URL is not set; export a throwaway database URL.",
    );
  }
  let name: string;
  try {
    name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  } catch {
    throw new Error("P1 eval: DATABASE_URL is not a valid URL.");
  }
  if (!name.startsWith(EVAL_DATABASE_PREFIX)) {
    throw new Error(
      `P1 eval: refusing to run against database "${name}"; its name must start with "${EVAL_DATABASE_PREFIX}".`,
    );
  }
}
