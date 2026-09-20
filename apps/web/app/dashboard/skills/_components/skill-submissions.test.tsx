// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SkillSubmission } from "@sourceweft/contracts";
import {
  MySubmissions,
  submissionStageRows,
  useSkillSubmissions,
} from "./skill-submissions";
import { SubmitSkillDialog } from "./submit-skill-dialog";
import messages from "../../../../messages/en.json";

const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];

const api = vi.hoisted(() => ({
  createSkillSubmission: vi.fn(),
  getSkillSubmission: vi.fn(),
  listSkillSubmissions: vi.fn(),
  retrySkillSubmission: vi.fn(),
}));
vi.mock("../../../../lib/sdk", () => ({ contentClient: api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// React only batches `act` work when told it runs under a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  api.listSkillSubmissions.mockResolvedValue({ items: [], nextCursor: null });
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.useRealTimers();
  vi.resetAllMocks();
});

function submission(extra: Partial<SkillSubmission> = {}): SkillSubmission {
  return {
    id: "sub-1",
    workspaceId: "workspace",
    submittedBy: "user",
    sourceKind: "github",
    sourceInput: "acme/skills",
    repoOwner: "acme",
    repoName: "skills",
    ref: null,
    subpath: null,
    commitSha: null,
    commitCommittedAt: null,
    target: "workspace",
    status: "queued",
    stage: null,
    stages: {},
    results: [],
    onComplete: null,
    error: null,
    attempts: 0,
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...extra,
  };
}

const stage = (status: "running" | "succeeded" | "failed") => ({
  status,
  startedAt: "2026-09-20T10:00:01.000Z",
});

test("stage rows keep the server's order, then list what is still ahead", () => {
  const running = submission({
    status: "running",
    stage: "download",
    stages: { resolve: stage("succeeded"), download: stage("running") },
  });
  expect(
    submissionStageRows(running).map((row) => [row.name, row.status]),
  ).toEqual([
    ["resolve", "succeeded"],
    ["download", "running"],
    ["discover", "pending"],
    ["analyze-scan", "pending"],
    ["triage-write", "pending"],
  ]);
  // The install stage is only announced to a submission that asked for one.
  expect(
    submissionStageRows({ ...running, onComplete: { install: {} } }).at(-1)
      ?.name,
  ).toBe("on-complete");
  // A finished run lists what ran — including a stage this client has never
  // heard of — and nothing that did not.
  const failed = submission({
    status: "failed",
    stages: {
      resolve: stage("succeeded"),
      translate: {
        ...stage("failed"),
        error: { code: "X", message: "no translator" },
      },
    },
  });
  expect(submissionStageRows(failed)).toEqual([
    { name: "resolve", label: "Pin the version", status: "succeeded" },
    {
      name: "translate",
      label: "translate",
      status: "failed",
      error: "no translator",
    },
  ]);
});

function Harness({ onFinished }: { onFinished: () => void }) {
  const submissions = useSkillSubmissions({
    workspaceId: "workspace",
    onFinished,
  });
  return (
    <NextIntlClientProvider locale="en" messages={intlMessages}>
      <SubmitSkillDialog submissions={submissions} workspaceId="workspace" />
      <MySubmissions submissions={submissions} />
    </NextIntlClientProvider>
  );
}

async function mount(onFinished = vi.fn()) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness onFinished={onFinished} />));
  return onFinished;
}

function button(name: string, scope: ParentNode = document.body) {
  return [...scope.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === name,
  )!;
}

async function submitFromDialog(source: string) {
  await act(async () => button("Submit skill").click());
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="GitHub skill repository"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, source);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Submit").click());
}

const tick = () => act(async () => vi.advanceTimersByTimeAsync(2_000));

