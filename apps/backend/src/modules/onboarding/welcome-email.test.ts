import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueWithAudit: vi.fn(),
  getBillingDeploymentCapabilities: vi.fn(),
  loggerError: vi.fn(),
  mailDeliveryConfigured: vi.fn(),
  resolveMailLocale: vi.fn(),
}));

vi.mock("../../shared/config", () => ({
  config: {
    auth: {
      webBaseUrl: "https://app.sourceweft.test/",
    },
  },
}));

vi.mock("../../billing-host/bindings", () => ({
  getBillingDeploymentCapabilities: mocks.getBillingDeploymentCapabilities,
}));

vi.mock("../mail/delivery", () => ({
  mailDeliveryConfigured: mocks.mailDeliveryConfigured,
}));

vi.mock("../auth/mail-locale", () => ({
  resolveMailLocale: mocks.resolveMailLocale,
}));

vi.mock("../../shared/queue", () => ({
  enqueueWithAudit: mocks.enqueueWithAudit,
}));

vi.mock("../../shared/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.loggerError,
  },
}));

import {
  buildWelcomeMailVariables,
  enqueueWelcomeEmail,
} from "./welcome-email";

beforeEach(() => {
  mocks.enqueueWithAudit.mockReset();
  mocks.getBillingDeploymentCapabilities.mockReset();
  mocks.loggerError.mockReset();
  mocks.mailDeliveryConfigured.mockReset();
  mocks.resolveMailLocale.mockReset();

  mocks.getBillingDeploymentCapabilities.mockReturnValue({
    billing: {
      available: true,
      catalog: { plans: { free: { credits: 3000, pages: 300 } } },
    },
  });
  mocks.mailDeliveryConfigured.mockReturnValue(true);
  mocks.resolveMailLocale.mockResolvedValue("en");
});

test("builds links from the web base URL without double slashes", () => {
  const v = buildWelcomeMailVariables({ name: "Alice", locale: "en" });
  assert.equal(v.dashboardUrl, "https://app.sourceweft.test/dashboard");
  assert.equal(v.chatUrl, "https://app.sourceweft.test/dashboard/chat");
  assert.equal(
    v.scheduledUrl,
    "https://app.sourceweft.test/dashboard/scheduled",
  );
  assert.equal(
    v.assistantUrl,
    "https://app.sourceweft.test/dashboard/assistant",
  );
  assert.equal(v.downloadUrl, "https://app.sourceweft.test/download");
  assert.equal(v.imageUrl, "https://app.sourceweft.test/icon-512.png");
});

test("prefixes the download link with a non-English locale", () => {
  assert.equal(
    buildWelcomeMailVariables({ name: null, locale: "zh-CN" }).downloadUrl,
    "https://app.sourceweft.test/zh-CN/download",
  );
});

test("formats the free allowance from the billing catalog", () => {
  const v = buildWelcomeMailVariables({ name: null, locale: "en" });
  assert.equal(v.freeCredits, "3,000");
  assert.equal(v.freePages, "300");
});

test("omits the allowance when billing is unavailable, or either number is zero", () => {
  mocks.getBillingDeploymentCapabilities.mockReturnValueOnce({
    billing: { available: false },
  });
  const unavailable = buildWelcomeMailVariables({ name: null, locale: "en" });
  assert.equal(unavailable.freeCredits, null);
  assert.equal(unavailable.freePages, null);

  mocks.getBillingDeploymentCapabilities.mockReturnValueOnce({
    billing: {
      available: true,
      catalog: { plans: { free: { credits: 0, pages: 300 } } },
    },
  });
  const zeroCredits = buildWelcomeMailVariables({ name: null, locale: "en" });
  assert.equal(zeroCredits.freeCredits, null);
  assert.equal(zeroCredits.freePages, null);

  mocks.getBillingDeploymentCapabilities.mockReturnValueOnce({
    billing: {
      available: true,
      catalog: { plans: { free: { credits: 3000, pages: 0 } } },
    },
  });
  const zeroPages = buildWelcomeMailVariables({ name: null, locale: "en" });
  assert.equal(zeroPages.freeCredits, null);
  assert.equal(zeroPages.freePages, null);
});

test("trims the name, caps it at 80 characters and treats blank as null", () => {
  assert.equal(
    buildWelcomeMailVariables({ name: "  Alice ", locale: "en" }).name,
    "Alice",
  );
  assert.equal(
    buildWelcomeMailVariables({ name: "x".repeat(200), locale: "en" }).name
      ?.length,
    80,
  );
  assert.equal(
    buildWelcomeMailVariables({ name: "   ", locale: "en" }).name,
    null,
  );
  assert.equal(
    buildWelcomeMailVariables({ name: undefined, locale: "en" }).name,
    null,
  );
});

test("does not enqueue when mail cannot be delivered", async () => {
  mocks.mailDeliveryConfigured.mockReturnValue(false);
  await enqueueWelcomeEmail({ userId: "u1" });
  assert.equal(mocks.enqueueWithAudit.mock.calls.length, 0);
});

test("enqueues one job per user with the resolved locale and no email", async () => {
  mocks.resolveMailLocale.mockResolvedValue("zh-TW");
  await enqueueWelcomeEmail({ userId: "u1", headers: new Headers() });
  assert.deepEqual(mocks.enqueueWithAudit.mock.calls[0], [
    "welcome-email",
    { userId: "u1", locale: "zh-TW" },
    {
      jobId: "welcome-email_u1",
      attempts: 5,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  ]);
});

test("never throws when enqueueing fails", async () => {
  mocks.enqueueWithAudit.mockRejectedValueOnce(new Error("redis down"));
  await enqueueWelcomeEmail({ userId: "u1" });
  assert.equal(mocks.loggerError.mock.calls.length, 1);
  assert.equal(
    mocks.loggerError.mock.calls[0]?.[0],
    "welcome_email_enqueue_failed",
  );
});

test("never throws when resolving the mail locale fails", async () => {
  mocks.resolveMailLocale.mockRejectedValueOnce(new Error("settings down"));
  await assert.doesNotReject(() => enqueueWelcomeEmail({ userId: "u1" }));
  assert.equal(mocks.enqueueWithAudit.mock.calls.length, 0);
  assert.equal(mocks.loggerError.mock.calls.length, 1);
  assert.equal(
    mocks.loggerError.mock.calls[0]?.[0],
    "welcome_email_enqueue_failed",
  );
});
