import type { PresentationSourceV1 } from "../domain/schemas";
import { basicProductOverviewFixture } from "./basic-product-overview";

export const brandLowContrastFixture = {
  ...basicProductOverviewFixture,
  designSystem: {
    ...basicProductOverviewFixture.designSystem,
    name: "Low Contrast Brand Stress Fixture",
    palette: {
      background: "#F8FAFC",
      foreground: "#E2E8F0",
      accent: "#CBD5E1",
      muted: "#E5E7EB",
      surface: "#F1F5F9",
    },
    brandNotes: "Schema-valid colors that downstream contrast QA should reject or repair.",
  },
  contentBrief: {
    ...basicProductOverviewFixture.contentBrief,
    title: "Low Contrast Brand Stress Fixture",
  },
  deckStrategy: {
    ...basicProductOverviewFixture.deckStrategy,
    deckTitle: "Low Contrast Brand Stress Fixture",
  },
} satisfies PresentationSourceV1;
