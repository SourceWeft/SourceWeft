export function parseSystemSubmitCommand(
  args: readonly string[],
): "submit" | "status" {
  if (args.length !== 1 || (args[0] !== "submit" && args[0] !== "status")) {
    throw new Error(
      "Usage: skills-submit <submit|status>. System imports do not accept team/workspace arguments.",
    );
  }
  return args[0];
}
