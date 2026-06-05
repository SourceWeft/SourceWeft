import { basicProductOverviewFixture } from "./basic-product-overview";

const coverSlide = basicProductOverviewFixture.slides[0]!;

export const invalidLayoutSpecFixture = {
  ...basicProductOverviewFixture,
  slides: [
    {
      ...coverSlide,
      layoutSpec: {
        ...coverSlide.layoutSpec,
        regions: [
          {
            id: "invalid-region",
            slot: "title",
            x: 1.2,
            y: 0.12,
            width: 0.7,
            height: 0.18,
            zIndex: 1,
          },
        ],
      },
    },
  ],
  renderMetadata: {
    engine: "pptxgenjs-native",
    slideCount: 1,
    warnings: [],
  },
};
