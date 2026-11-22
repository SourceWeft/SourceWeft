// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  FlashcardsViewer,
  StudyHostProvider,
  type ReviewStateView,
  type StudyHost,
} from "@sourceweft/builtin-tool-study/ui";
import {
  createRecordingStudyHost,
  flashcardsFixtureEn,
} from "@sourceweft/builtin-tool-study/testing";
import { button, flush, mount, unmountAll } from "@/test/react";

afterEach(unmountAll);

const version = {
  workspaceId: "workspace-1",
  artifactId: "artifact-1",
  artifactVersionId: "version-1",
};

async function renderViewer(host: StudyHost) {
  const mounted = await mount(
    createElement(
      StudyHostProvider,
      { host },
      createElement(FlashcardsViewer, { content: flashcardsFixtureEn, version }),
    ),
  );
  await flush(3);
  return mounted;
}

function deck() {
  return document.querySelector<HTMLElement>("[data-study-flashcards]")!;
}

function press(key: string) {
  return act(async () => {
    deck().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function text() {
  return document.body.textContent ?? "";
}

/** The Review mode button; its text carries the due count after the label. */
function reviewButton() {
  return [...document.querySelectorAll("button")].find((node) =>
    node.textContent?.startsWith("study.flashcards.mode.review"),
  )!;
}

function openReview() {
  return act(async () => reviewButton().click());
}

const DAY = 86_400_000;

function learned(itemId: string, dueAt: string): ReviewStateView {
  return { itemId, state: 2, dueAt, reps: 3, lapses: 0 };
}

describe("FlashcardsViewer", () => {
  it("flips the card with the space bar and announces the side", async () => {
    await renderViewer(createRecordingStudyHost());
    expect(text()).toContain("What does photosynthesis produce?");
    expect(text()).not.toContain("Glucose and oxygen");

    await press(" ");
    expect(text()).toContain("Glucose and oxygen");
    expect(
      document.querySelector("[aria-live]")?.textContent,
    ).toContain("study.flashcards.showingBack");

    await press("Enter");
    expect(text()).not.toContain("Glucose and oxygen");
  });

  it("grades a flipped card with a number key exactly once and moves on", async () => {
    const host = createRecordingStudyHost();
    await renderViewer(host);
    await openReview();
    await press(" ");
    await press("3");
    await flush(3);

    expect(host.callsTo("gradeCard")).toEqual([
      { ...version, itemId: "c_photosynthesis", grade: 3 },
    ]);
    expect(text()).toContain("Which pigment absorbs light in plants?");
  });

  it("does not grade a card that has not been flipped", async () => {
    const host = createRecordingStudyHost();
    await renderViewer(host);
    await openReview();
    await press("3");
    await flush(2);
    expect(host.callsTo("gradeCard")).toEqual([]);
  });

  it("rolls the grade back and says so when saving it fails", async () => {
    const host = createRecordingStudyHost({
      gradeCard: () => Promise.reject(new Error("offline")),
    });
    await renderViewer(host);
    await openReview();
    await press(" ");
    await act(async () => button("study.flashcards.grade.again").click());
    await flush(5);

    expect(host.callsTo("gradeCard")).toHaveLength(1);
    expect(text()).toContain("What does photosynthesis produce?");
    expect(text()).toContain("study.flashcards.gradeFailed");
    expect(text()).toContain("study.flashcards.progress current=1 total=3");
  });

  it("navigates with the arrow keys", async () => {
    await renderViewer(createRecordingStudyHost());
    await press("ArrowRight");
    expect(text()).toContain("Which pigment absorbs light in plants?");
    await press("ArrowLeft");
    expect(text()).toContain("What does photosynthesis produce?");
  });

  it("shows no grading controls when the viewer is not interactive", async () => {
    const host = createRecordingStudyHost({ interactive: false });
    await renderViewer(host);
    await press(" ");
    expect(text()).toContain("Glucose and oxygen");
    expect(document.querySelector("[data-grade]")).toBeNull();
    await press("3");
    await flush(2);
    expect(host.callsTo("gradeCard")).toEqual([]);
    expect(host.callsTo("listReviewProgress")).toEqual([]);
  });

  it("review mode holds only the cards that are new or due", async () => {
    const host = createRecordingStudyHost({
      listReviewProgress: async () => ({
        c_photosynthesis: {
          itemId: "c_photosynthesis",
          state: 2,
          dueAt: "2999-01-01T00:00:00.000Z",
          reps: 3,
          lapses: 0,
        },
      }),
    });
    await renderViewer(host);
    expect(text()).toContain("study.flashcards.progress current=1 total=2");
    expect(text()).toContain("Which pigment absorbs light in plants?");
  });

  it("browsing a new deck changes nothing: no grading, only where each card stands", async () => {
    const host = createRecordingStudyHost();
    await renderViewer(host);
    expect(reviewButton().getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector("[data-card-status]")?.textContent).toBe(
      "study.flashcards.status.new",
    );
    await press(" ");
    expect(document.querySelector("[data-grade]")).toBeNull();
    expect(text()).toContain("study.flashcards.hintBrowse");
    await press("3");
    await flush(2);
    expect(host.callsTo("gradeCard")).toEqual([]);
    expect(text()).toContain("Glucose and oxygen");
  });

  it("shows the deck's progress and opens a studied deck on its review", async () => {
    const future = new Date(Date.now() + 3 * DAY).toISOString();
    const host = createRecordingStudyHost({
      listReviewProgress: async () => ({
        c_photosynthesis: learned("c_photosynthesis", future),
        c_chlorophyll: {
          itemId: "c_chlorophyll",
          state: 1,
          dueAt: "2020-01-01T00:00:00.000Z",
          reps: 1,
          lapses: 1,
        },
      }),
    });
    await renderViewer(host);
    expect(reviewButton().getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("[data-due-count]")?.textContent).toBe("2");
    expect(document.querySelector("[data-deck-summary]")?.textContent).toBe(
      "study.flashcards.summary new=1 learning=1 learned=1",
    );
    // Review holds the due card and the new one, not the learned one.
    expect(text()).toContain("study.flashcards.progress current=1 total=2");
    expect(text()).toContain("Which pigment absorbs light in plants?");

    await act(async () => button("study.flashcards.mode.browse").click());
    expect(text()).toContain("study.flashcards.progress current=1 total=3");
    expect(document.querySelector("[data-card-status]")?.textContent).toBe(
      "study.flashcards.status.learned · study.flashcards.due.days count=3",
    );
  });

  it("says when the next card is due once nothing is left to review", async () => {
    const soon = new Date(Date.now() + 10 * 60_000 - 1_000).toISOString();
    const later = new Date(Date.now() + 5 * DAY).toISOString();
    const host = createRecordingStudyHost({
      listReviewProgress: async () => ({
        c_photosynthesis: learned("c_photosynthesis", later),
        c_chlorophyll: learned("c_chlorophyll", later),
        c_stomata: { itemId: "c_stomata", state: 1, dueAt: soon, reps: 1, lapses: 0 },
      }),
    });
    await renderViewer(host);
    expect(text()).toContain("study.flashcards.nothingDue");
    expect(document.querySelector("[data-next-due]")?.textContent).toBe(
      "study.flashcards.nextDue when=study.flashcards.due.minutes count=10",
    );
    expect(document.querySelector("[data-due-count]")).toBeNull();
  });

  it("a new review pass picks up cards graded into a short step", async () => {
    // The recording host saves every grade as due in the past.
    const host = createRecordingStudyHost();
    await renderViewer(host);
    await openReview();
    for (let card = 0; card < 3; card += 1) {
      await press(" ");
      await press("1");
      await flush(3);
    }
    expect(text()).toContain("study.flashcards.done graded=3 total=3");
    await act(async () => button("study.flashcards.restart").click());
    expect(text()).toContain("study.flashcards.progress current=1 total=3");
    expect(document.querySelector("[data-deck-summary]")?.textContent).toBe(
      "study.flashcards.summary new=0 learning=3 learned=0",
    );
  });

  it("exports the deck as an Anki CSV through the host", async () => {
    const host = createRecordingStudyHost();
    await renderViewer(host);
    await act(async () => button("study.flashcards.exportAnki").click());
    const [download] = host.callsTo("downloadText") as Array<{
      fileName: string;
      mimeType: string;
      body: string;
    }>;
    expect(download?.fileName).toMatch(/\.csv$/);
    expect(download?.mimeType).toBe("text/csv");
    expect(download?.body).toContain("#columns:Front,Back,Source,Tags");
  });
});
