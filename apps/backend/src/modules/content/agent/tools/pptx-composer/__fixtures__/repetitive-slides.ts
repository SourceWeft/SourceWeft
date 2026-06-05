import type { PresentationSourceV1 } from "../domain/schemas";
import { basicProductOverviewFixture } from "./basic-product-overview";

const repeatedSlide = basicProductOverviewFixture.slides[1]!;
const repeatedLayoutSpec = repeatedSlide.layoutSpec;

export const repetitiveSlidesFixture = {
  ...basicProductOverviewFixture,
  contentBrief: {
    ...basicProductOverviewFixture.contentBrief,
    title: "Repetitive Layout Stress Fixture",
    keyPoints: ["Repeated layouts are schema-valid", "Downstream diversity QA should score this fixture poorly"],
  },
  deckStrategy: {
    ...basicProductOverviewFixture.deckStrategy,
    deckTitle: "Repetitive Layout Stress Fixture",
    slideCountTarget: 5,
  },
  slides: [
    {
      ...repeatedSlide,
      id: "repeat-1",
      title: "Repeated structure one",
      layoutSpec: repeatedLayoutSpec,
    },
    {
      ...repeatedSlide,
      id: "repeat-2",
      title: "Repeated structure two",
      layoutSpec: repeatedLayoutSpec,
    },
    {
      ...repeatedSlide,
      id: "repeat-3",
      title: "Repeated structure three",
      layoutSpec: repeatedLayoutSpec,
    },
    {
      ...repeatedSlide,
      id: "repeat-4",
      title: "Repeated structure four",
      layoutSpec: repeatedLayoutSpec,
    },
    {
      ...repeatedSlide,
      id: "repeat-5",
      title: "Repeated structure five",
      layoutSpec: repeatedLayoutSpec,
    },
  ],
  renderMetadata: {
    engine: "pptxgenjs-native",
    slideCount: 5,
    warnings: [],
  },
} satisfies PresentationSourceV1;
