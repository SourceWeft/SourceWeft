import type { Metadata } from "next";

import { NO_INDEX_METADATA } from "../seo";
import { JoinClient } from "./join-client";

export const metadata: Metadata = NO_INDEX_METADATA;

export default function JoinPage() {
  return <JoinClient />;
}
