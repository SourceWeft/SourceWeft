import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, test, vi } from "vitest";
import type { PublicSharedChat } from "@sourceweft/contracts";

// `getTranslations`/`getFormatter` read the request-scoped config the Next
// plugin provides; a unit test has no request, so serve the real catalogs
// directly instead, the same way `app/auth/error/page.test.tsx` does.
// `localeRef` lets individual tests render as a different visitor locale.
const { localeRef } = vi.hoisted(() => ({ localeRef: { current: "en" } }));

vi.mock("next-intl/server", async () => {
  const { createFormatter, createTranslator } = await import("next-intl");
  const en = (await import("../../../messages/en.json")).default;
  const zhCN = (await import("../../../messages/zh-CN.json")).default;
  const catalogs: Record<string, unknown> = { en, "zh-CN": zhCN };
  return {
    getTranslations: async (
      input?: string | { locale?: string; namespace?: string },
    ) => {
      const namespace = typeof input === "string" ? input : input?.namespace;
      const locale =
        (typeof input === "object" && input?.locale) || localeRef.current;
      return createTranslator({
        locale,
        messages: catalogs[locale] as never,
        namespace: namespace as never,
      });
    },
    getFormatter: async () =>
      createFormatter({ locale: localeRef.current, timeZone: "UTC" }),
  };
});

import { createFormatter } from "next-intl";
import { renderFootnoteReferences } from "./shared-chat-markdown";
import {
  AS_OF_DATE_OPTIONS,
  SharedChatUnavailable,
  SharedChatView,
} from "./shared-chat-view";

afterEach(() => {
  localeRef.current = "en";
});

type SharedMessage = PublicSharedChat["messages"][number];

function message(overrides: Partial<SharedMessage> = {}): SharedMessage {
  return {
    role: "user",
    createdAt: "2026-11-20T10:00:00.000Z",
    content: "Hello there",
    stopped: false,
    citations: [],
    images: [],
    artifacts: [],
    ...overrides,
  };
}

function chat(overrides: Partial<PublicSharedChat> = {}): PublicSharedChat {
  return {
    title: "Trip planning",
    takenAt: "2026-11-20T10:30:00.000Z",
    assistantName: null,
    noindex: false,
    messages: [],
    ...overrides,
  };
}

async function render(sharedChat: PublicSharedChat) {
  const element = await SharedChatView({ chat: sharedChat });
  return renderToStaticMarkup(element);
}

async function renderUnavailable() {
  const element = await SharedChatUnavailable();
  return renderToStaticMarkup(element);
}

/** Whether some `<a>` element's text includes `text` (ignoring nesting). */
function anchorContains(html: string, text: string) {
  return new RegExp(`<a\\b[^>]*>(?:(?!</a>)[\\s\\S])*?${text}`).test(html);
}

test("renders the title, the as-of line and role labels including a custom assistant name", async () => {
  const html = await render(
    chat({
      title: "Trip planning",
      assistantName: "Scout",
      messages: [
        message({ role: "user", content: "Where should I go?" }),
        message({ role: "assistant", content: "Try Kyoto." }),
      ],
    }),
  );

  assert.ok(html.includes("Trip planning"));
  const asOf = createFormatter({ locale: "en", timeZone: "UTC" }).dateTime(
    new Date("2026-11-20T10:30:00.000Z"),
    AS_OF_DATE_OPTIONS,
  );
  assert.ok(html.includes("Shared on SourceWeft"));
  assert.ok(html.includes(asOf));
  assert.ok(html.includes("Where should I go?"));
  assert.ok(html.includes(">User<"));
  assert.ok(html.includes(">Scout<"));
  assert.ok(!html.includes(">Assistant<"));
});

test("falls back to the translated Assistant label when no assistantName is set", async () => {
  const html = await render(
    chat({
      assistantName: null,
      messages: [message({ role: "assistant", content: "Hi." })],
    }),
  );
  assert.ok(html.includes(">Assistant<"));
});

test("a web footnote links with rel=nofollow noopener noreferrer; a private footnote is title-only text", async () => {
  const html = await render(
    chat({
      messages: [
        message({
          role: "assistant",
          content: "See the sources below.",
          citations: [
            { n: 1, title: "Web source", url: "https://example.com/r" },
            { n: 2, title: "Private source", url: null },
          ],
        }),
      ],
    }),
  );

  assert.ok(
    html.includes(
      '<a href="https://example.com/r" rel="nofollow noopener noreferrer"',
    ),
  );
  assert.ok(anchorContains(html, "Web source"));
  assert.ok(html.includes("Private source"));
  assert.ok(!anchorContains(html, "Private source"));
});

test("an artifact card with a publicUrl is a link; one without is plain text", async () => {
  const html = await render(
    chat({
      messages: [
        message({
          role: "assistant",
          content: "I made two things.",
          artifacts: [
            {
              kind: "report",
              title: "Public report",
              publicUrl: "https://app.test/artifact/public-token",
            },
            { kind: "table", title: "Private table", publicUrl: null },
          ],
        }),
      ],
    }),
  );

  assert.ok(anchorContains(html, "Public report"));
  assert.ok(html.includes("Private table"));
  assert.ok(!anchorContains(html, "Private table"));
});

