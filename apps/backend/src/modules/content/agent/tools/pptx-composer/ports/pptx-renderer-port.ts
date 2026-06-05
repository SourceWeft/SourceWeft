import type { PresentationSourceV1, RenderMetadata } from "../domain/schemas";

export type PptxRenderOptions = {
  readonly includeSpeakerNotes?: boolean;
  readonly locale?: string;
  readonly sourceHash?: string;
};

export type PptxRenderResult = {
  readonly pptxBuffer: Buffer;
  readonly metadata: RenderMetadata;
};

export type PptxRendererPort = {
  renderPresentation(input: {
    source: PresentationSourceV1;
    options?: PptxRenderOptions;
  }): Promise<PptxRenderResult>;
};
