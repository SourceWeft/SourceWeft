import SrtParser from "srt-parser-2";
import { buildParsedDocument } from "./build-parsed-document";
import type { SourceParser } from "./types";

export const srtSourceParser: SourceParser = {
  id: "srt",
  name: "SRT Parser",
  supportedMimeTypes: ["application/x-subrip", "text/srt", "application/srt"],
  async parse(input) {
    // Preserve the previous wrapper's exact text extraction: caption order,
    // inline markup and line breaks remain; cue IDs/timestamps are not indexed.
    const content = new SrtParser()
      .fromSrt(input.content.toString("utf8"))
      .map((cue) => cue.text)
      .filter(Boolean)
      .join(" ");
    return buildParsedDocument({ parseInput: input, content });
  },
};
