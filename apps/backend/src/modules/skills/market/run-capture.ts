import { SOURCEWEFT_SKILLS_ROOT } from "@sourceweft/builtin-tool-sandbox";
import type { SkillRunErrorClass } from "@sourceweft/contracts";

/**
 * The pure half of sandbox run statistics (skill-marketplace-plan §17.5):
 * which staged skills a finished `execute` command ran, and what class of
 * failure its output shows. Nothing here keeps the command or the output — the
 * only things that leave are skill names the turn already knows, an error
 * class, and a package name that passed a strict pattern.
 */

// A skill directory named in the command: `/skills/<name>` where the root is
// not the tail of a longer path (`/home/me/skills/x` is not ours) and the name
// ends at a path, word or shell boundary. The name pattern is the staging
// engine's SAFE_SEGMENT.
const SKILL_DIR_IN_COMMAND = new RegExp(
  `(?:^|[\\s'"\`=:;&|()<>{}])${SOURCEWEFT_SKILLS_ROOT.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/([a-zA-Z0-9][a-zA-Z0-9._-]*)(?=$|[/\\s'"\`;&|()<>{}])`,
  "gu",
);

/**
 * The names of the given skills whose directory the command references, each
 * once, in the order first referenced. A name the turn did not stage is never
 * returned, so whatever else the command says cannot become a skill.
 */
export function skillNamesReferencedByCommand(
  command: string,
  stagedNames: ReadonlySet<string>,
): string[] {
  if (!command.includes(`${SOURCEWEFT_SKILLS_ROOT}/`)) return [];
  const found: string[] = [];
  for (const match of command.matchAll(SKILL_DIR_IN_COMMAND)) {
    const name = match[1];
    if (name && stagedNames.has(name) && !found.includes(name)) {
      found.push(name);
    }
  }
  return found;
}

// A package or command name and nothing else: no path, no argument, no space.
const SUBJECT_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9._@/-]{0,63}$/u;

/**
 * The package a missing-module message names, reduced to the part that is a
 * package: `pptx.util` → `pptx`, `lodash/fp` → `lodash`, `@scope/pkg/x` →
 * `@scope/pkg`. Null for a relative or absolute path (that is the skill's own
 * missing file, not a dependency) and for anything outside the pattern.
 */
export function dependencySubject(
  raw: string,
  kind: "python" | "node" | "command",
): string | null {
  const value = raw.trim();
  if (value === "" || value.startsWith(".") || value.startsWith("/")) {
    return null;
  }
  if (value.includes("..") || value.includes("//") || value.includes("\\")) {
    return null;
  }
  let subject: string;
  if (kind === "python") {
    subject = value.split(".")[0]!;
  } else if (kind === "node") {
    const segments = value.replace(/^node:/u, "").split("/");
    subject = value.startsWith("@")
      ? segments.slice(0, 2).join("/")
      : segments[0]!;
  } else {
    // A command given as a path (`./run.sh`, `bin/tool`) is not a dependency.
    if (value.includes("/")) return null;
    subject = value;
  }
  return SUBJECT_PATTERN.test(subject) ? subject : null;
}

// Each rule captures the missing name, quoted or not.
const MISSING_DEPENDENCY_RULES: ReadonlyArray<{
  kind: "python" | "node" | "command";
  pattern: RegExp;
}> = [
  // ModuleNotFoundError: No module named 'pptx'
  // ImportError: No module named yaml   (Python 2 / old shims)
  { kind: "python", pattern: /No module named ['"]?([^'"\s]+)['"]?/gu },
  // Error: Cannot find module 'pptxgenjs'
  { kind: "node", pattern: /Cannot find module ['"]([^'"]+)['"]/gu },
  // Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'sharp' imported from …
  { kind: "node", pattern: /Cannot find package ['"]([^'"]+)['"]/gu },
  // zsh: command not found: jq
  { kind: "command", pattern: /command not found: ([^\s'"]+)/gu },
  // bash: jq: command not found · /bin/sh: line 1: jq: command not found
  {
    kind: "command",
    pattern: /(?:^|[\s:])([^\s:'"]+): command not found(?!:)/gmu,
  },
  // sh: 1: jq: not found   (dash)
  { kind: "command", pattern: /^[^\s:]*sh: \d+: ([^\s:'"]+): not found$/gmu },
  // /usr/bin/env: 'node': No such file or directory
  {
    kind: "command",
    pattern: /env: ['"]?([^\s'"]+?)['"]?: No such file or directory/gu,
  },
];

const PERMISSION_PATTERN = /\bEACCES\b|Permission denied/u;

// GNU `timeout` exits 124 when it had to stop the command.
const TIMEOUT_EXIT_CODE = 124;
// The shell's "command not found".
const COMMAND_NOT_FOUND_EXIT_CODE = 127;

export type SkillRunOutcome =
  { kind: "result"; exitCode: number; output: string } | { kind: "timeout" };

export type SkillRunClassification = {
  errorClass: SkillRunErrorClass | null;
  errorSubject: string | null;
};

/**
 * The class of a finished command. Exit 0 is a success whatever the output
 * says. Otherwise the first rule that fits, in this order: a missing module or
 * command (the LAST one the output names — the one that stopped the run),
 * a timeout, a permission error, anything else.
 */
export function classifySkillRun(
  outcome: SkillRunOutcome,
): SkillRunClassification {
  if (outcome.kind === "timeout") {
    return { errorClass: "timeout", errorSubject: null };
  }
  if (outcome.exitCode === 0) {
    return { errorClass: null, errorSubject: null };
  }
  const output = outcome.output;
  let last: { index: number; subject: string | null } | null = null;
  for (const rule of MISSING_DEPENDENCY_RULES) {
    for (const match of output.matchAll(rule.pattern)) {
      if (last && match.index < last.index) continue;
      last = {
        index: match.index,
        subject: dependencySubject(match[1] ?? "", rule.kind),
      };
    }
  }
  if (last) {
    return { errorClass: "missing_dependency", errorSubject: last.subject };
  }
  if (outcome.exitCode === COMMAND_NOT_FOUND_EXIT_CODE) {
    return { errorClass: "missing_dependency", errorSubject: null };
  }
  if (outcome.exitCode === TIMEOUT_EXIT_CODE) {
    return { errorClass: "timeout", errorSubject: null };
  }
  if (PERMISSION_PATTERN.test(output)) {
    return { errorClass: "permission", errorSubject: null };
  }
  return { errorClass: "other", errorSubject: null };
}

// The sandbox backend's own refusals (path policy, staging unavailable) come
// back as an ordinary exit-1 result carrying this line. The skill never ran.
const PLATFORM_REFUSAL =
  /^Diagnostics: toolName=\S+ commandFingerprint=\S+ failureCode=SANDBOX_/mu;

/**
 * What the finished `execute` says about the skill, or null when it says
 * nothing: the platform refused the command, the run was cancelled, or the
 * backend failed for its own reasons. Only a completed command and a timeout
 * are the skill's.
 */
export function skillRunOutcome(
  finished:
    | { result: { output: string; exitCode: number | null } }
    | { error: unknown },
): SkillRunOutcome | null {
  if ("error" in finished) {
    const error = finished.error as { code?: unknown } | null;
    return error?.code === "SANDBOX_OPERATION_TIMED_OUT"
      ? { kind: "timeout" }
      : null;
  }
  const { output, exitCode } = finished.result;
  if (exitCode === null) return null;
  if (exitCode !== 0 && PLATFORM_REFUSAL.test(output)) return null;
  return { kind: "result", exitCode, output };
}
