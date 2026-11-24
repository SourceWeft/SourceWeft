// @vitest-environment jsdom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { quizFixtureEn } from "@sourceweft/builtin-tool-study/testing";

const sdk = vi.hoisted(() => ({
  contentClient: {
    listSourceMentions: vi.fn(async () => ({ items: [], nextCursor: null })),
    getSource: vi.fn(),
    getArtifact: vi.fn(),
    estimateStudy: vi.fn(),
    generateStudyArtifact: vi.fn(),
    regenerateStudyArtifact: vi.fn(),
  },
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("../../../../../lib/sdk", () => sdk);

import { button, flush, mountWithIntl, unmountAll } from "@/test/react";
import { webStudyHost } from "../artifact-preview/study-host";
import { StudyRegenerateDialogHost } from "./study-regenerate";

function mountHost() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return mountWithIntl(
    <QueryClientProvider client={client}>
      <StudyRegenerateDialogHost />
    </QueryClientProvider>,
  );
}

const version = {
  workspaceId: "workspace-1",
  artifactId: "artifact-1",
  artifactVersionId: "version-1",
};

function quizWithRecipe(recipe: Record<string, unknown>) {
  return {
    ...quizFixtureEn,
    generation: {
      ...quizFixtureEn.generation,
      recipe: { ...quizFixtureEn.generation.recipe, ...recipe },
    },
  };
}

function storedArtifact(payloadJson: unknown, overrides: Record<string, unknown> = {}) {
  return {
    artifact: {
      id: "artifact-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      artifactType: "quiz",
      status: "ready",
      payloadJson,
      ...overrides,
    },
  };
}

function pressed(groupLabel: string) {
  const group = document.querySelector(`[role="group"][aria-label="${groupLabel}"]`);
  return group?.querySelector('[aria-pressed="true"]')?.textContent ?? null;
}

function text() {
  return document.body.textContent ?? "";
}

async function requestRegenerate() {
  await act(async () => webStudyHost.requestRegenerate!(version));
  await flush(8);
}

async function settleEstimate() {
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  await flush(5);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  sdk.contentClient.estimateStudy.mockResolvedValue({
    mode: "single",
    inputTokensEstimate: 900,
    groups: 1,
    maxItems: 20,
    exceedsLimit: false,
  });
  sdk.contentClient.regenerateStudyArtifact.mockResolvedValue({
    artifactId: "artifact-1",
    versionNo: 2,
    status: "pending",
  });
});

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("StudyRegenerateDialogHost", () => {
  test("adjust and regenerate opens the dialog pre-filled from the recipe", async () => {
    sdk.contentClient.getArtifact.mockResolvedValue(
      storedArtifact(
        quizWithRecipe({
          options: { size: "more", difficulty: "hard", language: "fr" },
          focus: "Light reactions",
          sourceIds: ["source-1", "source-2"],
        }),
      ),
    );
    await mountHost();
    await requestRegenerate();

    expect(sdk.contentClient.getArtifact).toHaveBeenCalledWith("workspace-1", "artifact-1");
    expect(text()).toContain("Adjust and regenerate");
    expect(text()).toContain("From the same 2 sources as the current version.");
    expect(pressed("Amount")).toBe("More · 20 questions");
    expect(pressed("Difficulty")).toBe("Hard");
    expect(document.querySelector<HTMLTextAreaElement>("#study-focus")!.value).toBe(
      "Light reactions",
    );
    expect(document.querySelector<HTMLSelectElement>("#study-language")!.value).toBe("fr");

    await settleEstimate();
    expect(sdk.contentClient.estimateStudy).toHaveBeenCalledWith("workspace-1", {
      threadId: "thread-1",
      artifactType: "quiz",
      sourceIds: ["source-1", "source-2"],
      options: { size: "more", difficulty: "hard", language: "fr", focus: "Light reactions" },
    });
    await act(async () => button("Regenerate").click());
    await flush(3);
    expect(sdk.contentClient.regenerateStudyArtifact).toHaveBeenCalledWith(
      "workspace-1",
      "artifact-1",
      {
        options: { size: "more", difficulty: "hard", language: "fr", focus: "Light reactions" },
        focus: "Light reactions",
      },
    );
    expect(toasts.success).toHaveBeenCalledWith(
      "Regenerating. The current version stays until the new one is ready.",
    );
    // The dialog closed.
    expect(text()).not.toContain("Adjust and regenerate");
  });

  test("an exact count from the recipe is kept until a size is picked", async () => {
    sdk.contentClient.getArtifact.mockResolvedValue(
      storedArtifact(quizWithRecipe({ options: { count: 18 } })),
    );
    await mountHost();
    await requestRegenerate();
    // The nearest size step is chosen, labelled with the count that is sent.
    expect(pressed("Amount")).toBe("More · 18 questions");
    await settleEstimate();
    expect(sdk.contentClient.estimateStudy).toHaveBeenLastCalledWith(
      "workspace-1",
      expect.objectContaining({ options: { size: "more", count: 18, difficulty: "mixed" } }),
    );

    await act(async () => button("Fewer · 5 questions").click());
    await settleEstimate();
    expect(sdk.contentClient.estimateStudy).toHaveBeenLastCalledWith(
      "workspace-1",
      expect.objectContaining({ options: { size: "fewer", count: 5, difficulty: "mixed" } }),
    );
    expect(pressed("Amount")).toBe("Fewer · 5 questions");
    // Once a size is picked, every step shows its own count again.
    expect(text()).toContain("More · 20 questions");
  });

  test("a set without a readable recipe says so and opens nothing", async () => {
    sdk.contentClient.getArtifact.mockResolvedValue(
      storedArtifact({}, { status: "failed" }),
    );
    await mountHost();
    await requestRegenerate();
    expect(toasts.error).toHaveBeenCalledWith(
      "This study set can't be adjusted. Generate a new one from the source hub.",
    );
    expect(text()).not.toContain("Adjust and regenerate");
  });

  test("with no dialog host mounted the request settles at once", async () => {
    await expect(webStudyHost.requestRegenerate!(version)).resolves.toBeUndefined();
    expect(sdk.contentClient.getArtifact).not.toHaveBeenCalled();
  });
});
