// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EvidencePopover,
  StaleBanner,
  StudyArtifactView,
  StudyErrorBoundary,
  StudyHostProvider,
  type StudyHost,
} from "@sourceweft/builtin-tool-study/ui";
import {
  createRecordingStudyHost,
  fixtureEvidence,
  flashcardsFixtureEn,
} from "@sourceweft/builtin-tool-study/testing";
import { button, flush, mount, unmountAll } from "@/test/react";

afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
});

const version = {
  workspaceId: "workspace-1",
  artifactId: "artifact-1",
  artifactVersionId: "version-1",
};
const evidence = fixtureEvidence("The original sentence from the source.");

function withHost(host: StudyHost, node: React.ReactNode) {
  return createElement(StudyHostProvider, { host }, node);
}

function text() {
  return document.body.textContent ?? "";
}

async function openEvidence(host: StudyHost) {
  await mount(
    withHost(
      host,
      createElement(EvidencePopover, {
        evidence: [evidence],
        workspaceId: "workspace-1",
        artifactId: "artifact-1",
      }),
    ),
  );
  await act(async () => button("study.evidence.show").click());
  await flush(3);
}

describe("EvidencePopover", () => {
  it("shows the heading path and quote, and opens the source through the host", async () => {
    const host = createRecordingStudyHost();
    await openEvidence(host);
    expect(text()).toContain("Chapter 1 > Photosynthesis");
    expect(text()).toContain("The original sentence from the source.");
    expect(text()).not.toContain("study.evidence.sourceChanged");

    await act(async () => button("study.evidence.openSource").click());
    expect(host.callsTo("openEvidence")).toEqual([
      {
        evidence,
        context: { workspaceId: "workspace-1", artifactId: "artifact-1" },
      },
    ]);
  });

  it("says the source changed when the quote hash no longer matches", async () => {
    await openEvidence(
      createRecordingStudyHost({
        currentQuoteHash: async () => `sha256:${"0".repeat(64)}`,
      }),
    );
    expect(text()).toContain("study.evidence.sourceChanged");
    expect(text()).toContain("The original sentence from the source.");
  });

  it("falls back to the snapshot quote when the chunk is gone", async () => {
    await openEvidence(
      createRecordingStudyHost({ currentQuoteHash: async () => null }),
    );
    expect(text()).toContain("study.evidence.sourceChanged");
    expect(text()).toContain("The original sentence from the source.");
  });

  it("shows only the snapshot when not interactive", async () => {
    const host = createRecordingStudyHost({ interactive: false });
    await openEvidence(host);
    expect(text()).toContain("The original sentence from the source.");
    expect(button("study.evidence.openSource")).toBeUndefined();
    expect(host.callsTo("currentQuoteHash")).toEqual([]);
  });
});

describe("StaleBanner", () => {
  it("suggests regenerating when a source changed", async () => {
    const host = createRecordingStudyHost({
      getFreshness: async () => ({ status: "stale" }),
      requestRegenerate: () => {},
    });
    await mount(withHost(host, createElement(StaleBanner, { version })));
    await flush(3);
    expect(text()).toContain("study.stale.message");
    await act(async () => button("study.stale.regenerate").click());
    expect(host.callsTo("requestRegenerate")).toEqual([version]);
  });

  it("stays hidden while the sources are unchanged", async () => {
    const host = createRecordingStudyHost();
    await mount(withHost(host, createElement(StaleBanner, { version })));
    await flush(3);
    expect(text()).toBe("");
  });
});

function view(
  overrides: Partial<{
    status: string;
    errorCode: string | null;
    payload: Record<string, unknown>;
    artifactType: string;
  }> = {},
) {
  return createElement(StudyArtifactView, {
    artifact: {
      id: "artifact-1",
      workspaceId: "workspace-1",
      artifactType: overrides.artifactType ?? "flashcards",
      status: overrides.status ?? "ready",
      errorMessage: null,
      errorCode: overrides.errorCode ?? null,
      artifactVersionId: "version-1",
    },
    payload: overrides.payload ?? (flashcardsFixtureEn as never),
  });
}

describe("StudyArtifactView", () => {
  it("renders a valid payload with its viewer", async () => {
    await mount(withHost(createRecordingStudyHost(), view()));
    await flush(3);
    expect(document.querySelector("[data-study-flashcards]")).not.toBeNull();
  });

  it("shows a message instead of crashing on an invalid payload", async () => {
    await mount(
      withHost(createRecordingStudyHost(), view({ payload: { kind: "quiz" } })),
    );
    expect(text()).toContain("study.error.cannotDisplay");
  });

  it("refuses content whose kind is not the artifact type", async () => {
    await mount(
      withHost(createRecordingStudyHost(), view({ artifactType: "quiz" })),
    );
    expect(text()).toContain("study.error.cannotDisplay");
  });

  it("shows generation progress while pending", async () => {
    await mount(
      withHost(
        createRecordingStudyHost(),
        view({
          status: "running",
          payload: { study: { progress: { stage: "generate", done: 2, total: 5 } } },
        }),
      ),
    );
    expect(text()).toContain("study.status.generating completed=2 total=5");
  });

  it("names the failure and offers a retry when the host can regenerate", async () => {
    const host = createRecordingStudyHost({ requestRegenerate: () => {} });
    await mount(
      withHost(
        host,
        view({ status: "failed", errorCode: "INSUFFICIENT_CREDITS", payload: {} }),
      ),
    );
    expect(text()).toContain("study.error.code.INSUFFICIENT_CREDITS");
    await act(async () => button("study.error.retry").click());
    expect(host.callsTo("requestRegenerate")).toEqual([version]);
  });

  it("maps an unknown failure code to the generic message", async () => {
    await mount(
      withHost(
        createRecordingStudyHost(),
        view({ status: "failed", errorCode: "SOMETHING_ELSE", payload: {} }),
      ),
    );
    expect(text()).toContain("study.error.code.UNKNOWN");
  });
});

describe("StudyErrorBoundary", () => {
  it("catches a render error and shows the cannot-display message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Broken(): never {
      throw new Error("bad item");
    }
    await mount(
      withHost(
        createRecordingStudyHost(),
        createElement(StudyErrorBoundary, null, createElement(Broken)),
      ),
    );
    expect(text()).toContain("study.error.cannotDisplay");
  });
});
