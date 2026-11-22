/**
 * `youtube` source parser: catalog.getVideo → transcript.transcribe →
 * format → `buildParsedDocument`. The catalog/transcript providers are
 * injected so the backend can choose implementations (and swap the model
 * gateway-backed transcript provider in) without this package depending on
 * any backend concern.
 */
import { buildParsedDocument } from "../build-parsed-document";
import type { ParsedDocument, ParseInput, SourceParser } from "../types";
import type { YouTubeCatalogProvider } from "./catalog/types";
import { YouTubeSourceError } from "./errors";
import { formatYouTubeSourceMarkdown, YOUTUBE_SOURCE_MIME_TYPE } from "./format";
import type { YouTubeTranscriptProvider } from "./transcript/types";
import { canonicalVideoUrl, parseYouTubeUrl } from "./url";

export class YouTubeSourceParser implements SourceParser {
  readonly id = "youtube";
  readonly name = "YouTube Source Parser";
  readonly supportedMimeTypes = [YOUTUBE_SOURCE_MIME_TYPE] as const;

  constructor(
    private readonly deps: {
      catalog: YouTubeCatalogProvider;
      transcript: YouTubeTranscriptProvider;
    },
  ) {}

  async parse(input: ParseInput): Promise<ParsedDocument> {
    if (!input.sourceExternalUri) {
      throw new YouTubeSourceError(
        422,
        "YOUTUBE_URL_UNSUPPORTED",
        "A YouTube source URL is required",
      );
    }

    const target = parseYouTubeUrl(input.sourceExternalUri);
    if (!target || target.kind !== "video") {
      throw new YouTubeSourceError(
        422,
        "YOUTUBE_URL_UNSUPPORTED",
        `Unsupported YouTube URL: ${input.sourceExternalUri}`,
      );
    }

    const videoId = target.videoId;
    const videoUrl = canonicalVideoUrl(videoId);

    const video = await this.deps.catalog.getVideo(videoId);
    const transcript = await this.deps.transcript.transcribe({ videoId, videoUrl });

    const title = input.preferInputTitle === true ? input.fileName : video.title;
    // The `# heading` must read the same as the document title: when the
    // requested title wins, format against a video view with that title
    // rather than the catalog's.
    const content = formatYouTubeSourceMarkdown({
      video: title === video.title ? video : { ...video, title },
      transcript,
    });

    return buildParsedDocument({
      parseInput: {
        ...input,
        fileName: title,
        mimeType: YOUTUBE_SOURCE_MIME_TYPE,
        fileSize: Buffer.byteLength(content, "utf8"),
      },
      title,
      content,
      metadata: {
        parserId: this.id,
        videoId,
        catalogProvider: this.deps.catalog.id,
        transcriptProvider: this.deps.transcript.id,
        transcriptOrigin: transcript.origin,
        transcriptModel: transcript.model,
        transcriptLanguage: transcript.language,
        durationSeconds: transcript.durationSeconds,
        coverage: transcript.coverage,
        titleSource: video.titleSource,
        transcriptWarnings: transcript.warnings,
      },
    });
  }
}
