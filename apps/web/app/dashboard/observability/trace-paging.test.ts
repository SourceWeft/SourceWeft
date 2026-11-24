import { expect, test } from "vitest";
import {
  FIRST_TRACE_PAGE,
  INITIAL_TRACE_PAGING,
  adjacentTracePage,
  settleTracePage,
} from "./trace-paging";

test("steps forward by cursor and back to the cursors already seen", () => {
  expect(adjacentTracePage(INITIAL_TRACE_PAGING, "previous")).toBeNull();
  expect(adjacentTracePage(INITIAL_TRACE_PAGING, "next")).toBeNull();

  let paging = settleTracePage(INITIAL_TRACE_PAGING, FIRST_TRACE_PAGE, "c1");
  const second = adjacentTracePage(paging, "next");
  expect(second).toEqual({ cursor: "c1", index: 1 });

  paging = settleTracePage(paging, second!, "c2");
  const third = adjacentTracePage(paging, "next");
  expect(third).toEqual({ cursor: "c2", index: 2 });

  paging = settleTracePage(paging, third!, null);
  expect(paging.index).toBe(2);
  expect(adjacentTracePage(paging, "next")).toBeNull();
  expect(adjacentTracePage(paging, "previous")).toEqual({
    cursor: "c1",
    index: 1,
  });

  paging = settleTracePage(paging, { cursor: "c1", index: 1 }, "c2");
  expect(adjacentTracePage(paging, "previous")).toEqual(FIRST_TRACE_PAGE);
  expect(adjacentTracePage(paging, "next")).toEqual({ cursor: "c2", index: 2 });
});

test("going back to the first page forgets later cursors", () => {
  let paging = settleTracePage(INITIAL_TRACE_PAGING, FIRST_TRACE_PAGE, "c1");
  paging = settleTracePage(paging, { cursor: "c1", index: 1 }, "c2");
  paging = settleTracePage(paging, FIRST_TRACE_PAGE, "fresh");
  expect(paging).toEqual({ cursors: [null], index: 0, nextCursor: "fresh" });
});
