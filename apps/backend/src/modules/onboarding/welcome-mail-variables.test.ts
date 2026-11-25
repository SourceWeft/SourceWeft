import assert from "node:assert/strict";
import { test } from "vitest";
import { composeWelcomeMailVariables } from "./welcome-mail-variables";

test("builds links from the web base URL without double slashes", () => {
  const v = composeWelcomeMailVariables({
    name: "Alice",
    locale: "en",
    webBaseUrl: "https://app.sourceweft.test/",
    freeAllowance: null,
  });
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
    composeWelcomeMailVariables({
      name: null,
      locale: "en",
      webBaseUrl: "https://app.sourceweft.test",
      freeAllowance: null,
    }).downloadUrl,
    "https://app.sourceweft.test/download",
  );
  assert.equal(
    composeWelcomeMailVariables({
      name: null,
      locale: "zh-TW",
      webBaseUrl: "https://app.sourceweft.test",
      freeAllowance: null,
    }).downloadUrl,
    "https://app.sourceweft.test/zh-TW/download",
  );
});

test("formats the free allowance when both numbers are positive", () => {
  const v = composeWelcomeMailVariables({
    name: null,
    locale: "en",
    webBaseUrl: "https://app.sourceweft.test",
    freeAllowance: { credits: 3000, pages: 300 },
  });
  assert.equal(v.freeCredits, "3,000");
  assert.equal(v.freePages, "300");
});

test("omits the allowance when it is null, or either number is zero", () => {
  const nullAllowance = composeWelcomeMailVariables({
    name: null,
    locale: "en",
    webBaseUrl: "https://app.sourceweft.test",
    freeAllowance: null,
  });
  assert.equal(nullAllowance.freeCredits, null);
  assert.equal(nullAllowance.freePages, null);

  const zeroCredits = composeWelcomeMailVariables({
    name: null,
    locale: "en",
    webBaseUrl: "https://app.sourceweft.test",
    freeAllowance: { credits: 0, pages: 300 },
  });
  assert.equal(zeroCredits.freeCredits, null);
  assert.equal(zeroCredits.freePages, null);

  const zeroPages = composeWelcomeMailVariables({
    name: null,
    locale: "en",
    webBaseUrl: "https://app.sourceweft.test",
    freeAllowance: { credits: 3000, pages: 0 },
  });
  assert.equal(zeroPages.freeCredits, null);
  assert.equal(zeroPages.freePages, null);
});

test("trims the name, caps it at 80 characters and treats blank/undefined as null", () => {
  assert.equal(
    composeWelcomeMailVariables({
      name: "  Alice ",
      locale: "en",
      webBaseUrl: "https://app.sourceweft.test",
      freeAllowance: null,
    }).name,
    "Alice",
  );
  assert.equal(
    composeWelcomeMailVariables({
      name: "x".repeat(200),
      locale: "en",
      webBaseUrl: "https://app.sourceweft.test",
      freeAllowance: null,
    }).name?.length,
    80,
  );
  assert.equal(
    composeWelcomeMailVariables({
      name: "   ",
      locale: "en",
      webBaseUrl: "https://app.sourceweft.test",
      freeAllowance: null,
    }).name,
    null,
  );
  assert.equal(
    composeWelcomeMailVariables({
      name: undefined,
      locale: "en",
      webBaseUrl: "https://app.sourceweft.test",
      freeAllowance: null,
    }).name,
    null,
  );
});
