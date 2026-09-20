import { expect, test, vi } from "vitest";
import { ContentSkillsService } from "./service";
import type { SkillCatalogItem } from "./types";

const mocks = vi.hoisted(() => ({
  getRegistryVersionDetail: vi.fn(),
  admins: [] as string[],
}));
vi.mock("./registry/versions", async (original) => ({
  ...(await original<typeof import("./registry/versions")>()),
  getRegistryVersionDetail: mocks.getRegistryVersionDetail,
}));
vi.mock("../market/admin", () => ({
  isMarketAdmin: (userId: string) => mocks.admins.includes(userId),
}));

const input = {
  teamId: "team",
  workspaceId: "workspace",
  userId: "submitter",
  catalogId: "skill:version",
};
function service(
  item: Partial<SkillCatalogItem> = {},
  ownerUserId: string | null = "submitter",
) {
  const instance = new ContentSkillsService();
  // The detail resolves its item with a direct query; stub that seam so these
  // tests stay about documents, not the database.
  vi.spyOn(
    instance as unknown as {
      findCatalogItemById: () => Promise<SkillCatalogItem | null>;
    },
    "findCatalogItemById",
  ).mockResolvedValue({
    catalogId: input.catalogId,
    skillVersionId: "version",
    sourceType: "registry_github",
    skillId: "skill",
    enabledWorkspaceSkillId: null,
    ...item,
  } as SkillCatalogItem);
  vi.spyOn(
    instance as unknown as {
      findSkillOwnerUserId: () => Promise<string | null>;
    },
    "findSkillOwnerUserId",
  ).mockResolvedValue(ownerUserId);
  listCatalog = vi.spyOn(instance, "listCatalog");
  return instance;
}
let listCatalog: ReturnType<typeof vi.spyOn>;
test("registry previews forward the viewer to version authorization and preserve real README", async () => {
  mocks.getRegistryVersionDetail.mockResolvedValue({
    readmeContent: "# Author introduction",
    readmePath: "readme.md",
    skillContent: "# Instructions",
  });
  const result = await service().getCatalogSkillDetail(input);
  expect(mocks.getRegistryVersionDetail).toHaveBeenLastCalledWith({
    ...input,
    versionId: "version",
  });
  expect(result.readmeContent).toBe("# Author introduction");
  expect(result.readmePath).toBe("readme.md");
  expect(result.skillContent).toBe("# Instructions");
  expect(result.skill.hasReadme).toBe(true);
  // One skill's detail must never cost a full catalog listing.
  expect(listCatalog).not.toHaveBeenCalled();
});
test("authorization and storage failures are not converted into missing documentation", async () => {
  const error = new Error("Skill version is not available to this workspace");
  mocks.getRegistryVersionDetail.mockRejectedValue(error);
  await expect(service().getCatalogSkillDetail(input)).rejects.toBe(error);
});

// --- who gets a community skill's full text ---------------------------------

const documents = {
  readmeContent: "# Author introduction",
  readmePath: "README.md",
  skillContent: "# Instructions",
};

test("a stranger gets a community skill's listing but not its text", async () => {
  mocks.getRegistryVersionDetail.mockResolvedValue(documents);
  const result = await service().getCatalogSkillDetail({
    ...input,
    userId: "stranger",
  });
  expect(result.skillContent).toBeNull();
  expect(result.readmeContent).toBeNull();
  expect(result.contentRestricted).toBe(true);
  // What the listing shows is unaffected — including that a README exists.
  expect(result.skill.hasReadme).toBe(true);
  expect(result.readmePath).toBe("README.md");
});

test("a workspace that installed it, its submitter and a market admin get the full text", async () => {
  mocks.getRegistryVersionDetail.mockResolvedValue(documents);
  const stranger = { ...input, userId: "stranger" };

  const installed = await service({
    enabledWorkspaceSkillId: "ws-skill",
  }).getCatalogSkillDetail(stranger);
  const submitter = await service().getCatalogSkillDetail(input);
  mocks.admins = ["stranger"];
  const admin = await service().getCatalogSkillDetail(stranger);
  mocks.admins = [];

  for (const result of [installed, submitter, admin]) {
    expect(result.skillContent).toBe("# Instructions");
    expect(result.readmeContent).toBe("# Author introduction");
    expect("contentRestricted" in result).toBe(false);
  }
});

test("builtin and workspace skills are never restricted", async () => {
  for (const sourceType of ["builtin", "workspace_custom", "team_custom"]) {
    const instance = service({
      sourceType: sourceType as SkillCatalogItem["sourceType"],
    });
    vi.spyOn(
      instance as unknown as { getSkillFiles: () => Promise<unknown[]> },
      "getSkillFiles",
    ).mockResolvedValue([{ path: "SKILL.md", contentText: "# Ours" }]);
    const result = await instance.getCatalogSkillDetail({
      ...input,
      userId: "stranger",
    });
    expect(result.skillContent).toBe("# Ours");
    expect("contentRestricted" in result).toBe(false);
  }
});

test("the by-slug detail applies the same rule", async () => {
  mocks.getRegistryVersionDetail.mockResolvedValue(documents);
  const instance = service();
  vi.spyOn(
    instance as unknown as {
      findStoredCatalogItemBySlug: () => Promise<SkillCatalogItem | null>;
    },
    "findStoredCatalogItemBySlug",
  ).mockResolvedValue({
    catalogId: input.catalogId,
    skillId: "skill",
    skillVersionId: "version",
    sourceType: "registry_github",
    enabledWorkspaceSkillId: null,
  } as SkillCatalogItem);
  const result = await instance.getCatalogSkillDetailBySlug({
    teamId: "team",
    workspaceId: "workspace",
    userId: "stranger",
    slug: "gh-o-r-pdf",
  });
  expect(result.skillContent).toBeNull();
  expect(result.contentRestricted).toBe(true);
});
