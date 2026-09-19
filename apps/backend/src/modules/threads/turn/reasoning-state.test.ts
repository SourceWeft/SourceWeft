import { describe, expect, it } from "vitest";
import {
  beginReasoningRun,
  canApplyReasoningWrite,
  projectReasoning,
  projectSnapshotReasoning,
} from "./reasoning-state";
import { preserveTraceMetadata } from "./trace-metadata";

describe("reasoning ownership", () => {
  it("replaces growing resume snapshots without losing pre-approval reasoning", () => {
    const first = projectReasoning({
      run: beginReasoningRun({ runId: "first", continuation: false }),
      text: "before approval",
      terminal: true,
    });
    const run = beginReasoningRun({
      runId: "resume",
      continuation: true,
      metadata: first,
    });
    let saved: Record<string, unknown> = first;
    let text = "";
    // Reproduce hundreds of writes containing the same completed reasoning segment.
    const completedSegment = "completed tool reasoning".repeat(1000);
    for (let revision = 1; revision <= 738; revision++) {
      text = completedSegment + "x".repeat(revision);
      const next = projectReasoning({ run, text, revision });
      expect(canApplyReasoningWrite(saved, next)).toBe(true);
      saved = preserveTraceMetadata({
        existingMetadata: saved,
        nextMetadata: next,
      });
      expect(saved.reasoning).toBe(`before approval\n${text}`);
      expect(
        preserveTraceMetadata({ existingMetadata: saved, nextMetadata: next }),
      ).toEqual(saved);
    }
    expect((saved.reasoning as string).length).toBe(
      "before approval\n".length + text.length,
    );
  });

  it("keeps the base across retries, terminal retries, and multiple resumes", () => {
    const first = beginReasoningRun({ runId: "first", continuation: false });
    let saved = projectReasoning({ run: first, text: "A", terminal: true });
    for (const [id, text] of [
      ["second", "B"],
      ["third", "C"],
    ]) {
      const run = beginReasoningRun({
        runId: id!,
        continuation: true,
        metadata: saved,
      });
      const partial = projectReasoning({ run, text: text!, revision: 1 });
      const restored = beginReasoningRun({
        runId: id!,
        continuation: true,
        metadata: partial,
        restored: JSON.parse(JSON.stringify(run)),
      });
      expect(restored).toEqual(run);
      expect(
        beginReasoningRun({
          runId: id!,
          continuation: true,
          metadata: partial,
        }),
      ).toEqual(run);
      saved = projectReasoning({ run: restored, text: text!, terminal: true });
      expect(canApplyReasoningWrite(saved, saved)).toBe(true);
    }
    expect(saved.reasoning).toBe("A\nB\nC");
  });

  it("preserves legitimate repeated text and whitespace, including no reasoning", () => {
    const run = beginReasoningRun({
      runId: "r",
      continuation: true,
      metadata: { reasoning: "same " },
    });
    expect(projectReasoning({ run, text: "same " }).reasoning).toBe(
      "same \nsame ",
    );
    expect(projectReasoning({ run, text: undefined }).reasoning).toBe("same ");
    expect(projectReasoning({ run, text: "" }).reasoning).toBe("same ");
    expect(
      projectReasoning({
        run: beginReasoningRun({
          runId: "edit",
          continuation: false,
          metadata: { reasoning: "old version" },
        }),
        text: "new version",
      }).reasoning,
    ).toBe("new version");
  });

  it("rejects missing or mismatched ownership instead of inferring a base", () => {
    expect(() => projectSnapshotReasoning({ reasoning: "unowned" })).toThrow(
      "Reasoning run state",
    );
    expect(() =>
      beginReasoningRun({
        runId: "r2",
        continuation: true,
        restored: { runId: "r1", base: "", parentRunId: null },
      }),
    ).toThrow("Reasoning run state");
  });

  it("blocks old revisions and old runs, even after a new run has started", () => {
    const run = beginReasoningRun({ runId: "r1", continuation: false });
    const latest = projectReasoning({ run, text: "AB", revision: 2 });
    expect(
      canApplyReasoningWrite(
        latest,
        projectReasoning({ run, text: "A", revision: 1 }),
      ),
    ).toBe(false);
    const terminal = projectReasoning({ run, text: "ABC", terminal: true });
    expect(canApplyReasoningWrite(terminal, latest)).toBe(false);
    const resumed = projectReasoning({
      run: beginReasoningRun({
        runId: "r2",
        continuation: true,
        metadata: terminal,
      }),
      text: "D",
      revision: 1,
    });
    expect(canApplyReasoningWrite(terminal, resumed)).toBe(true);
    expect(canApplyReasoningWrite(resumed, terminal)).toBe(false);
    expect(
      canApplyReasoningWrite(
        latest,
        projectReasoning({ run, text: "different", revision: 2 }),
      ),
    ).toBe(false);
  });
});
