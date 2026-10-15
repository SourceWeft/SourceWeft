import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { afterEach, describe, test, vi } from "vitest";

import { renderMailTemplate } from "./templates";

const url = "https://app.sourceweft.test/verify?token=abc";

afterEach(() => vi.unstubAllEnvs());

describe("production mail base URL", () => {
  test("trusted per-message URL overrides deployment URL for email links", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_WEB_BASE_URL", "https://deployment.sourceweft.test");
    vi.stubEnv("NEXT_PUBLIC_WEB_BASE_URL", "https://legacy.sourceweft.test");

    const rendered = renderMailTemplate("auth.email-otp.sign-in", {
      baseUrl: "https://tenant.sourceweft.test/",
      otp: "000000",
    });

    assert.match(
      rendered.html,
      /https:\/\/tenant\.sourceweft\.test\/icon-512\.png/,
    );
    assert.match(rendered.html, /href="https:\/\/tenant\.sourceweft\.test"/);
    assert.doesNotMatch(rendered.html, /deployment\.sourceweft\.test/);
    assert.doesNotMatch(rendered.html, /legacy\.sourceweft\.test/);
  });

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

describe("user mail usability", () => {
  const ids = readdirSync(new URL("./templates/", import.meta.url))
    .filter(
      (name) =>
        /^(auth|org|workspace)\./.test(name) &&
        name.endsWith(".html") &&
        !/\.zh-(CN|TW)\.html$/.test(name),
    )
    .map((name) => name.replace(/\.html$/, ""));
  const variables = {
    baseUrl: "https://app.sourceweft.test",
    url: "https://app.sourceweft.test/action?token=abc&next=dashboard",
    dashboardUrl: "https://app.sourceweft.test/dashboard",
    otp: "012345",
    inviterLabel: '<img src=x onerror="alert(1)">',
    organizationName: "Research & Design",
    workspaceName: "Research & Design",
    greeting: "Hello <Alice>",
  };

  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    for (const id of ids) {
      test(`${id} is usable in ${locale} HTML and plain text`, () => {
        const rendered = renderMailTemplate(id, variables, locale);
        assert.match(rendered.subject, /SourceWeft/);
        assert.doesNotMatch(rendered.html, /\{\{|<img src=x/);
        assert.doesNotMatch(rendered.text, /\{\{|<table|<p /);
        assert.match(rendered.html, /role="presentation"/);
        assert.ok(
          rendered.text.includes("Research & Design") || id.startsWith("auth."),
        );
        if (id.includes("otp")) {
          assert.match(rendered.html, />\s*012345\s*<\/p>/);
          assert.match(rendered.text, /012345/);
          assert.doesNotMatch(rendered.html, /class="button"/);
          assert.match(
            rendered.text,
            /don’t share|请勿与他人分享|請勿與他人分享/,
          );
        } else {
          const target =
            id === "auth.welcome" ? variables.dashboardUrl : variables.url;
          assert.ok(rendered.text.includes(target));
          assert.match(
            rendered.html,
            /Button not working|按钮无法打开|按鈕無法開啟/,
          );
          assert.match(rendered.html, /class="button"[^>]*style=/);
        }
      });
    }
  }

  test("optional welcome content does not render empty greetings or links", () => {
    const rendered = renderMailTemplate("auth.welcome", {
      baseUrl: variables.baseUrl,
      dashboardUrl: variables.dashboardUrl,
    });
    assert.doesNotMatch(rendered.html, /href=""|\{\{/);
    assert.doesNotMatch(rendered.text, /Virtual FS|Skills|NotebookLM/);
    assert.match(rendered.text, /Add a source/);
    assert.match(rendered.text, /Ask a question/);
    assert.match(rendered.text, /Check the citations/);
  });
});
