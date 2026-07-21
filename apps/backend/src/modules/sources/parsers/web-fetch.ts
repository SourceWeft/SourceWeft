import {
  ParserContentError,
  WebFetchSourceParser as PackageWebFetchSourceParser,
  WEB_FETCH_SOURCE_MIME_TYPE,
} from "@sourceweft/builtin-document-parsers";
import { createDefaultWebProvider } from "../web-provider";
import { ContentError } from "../../content/errors";
import type { ParseInput } from "./types";

const WEB_FETCH_SOURCE_TIMEOUT_MS = 60_000;

/**
 * Source ingestion gets a far longer fetch budget than a live turn does. The
 * budget is the host's call; which provider honours it is the capability's.
 */
function createWebFetchSourceProvider() {
  return createDefaultWebProvider({
    fetchTimeoutMs: WEB_FETCH_SOURCE_TIMEOUT_MS,
  });
}

export { WEB_FETCH_SOURCE_MIME_TYPE };
export { validatePublicHttpUrl } from "@sourceweft/builtin-document-parsers";

export class WebFetchSourceParser extends PackageWebFetchSourceParser {
  constructor(
    createProvider: ConstructorParameters<
      typeof PackageWebFetchSourceParser
    >[0] = createWebFetchSourceProvider,
  ) {
    super(createProvider);
  }

  override async parse(input: ParseInput) {
    try {
      return await super.parse(input);
    } catch (error) {
      if (error instanceof ParserContentError) {
        throw new ContentError(error.statusCode, error.code, error.message);
      }
      throw error;
    }
  }
}

export const webFetchSourceParser = new WebFetchSourceParser();
