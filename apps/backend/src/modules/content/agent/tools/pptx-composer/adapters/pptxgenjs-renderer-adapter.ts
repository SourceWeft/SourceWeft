import pptxgen from "pptxgenjs";
import { resolveLayoutSpec } from "../domain/layout-system";
import { PresentationSourceV1Schema } from "../domain/schemas";
import type { LayoutSpec, PresentationSourceV1, SlideInstruction } from "../domain/schemas";
import { inspectOoxmlPptx } from "../inspection/ooxml-pptx-inspector";
import type { PptxRendererPort, PptxRenderResult } from "../ports";

type SlideSize = {
  h: number;
  w: number;
};

type RegionBox = {
  h: number;
  w: number;
  x: number;
  y: number;
};

const layoutByAspectRatio = {
  "16:9": "LAYOUT_WIDE",
  "16:10": "LAYOUT_16x10",
  "4:3": "LAYOUT_4x3",
} as const;

export class PptxGenJsRendererAdapter implements PptxRendererPort {
  async renderPresentation(input: Parameters<PptxRendererPort["renderPresentation"]>[0]): Promise<PptxRenderResult> {
    const source = PresentationSourceV1Schema.parse(input.source);
    const pptx = new pptxgen();
    pptx.layout = layoutByAspectRatio[source.designSystem.aspectRatio];
    pptx.author = "SourceWeft";
    pptx.company = "SourceWeft";
    pptx.subject = source.contentBrief.title;
    pptx.title = source.deckStrategy.deckTitle;
    pptx.theme = {
      headFontFace: source.designSystem.typography.family,
      bodyFontFace: source.designSystem.typography.family,
    };

    const warnings: string[] = [];
    for (const [index, slideInstruction] of source.slides.entries()) {
      warnings.push(...this.addSlide(pptx, source, slideInstruction, index, input.options?.includeSpeakerNotes === true));
    }

    const written = await pptx.write({ outputType: "nodebuffer", compression: true });
    if (!Buffer.isBuffer(written)) {
      throw new Error("PptxGenJS did not return a Node.js Buffer");
    }
    const inspection = inspectOoxmlPptx(written);

    return {
      pptxBuffer: written,
      metadata: {
        engine: "pptxgenjs-native",
        generatedAtIso: new Date().toISOString(),
        ...(input.options?.sourceHash ? { sourceHash: input.options.sourceHash } : {}),
        slideCount: source.slides.length,
        editableCompatibility: "native-v1",
        editablePrimitiveCountsBySlide: source.slides.map((slide, index) => ({
          slideId: slide.id,
          ...(inspection.slides[index]?.editablePrimitiveCounts ?? emptyEditablePrimitiveCounts()),
        })),
        warnings,
      },
    };
  }

  private addSlide(
    pptx: pptxgen,
    source: PresentationSourceV1,
    slideInstruction: SlideInstruction,
    slideIndex: number,
    includeSpeakerNotes: boolean,
  ) {
    const slide = pptx.addSlide();
    const size = slideSize(source);
    const palette = source.designSystem.palette;
    slide.background = { color: pptxColor(palette.background) };
    slide.addShape("rect", {
      objectName: `sw:chrome:${slideInstruction.id}:accent-rail`,
      x: 0,
      y: 0,
      w: Math.max(0.08, size.w * 0.012),
      h: size.h,
      fill: { color: pptxColor(palette.accent) },
      line: { color: pptxColor(palette.accent) },
    });

    const resolvedLayout = resolveLayoutSpec(slideInstruction.layoutSpec, { slideRole: slideInstruction.role });
    const resolvedSpec = resolvedLayout.spec;
    const warnings = resolvedLayout.issues.map((issue) => `${slideInstruction.id}:${issue.code}:${issue.message}`);
    const contentBySlot = contentSlotsForSlide(slideInstruction);

    for (const region of sortRegions(resolvedSpec)) {
      const content = contentBySlot.get(region.slot) ?? fallbackContentForSlot(slideInstruction, region.slot);
      if (!content) {
        continue;
      }
      this.addTextRegion({ slide, source, slideInstruction, slideIndex, region, size, text: content });
    }

    if (includeSpeakerNotes && slideInstruction.speakerNotes) {
      slide.addNotes(slideInstruction.speakerNotes);
    }
    return warnings;
  }

