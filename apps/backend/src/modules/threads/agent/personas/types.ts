import type { FilesystemPermission } from "deepagents";

/**
 * Who authored a persona. `system` personas ship with the product and are
 * read-only; `user` personas are workspace-authored rows created by cloning
 * a built-in (or another row), never by posting raw configuration.
 */
export type PersonaTrust = "system" | "user";

/** `read_only` keeps a persona, or a clone of one, from writing files. */
export type PersonaFilesystemPolicy = "default" | "read_only";

/**
 * The model a persona prefers. Stamped into the child thread's model settings
 * at creation time, so the existing per-thread model resolution applies
 * unchanged and the user can still override it per thread. Absent = inherit
 * the workspace default.
 */
export type PersonaModelSettings = {
  llmProfileAlias?: string | null;
  llmModelAlias?: string | null;
};

/**
 * A chat-able agent persona. Mirrors deepagents' `SubAgent` declaration
 * (name / description / systemPrompt / optional model / optional tools) so a
 * persona can drive a thread of its own — its own top-level graph on its own
 * checkpoint — instead of only being spawned as a stateless `task` delegate.
 */
export type PersonaSpec = {
  /**
   * Stable identifier and what `threads.persona_id` stores: the delegate
   * `subagent_type` for a built-in, the row id for a workspace persona.
   */
  slug: string;
  /** Display name shown in the sidebar and the persona gallery. */
  name: string;
  /** What the persona is for, in the user's terms. */
  description: string;
  /** Replaces the default assistant identity when the persona owns a thread. */
  systemPrompt: string;
  modelSettings?: PersonaModelSettings;
  /**
   * Business tools the persona may use. Undefined inherits the thread's normal
   * tool set; a list restricts the bound tools to exactly these names. The
   * filesystem read/write tools are governed by {@link filesystemPermissions}
   * instead — they are middleware, not bound business tools.
   */
  toolAllowlist?: readonly string[];
  /** Filesystem policy for the persona's thread. Undefined = the thread default. */
  filesystemPermissions?: readonly FilesystemPermission[];
  skills?: readonly string[];
  avatar?: string;
  trust: PersonaTrust;
  /** Set on workspace personas: what the row was cloned from. */
  clonedFrom?: string | null;
  /** Set on workspace personas: the member who created the row. */
  createdBy?: string | null;
  /** Set on workspace personas: last edit time, ISO 8601. */
  updatedAt?: string | null;
};
