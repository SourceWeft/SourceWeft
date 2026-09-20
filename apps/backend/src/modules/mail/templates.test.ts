import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { renderMailTemplate } from "./templates";

const url = "https://app.sourceweft.test/verify?token=abc";

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
