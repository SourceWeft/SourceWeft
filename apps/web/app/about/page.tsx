import type { Metadata } from "next";

import { AboutPage } from "./about-page";

export const metadata: Metadata = {
  title: "About SourceWeft",
  description:
    "SourceWeft is an AI notebook workspace for source-grounded thinking, connected knowledge, citations, study guides, FAQs, and audio overviews.",
  alternates: {
    canonical: "https://sourceweft.com/about",
  },
};

export default function AboutRoute() {
  return <AboutPage />;
}
