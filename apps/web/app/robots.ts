export const dynamic = "force-dynamic";
import type { MetadataRoute } from "next";
import { LOCALE_IDS } from "@sourceweft/i18n/locales";
import { addLocalePrefix } from "@sourceweft/i18n/resolve";

import { SITE_URL } from "./seo";

// Catalog search, filter, sort and tab permutations are noindex and endless:
// crawling them only spends the crawl the catalog pages need. Plain paging
// (`view`, `cursor`) stays crawlable, and the sitemap lists every page.
const CATALOG_ROOTS = ["/mcp", "/skills"];
const UNCRAWLED_CATALOG_PARAMS = [
  "q",
  "runtime",
  "sort",
  "tab",
  "trust",
  "type",
];

function catalogPermutations() {
  return LOCALE_IDS.flatMap((locale) =>
    CATALOG_ROOTS.flatMap((root) => {
      const base = addLocalePrefix(root, locale);
      return UNCRAWLED_CATALOG_PARAMS.flatMap((param) => [
        `${base}*?${param}=`,
        `${base}*&${param}=`,
      ]);
    }),
  );
}

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        allow: "/",
        disallow: [
          "/api/",
          "/auth/",
          "/dashboard/",
          "/join",
          "/organization/",
          "/settings/",
          ...catalogPermutations(),
          // React Server Component payloads (`?_rsc=`) are what client
          // navigation and link prefetch fetch; the HTML already carries the
          // first render's payload, so crawling them only spends crawl budget.
          "/*?_rsc=",
          "/*&_rsc=",
        ],
        userAgent: "*",
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
