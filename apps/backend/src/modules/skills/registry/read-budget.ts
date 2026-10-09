/** Raw bundle bytes retained by concurrent ingestion runs in this process. */
export const SKILL_READ_BUDGET_BYTES = 512 * 1024 * 1024;
export function createSkillReadBudget(limit = SKILL_READ_BUDGET_BYTES) {
  let held = 0;
  type Waiter = {
    bytes: number;
    signal: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    abort: () => void;
  };
  const pending: Waiter[] = [];
  function drain() {
    while (pending.length && held + pending[0]!.bytes <= limit) {
      const waiter = pending.shift()!;
      waiter.signal.removeEventListener("abort", waiter.abort);
      held += waiter.bytes;
      let released = false;
      waiter.resolve(() => {
        if (!released) {
          released = true;
          held -= waiter.bytes;
          drain();
        }
      });
    }
  }
  return (bytes: number, signal: AbortSignal): Promise<() => void> => {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit)
      throw new Error("Invalid skill read budget request");
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        bytes,
        signal,
        resolve,
        reject,
        abort: () => {
          const index = pending.indexOf(waiter);
          if (index >= 0) pending.splice(index, 1);
          reject(signal.reason);
          drain();
        },
      };
      pending.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
      drain();
    });
  };
}
export const reserveSkillReadBytes = createSkillReadBudget();
