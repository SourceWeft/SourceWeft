import { ParserContentError } from "../errors";

/**
 * Error thrown by YouTube source parsing/catalog code. Extends
 * `ParserContentError` with no behaviour changes, so the backend's existing
 * `instanceof ParserContentError` wrapper maps it to a `ContentError`
 * without needing any YouTube-specific handling.
 */
export class YouTubeSourceError extends ParserContentError {}
