import { ContentError } from "../errors";
import {
  listBuiltinSkills,
  loadBuiltinSkillBundle,
  validateBuiltinSkills,
} from "./builtin";
import {
  createNextCustomSkillVersionDraft,
  createWorkspaceCustomSkillDraft,
  deleteCustomSkillVersionFileRecord,
  deleteWorkspaceSkillRecord,
  findCatalogSkillVersionForWorkspace,
  findWorkspaceCustomDraftVersion,
  listCatalogSkillVersionsForWorkspace,
  listCustomSkillVersionFileRecords,
  listWorkspaceSkillRecords,
  loadSkillVersionBundle,
  publishWorkspaceCustomSkillVersion,
  syncBuiltinSkillMetadata,
  updateWorkspaceCustomDraftMetadata,
  updateWorkspaceSkillRecord,
  upsertCustomSkillVersionFile,
  upsertWorkspaceSkill,
} from "./repository";
import {
  validateCustomSkillBundle,
  validateCustomSkillFileInput,
} from "./custom-validation";
import type { SkillCatalogItem } from "./types";

function displayNameFromName(name: string) {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export class ContentSkillsService {
  async syncBuiltinCatalog() {
    await validateBuiltinSkills();
    const synced = [];
    for (const skill of await listBuiltinSkills()) {
      synced.push(await syncBuiltinSkillMetadata({
        slug: skill.slug,
        displayName: skill.displayName,
        description: skill.description,
        visibility: skill.visibility,
        version: skill.version,
        storagePointer: skill.storagePointer,
        contentHash: skill.contentHash,
        manifestJson: skill.manifestJson,
      }));
    }
    return { items: synced };
  }

  async validateBuiltinCatalog() {
    await validateBuiltinSkills();
  }

  async listCatalog(input: { teamId: string; workspaceId: string }) {
    const rows = await listCatalogSkillVersionsForWorkspace(input);
    const items: SkillCatalogItem[] = rows.map((row) => {
      const manifest = row.version.manifestJson;
      return {
        catalogId: `${row.definition.id}:${row.version.id}`,
        sourceType: row.definition.sourceType,
        skillId: row.definition.id,
        skillVersionId: row.version.id,
        slug: row.definition.slug,
        name: row.definition.displayName,
        version: row.version.version,
        displayName: row.definition.displayName,
        description: row.definition.description,
        visibility: row.definition.visibility,
        categories: Array.isArray(manifest.categories) ? manifest.categories : [],
        enabledWorkspaceSkillId: row.enabled?.id ?? null,
        enabled: row.enabled?.enabled ?? false,
        hasReadme: false,
        capabilities: manifest.capabilities,
        models: manifest.models,
        commands: manifest.commands,
        tools: manifest.tools,
        slash: manifest.slash,
        slashConfig: manifest.slashConfig,
        defaultConfig: manifest.defaultConfig,
      };
    });
    await Promise.all(
      items.map(async (item) => {
        item.hasReadme = Boolean(await this.getSkillReadmeContent(input, item));
      }),
    );
    return { items };
  }

  async listWorkspaceSkills(input: { teamId: string; workspaceId: string }) {
    return { items: await listWorkspaceSkillRecords(input) };
  }

  async getCatalogSkillDetail(input: {
    teamId: string;
    workspaceId: string;
    catalogId: string;
  }) {
    const catalog = await this.listCatalog(input);
    const item = catalog.items.find((candidate) => candidate.catalogId === input.catalogId);
    if (!item) {
      throw new ContentError(404, "SKILL_NOT_FOUND", "Skill not found");
    }

    const files = await this.getSkillFiles(input, item);
    return {
      skill: item,
      readmeContent: files.find((file) => file.path === "README.md")?.contentText ?? null,
      skillContent: files.find((file) => file.path === "SKILL.md")?.contentText ?? null,
    };
  }

  private async getSkillReadmeContent(
    input: { teamId: string; workspaceId: string },
    item: SkillCatalogItem,
  ) {
    return (await this.getSkillFiles(input, item))
      .find((file) => file.path === "README.md")
      ?.contentText ?? null;
  }

  private async getSkillFiles(
    input: { teamId: string; workspaceId: string },
    item: SkillCatalogItem,
  ) {
    const bundle = await loadSkillVersionBundle({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      skillId: item.skillId,
      skillVersionId: item.skillVersionId,
    });
    if (!bundle) {
      return [];
    }
    if (bundle.version.storageType === "repo_builtin") {
      return (await loadBuiltinSkillBundle(bundle.version.storagePointer))
        ?.files ?? [];
    }
    return bundle.files;
  }

  async enableSkill(input: {
    teamId: string;
    workspaceId: string;
    userId: string;
    skillId: string;
    skillVersionId: string;
    configJson?: Record<string, unknown>;
  }) {
    const skill = await findCatalogSkillVersionForWorkspace(input);
    if (!skill) {
      throw new ContentError(404, "SKILL_NOT_FOUND", "Skill not found or not available to this workspace");
    }
    return {
      workspaceSkill: await upsertWorkspaceSkill({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        skillId: input.skillId,
        skillVersionId: input.skillVersionId,
        enabledBy: input.userId,
        configJson: input.configJson,
      }),
    };
  }

  async createWorkspaceCustomSkill(input: {
    teamId: string;
    workspaceId: string;
    userId: string;
    name: string;
    displayName?: string;
    description: string;
    version?: string;
  }) {
    return {
      customSkill: await createWorkspaceCustomSkillDraft({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        name: input.name,
        displayName: input.displayName ?? displayNameFromName(input.name),
        description: input.description,
        version: input.version,
      }),
    };
  }

  async createWorkspaceCustomSkillVersion(input: {
    teamId: string;
    workspaceId: string;
    skillId: string;
    userId: string;
    version: string;
  }) {
    const customSkill = await createNextCustomSkillVersionDraft(input);
    if (!customSkill) {
      throw new ContentError(404, "CUSTOM_SKILL_NOT_FOUND", "Custom skill not found");
    }
    return { customSkill };
  }

  async updateWorkspaceCustomSkillVersion(input: {
    teamId: string;
    workspaceId: string;
    skillId: string;
    skillVersionId: string;
    displayName?: string;
    description?: string;
  }) {
    const draft = await updateWorkspaceCustomDraftMetadata(input);
    if (!draft) {
      throw new ContentError(404, "CUSTOM_SKILL_DRAFT_NOT_FOUND", "Custom skill draft version not found");
    }
    return { customSkill: draft };
  }

  async putWorkspaceCustomSkillVersionFile(input: {
    teamId: string;
    workspaceId: string;
    skillId: string;
    skillVersionId: string;
    path: string;
    contentText: string;
    mimeType?: string | null;
  }) {
    const file = validateCustomSkillFileInput({
      path: input.path,
      contentText: input.contentText,
      mimeType: input.mimeType,
    });
    const saved = await upsertCustomSkillVersionFile({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      skillId: input.skillId,
      skillVersionId: input.skillVersionId,
      file,
    });
    if (!saved) {
      throw new ContentError(404, "CUSTOM_SKILL_DRAFT_NOT_FOUND", "Custom skill draft version not found");
    }
    return { file: saved };
  }

  async deleteWorkspaceCustomSkillVersionFile(input: {
    teamId: string;
    workspaceId: string;
    skillId: string;
    skillVersionId: string;
    path: string;
  }) {
    const file = validateCustomSkillFileInput({
      path: input.path,
      contentText: "",
    });
    const deleted = await deleteCustomSkillVersionFileRecord({
      ...input,
      path: file.path,
    });
    if (!deleted) {
      throw new ContentError(404, "CUSTOM_SKILL_FILE_NOT_FOUND", "Custom skill draft file not found");
    }
    return { deleted: true as const, path: file.path };
  }

  async publishWorkspaceCustomSkillVersion(input: {
    teamId: string;
    workspaceId: string;
    skillId: string;
    skillVersionId: string;
  }) {
    const draft = await findWorkspaceCustomDraftVersion(input);
    if (!draft) {
      throw new ContentError(404, "CUSTOM_SKILL_DRAFT_NOT_FOUND", "Custom skill draft version not found");
    }
    const files = await listCustomSkillVersionFileRecords({
      skillVersionId: input.skillVersionId,
    });
    const bundle = validateCustomSkillBundle({
      files: files.map((file) => ({
        path: file.path,
        contentText: file.contentText,
        mimeType: file.mimeType,
      })),
    });
    const expectedVisibility = draft.definition.sourceType === "team_custom" ? "team" : "workspace";
    if (bundle.manifestJson.visibility !== expectedVisibility) {
      throw new ContentError(400, "CUSTOM_SKILL_VISIBILITY_MISMATCH", "Custom skill manifest visibility does not match its scope");
    }
    if (bundle.name !== draft.definition.slug) {
      throw new ContentError(400, "CUSTOM_SKILL_SLUG_MISMATCH", "Custom skill manifest slug cannot change after creation");
    }

    const customSkill = await publishWorkspaceCustomSkillVersion({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      skillId: input.skillId,
      skillVersionId: input.skillVersionId,
      name: bundle.name,
      displayName: bundle.displayName,
      description: bundle.description,
      version: bundle.version,
      contentHash: bundle.contentHash,
      manifestJson: bundle.manifestJson,
    });
    if (!customSkill) {
      throw new ContentError(404, "CUSTOM_SKILL_DRAFT_NOT_FOUND", "Custom skill draft version not found");
    }
    return { customSkill };
  }

  async updateWorkspaceSkill(input: {
    teamId: string;
    workspaceId: string;
    userId: string;
    workspaceSkillId: string;
    enabled?: boolean;
    configJson?: Record<string, unknown>;
  }) {
    const workspaceSkill = await updateWorkspaceSkillRecord(input);
    if (!workspaceSkill) {
      throw new ContentError(404, "WORKSPACE_SKILL_NOT_FOUND", "Workspace skill not found");
    }
    return { workspaceSkill };
  }

  async deleteWorkspaceSkill(input: {
    teamId: string;
    workspaceId: string;
    workspaceSkillId: string;
  }) {
    const deleted = await deleteWorkspaceSkillRecord(input);
    if (!deleted) {
      throw new ContentError(404, "WORKSPACE_SKILL_NOT_FOUND", "Workspace skill not found");
    }
    return { deleted: true as const, workspaceSkillId: input.workspaceSkillId };
  }
}

export const contentSkillsService = new ContentSkillsService();
