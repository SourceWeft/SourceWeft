import type { VideoPresentationProjectExecutionResult } from "@sourceweft/contracts/video-presentation";

export type SandboxExecuteLikeResult = {
  exitCode: number | null;
  output: string;
  truncated?: boolean;
};

export function projectExecutionResultFromSandbox(
  result: SandboxExecuteLikeResult,
): VideoPresentationProjectExecutionResult {
  const output = result.output.trim();
  const ok = result.exitCode === 0;
  return {
    ok,
    diagnostics: ok ? [] : [output || `Command exited with ${result.exitCode}`],
    stdout: ok ? output : "",
    stderr: ok ? "" : output,
  };
}

export type CanonicalProjectValidationResult = {
  install: VideoPresentationProjectExecutionResult;
  typecheck: VideoPresentationProjectExecutionResult;
  smoke: VideoPresentationProjectExecutionResult & { checked: boolean };
};

/**
 * Packages are copied out of the store rather than hard-linked. The sandbox
 * image prewarms the store as root, and pnpm sets the executable bit on every
 * linked bin: a hard link shares the store file's owner, so the sandbox user
 * is refused (EPERM) and the install fails. A copy belongs to the installing
 * user.
 */
export const VIDEO_PROJECT_INSTALL_COMMAND =
  'pnpm install --frozen-lockfile --ignore-scripts --prefer-offline --package-import-method copy --store-dir "${SOURCEWEFT_PNPM_STORE:-.pnpm-store}"';

/**
 * Validate an already-materialized canonical project tree. The caller owns the
 * trusted root/cwd and command identity; this seam never rebuilds or uploads a
 * second payload, so validation operates on the immutable tree it will render.
 */
export async function validateCanonicalProjectTree(input: {
  execute: (command: string) => Promise<SandboxExecuteLikeResult>;
  /** Called before each command runs, so callers can report progress. */
  onStage?: (stage: "install" | "typecheck" | "smoke") => void;
}): Promise<CanonicalProjectValidationResult> {
  const run = async (command: string) =>
    projectExecutionResultFromSandbox(await input.execute(command));
  // The dependency manifest and lockfile are host-generated and pinned.
  // Generated scene code never gets package lifecycle-script authority.
  input.onStage?.("install");
  const install = await run(VIDEO_PROJECT_INSTALL_COMMAND);
  if (install.ok) input.onStage?.("typecheck");
  const typecheck = install.ok
    ? await run("pnpm run build")
    : { ok: false, diagnostics: [] };
  if (install.ok && typecheck.ok) input.onStage?.("smoke");
  const smoke =
    install.ok && typecheck.ok
      ? { ...(await run("pnpm run render-smoke")), checked: true }
      : { ok: false, diagnostics: [], checked: false };
  return { install, typecheck, smoke };
}
