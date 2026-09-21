import type { SkillRunErrorClass } from "@sourceweft/contracts";

/**
 * English copy for a community skill's sandbox run stats (§17.5). Kept in its
 * own module so the i18n pass can move it into messages without touching the
 * components.
 */
export const skillRunStatsCopy = {
  heading: "Sandbox runs",
  ran: (runs: string, days: number) =>
    `Ran ${runs} ${runs === "1" ? "time" : "times"} in SourceWeft sandboxes in the last ${days} days`,
  succeeded: (percent: string) => `${percent} succeeded`,
  commonIssue: (label: string) => `Common issue: ${label}`,
  errorLabel: (
    errorClass: SkillRunErrorClass,
    subject: string | null,
  ): string => {
    switch (errorClass) {
      case "missing_dependency":
        return subject ? `missing ${subject}` : "a missing dependency";
      case "timeout":
        return "timed out";
      case "permission":
        return "permission denied";
      case "other":
        return "other errors";
    }
  },
  full: {
    privateNote: "Only you and market admins see this.",
    none: (days: number) => `No sandbox runs in the last ${days} days.`,
    succeeded: "Succeeded",
    succeededValue: (successes: string, runs: string, percent: string) =>
      `${successes} of ${runs} (${percent})`,
    workspaces: "Workspaces",
    issues: "Common issues",
    issueCount: (count: string) => `× ${count}`,
    publicLine: "Public page",
    shownPublicly: "Shown",
    hiddenPublicly: (minRuns: number, minWorkspaces: number) =>
      `Hidden until ${minRuns} runs from ${minWorkspaces} workspaces`,
    updated: (when: string) => `Updated ${when}`,
  },
};
