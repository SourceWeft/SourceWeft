/**
 * Built-in personas: the code-defined, read-only roster (the "channel index"
 * in LobeHub terms). They are the same three roles the parent agent can spawn
 * through the `task` tool, so a user who opens one gets exactly the delegate
 * they saw working inside a chat — now as a thread they can keep talking to.
 *
 * No database row backs these; the registry composes them at import time from
 * the delegate definitions in `../subagents/*`, so the roster and the delegates
 * cannot drift apart.
 */
import { GENERAL_PURPOSE_SUBAGENT } from "deepagents";
import {
  EXPLORE_DESCRIPTION,
  EXPLORE_SUBAGENT_NAME,
  EXPLORE_SYSTEM_PROMPT,
} from "../subagents/explore";
import {
  PLAN_DESCRIPTION,
  PLAN_SUBAGENT_NAME,
  PLAN_SYSTEM_PROMPT,
} from "../subagents/plan";
import {
  READ_ONLY_BUSINESS_TOOL_NAMES,
  READ_ONLY_FILESYSTEM_PERMISSIONS,
} from "../subagents/read-only";
import type { PersonaSpec } from "./types";

const readOnlyToolAllowlist = Object.freeze([...READ_ONLY_BUSINESS_TOOL_NAMES]);

export const BUILTIN_PERSONAS: readonly PersonaSpec[] = Object.freeze([
  {
    slug: GENERAL_PURPOSE_SUBAGENT.name,
    name: "General purpose",
    description: GENERAL_PURPOSE_SUBAGENT.description,
    systemPrompt: GENERAL_PURPOSE_SUBAGENT.systemPrompt,
    trust: "system",
  },
  {
    slug: EXPLORE_SUBAGENT_NAME,
    name: "Explore",
    description: EXPLORE_DESCRIPTION,
    systemPrompt: EXPLORE_SYSTEM_PROMPT,
    toolAllowlist: readOnlyToolAllowlist,
    filesystemPermissions: READ_ONLY_FILESYSTEM_PERMISSIONS,
    trust: "system",
  },
  {
    slug: PLAN_SUBAGENT_NAME,
    name: "Plan",
    description: PLAN_DESCRIPTION,
    systemPrompt: PLAN_SYSTEM_PROMPT,
    toolAllowlist: readOnlyToolAllowlist,
    filesystemPermissions: READ_ONLY_FILESYSTEM_PERMISSIONS,
    trust: "system",
  },
]);
