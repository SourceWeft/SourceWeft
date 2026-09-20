import assert from "node:assert/strict";
import type { Job } from "bullmq";
import { afterEach, test, vi } from "vitest";
import { ContentError } from "../modules/content/errors";
import { logger } from "../shared/logger";
import {
  handleUnhandledWorkerRuntimeError,
  installWorkerProcessErrorGuards,
  isRecoverableWorkerRuntimeError,
  runWorkerJobWithIsolation,
  type PersistThreadRunFailure,
  type PersistThreadRunFailureInput,
} from "./job-isolation";

const loggerErrorSpy = vi
  .spyOn(logger, "error")
  .mockImplementation(() => undefined);

afterEach(() => {
  loggerErrorSpy.mockClear();
});

function createJob(input?: {
  data?: Record<string, unknown>;
  name?: string;
}): Job<Record<string, unknown>> {
  return {
    id: "job-1",
    name: input?.name ?? "thread-chat-run",
    attemptsMade: 0,
    opts: { attempts: 1 },
    data:
      input?.data ??
      {
        runId: "run-1",
        teamId: "team-1",
        workspaceId: "workspace-1",
        threadId: "thread-1",
        userId: "user-1",
      },
  } as Job<Record<string, unknown>>;
}

test("runWorkerJobWithIsolation logs and rethrows processor MiddlewareError failures", async () => {
  const cause = new Error("SANDBOX_PROVIDER_ERROR: provider mkdir failed");
  const error = new Error("MiddlewareError", { cause });
  error.name = "MiddlewareError";

  await assert.rejects(
    () =>
      runWorkerJobWithIsolation(createJob(), async () => {
        throw error;
      }),
    /MiddlewareError/u,
  );

  assert.equal(loggerErrorSpy.mock.calls.length, 1);
  assert.equal(loggerErrorSpy.mock.calls[0]?.[0], "Job processor failed");
  assert.equal(isRecoverableWorkerRuntimeError(error), true);
});

test("handleUnhandledWorkerRuntimeError persists active thread run failures", async () => {
  const persisted: PersistThreadRunFailureInput[] = [];
  const persistThreadRunFailure: PersistThreadRunFailure = async (input) => {
    persisted.push(input);
  };
  const job = createJob();

  await runWorkerJobWithIsolation(job, async () => {
    await handleUnhandledWorkerRuntimeError({
      error: new ContentError(500, "CHAT_RUN_FAILED", "tool failed"),
      event: "unhandledRejection",
      persistThreadRunFailure,
    });
  });

  assert.equal(persisted.length, 1);
  const failureInput = persisted[0]!;
  assert.equal(failureInput.payload.runId, "run-1");
});

// vitest installs its own process listeners that fail the run; they are taken
// off while a guard is exercised so the events reach only the guard.
async function withWorkerGuards(
  restartAfterException: () => void,
  emit: () => void,
) {
  const parked = {
    unhandledRejection: process.listeners("unhandledRejection"),
    uncaughtException: process.listeners("uncaughtException"),
  };
  process.removeAllListeners("unhandledRejection");
  process.removeAllListeners("uncaughtException");
  const uninstall = installWorkerProcessErrorGuards({ restartAfterException });
  try {
    emit();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    if (typeof uninstall === "function") uninstall();
    process.removeAllListeners("unhandledRejection");
    process.removeAllListeners("uncaughtException");
    for (const listener of parked.unhandledRejection) {
      process.on("unhandledRejection", listener);
    }
    for (const listener of parked.uncaughtException) {
      process.on("uncaughtException", listener);
    }
  }
}

test("an uncaught exception asks the worker to restart, once it has been recorded", async () => {
  let restarts = 0;
  await withWorkerGuards(
    () => {
      restarts += 1;
    },
    () => process.emit("uncaughtException", new Error("sync throw escaped")),
  );
  assert.equal(restarts, 1);
});

test("an unhandled rejection stays scoped to its job: no restart", async () => {
  let restarts = 0;
  await withWorkerGuards(
    () => {
      restarts += 1;
    },
    () =>
      process.emit(
        "unhandledRejection",
        new Error("nobody awaited this"),
        Promise.resolve(),
      ),
  );
  assert.equal(restarts, 0);
});
