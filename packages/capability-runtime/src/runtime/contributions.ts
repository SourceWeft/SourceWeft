export function getContributionDisplayTitle(input: {
  readonly fallback: string;
  readonly title?: string;
}) {
  return input.title?.trim() || input.fallback;
}
