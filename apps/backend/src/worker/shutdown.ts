/**
 * How long a shutting-down worker lets its chat turns end on their own before
 * stopping them. A turn that has finished writing its reply is still saving it
 * for a moment; stopping it then would fail a complete answer.
 */
export const CHAT_RUN_SHUTDOWN_GRACE_MS = 5_000;

/**
 * Shuts the worker down: stops taking jobs, gives in-flight chat turns
 * `graceMs` to end on their own, then stops the rest — each commits as failed
 * with a restart error, so its thread is free at once rather than showing a
 * reply in progress until stale recovery fails it — and resolves once every
 * job has returned.
 */
export async function drainWorkerForShutdown(input: {
  closeWorkers: () => Promise<unknown>;
  graceMs?: number;
  interruptActiveChatRuns: () => number;
  onInterrupted?: (count: number) => void;
}) {
  const closing = input.closeWorkers();
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const endedInGrace = await Promise.race([
    closing.then(() => true),
    new Promise<false>((resolve) => {
      graceTimer = setTimeout(
        () => resolve(false),
        input.graceMs ?? CHAT_RUN_SHUTDOWN_GRACE_MS,
      );
    }),
  ]);
  clearTimeout(graceTimer);
  if (!endedInGrace) {
    input.onInterrupted?.(input.interruptActiveChatRuns());
  }
  await closing;
}
