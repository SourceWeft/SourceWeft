import type { SkillManifestJson } from "@sourceweft/db";
import type { SkillBundleFile } from "./builtin";

export type SkillSourceType = "builtin" | "workspace_custom" | "team_custom";

export type SkillOptionDescriptor = {
  id: string;
  title: string;
  description?: string;
  valueType: "string" | "number" | "boolean";
  defaultValue?: string | number | boolean;
  target: {
    toolName?: string;
    path: string;
  };
  values: Array<{
    value: string | number | boolean;
    label?: string;
  }>;
};

export type EnabledSkillDescriptor = {
  workspaceSkillId: string;
  selectionId?: string;
  sourceType: SkillSourceType;
  name: string;
  displayName?: string;
  version: string;
  description: string;
  capabilities?: {
    required?: string[];
    optional?: string[];
  };
  models?: {
    chat?: string;
    image?: string;
    vision?: string;
  };
  commands?: NonNullable<SkillManifestJson["commands"]>;
  tools?: string[];
  options?: SkillOptionDescriptor[];
  slash?: boolean;
  slashConfig?: {
    enabled?: boolean;
  };
  defaultConfig?: Record<string, unknown>;
  files: SkillBundleFile[];
};

export type WorkspaceSkillRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  skillId: string;
  skillVersionId: string;
  enabled: boolean;
  configJson: Record<string, unknown>;
  enabledBy: string | null;
  enabledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceInstalledSkillItem = {
  workspaceSkillId: string;
  selectionId: string;
  catalogId: string;
  sourceType: SkillSourceType;
  skillId: string;
  skillVersionId: string;
  slug: string;
  name: string;
  version: string;
  displayName: string;
  description: string;
  visibility: "public" | "restricted" | "workspace" | "team";
  categories: string[];
  enabled: boolean;
  configJson: Record<string, unknown>;
  enabledBy: string | null;
  enabledAt: string | null;
  capabilities?: {
    required?: string[];
    optional?: string[];
  };
  models?: {
    chat?: string;
    image?: string;
    vision?: string;
  };
  commands?: NonNullable<SkillManifestJson["commands"]>;
  tools?: string[];
  options?: SkillOptionDescriptor[];
  slash?: boolean;
  slashConfig?: {
    enabled?: boolean;
  };
  defaultConfig?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type SkillCatalogItem = {
  catalogId: string;
  selectionId: string | null;
  sourceType: SkillSourceType;
  skillId: string;
  skillVersionId: string;
  slug: string;
  name: string;
  version: string;
  displayName: string;
  description: string;
  visibility: "public" | "restricted" | "workspace" | "team";
  categories: string[];
  enabledWorkspaceSkillId: string | null;
  enabled: boolean;
  installable: boolean;
  defaultEnabled?: boolean;
  hasReadme: boolean;
  capabilities?: {
    required?: string[];
    optional?: string[];
  };
  models?: {
    chat?: string;
    image?: string;
    vision?: string;
  };
  commands?: NonNullable<SkillManifestJson["commands"]>;
  tools?: string[];
  options?: SkillOptionDescriptor[];
  slash?: boolean;
  slashConfig?: {
    enabled?: boolean;
  };
  defaultConfig?: Record<string, unknown>;
};
