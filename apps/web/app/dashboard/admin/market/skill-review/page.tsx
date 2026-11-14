"use client";

import { AdminPage } from "../../_components/admin-page";
import { SkillReviewQueue } from "../_components/skill-review-queue";

export default function SkillReviewPage() {
  return (
    <AdminPage>
      <SkillReviewQueue />
      <SkillReviewQueue queue="listing" />
    </AdminPage>
  );
}
