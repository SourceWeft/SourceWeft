import { InterpreterError } from "./errors";
import type { InterpreterErrorCode } from "./types";
import type { InterpreterExecutionGate, InterpreterLimits } from "./types";

type QueueEntry = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

class Semaphore {
  private active = 0;
  private readonly queue: QueueEntry[] = [];

  constructor(private readonly capacity: number) {}

  acquire(
    timeoutMs?: number,
    timeoutCode: InterpreterErrorCode = "BUSY",
  ): Promise<() => void> {
    if (this.active < this.capacity) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }

    return new Promise((resolve, reject) => {
      const entry: QueueEntry = { resolve, reject };
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) {
            this.queue.splice(index, 1);
          }
          reject(new InterpreterError(timeoutCode));
        }, timeoutMs);
        entry.timer.unref?.();
      }
      this.queue.push(entry);
    });
  }

  private releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        if (next.timer) clearTimeout(next.timer);
        next.resolve(this.releaseOnce());
        return;
      }
      this.active = Math.max(0, this.active - 1);
    };
  }
}

type TurnState = {
  evals: number;
  ptcCalls: number;
  ptcSemaphore: Semaphore;
};

export function createInterpreterExecutionGate(
  limits: Readonly<InterpreterLimits>,
): InterpreterExecutionGate {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(
        `Interpreter limit '${name}' must be a positive integer.`,
      );
    }
  }
  if (limits.maxPtcCallsPerTurn < limits.maxPtcCallsPerEval) {
    throw new RangeError(
      "maxPtcCallsPerTurn must be greater than or equal to maxPtcCallsPerEval.",
    );
  }

  const stableLimits = Object.freeze({ ...limits });
  const evalSemaphore = new Semaphore(stableLimits.maxConcurrentEvals);
  const turns = new Map<string, TurnState>();

  const stateFor = (turnKey: string) => {
    const existing = turns.get(turnKey);
    if (existing) return existing;
    const state: TurnState = {
      evals: 0,
      ptcCalls: 0,
      ptcSemaphore: new Semaphore(stableLimits.maxConcurrentPtcPerTurn),
    };
    turns.set(turnKey, state);
    return state;
  };

  return {
    limits: stableLimits,
    async acquireEval(turnKey) {
      const state = stateFor(turnKey);
      if (state.evals >= stableLimits.maxEvalsPerTurn) {
        throw new InterpreterError("EVAL_LIMIT");
      }
      state.evals += 1;
      try {
        return await evalSemaphore.acquire(stableLimits.evalQueueTimeoutMs);
      } catch (error) {
        state.evals = Math.max(0, state.evals - 1);
        throw error;
      }
    },
    async runPtc<T>(turnKey: string, operation: () => Promise<T>) {
      const state = stateFor(turnKey);
      if (state.ptcCalls >= stableLimits.maxPtcCallsPerTurn) {
        throw new InterpreterError("PTC_LIMIT");
      }
      state.ptcCalls += 1;
      const deadline = Date.now() + stableLimits.ptcCallTimeoutMs;
      const release = await state.ptcSemaphore.acquire(
        stableLimits.ptcCallTimeoutMs,
        "PTC_TIMEOUT",
      );
      const running = Promise.resolve().then(operation);
      void running.then(release, release);

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new InterpreterError("PTC_TIMEOUT")),
          Math.max(1, deadline - Date.now()),
        );
        timer.unref?.();
      });
      try {
        return await Promise.race([running, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    resetTurn(turnKey) {
      turns.delete(turnKey);
    },
  };
}
