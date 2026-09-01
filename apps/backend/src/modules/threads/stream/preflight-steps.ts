/**
 * Preflight thinking-step delivery: the queue that lets `prepareThreadTurn`
 * push thinking steps while the stream is still waiting on it, and the race
 * that interleaves those steps with the prepare result.
 *
 * Carved out of `service.ts` verbatim (T2.3 mechanical split); behavior
 * unchanged.
 */
import type { PreparedThreadTurn } from "../turn/service";
import type { ThinkingStepTrace } from "../turn/types";

export function createPreflightThinkingStepQueue() {
  const queuedSteps: ThinkingStepTrace[] = [];
  const waitingResolvers: Array<
    (result: IteratorResult<ThinkingStepTrace>) => void
  > = [];
  let closed = false;

  return {
    close() {
      if (closed) {
        return;
      }
      closed = true;
      while (waitingResolvers.length > 0) {
        waitingResolvers.shift()?.({
          done: true,
          value: undefined,
        });
      }
    },
    next(): Promise<IteratorResult<ThinkingStepTrace>> {
      const step = queuedSteps.shift();
      if (step) {
        return Promise.resolve({ done: false, value: step });
      }
      if (closed) {
        return Promise.resolve({
          done: true,
          value: undefined,
        });
      }
      return new Promise((resolve) => {
        waitingResolvers.push(resolve);
      });
    },
    push(step: ThinkingStepTrace) {
      if (closed) {
        return;
      }
      const resolve = waitingResolvers.shift();
      if (resolve) {
        resolve({ done: false, value: step });
        return;
      }
      queuedSteps.push(step);
    },
  };
}

export function waitForPrepareOrPreflightStep(input: {
  preparePromise: Promise<PreparedThreadTurn>;
  preflightStepQueue: ReturnType<typeof createPreflightThinkingStepQueue>;
}): Promise<
  | { type: "prepared"; prepared: PreparedThreadTurn }
  | { type: "preflight-step"; result: IteratorResult<ThinkingStepTrace> }
> {
  return Promise.race([
    input.preparePromise.then((prepared) => ({
      type: "prepared" as const,
      prepared,
    })),
    input.preflightStepQueue.next().then((result) => ({
      type: "preflight-step" as const,
      result,
    })),
  ]);
}
