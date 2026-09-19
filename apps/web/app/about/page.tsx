import type { Metadata } from "next";

import { OG_IMAGE, SITE_NAME, SITE_URL } from "../seo";
import { AboutPage } from "./about-page";

const title = "About SourceWeft";
const description =
  "SourceWeft is an AI notebook workspace for source-grounded thinking, connected knowledge, citations, study guides, FAQs, and audio overviews.";
const canonicalUrl = `${SITE_URL}/about`;

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

export default function AboutRoute() {
  return <AboutPage />;
}
