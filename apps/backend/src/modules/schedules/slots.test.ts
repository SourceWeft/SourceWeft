import { describe, expect, it } from "vitest";
import { intervalSlot } from "./slots";

const MIN = 60_000;

describe("intervalSlot", () => {
  const due = new Date("2026-01-01T00:00:00Z");

  it("uses the due time itself when it has only just passed", () => {
    const slot = intervalSlot(due, 60, new Date(due.getTime() + 5 * MIN));
    expect(slot.scheduledFor).toEqual(due);
    expect(slot.nextDueAt).toEqual(new Date(due.getTime() + 60 * MIN));
  });

  it("coalesces a long outage into the newest elapsed slot", () => {
    const now = new Date(due.getTime() + 5 * 60 * MIN + 7 * MIN);
    const slot = intervalSlot(due, 60, now);
    expect(slot.scheduledFor).toEqual(new Date(due.getTime() + 5 * 60 * MIN));
    expect(slot.nextDueAt).toEqual(new Date(due.getTime() + 6 * 60 * MIN));
  });
});
