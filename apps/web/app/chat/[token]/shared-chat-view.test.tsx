import assert from "node:assert/strict";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { test } from "vitest";
import type { PublicSharedChat } from "@sourceweft/contracts";
import {
  AS_OF_DATE_OPTIONS,
  SharedChatUnavailable,
  SharedChatView,
} from "./shared-chat-view";
import { formatDisplayDate } from "../../../lib/i18n/format";
import messages from "../../../messages/en.json";

const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];

function render(node: ReactNode, locale = "en") {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={intlMessages}
      timeZone="UTC"
      onError={(error) => {
        throw error;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

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

/** Whether some `<a>` element's text includes `text` (ignoring nesting). */
function anchorContains(html: string, text: string) {
  return new RegExp(`<a\\b[^>]*>(?:(?!</a>)[\\s\\S])*?${text}`).test(html);
}

test("renders the title, the as-of line and role labels including a custom assistant name", () => {
  const html = render(
    createElement(SharedChatView, {
      chat: chat({
        title: "Trip planning",
        assistantName: "Scout",
        messages: [
          message({ role: "user", content: "Where should I go?" }),
          message({ role: "assistant", content: "Try Kyoto." }),
        ],
      }),
    }),
  );

  assert.ok(html.includes("Trip planning"));
  const asOf = formatDisplayDate(
    new Date("2026-11-20T10:30:00.000Z"),
    "en",
    AS_OF_DATE_OPTIONS,
  );
  assert.ok(html.includes("Shared on SourceWeft"));
  assert.ok(html.includes(asOf));
  assert.ok(html.includes("Where should I go?"));
  assert.ok(html.includes(">User<"));
  assert.ok(html.includes(">Scout<"));
  assert.ok(!html.includes(">Assistant<"));
});

test("falls back to the translated Assistant label when no assistantName is set", () => {
  const html = render(
    createElement(SharedChatView, {
      chat: chat({
        assistantName: null,
        messages: [message({ role: "assistant", content: "Hi." })],
      }),
    }),
  );
  assert.ok(html.includes(">Assistant<"));
});

test("a web footnote links with rel=nofollow noopener; a private footnote is title-only text", () => {
  const html = render(
    createElement(SharedChatView, {
      chat: chat({
        messages: [
          message({
            role: "assistant",
            content: "See the sources below.",
            citations: [
              {
                n: 1,
                title: "Web source",
                url: "https://example.com/r",
              },
              { n: 2, title: "Private source", url: null },
            ],
          }),
        ],
      }),
    }),
  );

  assert.ok(
    html.includes('<a href="https://example.com/r" rel="nofollow noopener"'),
  );
  assert.ok(anchorContains(html, "Web source"));
  assert.ok(html.includes("Private source"));
  assert.ok(!anchorContains(html, "Private source"));
});

test("an artifact card with a publicUrl is a link; one without is plain text", () => {
  const html = render(
    createElement(SharedChatView, {
      chat: chat({
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
    }),
  );

  assert.ok(anchorContains(html, "Public report"));
  assert.ok(html.includes("Private table"));
  assert.ok(!anchorContains(html, "Private table"));
});

test("a stopped answer shows the Stopped label", () => {
  const html = render(
    createElement(SharedChatView, {
      chat: chat({
        messages: [
          message({
            role: "assistant",
            content: "I was interrupted",
            stopped: true,
          }),
        ],
      }),
    }),
  );
  assert.ok(html.includes("Stopped"));
});

test("an image whose URL is already in the content is not rendered again", () => {
  const html = render(
    createElement(SharedChatView, {
      chat: chat({
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

test("hostile message content never produces a script tag, an onerror handler or a javascript: link", () => {
  const html = render(
    createElement(SharedChatView, {
      chat: chat({
        messages: [
          message({
            role: "assistant",
            content:
              '<script>alert(1)</script><img src=x onerror="alert(1)"> [x](javascript:alert(1))',
          }),
        ],
      }),
    }),
  );

  assert.ok(!/<script/i.test(html));
  assert.ok(!/onerror/i.test(html));
  assert.ok(!/href="javascript:/i.test(html));
});

test("the unavailable view shows its message", () => {
  const html = render(createElement(SharedChatUnavailable, {}));
  // renderToStaticMarkup escapes the apostrophe as a numeric entity.
  assert.ok(html.includes("This share isn&#x27;t available"));
});
