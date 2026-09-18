import { publicWebBaseUrl } from "../lib/public-runtime-config";

export const SITE_NAME = "SourceWeft";
export const SITE_URL = publicWebBaseUrl();
export const DEFAULT_TITLE = "SourceWeft - AI Notebook Workspace";
export const DEFAULT_DESCRIPTION =
  "SourceWeft is an AI notebook workspace for connected knowledge sources: upload documents, connect your tools, and get source-grounded answers with citations.";

export const OG_IMAGE = {
  alt: "SourceWeft - AI notebook workspace for connected knowledge sources",
  height: 630,
  url: "/og",
  width: 1200,
} as const;

// A listing page with fewer entries than this is thin content: it renders and
// stays usable, but is kept out of the index and out of the sitemap. Both
// decisions must read this one predicate so they can never disagree.
const MIN_INDEXABLE_LISTING_ENTRIES = 3;

export function isIndexableListing(entryCount: number) {
  return entryCount >= MIN_INDEXABLE_LISTING_ENTRIES;
}

export const NO_INDEX_METADATA = {
  robots: {
    follow: false,
    index: false,
  },
} as const;
