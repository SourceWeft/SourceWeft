import { ParserContentError } from "./errors";

export function normalizeWhitespace(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .trim();
}

export function toWordCount(value: string) {
  const matches = value.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

export function assertTextLikeSourceContent(content: Buffer, fileName: string) {
  const sampleLength = Math.min(content.length, 8192);
  let nullBytes = 0;
  let controlBytes = 0;

  for (let index = 0; index < sampleLength; index += 1) {
    const byte = content[index] ?? 0;
    if (byte === 0) {
      nullBytes += 1;
    } else if (
      byte < 32 &&
      byte !== 9 &&
      byte !== 10 &&
      byte !== 12 &&
      byte !== 13
    ) {
      controlBytes += 1;
    }
  }

  if (
    nullBytes > 0 ||
    (sampleLength > 0 && controlBytes / sampleLength > 0.3)
  ) {
    throw new ParserContentError(
      400,
      "UNSUPPORTED_SOURCE_TYPE",
      `File '${fileName}' appears to be binary and cannot be parsed as text`,
    );
  }
}
