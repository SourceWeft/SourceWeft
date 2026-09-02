import type { Document } from "@langchain/core/documents";
import { chunkSourceContent } from "./chunker";
import { withTempFile } from "./file-buffer";
import { normalizeWhitespace, toWordCount } from "./text-utils";
import type {
  ParsedDocument,
  ParsedPage,
  ParseInput,
  SourceParser,
} from "./types";

type GenericLoader = {
  load(): Promise<Document[]>;
};

type LoaderParserOptions = {
  readonly id: string;
  readonly name: string;
  readonly supportedMimeTypes: readonly string[];
  readonly createLoader: (filePath: string, fileName?: string) => GenericLoader;
  readonly mapPages?: (input: {
    readonly docs: readonly Document[];
    readonly normalizeWhitespace: (value: string) => string;
  }) => ParsedPage[];
  readonly getPageCount?: (input: {
    readonly docs: readonly Document[];
    readonly pages: readonly ParsedPage[];
  }) => number;
};

function defaultMapPages(input: {
  readonly docs: readonly Document[];
  readonly normalizeWhitespace: (value: string) => string;
}) {
  const content = input.normalizeWhitespace(
    input.docs.map((doc) => doc.pageContent).join("\n\n"),
  );
  return content.length > 0 ? [{ pageNumber: 1, content }] : [];
}

class LoaderBackedParser implements SourceParser {
  readonly id: string;
  readonly name: string;
  readonly supportedMimeTypes: readonly string[];
  private readonly createLoaderFn: LoaderParserOptions["createLoader"];
  private readonly mapPagesFn: NonNullable<LoaderParserOptions["mapPages"]>;
  private readonly getPageCountFn: NonNullable<
    LoaderParserOptions["getPageCount"]
  >;

  constructor(options: LoaderParserOptions) {
    this.id = options.id;
    this.name = options.name;
    this.supportedMimeTypes = options.supportedMimeTypes;
    this.createLoaderFn = options.createLoader;
    this.mapPagesFn = options.mapPages ?? defaultMapPages;
    this.getPageCountFn =
      options.getPageCount ?? ((value) => value.pages.length);
  }

  async parse(input: ParseInput): Promise<ParsedDocument> {
    return withTempFile({
      fileName: input.fileName,
      content: input.content,
      run: async (filePath) => {
        const loader = this.createLoaderFn(filePath, input.fileName);
        const docs = await loader.load();
        const pages = this.mapPagesFn({
          docs,
          normalizeWhitespace,
        });
        const content = pages.map((page) => page.content).join("\n\n");
        const chunks = await chunkSourceContent(content, input.config);
        const pageCount = this.getPageCountFn({ docs, pages });
        return {
          title: input.fileName,
          content,
          metadata: {
            fileName: input.fileName,
            fileSize: input.fileSize,
            mimeType: input.mimeType,
            pageCount,
            wordCount: toWordCount(content),
            charCount: content.length,
            extractedAt: new Date().toISOString(),
          },
          pages,
          chunks,
        };
      },
    });
  }
}

export function createLoaderParser(options: LoaderParserOptions): SourceParser {
  return new LoaderBackedParser(options);
}
