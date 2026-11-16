// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  FlashcardsViewer,
  StudyHostProvider,
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
    await press("3");
    await flush(2);
    expect(host.callsTo("gradeCard")).toEqual([]);
  });

  it("rolls the grade back and says so when saving it fails", async () => {
    const host = createRecordingStudyHost({
      gradeCard: () => Promise.reject(new Error("offline")),
    });
    await renderViewer(host);
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
    await act(async () => button("study.flashcards.mode.review").click());
    expect(text()).toContain("study.flashcards.progress current=1 total=2");
    expect(text()).toContain("Which pigment absorbs light in plants?");
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
