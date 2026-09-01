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
 * Validate an already-materialized canonical project tree. The caller owns the
 * trusted root/cwd and command identity; this seam never rebuilds or uploads a
 * second payload, so validation operates on the immutable tree it will render.
 */
export async function validateCanonicalProjectTree(input: {
  execute: (command: string) => Promise<SandboxExecuteLikeResult>;
}): Promise<CanonicalProjectValidationResult> {
  const run = async (command: string) =>
    projectExecutionResultFromSandbox(await input.execute(command));
  // The dependency manifest and lockfile are host-generated and pinned.
  // Generated scene code never gets package lifecycle-script authority.
  const install = await run(
    'pnpm install --frozen-lockfile --ignore-scripts --prefer-offline --store-dir "${SOURCEWEFT_PNPM_STORE:-.pnpm-store}"',
  );
  const typecheck = install.ok
    ? await run("pnpm run build")
    : { ok: false, diagnostics: [] };
  const smoke =
    install.ok && typecheck.ok
      ? { ...(await run("pnpm run render-smoke")), checked: true }
      : { ok: false, diagnostics: [], checked: false };
  return { install, typecheck, smoke };
}
