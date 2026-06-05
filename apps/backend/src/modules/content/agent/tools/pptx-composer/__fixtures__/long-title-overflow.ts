import type { PresentationSourceV1 } from "../domain/schemas";
import { basicProductOverviewFixture } from "./basic-product-overview";

const coverSlide = basicProductOverviewFixture.slides[0]!;
const detailSlide = basicProductOverviewFixture.slides[1]!;

export const longTitleOverflowFixture = {
  ...basicProductOverviewFixture,
  contentBrief: {
    ...basicProductOverviewFixture.contentBrief,
    title: "SourceWeft enterprise knowledge orchestration and grounded artifact production operating model",
    keyPoints: [
      "Stress fixture for titles that are valid but likely to overflow visual layouts",
      "Downstream QA should flag visual risk without rejecting schema-valid source",
    ],
  },
  deckStrategy: {
    ...basicProductOverviewFixture.deckStrategy,
    deckTitle: "SourceWeft enterprise knowledge orchestration and grounded artifact production operating model",
    slideCountTarget: 2,
  },
  slides: [
    {
      ...coverSlide,
      id: "slide-long-title-cover",
      title:
        "SourceWeft enterprise knowledge orchestration and grounded artifact production operating model for source-aware teams",
      headline: "A deliberately long headline fixture for downstream overflow QA",
    },
    {
      ...detailSlide,
      id: "slide-long-title-detail",
      title:
        "How knowledge, citations, skills, virtual files, governance, and artifact production converge in one workspace",
    },
  ],
  renderMetadata: {
    engine: "pptxgenjs-native",
    slideCount: 2,
    warnings: [],
  },
} satisfies PresentationSourceV1;
