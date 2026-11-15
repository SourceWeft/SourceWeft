"use client";

import { AdminPage } from "../../_components/admin-page";
import { McpReviewQueue } from "../_components/mcp-review-queue";

export default function McpReviewPage() {
  return (
    <AdminPage>
      <McpReviewQueue />
    </AdminPage>
  );
}
