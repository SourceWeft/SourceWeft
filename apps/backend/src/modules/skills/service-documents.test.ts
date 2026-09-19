import { expect, test, vi } from "vitest";
import { ContentSkillsService } from "./service";
import type { SkillCatalogItem } from "./types";

const mocks = vi.hoisted(() => ({ getRegistryVersionDetail: vi.fn() }));
vi.mock("./registry/versions", async (original) => ({
  ...(await original<typeof import("./registry/versions")>()),
  getRegistryVersionDetail: mocks.getRegistryVersionDetail,
}));

const input = {
  teamId: "team",
  workspaceId: "workspace",
  userId: "submitter",
  catalogId: "skill:version",
};
function service() {
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
  } as SkillCatalogItem);
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
