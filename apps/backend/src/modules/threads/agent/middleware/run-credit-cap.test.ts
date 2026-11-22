import assert from "node:assert/strict";
import { test } from "vitest";
import type { BillingScope } from "../../../../shared/model-gateway/billing/scope";
import type { MeteredModelCallTrace } from "../../../../shared/model-gateway/billing/context";
import {
  RUN_CREDIT_CAP_EXCEEDED,
  createRunCreditCapMiddleware,
} from "./run-credit-cap";

function fakeScope(consumedCredits: number[]): BillingScope {
  const calls = consumedCredits.map(
    (credits) => ({ consumedCredits: credits }) as MeteredModelCallTrace,
  );
  return { meteredCalls: () => calls } as unknown as BillingScope;
}

async function runBeforeModel(middleware: ReturnType<
  typeof createRunCreditCapMiddleware
>) {
  const hook = middleware.beforeModel as unknown as (
    state: unknown,
    runtime: unknown,
  ) => Promise<unknown>;
  return hook({}, {});
}

test("continues when settled credits stay below the cap", async () => {
  const middleware = createRunCreditCapMiddleware({
    capCredits: 10,
    getScope: () => fakeScope([4, 5]),
  });
  await assert.doesNotReject(() => runBeforeModel(middleware));
});

test("throws RUN_CREDIT_CAP_EXCEEDED once settled credits reach the cap", async () => {
  const middleware = createRunCreditCapMiddleware({
    capCredits: 10,
    getScope: () => fakeScope([4, 6]),
  });
  await assert.rejects(
    () => runBeforeModel(middleware),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        RUN_CREDIT_CAP_EXCEEDED,
      );
      return true;
    },
  );
});

test("continues when there is no billing scope yet", async () => {
  const middleware = createRunCreditCapMiddleware({
    capCredits: 10,
    getScope: () => undefined,
  });
  await assert.doesNotReject(() => runBeforeModel(middleware));
});
