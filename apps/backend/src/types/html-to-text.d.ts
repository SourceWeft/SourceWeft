declare module "html-to-text" {
  export type HtmlToTextOptions = {
    selectors?: Array<{
      format?: string;
      selector: string;
    }>;
    wordwrap?: false | number;
  };

  export function htmlToText(html: string, options?: HtmlToTextOptions): string;
}
