/**
 * `?install=1` on a skill's dashboard page: the public market's install button
 * lands here after sign-in. A link must never install anything by itself — it
 * only opens the page's own confirmation, once, and then leaves the URL so a
 * refresh (or Back) does not ask again.
 */
export const INSTALL_INTENT_PARAM = "install";

type SearchParamsLike = { get(name: string): string | null; toString(): string };

export function hasInstallIntent(search: SearchParamsLike) {
  return search.get(INSTALL_INTENT_PARAM) === "1";
}

/** The same address without the install param; every other param and the hash survive. */
export function withoutInstallIntent(
  pathname: string,
  search: SearchParamsLike,
  hash = "",
) {
  const next = new URLSearchParams(search.toString());
  next.delete(INSTALL_INTENT_PARAM);
  const query = next.toString();
  return `${pathname}${query ? `?${query}` : ""}${hash}`;
}

export type InstallIntentAction =
  /** Nothing was asked for. */
  | "none"
  /** Asked, but the skill is not on screen (loading, not found, not visible): leave the URL alone. */
  | "wait"
  /** Ask the person, then drop the param. */
  | "prompt"
  /** Nothing to ask (already installed, or not installable): just drop the param. */
  | "strip";

export function resolveInstallIntent(input: {
  requested: boolean;
  loading: boolean;
  skill: { enabled: boolean; installable?: boolean } | null;
}): InstallIntentAction {
  if (!input.requested) return "none";
  // A missing skill keeps today's behaviour (the page's own error and Retry);
  // the param stays so a successful retry can still ask.
  if (input.loading || !input.skill) return "wait";
  if (input.skill.installable === false || input.skill.enabled) return "strip";
  return "prompt";
}
