/** Marks the latest user message, the turn a streaming reply belongs to. */
export const LATEST_USER_TURN_ATTRIBUTE = "data-latest-user-turn";

/** Space kept above a pinned user message. */
const PINNED_USER_TURN_GAP_PX = 16;

type ScrollElements = {
  contentElement: Pick<HTMLElement, "querySelector">;
  scrollElement: Pick<HTMLElement, "getBoundingClientRect" | "scrollTop">;
};

/**
 * The scroll position a streaming reply follows: the bottom, but no further
 * than the latest user message reaching the top of the view, so a long reply
 * never scrolls the message it answers out of sight.
 */
export function pinnedUserTurnScrollTop(
  bottomScrollTop: number,
  { contentElement, scrollElement }: ScrollElements,
) {
  const anchor = contentElement.querySelector(
    `[${LATEST_USER_TURN_ATTRIBUTE}]`,
  );
  if (!anchor) {
    return bottomScrollTop;
  }
  const anchorTop =
    anchor.getBoundingClientRect().top -
    scrollElement.getBoundingClientRect().top +
    scrollElement.scrollTop -
    PINNED_USER_TURN_GAP_PX;
  return Math.min(bottomScrollTop, Math.max(0, anchorTop));
}
