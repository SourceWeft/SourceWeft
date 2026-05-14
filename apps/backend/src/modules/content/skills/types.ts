import type { SkillBundleFile } from "./builtin";

export type SkillSourceType = "builtin" | "workspace_custom" | "team_custom";

export type SkillCommandDescriptor = {
  id: string;
  name: string;
  canonicalName: string;
  displayName: string;
  description: string;
  path: string;
  argumentHint?: string;
  title?: string;
  skillSlugs?: string[];
  tools?: string[];
  model?: string;
  instruction?: string;
  slash?: boolean;
};

export type EnabledSkillDescriptor = {
  workspaceSkillId: string;
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
  commands?: SkillCommandDescriptor[];
  tools?: string[];
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

export type SkillCatalogItem = {
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
  enabledWorkspaceSkillId: string | null;
  enabled: boolean;
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
  commands?: SkillCommandDescriptor[];
  tools?: string[];
  slash?: boolean;
  slashConfig?: {
    enabled?: boolean;
  };
  defaultConfig?: Record<string, unknown>;
};
