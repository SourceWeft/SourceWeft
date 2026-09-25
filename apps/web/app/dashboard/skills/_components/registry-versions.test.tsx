// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { RegistryVersionDetail } from "@sourceweft/contracts";
import { RegistryVersions } from "./registry-versions";
import {
  button,
  mount,
  mountWithIntl,
  unmountAll,
  withIntl,
} from "@/test/react";

// Components under next-intl need the provider in scope; feed it the shell
// catalog so the rendered chrome matches the English source of truth.
const intl = { timeZone: "UTC" };

const api = vi.hoisted(() => ({
  listRegistryVersions: vi.fn(),
  getRegistryVersion: vi.fn(),
  switchRegistryVersion: vi.fn(),
}));
vi.mock("../../../../lib/sdk", () => ({ contentClient: api }));
let container: HTMLDivElement;
afterEach(async () => {
  await unmountAll();
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
  ({ container } = await mountWithIntl(
    <RegistryVersions
      workspaceId="workspace"
      catalogId="skill:v1"
      initialVersionId="v1"
      onView={onView}
      onChanged={() => {}}
    />,
    intl,
  ));
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
      intl,
    );
  const view = await mount(render("v1"));
  ({ container } = view);
  await view.render(render("v2"));
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

test("a version that can do more asks in the app's own dialog, names what changed, and switches only on yes", async () => {
  const { HttpClientError } = await import("@sourceweft/sdk");
  const installed = { ...fixture().version, id: "v1", status: "published" };
  const target = { ...fixture(), version: { ...installed, id: "v2" } };
  api.listRegistryVersions.mockResolvedValue({
    items: [target.version, installed],
    nextCursor: null,
    installed: { id: "ws-skill", skillVersionId: "v1" },
  });
  api.getRegistryVersion.mockResolvedValue(target);
  api.switchRegistryVersion.mockImplementation(
    async (_ws: string, _id: string, _version: string, options?: unknown) => {
      if (options) return { workspaceSkill: {} };
      throw new HttpClientError({
        status: 409,
        statusText: "Conflict",
        code: "SKILL_VERSION_ESCALATION",
        message: "This version adds executable scripts.",
        details: { addsScripts: true, newFlags: ["binary:executable"] },
      });
    },
  );
  const confirm = vi.spyOn(window, "confirm");
  const onChanged = vi.fn();
  await mountWithIntl(
    <RegistryVersions
      workspaceId="workspace"
      catalogId="skill:v2"
      initialVersionId="v2"
      onView={() => {}}
      onChanged={onChanged}
    />,
    intl,
  );

  await act(async () => button("Use this version").click());
  const dialog = document.body.querySelector('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain("Adds scripts that run in the sandbox");
  expect(dialog.textContent).toContain("Ships a compiled binary");
  expect(confirm).not.toHaveBeenCalled();
  expect(api.switchRegistryVersion).toHaveBeenCalledTimes(1);
  expect(onChanged).not.toHaveBeenCalled();

  await act(async () => button("Switch to it").click());
  expect(api.switchRegistryVersion).toHaveBeenLastCalledWith(
    "workspace",
    "ws-skill",
    "v2",
    { acknowledgeEscalation: true },
  );
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
});

test("an install behind the current version is offered the update, through the same escalation question, and then shows what is installed", async () => {
  const { HttpClientError } = await import("@sourceweft/sdk");
  const base = fixture().version;
  const installed = { ...base, id: "v1", status: "published" as const };
  const current = {
    ...base,
    id: "v2",
    version: "cccccccccccc",
    status: "published" as const,
    isCurrent: true,
  };
  let installedVersionId = "v1";
  api.listRegistryVersions.mockImplementation(async () => ({
    items: [current, installed],
    nextCursor: null,
    installed: {
      id: "ws-skill",
      skillVersionId: installedVersionId,
      enabled: true,
    },
  }));
  api.getRegistryVersion.mockImplementation(
    async (_ws: string, _catalog: string, id: string) => ({
      ...fixture(),
      version: id === "v2" ? current : installed,
    }),
  );
  api.switchRegistryVersion.mockImplementation(
    async (_ws: string, _id: string, version: string, options?: unknown) => {
      if (!options)
        throw new HttpClientError({
          status: 409,
          statusText: "Conflict",
          code: "SKILL_VERSION_ESCALATION",
          message: "This version adds executable scripts.",
          details: { addsScripts: true, newFlags: [] },
        });
      installedVersionId = version;
      return { workspaceSkill: {} };
    },
  );
  const onChanged = vi.fn();
  // Viewing the INSTALLED version: the update is offered all the same.
  ({ container } = await mountWithIntl(
    <RegistryVersions
      workspaceId="workspace"
      catalogId="skill:v1"
      initialVersionId="v1"
      currentVersionId="v2"
      onView={() => {}}
      onChanged={onChanged}
    />,
    intl,
  ));
  const notice = () =>
    container.querySelector('[data-testid="skill-update-notice"]');
  expect(notice()?.textContent).toContain(
    "A newer version is available: cccccccc.",
  );
  // Nothing moved on its own.
  expect(api.switchRegistryVersion).not.toHaveBeenCalled();

  await act(async () => button("Update to the newest version").click());
  expect(api.switchRegistryVersion).toHaveBeenLastCalledWith(
    "workspace",
    "ws-skill",
    "v2",
    undefined,
  );
  expect(
    document.body.querySelector('[role="alertdialog"]')?.textContent,
  ).toContain("Adds scripts that run in the sandbox");
  expect(onChanged).not.toHaveBeenCalled();

  await act(async () => button("Switch to it").click());
  expect(api.switchRegistryVersion).toHaveBeenLastCalledWith(
    "workspace",
    "ws-skill",
    "v2",
    { acknowledgeEscalation: true },
  );
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(notice()).toBeNull();
  // The view followed the install to the new version.
  expect(api.getRegistryVersion).toHaveBeenLastCalledWith(
    "workspace",
    "skill:v1",
    "v2",
  );
  expect(container.textContent).toContain("Installed");
});

test("viewing the current version while an older one is installed offers the update and keeps the usual control", async () => {
  const base = fixture().version;
  const installed = { ...base, id: "v1", status: "published" as const };
  const current = {
    ...base,
    id: "v2",
    status: "published" as const,
    isCurrent: true,
  };
  api.listRegistryVersions.mockResolvedValue({
    items: [current, installed],
    nextCursor: null,
    installed: { id: "ws-skill", skillVersionId: "v1", enabled: true },
  });
  api.getRegistryVersion.mockResolvedValue({ ...fixture(), version: current });
  // No `currentVersionId` from the caller: the list's own current version serves.
  ({ container } = await mountWithIntl(
    <RegistryVersions
      workspaceId="workspace"
      catalogId="skill:v2"
      initialVersionId="v2"
      onView={() => {}}
      onChanged={() => {}}
    />,
    intl,
  ));
  expect(
    container.querySelector('[data-testid="skill-update-notice"]'),
  ).not.toBeNull();
  // The notice is a shortcut. "Use this version" is the control people (and the
  // e2e suite) already know, so it stays wherever the viewed version is not the
  // installed one.
  expect(container.textContent).toContain("Use this version");
});

test("the update notice says what the newer version changed", async () => {
  const base = fixture().version;
  const installed = { ...base, id: "v1", status: "published" as const };
  const current = {
    ...base,
    id: "v2",
    version: "cccccccccccc",
    status: "published" as const,
    isCurrent: true,
  };
  api.listRegistryVersions.mockResolvedValue({
    items: [current, installed],
    nextCursor: null,
    installed: { id: "ws-skill", skillVersionId: "v1", enabled: true },
  });
  api.getRegistryVersion.mockImplementation(
    async (_ws: string, _catalog: string, id: string) => ({
      ...fixture(),
      version: id === "v2" ? current : installed,
      changelog:
        id === "v2"
          ? {
              added: ["a.md", "scripts/run.sh"],
              removed: [],
              modified: ["SKILL.md"],
              newScripts: ["scripts/run.sh"],
              newFlags: [],
              compareUrl: "https://github.com/acme/skills/compare/aaa...ccc",
            }
          : null,
    }),
  );
  // Viewing the installed version: the target's changelog is fetched for it.
  ({ container } = await mountWithIntl(
    <RegistryVersions
      workspaceId="workspace"
      catalogId="skill:v1"
      initialVersionId="v1"
      currentVersionId="v2"
      onView={() => {}}
      onChanged={() => {}}
    />,
    intl,
  ));
  const changes = container.querySelector(
    '[data-testid="skill-update-changes"]',
  );
  expect(changes?.textContent).toContain("What changed: 3 files, 1 new script");
  expect(changes?.querySelector("a")?.href).toBe(
    "https://github.com/acme/skills/compare/aaa...ccc",
  );
  expect(api.switchRegistryVersion).not.toHaveBeenCalled();
});
