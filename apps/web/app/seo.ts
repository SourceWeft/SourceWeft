import { publicWebBaseUrl } from "../lib/public-runtime-config";

export const SITE_NAME = "SourceWeft";
export const SITE_URL = publicWebBaseUrl();
export const DEFAULT_TITLE =
  "SourceWeft - AI Workspace | Built to get work done";
export const DEFAULT_DESCRIPTION =
  "Bring your knowledge, files, and tools together in SourceWeft. Let AI agents research, plan, and create, then review and refine the results in one workspace.";

export const OG_IMAGE = {
  alt: "SourceWeft - Your AI workspace. Built to get work done.",
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
