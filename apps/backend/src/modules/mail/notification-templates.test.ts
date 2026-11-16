import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { describe, test } from "vitest";
import { NOTIFICATION_KINDS } from "../notifications/kinds";
import { renderMailTemplate } from "./templates";

const ids = readdirSync(new URL("./templates/", import.meta.url))
  .filter(
    (name) =>
      name.startsWith("notification.") &&
      name.endsWith(".html") &&
      !/\.zh-(CN|TW)\.html$/.test(name),
  )
  .map((name) => name.replace(/\.html$/, ""));

const variables = {
  baseUrl: "https://app.sourceweft.test",
  url: "https://app.sourceweft.test/dashboard/scheduled/abc?x=1&y=2",
  taskName: 'Weekly <b>digest</b> & "notes"',
};

describe("notification mail templates", () => {
  test("every emailable notification kind has a template in all three locales", () => {
    const wanted = Object.values(NOTIFICATION_KINDS)
      .map((kind): string | null => kind.template)
      .filter((template): template is string => template !== null);
    assert.deepEqual([...wanted].sort(), [...ids].sort());
    for (const id of ids) {
      for (const locale of ["zh-CN", "zh-TW"]) {
        assert.ok(
          readdirSync(new URL("./templates/", import.meta.url)).includes(
            `${id}.${locale}.html`,
          ),
          `${id} is missing its ${locale} variant`,
        );
      }
    }
  });

  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    for (const id of ids) {
      test(`${id} renders in ${locale} with the task name and link only`, () => {
        const rendered = renderMailTemplate(id, variables, locale);
        assert.doesNotMatch(rendered.html, /\{\{|<b>digest/);
        assert.match(rendered.html, new RegExp(`<html lang="${locale}">`));
        assert.ok(rendered.subject.includes("Weekly <b>digest</b>"));
        assert.ok(rendered.text.includes(variables.url));
        assert.match(rendered.html, /class="button"[^>]*style=/);
        assert.doesNotMatch(rendered.text, /<table|<p /);
      });
    }
  }

  test("zh-TW copy is Traditional and follows the project glossary", () => {
    for (const id of ids) {
      const rendered = renderMailTemplate(id, variables, "zh-TW");
      assert.doesNotMatch(rendered.html, /[运执户错览导]|定时/);
      assert.match(rendered.html, /排程任務|排程/);
    }
  });
});
