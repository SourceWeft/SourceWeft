import { ParserContentError } from "@sourceweft/builtin-document-parsers";
import {
  createYouTubeCatalogProvider,
  createYouTubeTranscriptProvider,
  DEFAULT_YOUTUBE_CATALOG_PROVIDER_ID,
  DEFAULT_YOUTUBE_TRANSCRIPT_PROVIDER_ID,
  YouTubeSourceParser,
  type VideoModelPort,
  type YouTubeCatalogProvider,
} from "@sourceweft/builtin-document-parsers/youtube";
import { ContentError } from "../../content/errors";
import type { ParseInput } from "../parsers/types";

let catalogProvider: YouTubeCatalogProvider | null = null;

/** The deployment's YouTube catalog provider, over the global `fetch`. */
export function getYouTubeCatalogProvider(): YouTubeCatalogProvider {
  catalogProvider ??= createYouTubeCatalogProvider(
    DEFAULT_YOUTUBE_CATALOG_PROVIDER_ID,
    { fetch: (input, init) => globalThis.fetch(input, init) },
  );
  return catalogProvider;
}

/**
 * The package parser with the backend's parse input (which carries the
 * billing port) and error type: a package `ParserContentError` (every
 * `YouTubeSourceError`) becomes a `ContentError` so the source failure keeps
 * its code; a `ContentError` raised by the billed model port already is one
 * and passes through.
 */
export class HostYouTubeSourceParser extends YouTubeSourceParser {
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

/**
 * A `youtube` source parser whose transcript provider runs on `port` — one
 * per parse job, since the port carries that job's payer and ledger key.
 */
export function createYouTubeSourceParser(
  port: VideoModelPort,
): HostYouTubeSourceParser {
  return new HostYouTubeSourceParser({
    catalog: getYouTubeCatalogProvider(),
    transcript: createYouTubeTranscriptProvider(
      DEFAULT_YOUTUBE_TRANSCRIPT_PROVIDER_ID,
      { model: port },
    ),
  });
}
