import { SkillArchiveError } from "@sourceweft/skill-format";
import { UnsupportedSourceError } from "./install/install-skill";
import { VerificationError, describeProblem } from "./install/verify";
import { InstallConflictError } from "./install/write";
import {
  RegistryConfigError,
  RegistryError,
  RegistryResponseError,
  RegistryUnreachableError,
} from "./registry/client";
import { GitHubSourceError } from "./source/github";

export const EXIT = Object.freeze({
  ok: 0,
  error: 1,
  usage: 2,
  verification: 3,
  needsConfirmation: 4,
});

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Raised when a confirmation is needed and there is no one to ask. */
export class ConfirmationRequiredError extends Error {
  constructor() {
    super(
      "Confirmation required. Re-run with --yes to proceed without asking.",
    );
    this.name = "ConfirmationRequiredError";
  }
}

/** The registry answered, but does not serve the skill marketplace. */
export class UnsupportedRegistryError extends Error {
  constructor(registry: string) {
    super(
      `${registry} does not serve the skill marketplace API (GET /v1/skills returned 404). It may not be deployed there yet.`,
    );
    this.name = "UnsupportedRegistryError";
  }
}

export type Failure = { exitCode: number; message: string; details?: string[] };

/** Turns anything thrown into what to print and which code to exit with. */
export function toFailure(error: unknown): Failure {
  if (error instanceof UsageError) {
    return { exitCode: EXIT.usage, message: error.message };
  }
  if (error instanceof UnsupportedRegistryError) {
    return { exitCode: EXIT.error, message: error.message };
  }
  if (error instanceof ConfirmationRequiredError) {
    return { exitCode: EXIT.needsConfirmation, message: error.message };
  }
  if (error instanceof VerificationError) {
    return {
      exitCode: EXIT.verification,
      message:
        "The downloaded skill does not match what the registry indexed, so nothing was installed.",
      details: error.problems.map(describeProblem),
    };
  }
  if (error instanceof RegistryError) {
    return {
      exitCode: EXIT.error,
      message:
        error.status === 404
          ? "Skill not found in the registry."
          : `Registry error (${error.status} ${error.code}): ${error.message}`,
    };
  }
  if (
    error instanceof InstallConflictError ||
    error instanceof UnsupportedSourceError ||
    error instanceof RegistryConfigError ||
    error instanceof RegistryUnreachableError ||
    error instanceof RegistryResponseError ||
    error instanceof GitHubSourceError
  ) {
    return { exitCode: EXIT.error, message: error.message };
  }
  if (error instanceof SkillArchiveError) {
    return {
      exitCode: EXIT.verification,
      message: `The downloaded archive was refused (${error.code}): ${error.message}`,
    };
  }
  return {
    exitCode: EXIT.error,
    message: error instanceof Error ? error.message : String(error),
  };
}
