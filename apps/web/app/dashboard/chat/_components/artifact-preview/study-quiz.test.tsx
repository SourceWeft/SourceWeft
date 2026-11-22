// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QuizViewer,
  StudyHostProvider,
  type StudyHost,
} from "@sourceweft/builtin-tool-study/ui";
import {
  createRecordingStudyHost,
  quizFixtureEn,
} from "@sourceweft/builtin-tool-study/testing";
import { button, flush, mount, typeInto, unmountAll } from "@/test/react";

afterEach(unmountAll);

const version = {
  workspaceId: "workspace-1",
  artifactId: "artifact-1",
  artifactVersionId: "version-1",
};
const allIds = quizFixtureEn.items.map((item) => item.id);

async function renderQuiz(host: StudyHost) {
  await mount(
    createElement(
      StudyHostProvider,
      { host },
      createElement(QuizViewer, { content: quizFixtureEn, version }),
    ),
  );
  await flush(4);
}

function choose(label: string) {
  const option = [
    ...document.querySelectorAll<HTMLElement>("[role=radio], [role=checkbox]"),
  ].find((node) => node.textContent?.trim() === label);
  if (!option) throw new Error(`no option ${label}`);
  return act(async () => option.click());
}

function press(label: string) {
  const target = button(label);
  if (!target) throw new Error(`no button ${label}`);
  return act(async () => target.click());
}

function text() {
  return document.body.textContent ?? "";
}

async function answerAll({ multiRight }: { multiRight: boolean }) {
  await choose("Oxygen");
  await press("study.quiz.next");
  await choose("Water");
  await choose("Carbon dioxide");
  if (multiRight) await choose("Light");
  await press("study.quiz.next");
  await choose("study.quiz.false");
  await press("study.quiz.next");
  const field = document.querySelector("textarea")!;
  await act(async () => typeInto(field, "It reflects green"));
  await press("study.quiz.showReference");
  await press("study.quiz.selfGrade.knew");
}

describe("QuizViewer", () => {
  it("starts an attempt, scores choice questions and keeps short answers apart", async () => {
    const host = createRecordingStudyHost();
    await renderQuiz(host);
    await press("study.quiz.start");
    await flush(3);
    expect(host.callsTo("startQuizAttempt")).toEqual([
      { ...version, itemIds: allIds },
    ]);

    await answerAll({ multiRight: false });
    await press("study.quiz.submit");
    await flush(4);

    const saves = host.callsTo("saveQuizAnswers") as Array<{
      attemptId: string;
      answers: Record<string, unknown>;
      finish?: boolean;
    }>;
    const final = saves.at(-1)!;
    expect(final.finish).toBe(true);
    expect(final.answers).toEqual({
      q_single: { selected: [1] },
      q_multi: { selected: [0, 1] },
      q_truefalse: { selected: [1] },
      q_short: { text: "It reflects green", selfGrade: "knew" },
    });

    // Multi needs every correct option: 2 of 3 auto-scored, short counted alone.
    expect(text()).toContain("study.quiz.result.score correct=2 total=3");
    expect(text()).toContain("study.quiz.result.selfGraded knew=1 total=1");
    expect(text()).toContain("Oxygen is released as a by-product.");
  });

  it("practising mistakes starts a new attempt with only the wrong questions", async () => {
    const host = createRecordingStudyHost();
    await renderQuiz(host);
    await press("study.quiz.start");
    await flush(3);
    await answerAll({ multiRight: false });
    await press("study.quiz.submit");
    await flush(4);

    await press("study.quiz.practiceMistakes");
    await flush(3);
    expect(host.callsTo("startQuizAttempt").at(-1)).toEqual({
      ...version,
      itemIds: ["q_multi"],
    });
    expect(text()).toContain("Which inputs does photosynthesis need?");
    expect(text()).toContain("study.quiz.questionOf current=1 total=1");
  });

  it("a fully right attempt offers no mistakes to practise", async () => {
    const host = createRecordingStudyHost();
    await renderQuiz(host);
    await press("study.quiz.start");
    await flush(3);
    await answerAll({ multiRight: true });
    await press("study.quiz.submit");
    await flush(4);
    expect(text()).toContain("study.quiz.result.score correct=3 total=3");
    expect(button("study.quiz.practiceMistakes")).toBeUndefined();
  });

  it("submitting waits for an autosave on its way, and its late refusal is not a failed save", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const pending: Array<{ reject: (error: Error) => void }> = [];
      const order: string[] = [];
      const host = createRecordingStudyHost({
        saveQuizAnswers: (input) => {
          if (input.finish) {
            order.push("finish");
            return Promise.resolve({
              id: input.attemptId,
              artifactId: "artifact-1",
              versionNo: 1,
              itemIds: allIds,
              answers: { ...input.answers },
              score: 3,
              total: 3,
              startedAt: "2026-11-15T00:00:00.000Z",
              finishedAt: "2026-11-15T00:10:00.000Z",
            });
          }
          order.push("autosave");
          return new Promise((_resolve, reject) => pending.push({ reject }));
        },
      });
      await renderQuiz(host);
      await press("study.quiz.start");
      await flush(3);
      await answerAll({ multiRight: true });
      // The debounced autosave leaves and has not come back.
      await act(async () => {
        // Past the 600 ms autosave debounce.
        vi.advanceTimersByTime(700);
      });
      await flush(2);
      expect(order).toEqual(["autosave"]);

      const submitted = press("study.quiz.submit");
      await flush(3);
      // Finishing waits for the autosave rather than racing it.
      expect(order).toEqual(["autosave"]);

      // The server refuses the autosave (say, the attempt was finished
      // elsewhere first): that is not a failed save of this submit.
      pending[0]!.reject(new Error("STUDY_ATTEMPT_FINISHED"));
      await submitted;
      await flush(4);
      expect(order).toEqual(["autosave", "finish"]);
      expect(text()).not.toContain("study.quiz.saveFailed");
      expect(text()).toContain("study.quiz.result.score correct=3 total=3");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes an unfinished attempt after a reload", async () => {
    const host = createRecordingStudyHost({
      latestQuizAttempt: async () => ({
        id: "attempt-9",
        artifactId: "artifact-1",
        versionNo: 1,
        itemIds: allIds,
        answers: { q_single: { selected: [1] } },
        score: null,
        total: 4,
        startedAt: "2026-11-15T00:00:00.000Z",
        finishedAt: null,
      }),
    });
    await renderQuiz(host);

    expect(button("study.quiz.start")).toBeUndefined();
    expect(text()).toContain("study.quiz.questionOf current=2 total=4");
    await press("study.quiz.previous");
    const oxygen = [...document.querySelectorAll("[role=radio]")].find(
      (node) => node.textContent?.trim() === "Oxygen",
    );
    expect(oxygen?.getAttribute("aria-checked")).toBe("true");
  });

  it("answers locally and records nothing when not interactive", async () => {
    const host = createRecordingStudyHost({ interactive: false });
    await renderQuiz(host);
    await press("study.quiz.start");
    await answerAll({ multiRight: true });
    await press("study.quiz.submit");
    await flush(3);
    expect(text()).toContain("study.quiz.result.score correct=3 total=3");
    expect(host.callsTo("startQuizAttempt")).toEqual([]);
    expect(host.callsTo("saveQuizAnswers")).toEqual([]);
    expect(host.callsTo("latestQuizAttempt")).toEqual([]);
  });
});
