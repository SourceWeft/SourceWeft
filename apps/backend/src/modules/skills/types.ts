import type { SkillManifestJson } from "@sourceweft/db";

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

/**
 * One file of a skill as a turn sees it: everything about the file except its
 * bytes. Listing, globbing and sandbox planning work from this alone.
 */
export type SkillFileManifestEntry = {
  path: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  /** False for bytes the model cannot read (fonts, images, archives). */
  isText: boolean;
};

export type SkillFileContent =
  { text: string } | { binary: true; sizeBytes: number };

/**
 * Fetches one file's content by its bundle-relative path, from wherever the
 * skill's storage type keeps it. Rejects for a path outside the manifest.
 */
export type SkillFileReader = (path: string) => Promise<SkillFileContent>;

/** The stored zip of an `object` version — what the sandbox downloads. */
export type SkillStoredBundle = {
  sha256: string;
  objectKey: string;
  sizeBytes: number;
  /**
   * Makes sure the object is there before it is handed to a sandbox: object
   * storage is a cache of a community skill, and a missing bundle is restored
   * from the pinned source (`storage/restore.ts`). Absent where there is no
   * source to go back to.
   */
  ensureStored?: () => Promise<void>;
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
  /**
   * The file MANIFEST — never bodies. Resolving a turn's skills used to load
   * every file of every enabled skill; now a body is fetched when read.
   */
  files: SkillFileManifestEntry[];
  /**
   * SKILL.md's text, available up front for every storage type. Optional only
   * so metadata-only descriptors (prompt/tool-selection fixtures) stay valid;
   * `resolveSelectedSkills` always sets it, and `readFile` with it.
   */
  skillMd?: string;
  /** Lazy content, bound to the skill's storage type; cached for the turn. */
  readFile?: SkillFileReader;
  /**
   * Raw bytes of one file, for building the sandbox bundle in process. Set for
   * builtins, whose binary files (fonts, images) live on disk and have no
   * stored bundle. Never used to show the model anything.
   */
  readBytes?: (path: string) => Promise<Uint8Array>;
  /**
   * Set for `object` versions only: the sandbox stages this stored bundle.
   * Without it (`db_text`, `repo_builtin`) the bundle is zipped in process.
   */
  bundle?: SkillStoredBundle;
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
  /** `agent`: installed by the chat agent on its own initiative. */
  installedVia: "user" | "agent";
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceInstalledSkillItem = {
  logo?: SkillManifestJson["logo"];
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
  /** `agent`: installed by the chat agent on its own initiative. */
  installedVia: "user" | "agent";
  /** The skill's published current version; null while there is none. */
  currentVersionId: string | null;
  /** True when `currentVersionId` exists and is not the installed version. */
  updateAvailable: boolean;
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
  logo?: SkillManifestJson["logo"];
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
  // `publisher` is "Community"; `verified` is the market admin's grant (trust
  // firewall — never self-asserted); `flagged` reflects the ingest scan's
  // reviewRequired; `sourceUrl`/`license` satisfy index-level attribution.
  // skill-registry-index.md §0/§5.5.
  publisher?: string | null;
  verified?: boolean;
  sourceUrl?: string | null;
  license?: string | null;
  flagged?: boolean;
  // Market surface of a registry entry, whose `categories` are then the
  // market's category slugs. `listedAt` is null while it is not listed.
  installCount?: number;
  listedAt?: string | null;
  capability?: "prompt-only" | "executable" | null;
};