  private addTextRegion(input: {
    region: LayoutSpec["regions"][number];
    size: SlideSize;
    slide: pptxgen.Slide;
    slideIndex: number;
    slideInstruction: SlideInstruction;
    source: PresentationSourceV1;
    text: string;
  }) {
    const box = regionToInches(input.region, input.size);
    const palette = input.source.designSystem.palette;
    const isTitle = input.region.slot === "title";
    const isHeadline = input.region.slot === "headline";
    const isCard = /^column-|^step-|^checklist$|^proof-chips$/.test(input.region.slot);
    input.slide.addText(input.text, {
      objectName: `sw:content:${input.slideInstruction.id}:${input.region.slot}`,
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      fontFace: input.source.designSystem.typography.family,
      fontSize: fontSizeForRegion(input.source, input.region.slot, box),
      bold: isTitle || isHeadline,
      color: pptxColor(isHeadline ? palette.accent : palette.foreground),
      fit: "shrink",
      margin: isCard ? 0.12 : 0.02,
      breakLine: false,
      ...(isCard
        ? {
            fill: { color: pptxColor(palette.surface), transparency: 8 },
            line: { color: pptxColor(palette.accent), transparency: 35, width: 0.75 },
          }
        : {}),
    });
  }
}

function slideSize(source: PresentationSourceV1): SlideSize {
  if (source.designSystem.aspectRatio === "4:3") {
    return { w: 10, h: 7.5 };
  }
  if (source.designSystem.aspectRatio === "16:10") {
    return { w: 10, h: 6.25 };
  }
  return { w: 13.33, h: 7.5 };
}

function regionToInches(region: LayoutSpec["regions"][number], size: SlideSize): RegionBox {
  return {
    x: round(region.x * size.w),
    y: round(region.y * size.h),
    w: round(region.width * size.w),
    h: round(region.height * size.h),
  };
}

function sortRegions(spec: LayoutSpec) {
  return [...spec.regions].sort((left, right) => left.zIndex - right.zIndex || left.y - right.y || left.x - right.x);
}

function contentSlotsForSlide(slide: SlideInstruction) {
  const slots = new Map<string, string>();
  slots.set("title", slide.title);
  if (slide.headline) {
    slots.set("headline", slide.headline);
    slots.set("proof", slide.headline);
  }
  if (slide.body.length > 0) {
    slots.set("body", slide.body.join("\n"));
    slots.set("checklist", slide.body.map((item) => `• ${item}`).join("\n"));
    slots.set("proof-chips", slide.body.join("   "));
    slide.body.forEach((item, index) => {
      const numbered = `${index + 1}. ${item}`;
      slots.set(`column-${String.fromCharCode(97 + index)}`, item);
      slots.set(`card-${index + 1}`, item);
      slots.set(`step-${index + 1}`, numbered);
      slots.set(`option-${String.fromCharCode(97 + index)}`, item);
    });
  }
  if (slide.visualIntent) {
    slots.set("insight", slide.visualIntent);
    slots.set("quote", slide.visualIntent);
  }
  return slots;
}

function fallbackContentForSlot(slide: SlideInstruction, slot: string) {
  if (slot.includes("title")) {
    return slide.title;
  }
  if (slot.includes("headline") && slide.headline) {
    return slide.headline;
  }
  if ((slot.includes("body") || slot.includes("list")) && slide.body.length > 0) {
    return slide.body.join("\n");
  }
  return undefined;
}

function fontSizeForRegion(source: PresentationSourceV1, slot: string, box: RegionBox) {
  const scaleDelta = source.designSystem.typography.scale === "expressive" ? 4 : source.designSystem.typography.scale === "compact" ? -2 : 0;
  const area = box.w * box.h;
  if (slot === "title") {
    return Math.max(22, Math.min(38, area * 17 + scaleDelta));
  }
  if (slot === "headline") {
    return Math.max(18, Math.min(30, area * 15 + scaleDelta));
  }
  return Math.max(11, Math.min(18, area * 8 + 10 + scaleDelta));
}

function pptxColor(value: string) {
  return value.replace(/^#/, "").toUpperCase();
}

function round(value: number) {
  return Number(value.toFixed(3));
}

function emptyEditablePrimitiveCounts() {
  return { textBoxes: 0, shapes: 0, images: 0, tables: 0, charts: 0 };
}
