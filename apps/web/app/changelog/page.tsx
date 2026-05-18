import type { Metadata } from "next";

import { ChangelogPage } from "./changelog-page";

export const metadata: Metadata = {
  title: "Changelog",
  description:
    "Product updates for SourceWeft, the AI notebook workspace for connected knowledge sources and source-grounded outputs.",
  alternates: {
    canonical: "https://sourceweft.com/changelog",
  },
};

export default function ChangelogRoute() {
  return <ChangelogPage />;
}
