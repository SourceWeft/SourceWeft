import { expect, test } from "vitest";
import { researchRunSchema } from "@sourceweft/contracts/source-research";
import { toResearchRun } from "./mapper";
import type { ResearchRunRow } from "./repository";

/** A full stored row; overrides stand in for whatever a test exercises. */
function row(overrides: Partial<ResearchRunRow> = {}): ResearchRunRow {
  return {
    id: "run-1",
    teamId: "org-1",
    workspaceId: "ws-1",
    createdByUserId: "user",
    topic: "Solid-state batteries",
    status: "queued",
    phase: null,
    progressJson: { round: 0, searches: 0, pagesRead: 0, modelCalls: 0 },
    planJson: null,
    ledgerJson: [],
    reportMarkdown: null,
    reportCitationsJson: null,
    modelCalls: 0,
    errorCode: null,
    cancelRequestedAt: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date("2026-11-22T00:00:00.000Z"),
    updatedAt: new Date("2026-11-22T00:00:00.000Z"),
    ...overrides,
  };
}

test("a run with no phase yet maps onto the schema as planning", () => {
  const parsed = researchRunSchema.parse(toResearchRun(row()));
  expect(parsed.phase).toBe("planning");
  expect(parsed.citations).toEqual([]);
  expect(parsed.plan).toBeNull();
  expect(parsed.finishedAt).toBeNull();
});

test("a failed run keeps its error code and maps onto the schema", () => {
  const parsed = researchRunSchema.parse(
    toResearchRun(
      row({
        status: "failed",
        phase: "searching",
        errorCode: "MODEL_UNAVAILABLE",
        finishedAt: new Date("2026-11-22T00:05:00.000Z"),
      }),
    ),
  );
  expect(parsed.status).toBe("failed");
  expect(parsed.errorCode).toBe("MODEL_UNAVAILABLE");
  expect(parsed.finishedAt).toBe("2026-11-22T00:05:00.000Z");
});

test("a cancelled run maps onto the schema with sources derived from the ledger", () => {
  const parsed = researchRunSchema.parse(
    toResearchRun(
      row({
        status: "cancelled",
        phase: "reading",
        finishedAt: new Date("2026-11-22T00:03:00.000Z"),
        ledgerJson: [
          {
            id: "e1",
            url: "https://example.com/a",
            title: "A",
            points: [],
            quotes: [],
          },
        ],
      }),
    ),
  );
  expect(parsed.status).toBe("cancelled");
  expect(parsed.errorCode).toBeNull();
  expect(parsed.sources).toEqual([
    { url: "https://example.com/a", title: "A", entryId: "e1" },
  ]);
});
