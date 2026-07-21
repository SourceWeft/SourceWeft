import { BaseSourceParser } from "@sourceweft/builtin-document-parsers";
import type { ParsedDocument, ParseInput } from "./types";
import { startDocumentParse } from "./providers/document-parse-orchestrator";

export class AsyncProviderPendingError extends Error {
  constructor() {
    super("Document parse provider returned an async pending result");
    this.name = "AsyncProviderPendingError";
  }
}

export class DocumentProviderParser extends BaseSourceParser {
  readonly id = "pdf";
  readonly name = "Document Provider Parser";
  readonly supportedMimeTypes = [
    "application/pdf",
    "image/avif",
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/tiff",
    "image/bmp",
    "image/gif",
  ] as const;

  async parse(input: ParseInput): Promise<ParsedDocument> {
    const outcome = await startDocumentParse({
      ...input,
      sourceId: "",
      teamId: "",
      workspaceId: "",
      userId: "",
    });

    if (outcome.kind === "pending") {
      throw new AsyncProviderPendingError();
    }

    return outcome.document;
  }
}

export const documentProviderParser = new DocumentProviderParser();
