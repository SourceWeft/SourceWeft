// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STUDY_TRANSLATION_KEYS,
  StudyArtifactView,
  StudyHostProvider,
  type StudyHost,
} from "@sourceweft/builtin-tool-study/ui";
import {
  createRecordingStudyHost,
  fixtureEvidence,
  flashcardsFixtureEn,
  flashcardsFixtureZh,
  mindmapFixtureEn,
  quizFixtureEn,
} from "@sourceweft/builtin-tool-study/testing";
import {
  PromptInputProvider,
  usePromptInputController,
} from "@sourceweft/ui-web/components/ai-elements/prompt-input";

const sdk = vi.hoisted(() => ({
  contentClient: {
    getStudyReviewProgress: vi.fn(),
    gradeStudyCard: vi.fn(),
    listStudyQuizAttempts: vi.fn(),
    startStudyQuizAttempt: vi.fn(),
    saveStudyQuizAnswers: vi.fn(),
    getStudyFreshness: vi.fn(),
  },
}));
vi.mock("../../../../../lib/sdk", () => sdk);
vi.mock("../source-preview-panel", () => ({
  SourcePreviewPanel: (props: {
    citation: { sourceId: string; chunkId: string; excerpt: string };
    open: boolean;
    workspaceId: string;
  }) =>
    createElement("div", {
      "data-testid": "source-preview",
      "data-source": props.citation.sourceId,
      "data-chunk": props.citation.chunkId,
      "data-excerpt": props.citation.excerpt,
      "data-workspace": props.workspaceId,
      "data-open": String(props.open),
    }),
}));

import en from "@/messages/en.json";
import zhCN from "@/messages/zh-CN.json";
import zhTW from "@/messages/zh-TW.json";
import { button, flush, mount, mountWithIntl, unmountAll } from "@/test/react";
import { ComposerInsertSlot } from "../chat-canvas/composer-insert";
import { artifactTypeLabel } from "../sources-hub/artifacts";
import { GroundedEvidenceSourcePreview } from "./grounded-evidence-source";
import { webStudyHost } from "./study-host";

const version = {
  workspaceId: "workspace-1",
  artifactId: "artifact-1",
  artifactVersionId: "version-1",
};

function progressResponse(versionNo = 2) {
  return {
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    versionNo,
    items: {
      card_1: {
        itemId: "card_1",
        state: 2,
        dueAt: "2026-11-30T00:00:00.000Z",
        stability: 3,
        difficulty: 5,
        elapsedDays: 1,
        scheduledDays: 3,
        learningSteps: 0,
        reps: 2,
        lapses: 0,
        lastReviewedAt: "2026-11-21T00:00:00.000Z",
      },
    },
  };
}

function attempt(id: string, versionNo: number) {
  return {
    id,
    artifactId: "artifact-1",
    versionNo,
    itemIds: ["q_single"],
    answers: {},
    score: null,
    total: 1,
    startedAt: "2026-11-21T00:00:00.000Z",
    finishedAt: null,
    results: null,
  };
}

function text() {
  return document.body.textContent ?? "";
}

