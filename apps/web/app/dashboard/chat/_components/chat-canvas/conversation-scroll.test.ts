import assert from "node:assert/strict";
import { test } from "vitest";
import {
  LATEST_USER_TURN_ATTRIBUTE,
  pinnedUserTurnScrollTop,
} from "./conversation-scroll";

function elements(input: {
  anchorTop: number | null;
  scrollElementTop?: number;
  scrollTop: number;
}) {
  return {
    contentElement: {
      querySelector: (selector: string) => {
        assert.equal(selector, `[${LATEST_USER_TURN_ATTRIBUTE}]`);
        return input.anchorTop === null
          ? null
          : ({
              getBoundingClientRect: () => ({ top: input.anchorTop }),
            } as unknown as Element);
      },
    },
    scrollElement: {
      getBoundingClientRect: () =>
        ({ top: input.scrollElementTop ?? 0 }) as DOMRect,
      scrollTop: input.scrollTop,
    },
  };
}

test("a short reply follows the bottom", () => {
  // The user message sits 600px down the content; the bottom is only 200px.
  assert.equal(
    pinnedUserTurnScrollTop(200, elements({ anchorTop: 600, scrollTop: 0 })),
    200,
  );
});

test("a long reply stops once the user message reaches the top", () => {
  // Scrolled 300px, the message is 500px below the viewport top: 800px down
  // the content, pinned 16px below the top edge.
  assert.equal(
    pinnedUserTurnScrollTop(
      2000,
      elements({ anchorTop: 580, scrollElementTop: 80, scrollTop: 300 }),
    ),
    784,
  );
});

test("without a user message the bottom is followed", () => {
  assert.equal(
    pinnedUserTurnScrollTop(900, elements({ anchorTop: null, scrollTop: 0 })),
    900,
  );
});

test("a user message at the very top never pins above zero", () => {
  assert.equal(
    pinnedUserTurnScrollTop(900, elements({ anchorTop: 4, scrollTop: 0 })),
    0,
  );
});
