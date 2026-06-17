import {
  READ_FILE_TOOL_NAME,
  GREP_TOOL_NAME,
  SEARCH_SOURCES_TOOL_NAME,
} from "@sourceweft/contracts/agent-tools";

export type FilesystemEvidenceRole =
  | "source_evidence"
  | "working_memory"
  | "instruction";

export type AgentFilesystemMountCapability = {
  root: string;
  label: string;
  readable: boolean;
  writable: boolean;
  citable: boolean;
  persisted: boolean;
  threadScoped: boolean;
  internal: boolean;
  userVisible: boolean;
  evidenceRole: FilesystemEvidenceRole;
  purpose: string;
  readPolicy: string;
  writePolicy: string;
  citationPolicy: string;
  pathPolicy: string;
};

export type AgentFilesystemPromptOptions = {
  mounts?: AgentFilesystemMountCapability[];
};

export const KB_READ_FILE_DEFAULT_LINE_LIMIT = 100;
export const KB_READ_FILE_MAX_LINE_LIMIT = 1000;

export const KNOWLEDGE_MOUNT: AgentFilesystemMountCapability = {
  root: "/kb",
  label: "Source Library knowledge",
  readable: true,
  writable: false,
  citable: true,
  persisted: true,
  threadScoped: false,
  internal: true,
  userVisible: false,
  evidenceRole: "source_evidence",
  purpose:
    "Primary source evidence filesystem. It is a read-only markdown view assembled from indexed workspace source records and scoped to the current turn's selected source tree.",
  readPolicy: `Use /kb for source-wide coverage, summarization, review, comparison, full-document analysis, extraction, listing source contents, or surrounding context after ${SEARCH_SOURCES_TOOL_NAME}.`,
  writePolicy: "Never write or edit /kb; it is read-only.",
  citationPolicy: `/kb ${READ_FILE_TOOL_NAME}, ${GREP_TOOL_NAME}, and ${SEARCH_SOURCES_TOOL_NAME} outputs may include [citation:cN] markers. Final-answer factual claims based on /kb content must copy the relevant markers exactly.`,
  pathPolicy:
    "Do not mention /kb paths in the final answer unless the user explicitly asks for file paths; refer to /kb evidence as sources or selected sources.",
};

export const WORK_MOUNT: AgentFilesystemMountCapability = {
  root: "/workfiles",
  label: "Workfiles",
  readable: true,
  writable: true,
  citable: false,
  persisted: true,
  threadScoped: true,
  internal: false,
  userVisible: true,
  evidenceRole: "working_memory",
  purpose:
    "Database-persisted, thread-scoped Workfiles for assistant-created process notes, plans, drafts, extracted intermediate records, outlines, calculations, and candidate final outputs.",
  readPolicy:
    "Read /workfiles to continue prior work in the same thread, reuse drafts, inspect intermediate records, or supplement the current task with persisted working context.",
  writePolicy:
    "Write and edit only /workfiles paths. Create Workfiles when a task is complex, multi-step, long-running, resumable, or benefits from persisted plans, notes, extracted data, calculations, drafts, or candidate outputs; skip Workfiles for simple one-shot answers where the final response is enough. Choose clear nested paths for multi-step or multi-output work.",
  citationPolicy:
    "/workfiles is not workspace source evidence and never provides citations. If /workfiles contains factual claims, verify them against /kb or another citable source before using them in a source-grounded final answer.",
  pathPolicy:
    "/workfiles paths are user-visible as Workfiles and may be mentioned when relevant to persistent working material.",
};

export const SKILLS_MOUNT: AgentFilesystemMountCapability = {
  root: "/skills",
  label: "selected skills",
  readable: true,
  writable: false,
  citable: false,
  persisted: false,
  threadScoped: false,
  internal: true,
  userVisible: false,
  evidenceRole: "instruction",
  purpose:
    "Read-only view of selected skill instructions and supporting workflow resources.",
  readPolicy:
    "Use /skills only to load workflow instructions, templates, output-shape guidance, or task-specific review checklists.",
  writePolicy: "Never write or edit /skills; it is read-only.",
  citationPolicy:
    "/skills is instruction material, not workspace source evidence. Do not cite /skills content or use it as proof for factual claims.",
  pathPolicy:
    "Do not mention /skills paths in the final answer unless the user explicitly asks for file paths.",
};

export function createDefaultFilesystemMounts(input?: {
  skillsEnabled?: boolean;
}) {
  return [
    KNOWLEDGE_MOUNT,
    WORK_MOUNT,
    ...(input?.skillsEnabled ? [SKILLS_MOUNT] : []),
  ];
}