test("artifact card kind labels follow the visitor's locale, not just the identifier title-cased", async () => {
  localeRef.current = "zh-CN";
  const html = await render(
    chat({
      messages: [
        message({
          role: "assistant",
          content: "报告已生成。",
          artifacts: [{ kind: "report", title: "季度报告", publicUrl: null }],
        }),
      ],
    }),
  );
  assert.ok(html.includes("报告 · 季度报告"));
  assert.ok(!html.includes("Report ·"));
});

test("a stopped answer shows the Stopped label", async () => {
  const html = await render(
    chat({
      messages: [
        message({
          role: "assistant",
          content: "I was interrupted",
          stopped: true,
        }),
      ],
    }),
  );
  assert.ok(html.includes("Stopped"));
});

test("an image whose URL is already in the content is not rendered again", async () => {
  const html = await render(
    chat({
      messages: [
        message({
          role: "assistant",
          content: "![a picture](https://files.test/already.png)",
          images: [
            { name: "already.png", url: "https://files.test/already.png" },
            { name: "extra.png", url: "https://files.test/extra.png" },
          ],
        }),
      ],
    }),
  );

  // The markdown itself renders "already.png" inline; the view must not add
  // a second <img> for it, only for the one not already in the content.
  const imgTags = html.match(/<img[^>]*>/g) ?? [];
  assert.equal(imgTags.length, 2);
  const extraOccurrences = imgTags.filter((tag) =>
    tag.includes("https://files.test/extra.png"),
  );
  assert.equal(extraOccurrences.length, 1);
  const alreadyOccurrences = imgTags.filter((tag) =>
    tag.includes("https://files.test/already.png"),
  );
  assert.equal(alreadyOccurrences.length, 1);
});

test("hostile message content never produces a script tag, an onerror handler or a javascript: link", async () => {
  const html = await render(
    chat({
      messages: [
        message({
          role: "assistant",
          content:
            '<script>alert(1)</script><img src=x onerror="alert(1)"> [x](javascript:alert(1))',
        }),
      ],
    }),
  );

  assert.ok(!/<script/i.test(html));
  // Raw HTML is not parsed: the markup survives only as inert, escaped
  // text, so no element carries an onerror handler.
  assert.ok(!/<[a-z][^>]*\sonerror/i.test(html));
  assert.ok(html.includes("&lt;img src=x onerror="));
  assert.ok(!/href="javascript:/i.test(html));
});

test("footnote references inside inline code and fenced blocks stay literal", () => {
  assert.equal(
    renderFootnoteReferences(
      "A[^1] `x[^1]y`\n\n```\nliteral [^2]\n```\n\n~~~\n[^3]\n~~~ B[^3]",
    ),
    "A\\[1\\] `x[^1]y`\n\n```\nliteral [^2]\n```\n\n~~~\n[^3]\n~~~ B\\[3\\]",
  );
});

const OWN_IMAGE = "https://api.test/v1/public/shares/tok-1/chat/images/1";

test("footnote references render as bracketed numbers outside code", async () => {
  const html = await render(
    chat({
      messages: [
        message({
          role: "assistant",
          content:
            "See the report.[^1][^2] Inline `a[^1]b` stays.\n\n```\nliteral [^2]\n```",
          citations: [
            { n: 1, title: "Report", url: "https://example.com/r" },
            { n: 2, title: "Notes", url: null },
          ],
        }),
      ],
    }),
  );

  const withoutCode = html.replace(/<(code|pre)\b[\s\S]*?<\/\1>/g, "");
  assert.ok(!withoutCode.includes("[^"), withoutCode);
  assert.ok(withoutCode.includes("[1][2]"), withoutCode);
});

test("raw HTML is not parsed and images are limited to the share's own image URLs", async () => {
  const html = await render(
    chat({
      messages: [
        message({
          role: "assistant",
          content: [
            '<img src="https://evil.example/p.png">',
            "![tracker](https://evil.example/q.png)",
            `![own](${OWN_IMAGE})`,
          ].join("\n\n"),
          images: [{ name: "own.png", url: OWN_IMAGE }],
        }),
      ],
    }),
  );

  const imgTags = html.match(/<img[^>]*>/g) ?? [];
  assert.ok(
    imgTags.every((tag) => !tag.includes("evil.example")),
    imgTags.join("\n"),
  );
  assert.ok(!/<img[^>]*evil\.example/.test(html));
  assert.equal(
    imgTags.filter((tag) => tag.includes(OWN_IMAGE)).length,
    1,
    imgTags.join("\n"),
  );
});

test("the unavailable view shows its message", async () => {
  const html = await renderUnavailable();
  // renderToStaticMarkup escapes the apostrophe as a numeric entity.
  assert.ok(html.includes("This share isn&#x27;t available"));
});
