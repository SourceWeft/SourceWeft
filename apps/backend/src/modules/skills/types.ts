import type { SkillManifestJson } from "@sourceweft/db";
import type { SkillBundleFile } from "./builtin";

export type SkillSourceType =
  | "builtin"
  | "workspace_custom"
  | "team_custom"
  // GitHub registry index entries: pointer + metadata only, content
  // fetched-on-use (docs/architecture/skill-registry-index.md).
  | "registry_github";

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
  /**
   * Set when the option's values are narrowed by the selected model. The host
   * only forwards it; resolving it is the client's job and the meaning is the
   * capability's.
   */
  modelValues?: {
    key: string;
    path: string;
  };
  values: Array<{
    value: string | number | boolean;
    label?: string;
  }>;
};

export type EnabledSkillDescriptor = {
  skillVersionId?: string;
  workspaceSkillId: string;
  selectionId?: string;
  sourceType: SkillSourceType;
  name: string;
  displayName?: string;
  version: string;
  description: string;
  /** Passive turn selection; it does not make runtime policy mandatory. */
  defaultEnabled?: boolean;
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
  /** Registry entries only — see the contracts schema for why it is surfaced. */
  registryCapability?: "prompt-only" | "executable";
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
  // Registry (`sourceType='registry_github'`) attribution + trust surface for the
  // gallery, populated only for registry entries (undefined otherwise).
  // `publisher` is "Community"; `verified` is always false (trust firewall — never
  // self-asserted); `flagged` reflects the ingest scan's reviewRequired;
  // `sourceUrl`/`license` satisfy index-level attribution.
  // skill-registry-index.md §0/§5.5.
  publisher?: string | null;
  verified?: boolean;
  sourceUrl?: string | null;
  license?: string | null;
  flagged?: boolean;
};
