import type { useTranslations } from "next-intl";
import {
  getAgentToolConnectorType,
  isAgentToolDomain,
} from "@sourceweft/agent-tool-registry";
import { connectorCatalog } from "../sources-hub/connectors/catalog";
import {
  getToolDisplayName,
  isRedactedSkillInstructionRead,
} from "./assistant-tool-display";
import { getRecordValue } from "../../../../../lib/records";
import type { ToolCallRecord } from "./types";

type Translate = ReturnType<typeof useTranslations>;

/** Categories beyond the third collapse into "and N more". */
const MAX_SUMMARY_CATEGORIES = 3;

const READ_FILE_TOOLS = new Set(["read_file"]);
const SEARCH_FILE_TOOLS = new Set(["ls", "glob", "grep"]);
const EDIT_FILE_TOOLS = new Set(["write_file", "edit_file"]);
const COMMAND_TOOLS = new Set(["execute"]);

/**
 * What a tool call did, coarse enough to summarize a run of calls in one line.
 * `key` deduplicates within a summary; file categories carry the path they
 * touched so the summary can count distinct files.
 */
export type ToolActivityCategory =
  | { key: "command"; kind: "command" }
  | { key: "read"; kind: "read"; path: string | null }
  | { key: "edit"; kind: "edit"; path: string | null }
  | { key: "search-files"; kind: "search-files" }
  | { key: "skill"; kind: "skill" }
  | { key: "web"; kind: "web" }
  | { key: "sources"; kind: "sources" }
  | { key: string; kind: "connector"; name: string }
  | { key: string; kind: "tool"; name: string };

function getInputPath(input: Record<string, unknown> | undefined) {
  for (const key of ["file_path", "path", "filePath"]) {
    const value = getRecordValue(input, key);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function getConnectorName(connectorType: string) {
  return (
    connectorCatalog.find((item) => item.id === connectorType)?.name ??
    getToolDisplayName(connectorType)
  );
}

/** Tool name without the `mcp__<serverKey>__` prefix the MCP client adds. */
function getMcpToolName(toolName: string) {
  const match = /^mcp__.+?__(.+)$/.exec(toolName);
  return match?.[1] ?? null;
}

export function getToolActivityCategory(
  toolCall: ToolCallRecord,
): ToolActivityCategory {
  const tool = toolCall.tool;
  if (COMMAND_TOOLS.has(tool)) {
    return { key: "command", kind: "command" };
  }
  if (READ_FILE_TOOLS.has(tool)) {
    if (isRedactedSkillInstructionRead(toolCall)) {
      return { key: "skill", kind: "skill" };
    }
    return { key: "read", kind: "read", path: getInputPath(toolCall.input) };
  }
  if (EDIT_FILE_TOOLS.has(tool)) {
    return { key: "edit", kind: "edit", path: getInputPath(toolCall.input) };
  }
  if (SEARCH_FILE_TOOLS.has(tool)) {
    return { key: "search-files", kind: "search-files" };
  }
  if (isAgentToolDomain(tool, "web")) {
    return { key: "web", kind: "web" };
  }
  if (isAgentToolDomain(tool, "retrieval")) {
    return { key: "sources", kind: "sources" };
  }
  const connectorType = getAgentToolConnectorType(tool);
  if (connectorType) {
    return {
      key: `connector:${connectorType}`,
      kind: "connector",
      name: getConnectorName(connectorType),
    };
  }
  // MCP server keys are sanitized install ids, not display names, so name the
  // tool itself rather than guessing a server label.
  const mcpToolName = getMcpToolName(tool);
  const name = getToolDisplayName(mcpToolName ?? tool);
  return { key: `tool:${name}`, kind: "tool", name };
}

type CategoryTally = {
  category: ToolActivityCategory;
  calls: number;
  paths: Set<string>;
};

function formatCategory(tally: CategoryTally, t: Translate) {
  const { category } = tally;
  switch (category.kind) {
    case "command":
      return t("toolGroup.command", { count: tally.calls });
    case "read":
      return t("toolGroup.read", { count: tally.paths.size });
    case "edit":
      return t("toolGroup.edit", { count: tally.paths.size });
    case "search-files":
      return t("toolGroup.searchFiles");
    case "skill":
      return t("toolGroup.skill");
    case "web":
      return t("toolGroup.web");
    case "sources":
      return t("toolGroup.sources");
    case "connector":
    case "tool":
      return t("toolGroup.used", { name: category.name });
  }
}

function capitalizeFirst(value: string, locale: string) {
  const first = value.charAt(0);
  return first.toLocaleUpperCase(locale) + value.slice(1);
}

/**
 * One-line summary of a run of tool calls, e.g. "Used Gmail, read 3 files,
 * and ran a command". Categories keep first-seen order and are counted once;
 * only commands and file reads/edits carry a count.
 */
export function summarizeToolGroup(input: {
  locale: string;
  t: Translate;
  toolCalls: ToolCallRecord[];
}): string {
  const tallies = new Map<string, CategoryTally>();
  for (const toolCall of input.toolCalls) {
    const category = getToolActivityCategory(toolCall);
    const tally = tallies.get(category.key) ?? {
      calls: 0,
      category,
      paths: new Set<string>(),
    };
    tally.calls += 1;
    if ("path" in category && category.path) {
      tally.paths.add(category.path);
    }
    tallies.set(category.key, tally);
  }

  const phrases = [...tallies.values()].map((tally) =>
    formatCategory(tally, input.t),
  );
  if (phrases.length === 0) {
    return "";
  }
  const visible = phrases.slice(0, MAX_SUMMARY_CATEGORIES);
  const hiddenCount = phrases.length - visible.length;
  if (hiddenCount > 0) {
    visible.push(input.t("toolGroup.more", { count: hiddenCount }));
  }
  const summary = new Intl.ListFormat(input.locale, {
    type: "conjunction",
  }).format(visible);
  return capitalizeFirst(summary, input.locale);
}