beforeAll(() => {
  // React Flow measures its viewport; jsdom has no layout engine.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

beforeEach(() => {
  sdk.contentClient.getStudyReviewProgress.mockResolvedValue(progressResponse());
  sdk.contentClient.getStudyFreshness.mockResolvedValue({
    state: "fresh",
    changedSourceIds: [],
    deletedSourceIds: [],
  });
});

afterEach(async () => {
  await unmountAll();
  vi.clearAllMocks();
});

describe("webStudyHost", () => {
  it("is interactive and records learning state through the SDK", async () => {
    expect(webStudyHost.interactive).toBe(true);

    await expect(webStudyHost.listReviewProgress(version)).resolves.toEqual(
      progressResponse().items,
    );
    expect(sdk.contentClient.getStudyReviewProgress).toHaveBeenCalledWith(
      "workspace-1",
      "artifact-1",
      { artifactVersionId: "version-1" },
    );

    sdk.contentClient.gradeStudyCard.mockResolvedValue(progressResponse().items.card_1);
    await webStudyHost.gradeCard({ ...version, itemId: "card_1", grade: 3 });
    expect(sdk.contentClient.gradeStudyCard).toHaveBeenCalledWith("workspace-1", "artifact-1", {
      artifactVersionId: "version-1",
      itemId: "card_1",
      grade: 3,
    });

    sdk.contentClient.startStudyQuizAttempt.mockResolvedValue(attempt("attempt-1", 2));
    await webStudyHost.startQuizAttempt({ ...version, itemIds: ["q_single"] });
    expect(sdk.contentClient.startStudyQuizAttempt).toHaveBeenCalledWith(
      "workspace-1",
      "artifact-1",
      { artifactVersionId: "version-1", itemIds: ["q_single"] },
    );

    sdk.contentClient.saveStudyQuizAnswers.mockResolvedValue(attempt("attempt-1", 2));
    await webStudyHost.saveQuizAnswers({
      workspaceId: "workspace-1",
      attemptId: "attempt-1",
      answers: { q_single: { selected: [1] } },
      finish: true,
    });
    expect(sdk.contentClient.saveStudyQuizAnswers).toHaveBeenCalledWith(
      "workspace-1",
      "attempt-1",
      { answers: { q_single: { selected: [1] } }, finish: true },
    );
  });

  it("resumes the newest attempt of the version shown, not of another version", async () => {
    sdk.contentClient.listStudyQuizAttempts.mockResolvedValue({
      items: [attempt("attempt-newer-version", 3), attempt("attempt-this-version", 2)],
    });
    await expect(webStudyHost.latestQuizAttempt(version)).resolves.toMatchObject({
      id: "attempt-this-version",
    });

    sdk.contentClient.listStudyQuizAttempts.mockResolvedValue({
      items: [attempt("attempt-other", 1)],
    });
    await expect(webStudyHost.latestQuizAttempt(version)).resolves.toBeNull();
  });

  it("refuses to record against an unknown version", async () => {
    await expect(
      webStudyHost.gradeCard({ ...version, artifactVersionId: null, itemId: "card_1", grade: 1 }),
    ).rejects.toThrow();
    expect(sdk.contentClient.gradeStudyCard).not.toHaveBeenCalled();
  });

  it("reports freshness in the viewers' terms", async () => {
    sdk.contentClient.getStudyFreshness.mockResolvedValue({
      state: "stale",
      changedSourceIds: ["source-1"],
      deletedSourceIds: [],
    });
    await expect(webStudyHost.getFreshness(version)).resolves.toEqual({ status: "stale" });
    expect(sdk.contentClient.getStudyFreshness).toHaveBeenCalledWith("workspace-1", "artifact-1");
  });

  it("opens a card's evidence in the source preview", async () => {
    await mount(createElement(GroundedEvidenceSourcePreview));
    expect(document.querySelector('[data-testid="source-preview"]')).toBeNull();

    const evidence = fixtureEvidence("Chlorophyll absorbs red and blue light.");
    await act(async () =>
      webStudyHost.openEvidence(evidence, { workspaceId: "workspace-1", artifactId: "artifact-1" }),
    );
    await flush(10);
    const preview = document.querySelector('[data-testid="source-preview"]');
    expect(preview?.getAttribute("data-source")).toBe("source-1");
    expect(preview?.getAttribute("data-chunk")).toBe("chunk-1");
    expect(preview?.getAttribute("data-excerpt")).toBe("Chlorophyll absorbs red and blue light.");
    expect(preview?.getAttribute("data-workspace")).toBe("workspace-1");
  });

  it("asks in chat by filling the composer, never sending", async () => {
    const inserted: string[] = [];
    const onSubmit = vi.fn();
    function FakeEditor() {
      const controller = usePromptInputController();
      useEffect(() => {
        controller.__registerTextInserter((value) => inserted.push(value));
        return () => controller.__registerTextInserter(null);
      }, [controller]);
      return createElement("form", { onSubmit });
    }
    // Without a composer nothing happens and nothing throws.
    webStudyHost.askInChat({ text: "Nowhere to go" });

    await mount(
      createElement(
        PromptInputProvider,
        null,
        createElement(ComposerInsertSlot),
        createElement(FakeEditor),
      ),
    );
    await act(async () =>
      webStudyHost.askInChat({
        text: 'Tell me more about "Light reactions" from my sources.',
        evidence: [fixtureEvidence("x")],
      }),
    );
    expect(inserted).toEqual(['Tell me more about "Light reactions" from my sources.']);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("speaks the app's catalog in the viewers", async () => {
    await mountWithIntl(
      createElement(
        StudyHostProvider,
        { host: webStudyHost },
        createElement(StudyArtifactView, {
          artifact: {
            id: "artifact-1",
            workspaceId: "workspace-1",
            artifactType: "flashcards",
            status: "ready",
            errorMessage: null,
            artifactVersionId: "version-1",
          },
          payload: flashcardsFixtureEn as never,
          title: "Photosynthesis",
        }),
      ),
    );
    await flush(5);
    expect(text()).toContain("Browse");
    expect(text()).toContain("Export for Anki (CSV)");
    expect(text()).not.toContain("study.");
    // The signed-in viewer reads the person's review progress.
    expect(sdk.contentClient.getStudyReviewProgress).toHaveBeenCalled();
    await unmountAll();

    await mountWithIntl(
      createElement(
        StudyHostProvider,
        { host: webStudyHost },
        createElement(StudyArtifactView, {
          artifact: {
            id: "artifact-1",
            workspaceId: "workspace-1",
            artifactType: "flashcards",
            status: "ready",
            errorMessage: null,
            artifactVersionId: "version-1",
          },
          payload: flashcardsFixtureZh as never,
        }),
      ),
      { locale: "zh-TW", messages: zhTW as never },
    );
    await flush(5);
    expect(text()).toContain("瀏覽");
    expect(text()).toContain("匯出到 Anki（CSV）");
  });
});

describe("study translations", () => {
  const catalogs = { en, "zh-CN": zhCN, "zh-TW": zhTW } as const;

  function lookup(catalog: unknown, key: string) {
    return key.split(".").reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      catalog,
    );
  }

  function placeholders(message: string) {
    return [...message.matchAll(/\{(\w+)[,}]/g)].map((match) => match[1]).sort();
  }

  it.each(Object.entries(catalogs))(
    "%s has every key the viewers can ask for, with the same placeholders",
    (_locale, catalog) => {
      for (const key of STUDY_TRANSLATION_KEYS) {
        const message = lookup(catalog, key);
        expect(typeof message, key).toBe("string");
        expect(placeholders(message as string), key).toEqual(
          placeholders(lookup(en, key) as string),
        );
      }
    },
  );

  it.each(Object.entries(catalogs))(
    "%s has the same study, hub generate and type label keys as English",
    (_locale, catalog) => {
      const keys = (node: unknown, prefix = ""): string[] =>
        node && typeof node === "object"
          ? Object.entries(node).flatMap(([name, child]) => keys(child, `${prefix}${name}.`))
          : [prefix.slice(0, -1)];
      for (const path of [
        "study",
        "dashboardSourcesHub.generate",
        "dashboardSourcesHub.artifacts.types",
      ]) {
        expect(keys(lookup(catalog, path)).sort(), path).toEqual(keys(lookup(en, path)).sort());
      }
    },
  );

  it("names the three study types in the artifact list in every locale", () => {
    const labels = (catalog: typeof en | typeof zhCN | typeof zhTW) =>
      (["flashcards", "quiz", "mindmap"] as const).map((type) =>
        artifactTypeLabel(type, (key) => lookup(catalog.dashboardSourcesHub, key) as string),
      );
    expect(labels(en)).toEqual(["Flashcards", "Quiz", "Mind map"]);
    expect(labels(zhCN)).toEqual(["闪卡", "测验", "思维导图"]);
    expect(labels(zhTW)).toEqual(["閃卡", "測驗", "心智圖"]);
  });

  it("the viewers ask only for keys that are listed", async () => {
    const asked = new Set<string>();
    const host = createRecordingStudyHost({
      useTranslate: () => (key: string) => {
        asked.add(key);
        return key;
      },
    }) as StudyHost;
    const artifact = {
      id: "artifact-1",
      workspaceId: "workspace-1",
      status: "ready",
      errorMessage: null,
      artifactVersionId: "version-1",
    };
    const render = (artifactType: string, payload: unknown, status = "ready") =>
      mount(
        createElement(
          StudyHostProvider,
          { host },
          createElement(StudyArtifactView, {
            artifact: { ...artifact, artifactType, status },
            payload: payload as never,
          }),
        ),
      );

    await render("flashcards", flashcardsFixtureEn);
    await flush(3);
    await act(async () => button("study.flashcards.exportAnki").click());
    await unmountAll();
    await render("quiz", quizFixtureEn);
    await flush(3);
    await act(async () => button("study.quiz.start").click());
    await flush(3);
    await unmountAll();
    await render("mindmap", mindmapFixtureEn);
    await flush(3);
    await unmountAll();
    for (const status of ["pending", "failed"]) {
      await render("quiz", {}, status);
      await unmountAll();
    }

    const listed = new Set<string>(STUDY_TRANSLATION_KEYS);
    expect([...asked].filter((key) => !listed.has(key))).toEqual([]);
    expect(asked.size).toBeGreaterThan(15);
  });
});
