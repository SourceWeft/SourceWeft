// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import {
  completesEdgeSwipe,
  findSwipeBack,
  startsEdgeSwipe,
  SWIPE_BACK_ATTRIBUTE,
  useLeftEdgeSwipe,
} from "./left-edge-swipe";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = "";
});

test("only a touch at the left edge can start the swipe", () => {
  expect(startsEdgeSwipe(4)).toBe(true);
  expect(startsEdgeSwipe(24)).toBe(true);
  expect(startsEdgeSwipe(60)).toBe(false);
});

test("a mostly sideways move far enough to the right completes it", () => {
  const start = { x: 6, y: 300 };
  expect(completesEdgeSwipe(start, { x: 60, y: 310 })).toBe(true);
  expect(completesEdgeSwipe(start, { x: 30, y: 300 })).toBe(false);
  // A vertical scroll that drifts right is not a swipe.
  expect(completesEdgeSwipe(start, { x: 60, y: 400 })).toBe(false);
  expect(completesEdgeSwipe(start, { x: -40, y: 300 })).toBe(false);
});

function touch(type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true }) as Event & {
    touches: { clientX: number; clientY: number }[];
  };
  event.touches = type === "touchend" ? [] : [{ clientX: x, clientY: y }];
  return event;
}

async function renderSwipe(enabled: boolean, onSwipe: () => void) {
  function Area() {
    const ref = useRef<HTMLDivElement>(null);
    useLeftEdgeSwipe(ref, enabled, onSwipe);
    return <div data-area ref={ref} />;
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Area />));
  return container.querySelector("[data-area]")!;
}

test("a swipe from the edge opens once per touch", async () => {
  const onSwipe = vi.fn();
  const area = await renderSwipe(true, onSwipe);
  area.dispatchEvent(touch("touchstart", 5, 300));
  area.dispatchEvent(touch("touchmove", 50, 302));
  area.dispatchEvent(touch("touchmove", 90, 304));
  area.dispatchEvent(touch("touchend", 0, 0));
  expect(onSwipe).toHaveBeenCalledTimes(1);

  // A swipe that starts in the middle of the screen does nothing.
  area.dispatchEvent(touch("touchstart", 150, 300));
  area.dispatchEvent(touch("touchmove", 260, 300));
  expect(onSwipe).toHaveBeenCalledTimes(1);
});

test("nothing happens while it is turned off", async () => {
  const onSwipe = vi.fn();
  const area = await renderSwipe(false, onSwipe);
  area.dispatchEvent(touch("touchstart", 5, 300));
  area.dispatchEvent(touch("touchmove", 90, 300));
  expect(onSwipe).not.toHaveBeenCalled();
});

function backButton(name: string, shown: boolean) {
  const button = document.createElement("button");
  button.setAttribute(SWIPE_BACK_ATTRIBUTE, "");
  button.textContent = name;
  // jsdom lays nothing out; a shown element has a box, a hidden one has none.
  button.getClientRects = () => (shown ? [{}] : []) as unknown as DOMRectList;
  return button;
}

test("the swipe presses the page's back button that is on screen", () => {
  const page = document.createElement("div");
  expect(findSwipeBack(page)).toBeNull();

  // The desktop copy of the page is hidden on a phone; only the shown one counts.
  page.append(backButton("phone", true), backButton("desktop", false));
  expect(findSwipeBack(page)?.textContent).toBe("phone");

  // A panel opened on top of the page brings its own back button, which wins.
  page.append(backButton("panel", true));
  expect(findSwipeBack(page)?.textContent).toBe("panel");
});
