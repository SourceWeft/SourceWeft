import type { FilesystemPermission } from "deepagents";

/**
 * Who authored a persona. `system` personas ship with the product and are
 * read-only; `user` personas are workspace-authored (a later phase) and are
 * created by cloning a built-in, never by posting raw configuration.
 */
export type PersonaTrust = "system" | "user";

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
  /** Stable identifier; built-ins reuse the delegate `subagent_type`. */
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
};
