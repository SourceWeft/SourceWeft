import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LocaleLink } from "./locale-link";

function hrefIn(locale: string, href: string) {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={{}}>
      <LocaleLink href={href}>x</LocaleLink>
    </NextIntlClientProvider>,
  );
  return /href="([^"]*)"/.exec(html)?.[1];
}

describe("LocaleLink", () => {
  it("keeps a zh visitor on zh pages", () => {
    expect(hrefIn("zh-CN", "/skills/deck-builder")).toBe(
      "/zh-CN/skills/deck-builder",
    );
    expect(hrefIn("zh-TW", "/mcp?category=search")).toBe(
      "/zh-TW/mcp?category=search",
    );
  });

  it("leaves English and app-tree links alone", () => {
    expect(hrefIn("en", "/skills/deck-builder")).toBe("/skills/deck-builder");
    expect(hrefIn("zh-CN", "/dashboard/skills/x")).toBe("/dashboard/skills/x");
  });
});
