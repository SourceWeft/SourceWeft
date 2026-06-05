declare module "dom-to-pptx" {
  export type DomToPptxFont = {
    name: string;
    url: string;
  };

  export type ExportToPptxOptions = {
    autoEmbedFonts?: boolean;
    fileName?: string;
    fonts?: DomToPptxFont[];
    height?: number;
    layout?: string;
    skipDownload?: boolean;
    svgAsVector?: boolean;
    width?: number;
  };

  export function exportToPptx(
    elements: HTMLElement[],
    options?: ExportToPptxOptions,
  ): Promise<Blob>;
}
