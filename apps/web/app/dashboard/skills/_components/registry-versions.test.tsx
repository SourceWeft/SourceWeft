// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import type { RegistryVersionDetail } from "@sourceweft/contracts";
import { RegistryVersions } from "./registry-versions";
import messages from "../../../../messages/en.json";

// Components under next-intl need the provider in scope; feed it the shell
// catalog so the rendered chrome matches the English source of truth.
const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];
function withIntl(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={intlMessages} timeZone="UTC">
      {node}
    </NextIntlClientProvider>
  );
}

const api = vi.hoisted(() => ({
  listRegistryVersions: vi.fn(),
  getRegistryVersion: vi.fn(),
  switchRegistryVersion: vi.fn(),
}));
vi.mock("../../../../lib/sdk", () => ({ contentClient: api }));
let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.resetAllMocks();
});

function fixture(): RegistryVersionDetail {
  return {
    version: {
      id: "v1",
      skillId: "skill",
      version: "41bbe19d1a1a",
      status: "draft",
      isCurrent: false,
      displayName: "Writer",
      description: "A very long duplicated description",
      sourceUrl: "https://github.com/acme/skills/tree/commit",
      createdAt: "2026-09-01T00:00:00Z",
      publishedAt: null,
      flags: [],
      diagnostics: [],
      findings: [],
      hasIngestion: false,
      moderation: null,
    },
    readmeContent: "# README",
    readmePath: "README.md",
    skillContent: "# Instructions",
    files: [{ path: "SKILL.md", contentHash: "hash", sizeBytes: 40 }],
    changes: { added: [], removed: [], changed: [] },
  };
}

test("compact version control separates revision and review status, with details collapsed", async () => {
  const detail = fixture();
  api.listRegistryVersions.mockResolvedValue({
    items: [detail.version],
    nextCursor: null,
    installed: null,
  });
  api.getRegistryVersion.mockResolvedValue(detail);
  const onView = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      withIntl(
        <RegistryVersions
          workspaceId="workspace"
          catalogId="skill:v1"
          initialVersionId="v1"
          onView={onView}
          onChanged={() => {}}
        />,
      ),
    ),
  );
  expect(container.querySelector('[role="combobox"]')?.textContent).toBe(
    "41bbe19d",
  );
  expect(container.textContent).toContain("Under review");
  expect(container.textContent).not.toContain(detail.version.description);
  expect(container.textContent).not.toContain(
    "Not installed in this workspace",
  );
  expect(container.querySelector("details")?.open).toBe(false);
  expect(container.querySelector("a")?.href).toBe(detail.version.sourceUrl);
  expect(onView.mock.calls.map(([value]) => value)).toEqual([null, detail]);
});

test("changing the viewed version clears old documents; a failed load stays empty until retry", async () => {
  const first = fixture();
  const second = {
    ...fixture(),
    version: { ...fixture().version, id: "v2", version: "bbbbbbbbbbbb" },
    readmeContent: "# Second README",
  };
  api.listRegistryVersions.mockResolvedValue({
    items: [first.version, second.version],
    nextCursor: null,
    installed: null,
  });
  api.getRegistryVersion
    .mockResolvedValueOnce(first)
    .mockRejectedValueOnce(new Error("Version unavailable"))
    .mockResolvedValueOnce(second);
  const onView = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = (id: string) =>
    withIntl(
      <RegistryVersions
        key={id}
        workspaceId="workspace"
        catalogId={`skill:${id}`}
        initialVersionId={id}
        onView={onView}
        onChanged={() => {}}
      />,
    );
  await act(async () => root.render(render("v1")));
  await act(async () => root.render(render("v2")));
  expect(onView).toHaveBeenLastCalledWith(null);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Version unavailable",
  );
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  )!;
  await act(async () => retry.click());
  expect(onView).toHaveBeenLastCalledWith(second);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(api.switchRegistryVersion).not.toHaveBeenCalled();
});
