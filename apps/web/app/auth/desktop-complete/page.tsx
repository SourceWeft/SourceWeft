import type { Metadata } from "next";

import { NO_INDEX_METADATA } from "../../seo";
import { DesktopAuthCompleteClient } from "./desktop-complete-client";

export const metadata: Metadata = NO_INDEX_METADATA;

export default function DesktopAuthCompletePage() {
  return <DesktopAuthCompleteClient />;
}
