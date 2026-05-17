import type { Metadata } from "next";

import { NO_INDEX_METADATA } from "../../seo";
import { ConsentClient } from "./consent-client";

export const metadata: Metadata = NO_INDEX_METADATA;

export default function ConsentPage() {
  return <ConsentClient />;
}
