export const DEFAULT_TOKENS_PER_STANDARD_PAGE = 1000;

export type IngestionPagesInput = {
  reportedPages?: number;
  parsedTokens?: number;
  minimumPages?: number;
  tokensPerStandardPage?: number;
};

export function tokensToStandardPages(
  tokens: number,
  tokensPerStandardPage = DEFAULT_TOKENS_PER_STANDARD_PAGE,
) {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return 0;
  }

  if (!Number.isFinite(tokensPerStandardPage) || tokensPerStandardPage <= 0) {
    throw new Error("tokensPerStandardPage must be a positive number");
  }

  return Math.ceil(tokens / tokensPerStandardPage);
}

export function resolveIngestionPages({
  reportedPages,
  parsedTokens,
  minimumPages = 1,
  tokensPerStandardPage = DEFAULT_TOKENS_PER_STANDARD_PAGE,
}: IngestionPagesInput) {
  const minPages =
    Number.isFinite(minimumPages) && minimumPages > 0
      ? Math.ceil(minimumPages)
      : 1;

  const directPages =
    Number.isFinite(reportedPages) && (reportedPages ?? 0) > 0
      ? Math.ceil(reportedPages ?? 0)
      : 0;

  const tokenPages =
    Number.isFinite(parsedTokens) && (parsedTokens ?? 0) > 0
      ? tokensToStandardPages(parsedTokens ?? 0, tokensPerStandardPage)
      : 0;

  return Math.max(minPages, directPages, tokenPages);
}
