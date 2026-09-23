import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";

import { renderMailTemplate } from "./templates";

const url = "https://app.sourceweft.test/verify?token=abc";

afterEach(() => vi.unstubAllEnvs());

describe("production mail base URL", () => {
  test("uses the canonical public web URL for an email OTP", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_WEB_BASE_URL", "https://sourceweft.test/");
    vi.stubEnv("NEXT_PUBLIC_WEB_BASE_URL", "https://old.sourceweft.test");
    vi.stubEnv("BASE_URL", "");

    const rendered = renderMailTemplate("auth.email-otp.sign-in", {
      otp: "000000",
    });

    assert.match(rendered.html, /https:\/\/sourceweft\.test\/icon-512\.png/);
    assert.doesNotMatch(rendered.html, /old\.sourceweft\.test/);
  });

  test("continues to accept the legacy web URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_WEB_BASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_WEB_BASE_URL", "https://legacy.sourceweft.test");
    vi.stubEnv("BASE_URL", "");

    const rendered = renderMailTemplate("auth.email-otp.sign-in", {
      otp: "000000",
    });

    assert.match(
      rendered.html,
      /https:\/\/legacy\.sourceweft\.test\/icon-512\.png/,
    );
  });

  test("fails clearly when production has no public web URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_WEB_BASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_WEB_BASE_URL", "");
    vi.stubEnv("BASE_URL", "");

    assert.throws(
      () => renderMailTemplate("auth.email-otp.sign-in", { otp: "000000" }),
      /Set PUBLIC_WEB_BASE_URL or pass variables\.baseUrl/,
    );
  });
});

describe("renderMailTemplate locale variants", () => {
  test("defaults to the English template when no locale is given", () => {
    const rendered = renderMailTemplate("auth.verify-email", { url });
    assert.equal(rendered.subject, "Verify your SourceWeft email");
    assert.match(rendered.html, /<html lang="en">/);
    assert.match(rendered.html, /Confirm your email address/);
  });

  test("selects the zh-CN variant and marks the document language", () => {
    const rendered = renderMailTemplate("auth.verify-email", { url }, "zh-CN");
    assert.equal(rendered.subject, "验证你的 SourceWeft 邮箱");
    assert.match(rendered.html, /<html lang="zh-CN">/);
    assert.match(rendered.html, /确认你的邮箱地址/);
    // Placeholders and links survive interpolation.
    assert.ok(rendered.html.includes(url));
  });

  test("selects the zh-TW (Traditional) variant", () => {
    const rendered = renderMailTemplate("auth.verify-email", { url }, "zh-TW");
    assert.equal(rendered.subject, "驗證你的 SourceWeft 郵箱");
    assert.match(rendered.html, /<html lang="zh-TW">/);
    assert.match(rendered.html, /確認你的郵箱地址/);
  });

  test("falls back to English for an unsupported locale", () => {
    const rendered = renderMailTemplate("auth.verify-email", { url }, "ja");
    assert.equal(rendered.subject, "Verify your SourceWeft email");
    assert.match(rendered.html, /<html lang="en">/);
  });

  test("falls back to the English body when a template has no variant", () => {
    // ops.alert is intentionally English-only (internal); requesting zh-CN must
    // render the English copy and mark the document as English, not throw.
    const rendered = renderMailTemplate(
      "ops.alert",
      {
        levelUpper: "CRITICAL",
        level: "critical",
        source: "worker",
        title: "Queue stalled",
        alertKey: "queue.stalled",
        teamLabel: "platform",
        triggerCount: 3,
        message: "Investigate the worker queue.",
      },
      "zh-CN",
    );
    assert.match(rendered.html, /<html lang="en">/);
    assert.match(rendered.html, /Queue stalled/);
  });
});
