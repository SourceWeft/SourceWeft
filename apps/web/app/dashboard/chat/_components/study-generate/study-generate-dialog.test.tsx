// @vitest-environment jsdom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { HttpClientError } from "@sourceweft/sdk";

const sdk = vi.hoisted(() => ({
  contentClient: {
    estimateStudy: vi.fn(),
    generateStudyArtifact: vi.fn(),
    regenerateStudyArtifact: vi.fn(),
    listSourceMentions: vi.fn(),
    getSource: vi.fn(),
  },
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("../../../../../lib/sdk", () => sdk);

import { button, flush, mountWithIntl, typeInto, unmountAll } from "@/test/react";
import { StudyGenerateDialog } from "./study-generate-dialog";

const sources = [
  { id: "source-1", title: "Source 1" },
  { id: "source-2", title: "Source 2" },
];

function estimate(overrides: Record<string, unknown> = {}) {
  return {
    mode: "single",
    inputTokensEstimate: 1200,
    groups: 1,
    maxItems: 20,
    exceedsLimit: false,
    ...overrides,
  };
}

const onQueued = vi.fn();
const onOpenChange = vi.fn();

async function renderDialog(props: Partial<Parameters<typeof StudyGenerateDialog>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await mountWithIntl(
    <QueryClientProvider client={client}>
      <StudyGenerateDialog
        artifactType="flashcards"
        onOpenChange={onOpenChange}
        onQueued={onQueued}
        open
        sources={sources}
        target={{ kind: "generate", threadId: "thread-1" }}
        workspaceId="workspace-1"
        {...props}
      />
    </QueryClientProvider>,
  );
  await flush(3);
}

/** Lets the debounced estimate fire and its answer land. */
async function settleEstimate() {
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  await flush(5);
}

function pressed(groupLabel: string) {
  const group = document.querySelector(`[role="group"][aria-label="${groupLabel}"]`);
  return group?.querySelector('[aria-pressed="true"]')?.textContent ?? null;
}

function focusField() {
  return document.querySelector<HTMLTextAreaElement>("#study-focus")!;
}

function languageField() {
  return document.querySelector<HTMLSelectElement>("#study-language")!;
}

function submitButton() {
  return button("Generate");
}

function text() {
  return document.body.textContent ?? "";
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  sdk.contentClient.estimateStudy.mockResolvedValue(estimate());
  sdk.contentClient.listSourceMentions.mockResolvedValue({ items: [], nextCursor: null });
  sdk.contentClient.generateStudyArtifact.mockResolvedValue({
    artifactId: "artifact-9",
    versionNo: 1,
    status: "pending",
    visibility: "private",
    reused: false,
  });
});

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("StudyGenerateDialog", () => {
  test("opens with standard size, mixed difficulty, no focus and the sources' language", async () => {
    await renderDialog();
    expect(text()).toContain("Generate flashcards");
    expect(pressed("Amount")).toBe("Standard · 20 cards");
    expect(pressed("Difficulty")).toBe("Mixed");
    expect(focusField().value).toBe("");
    expect(languageField().value).toBe("");
    expect(text()).toContain("Same as the sources");
    expect(submitButton().disabled).toBe(true);

    await settleEstimate();
    expect(sdk.contentClient.estimateStudy).toHaveBeenCalledWith("workspace-1", {
      threadId: "thread-1",
      artifactType: "flashcards",
      sourceIds: ["source-1", "source-2"],
      options: { size: "standard", difficulty: "mixed" },
    });
    expect(text()).toContain("Up to 20 cards from 2 sources");
    expect(submitButton().disabled).toBe(false);
  });

  test("the size steps show each type's counts, and a mind map has no difficulty", async () => {
    await renderDialog({ artifactType: "quiz" });
    expect(text()).toContain("Fewer · 5 questions");
    expect(text()).toContain("More · 20 questions");
    await unmountAll();

    await renderDialog({ artifactType: "mindmap" });
    expect(text()).toContain("Generate a mind map");
    expect(pressed("Amount")).toBe("Standard · up to 40 ideas");
    expect(document.querySelector('[role="group"][aria-label="Difficulty"]')).toBeNull();
    await settleEstimate();
    expect(sdk.contentClient.estimateStudy).toHaveBeenLastCalledWith(
      "workspace-1",
      expect.objectContaining({ artifactType: "mindmap", options: { size: "standard" } }),
    );
  });

  test("a request too large for one generation cannot be submitted", async () => {
    sdk.contentClient.estimateStudy.mockResolvedValue(
      estimate({ mode: "mapreduce", groups: 9, exceedsLimit: true }),
    );
    await renderDialog();
    await settleEstimate();
    expect(text()).toContain("The selected sources are too large for one study set.");
    expect(submitButton().disabled).toBe(true);
    await act(async () => submitButton().click());
    expect(sdk.contentClient.generateStudyArtifact).not.toHaveBeenCalled();
  });

  test("a long generation says it reads the sources in parts", async () => {
    sdk.contentClient.estimateStudy.mockResolvedValue(estimate({ mode: "mapreduce", groups: 3 }));
    await renderDialog();
    await settleEstimate();
    expect(text()).toContain("Long sources are read in 3 parts");
    expect(submitButton().disabled).toBe(false);
  });

  test("a focus longer than 200 characters is refused before any request", async () => {
    await renderDialog();
    expect(focusField().maxLength).toBe(200);
    // A pasted or pre-filled value can get past the field's own limit.
    typeInto(focusField(), "x".repeat(201));
    await settleEstimate();
    expect(text()).toContain("Keep the focus to 200 characters or fewer.");
    expect(focusField().getAttribute("aria-invalid")).toBe("true");
    expect(sdk.contentClient.estimateStudy).not.toHaveBeenCalled();
    expect(submitButton().disabled).toBe(true);

    typeInto(focusField(), "  Key dates  ");
    await settleEstimate();
    expect(text()).toContain("9 / 200");
    expect(sdk.contentClient.estimateStudy).toHaveBeenLastCalledWith(
      "workspace-1",
      expect.objectContaining({
        options: { size: "standard", difficulty: "mixed", focus: "Key dates" },
      }),
    );
  });

  test("submits the chosen options and opens what was queued", async () => {
    await renderDialog();
    await act(async () => button("More · 40 cards").click());
    await act(async () => button("Hard").click());
    typeInto(focusField(), "Definitions");
    await act(async () => {
      languageField().value = "ja";
      languageField().dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settleEstimate();
    await act(async () => submitButton().click());
    await flush(3);

    expect(sdk.contentClient.generateStudyArtifact).toHaveBeenCalledWith("workspace-1", {
      threadId: "thread-1",
      artifactType: "flashcards",
      sourceIds: ["source-1", "source-2"],
      options: { size: "more", difficulty: "hard", language: "ja", focus: "Definitions" },
    });
    expect(toasts.success).toHaveBeenCalledWith(
      "Generating. It will also appear under Artifacts.",
    );
    expect(onQueued).toHaveBeenCalledWith({ artifactId: "artifact-9", versionNo: 1 });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("running out of credits is explained in the dialog, which stays open", async () => {
    sdk.contentClient.generateStudyArtifact.mockRejectedValue(
      new HttpClientError({
        message: "Payment required",
        status: 402,
        statusText: "Payment Required",
        code: "INSUFFICIENT_CREDITS",
      }),
    );
    await renderDialog();
    await settleEstimate();
    await act(async () => submitButton().click());
    await flush(3);

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Not enough credits to generate this.",
    );
    expect(toasts.error).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  test("other failures are worded by their API code", async () => {
    sdk.contentClient.generateStudyArtifact.mockRejectedValue(
      new HttpClientError({
        message: "Too many",
        status: 429,
        statusText: "Too Many Requests",
        code: "STUDY_TOO_MANY_RUNNING",
      }),
    );
    await renderDialog();
    await settleEstimate();
    await act(async () => submitButton().click());
    await flush(3);
    expect(toasts.error).toHaveBeenCalledWith(
      "Too many tables and study sets are generating at once. Wait for one to finish.",
    );
  });
});
