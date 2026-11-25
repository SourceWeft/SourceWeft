import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  databaseQuery: vi.fn(),
  enqueueWithAudit: vi.fn(),
  getBillingDeploymentCapabilities: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  mailDeliveryConfigured: vi.fn(),
  resolveMailLocale: vi.fn(),
  sendTemplate: vi.fn(),
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

vi.mock("../mail", () => ({
  mailService: { sendTemplate: mocks.sendTemplate },
}));

vi.mock("@sourceweft/db", () => ({
  database: { query: mocks.databaseQuery },
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
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

import {
  buildWelcomeMailVariables,
  enqueueWelcomeEmail,
  sendWelcomeEmail,
} from "./welcome-email";

beforeEach(() => {
  mocks.databaseQuery.mockReset();
  mocks.enqueueWithAudit.mockReset();
  mocks.getBillingDeploymentCapabilities.mockReset();
  mocks.loggerError.mockReset();
  mocks.loggerInfo.mockReset();
  mocks.loggerWarn.mockReset();
  mocks.mailDeliveryConfigured.mockReset();
  mocks.resolveMailLocale.mockReset();
  mocks.sendTemplate.mockReset();

  mocks.getBillingDeploymentCapabilities.mockReturnValue({
    billing: {
      available: true,
      catalog: { plans: { free: { credits: 3000, pages: 300 } } },
    },
  });
  mocks.mailDeliveryConfigured.mockReturnValue(true);
  mocks.resolveMailLocale.mockResolvedValue("en");
  mocks.databaseQuery.mockResolvedValue({
    rows: [{ email: "a@example.test", name: "Alice", emailVerified: true }],
  });
  mocks.sendTemplate.mockResolvedValue(undefined);
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

test("sends auth.welcome in the job's locale to the user's current address", async () => {
  // User row: { email: "a@example.test", name: "Alice", emailVerified: true }
  assert.equal(
    await sendWelcomeEmail({ userId: "u1", locale: "zh-CN" }),
    "sent",
  );
  const call = mocks.sendTemplate.mock.calls[0]![0];
  assert.equal(call.to, "a@example.test");
  assert.equal(call.templateId, "auth.welcome");
  assert.equal(call.messageType, "auth.welcome");
  assert.equal(call.locale, "zh-CN");
  assert.equal(call.variables.name, "Alice");
});

test("falls back to English when the job has no usable locale", async () => {
  await sendWelcomeEmail({ userId: "u1" });
  assert.equal(mocks.sendTemplate.mock.calls[0]![0].locale, "en");
  assert.equal(mocks.loggerWarn.mock.calls.length, 0);

  await sendWelcomeEmail({ userId: "u1", locale: "fr" });
  assert.equal(mocks.sendTemplate.mock.calls[1]![0].locale, "en");
  assert.equal(mocks.loggerWarn.mock.calls.length, 1);
  assert.equal(
    mocks.loggerWarn.mock.calls[0]?.[0],
    "welcome_email_locale_unsupported",
  );
  assert.deepEqual(mocks.loggerWarn.mock.calls[0]?.[1], {
    userId: "u1",
    locale: "fr",
  });
});

test("rejects with a userId-mentioning message for a non-string or empty userId", async () => {
  await assert.rejects(
    sendWelcomeEmail({ userId: 123, locale: "en" }),
    /userId/,
  );
  await assert.rejects(
    sendWelcomeEmail({ userId: "", locale: "en" }),
    /userId/,
  );
});

test("skips a user row with an empty email without calling sendTemplate", async () => {
  mocks.databaseQuery.mockResolvedValueOnce({
    rows: [{ email: "", name: "Alice", emailVerified: true }],
  });
  assert.equal(
    await sendWelcomeEmail({ userId: "u1", locale: "en" }),
    "skipped",
  );
  assert.equal(mocks.sendTemplate.mock.calls.length, 0);
  assert.equal(mocks.loggerInfo.mock.calls.length, 1);
  assert.equal(mocks.loggerInfo.mock.calls[0]?.[0], "welcome_email_skipped");
  assert.equal(mocks.loggerInfo.mock.calls[0]?.[1]?.reason, "user_missing");
});

test("skips a user that no longer exists", async () => {
  mocks.databaseQuery.mockResolvedValueOnce({ rows: [] });
  assert.equal(
    await sendWelcomeEmail({ userId: "gone", locale: "en" }),
    "skipped",
  );
  assert.equal(mocks.sendTemplate.mock.calls.length, 0);
});

test("skips a user whose email is not verified", async () => {
  mocks.databaseQuery.mockResolvedValueOnce({
    rows: [{ email: "a@example.test", name: "Alice", emailVerified: false }],
  });
  assert.equal(
    await sendWelcomeEmail({ userId: "u1", locale: "en" }),
    "skipped",
  );
  assert.equal(mocks.sendTemplate.mock.calls.length, 0);
});

test("throws when this process cannot deliver mail", async () => {
  mocks.mailDeliveryConfigured.mockReturnValue(false);
  await assert.rejects(
    sendWelcomeEmail({ userId: "u1", locale: "en" }),
    /not configured/,
  );
});

test("throws on a payload without a user id", async () => {
  await assert.rejects(sendWelcomeEmail({ locale: "en" }), /userId/);
});

test("lets a provider failure propagate so the job retries", async () => {
  mocks.sendTemplate.mockRejectedValueOnce(new Error("plunk 503"));
  await assert.rejects(
    sendWelcomeEmail({ userId: "u1", locale: "en" }),
    /plunk 503/,
  );
});
