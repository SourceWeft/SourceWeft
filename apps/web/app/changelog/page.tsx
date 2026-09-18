import type { Metadata } from "next";

import { loadChangelogEntries } from "../../lib/changelog";
import { OG_IMAGE, SITE_NAME, SITE_URL } from "../seo";
import { ChangelogPage } from "./changelog-page";

const title = "Changelog";
const description =
  "Product updates for SourceWeft, the AI notebook workspace for connected knowledge sources and source-grounded outputs.";
const canonicalUrl = `${SITE_URL}/changelog`;

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: canonicalUrl,
  },
  openGraph: {
    description,
    images: [OG_IMAGE],
    siteName: SITE_NAME,
    title,
    type: "website",
    url: canonicalUrl,
  },
  twitter: {
    card: "summary_large_image",
    description,
    images: [OG_IMAGE.url],
    title,
  },
};

export default function ChangelogRoute() {
  return <ChangelogPage entries={loadChangelogEntries()} />;
}
