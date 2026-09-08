import {
  anydocMimeTypes,
  imageMimeTypes,
} from "@sourceweft/builtin-document-parsers";
import type { ParsedDocument, ParseInput, SourceParser } from "./types";
import { startDocumentParse } from "./providers/document-parse-orchestrator";

export class AsyncProviderPendingError extends Error {
  constructor() {
    super("Document parse provider returned an async pending result");
    this.name = "AsyncProviderPendingError";
  }
}

export class DocumentProviderParser implements SourceParser {
  readonly id = "pdf";
  readonly name = "Document Provider Parser";
  readonly supportedMimeTypes: readonly string[] = Array.from(
    new Set(["application/pdf", ...imageMimeTypes, ...anydocMimeTypes]),
  );

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