test("submitting starts an import, shows its stages as they run, then its results — and refreshes the catalog once", async () => {
  api.createSkillSubmission.mockResolvedValue({ submission: submission() });
  api.getSkillSubmission
    .mockResolvedValueOnce({
      submission: submission({
        status: "running",
        stage: "download",
        stages: { resolve: stage("succeeded"), download: stage("running") },
      }),
    })
    .mockResolvedValue({
      submission: submission({
        status: "succeeded",
        attempts: 1,
        stages: { resolve: stage("succeeded"), download: stage("succeeded") },
        results: [
          {
            sourcePath: "skills/pdf",
            name: "pdf",
            slug: "gh-acme-skills-pdf",
            version: "abc123",
            status: "indexed",
            flags: [],
            diagnostics: [],
          },
          {
            sourcePath: "skills/risky",
            name: "risky",
            status: "queued",
            flags: ["shell-exec"],
            diagnostics: [],
          },
          {
            sourcePath: "skills/broken",
            status: "failed",
            flags: [],
            diagnostics: [
              {
                code: "FRONTMATTER",
                severity: "error",
                message: "name is required",
                file: "SKILL.md",
                line: 2,
              },
            ],
          },
        ],
      }),
    });
  const onFinished = await mount();
  await submitFromDialog(" acme/skills ");
  expect(api.createSkillSubmission).toHaveBeenCalledWith("workspace", {
    source: "acme/skills",
  });

  const dialog = () => document.querySelector('[role="dialog"]')!;
  // Queued: every stage is still ahead.
  expect(
    [...dialog().querySelectorAll("li")].map((item) =>
      item.getAttribute("data-status"),
    ),
  ).toEqual(Array(5).fill("pending"));

  await tick();
  const progress = dialog().querySelector('[aria-label="Import progress"]')!;
  expect(
    [...progress.querySelectorAll("li")].map((item) => [
      item.textContent,
      item.getAttribute("data-status"),
    ]),
  ).toEqual([
    ["Pin the version", "succeeded"],
    ["Download the repository", "running"],
    ["Find skills", "pending"],
    ["Analyze and safety-scan", "pending"],
    ["Index", "pending"],
  ]);
  expect(onFinished).not.toHaveBeenCalled();

  await tick();
  const results = dialog().querySelector('[aria-label="Import results"]')!;
  expect(results.textContent).toContain(
    "1 indexed · 1 awaiting review · 1 failed",
  );
  expect(results.textContent).toContain("pdf — indexed");
  expect(results.textContent).toContain("risky — held for review");
  expect(results.textContent).toContain("Review flags: shell-exec");
  expect(results.textContent).toContain("SKILL.md:2 name is required");
  expect(onFinished).toHaveBeenCalledTimes(1);

  // Nothing left in flight: polling stops.
  const polls = api.getSkillSubmission.mock.calls.length;
  await tick();
  expect(api.getSkillSubmission.mock.calls.length).toBe(polls);
});

test("closing the dialog does not stop the import being followed", async () => {
  api.createSkillSubmission.mockResolvedValue({ submission: submission() });
  api.getSkillSubmission.mockResolvedValue({
    submission: submission({ status: "succeeded", attempts: 1 }),
  });
  const onFinished = await mount();
  await submitFromDialog("acme/skills");
  await act(async () => button("Close").click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();

  await tick();
  expect(onFinished).toHaveBeenCalledTimes(1);
  // It is listed — and the list opened itself while the import was running.
  expect(container.querySelector("details")?.open).toBe(true);
  expect(container.textContent).toContain("My submissions");
  expect(container.textContent).toContain("acme/skills");
  expect(container.textContent).toContain("Done");
});

test("a failed import shows its error with a Retry that puts it back in flight", async () => {
  const failed = submission({
    status: "failed",
    attempts: 1,
    stages: { resolve: { ...stage("failed") } },
    error: { code: "ARCHIVE_UNAVAILABLE", message: "Repository not found" },
  });
  api.listSkillSubmissions.mockResolvedValue({
    items: [failed],
    nextCursor: null,
  });
  api.retrySkillSubmission.mockResolvedValue({
    submission: { ...failed, status: "queued", stages: {}, error: null },
  });
  api.getSkillSubmission.mockResolvedValue({
    submission: { ...failed, status: "running", attempts: 2, error: null },
  });
  await mount();
  expect(container.textContent).toContain("Failed");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Repository not found",
  );
  // Nothing in flight, so nothing is polled.
  await tick();
  expect(api.getSkillSubmission).not.toHaveBeenCalled();

  await act(async () => button("Retry", container).click());
  expect(api.retrySkillSubmission).toHaveBeenCalledWith("workspace", "sub-1");
  expect(container.textContent).toContain("Queued");
  await tick();
  expect(api.getSkillSubmission).toHaveBeenCalledWith("workspace", "sub-1");
  expect(container.textContent).toContain("Importing");
});

test("a source that cannot be imported is refused in the dialog, with nothing tracked", async () => {
  api.createSkillSubmission.mockRejectedValue(
    new Error("Only github.com URLs are supported"),
  );
  await mount();
  await submitFromDialog("https://gitlab.com/a/b");
  expect(
    document.querySelector('[role="dialog"] [role="alert"]')?.textContent,
  ).toContain("Only github.com URLs are supported");
  expect(container.textContent).not.toContain("My submissions");
});
