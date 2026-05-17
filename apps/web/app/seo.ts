export const SITE_NAME = "SourceWeft";
export const SITE_URL = "https://sourceweft.com";
export const DEFAULT_TITLE = "SourceWeft - AI Notebook Workspace";
export const DEFAULT_DESCRIPTION =
  "SourceWeft is an AI notebook workspace for connected knowledge sources. Upload documents, connect your tools, and generate source-grounded answers, citations, study guides, FAQs, and audio overviews.";

export const OG_IMAGE = {
  alt: "SourceWeft - AI notebook workspace for connected knowledge sources",
  height: 630,
  url: "/logo-white-bg.svg",
  width: 1200,
} as const;

export const NO_INDEX_METADATA = {
  robots: {
    follow: false,
    index: false,
  },
} as const;
