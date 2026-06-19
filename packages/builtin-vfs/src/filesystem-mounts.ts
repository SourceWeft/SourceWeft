import {
  READ_FILE_TOOL_NAME,
  GREP_TOOL_NAME,
  SEARCH_SOURCES_TOOL_NAME,
} from "@sourceweft/contracts/agent-tools";

export type FilesystemEvidenceRole =
  | "source_evidence"
  | "working_memory"
  | "instruction"
  | "runtime_sandbox";

export type AgentFilesystemReadFileContract = {
  contentKind: "utf8-text-only" | "markdown-source-view";
  pagination: "source-line-offset" | "line-offset";
  allowedExamples: readonly string[];
  deniedExamples: readonly string[];
};

export type AgentFilesystemBinaryHandlingContract = {
  preferredTools: readonly string[];
};

export type AgentFilesystemMountCapability = {
  root: string;
  backendKind: "knowledge" | "workfiles" | "skills" | "sandbox";
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
  readFile: AgentFilesystemReadFileContract;
  binaryHandling?: AgentFilesystemBinaryHandlingContract;
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
  backendKind: "knowledge",
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
  readFile: {
    contentKind: "markdown-source-view",
    pagination: "source-line-offset",
    allowedExamples: [
      "canonical markdown",
      "source-wide context",
      "surrounding context",
      "indexed source text",
    ],
    deniedExamples: [
      "raw binaries",
      "source attachments that have no indexed readable text",
    ],
  },
  readPolicy: `Use /kb for source-wide coverage, summarization, review, comparison, full-document analysis, extraction, listing source contents, or surrounding context after ${SEARCH_SOURCES_TOOL_NAME}.`,
  writePolicy: "Never write or edit /kb; it is read-only.",
  citationPolicy: `/kb ${READ_FILE_TOOL_NAME}, ${GREP_TOOL_NAME}, and ${SEARCH_SOURCES_TOOL_NAME} outputs may include [citation:cN] markers. Final-answer factual claims based on /kb content must copy the relevant markers exactly.`,
  pathPolicy:
    "Do not mention /kb paths in the final answer unless the user explicitly asks for file paths; refer to /kb evidence as sources or selected sources.",
};

export const WORK_MOUNT: AgentFilesystemMountCapability = {
  root: "/workfiles",
  backendKind: "workfiles",
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
  readFile: {
    contentKind: "utf8-text-only",
    pagination: "line-offset",
    allowedExamples: [
      "plans",
      "notes",
      "drafts",
      "markdown",
      "json",
      "csv",
      "plain text",
    ],
    deniedExamples: [
      "images",
      "PDFs",
      "PPTX decks",
      "ZIP archives",
      "video",
      "audio",
    ],
  },
  binaryHandling: {
    preferredTools: ["publish_artifact", "artifact preview"],
  },
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
  backendKind: "skills",
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
  readFile: {
    contentKind: "utf8-text-only",
    pagination: "line-offset",
    allowedExamples: [
      "skill instructions",
      "workflow templates",
      "output-shape guidance",
      "review checklists",
    ],
    deniedExamples: ["binary assets", "archives", "media files"],
  },
  readPolicy:
    "Use /skills only to load workflow instructions, templates, output-shape guidance, or task-specific review checklists.",
  writePolicy: "Never write or edit /skills; it is read-only.",
  citationPolicy:
    "/skills is instruction material, not workspace source evidence. Do not cite /skills content or use it as proof for factual claims.",
  pathPolicy:
    "Do not mention /skills paths in the final answer unless the user explicitly asks for file paths.",
};

export function createSandboxFilesystemMount(input?: {
  root?: string;
}): AgentFilesystemMountCapability {
  const root = input?.root ?? "/workspace";
  return {
    root,
    backendKind: "sandbox",
    label: "sandbox workspace",
    readable: true,
    writable: true,
    citable: false,
    persisted: false,
    threadScoped: true,
    internal: false,
    userVisible: false,
    evidenceRole: "runtime_sandbox",
    purpose:
      "Provider sandbox filesystem for command execution, generated code, logs, QA renders, intermediate files, and task artifacts.",
    readFile: {
      contentKind: "utf8-text-only",
      pagination: "line-offset",
      allowedExamples: [
        "code",
        "logs",
        "markdown",
        "json",
        "csv",
        "plain text",
      ],
      deniedExamples: [
        "images",
        "slide screenshots",
        "PDFs",
        "PPTX decks",
        "ZIP archives",
        "video",
        "audio",
      ],
    },
    binaryHandling: {
      preferredTools: [
        "publish_artifact",
        "artifact preview",
        "media-aware inspection",
      ],
    },
    readPolicy:
      "Use read_file on sandbox paths only for UTF-8 text such as code, logs, markdown, JSON, CSV, and plain text. Do not use read_file for sandbox images, slide screenshots, PDFs, PPTX decks, archives, video, or audio.",
    writePolicy:
      "Write sandbox files under provider read/write roots when command execution, testing, conversion, or artifact preparation needs ordinary filesystem paths.",
    citationPolicy:
      "Sandbox files are generated or intermediate runtime state and are non-citable. Verify factual claims against /kb, retrieval, web, or another citable source before final answers.",
    pathPolicy:
      "Sandbox paths are runtime filesystem paths. Mention them only when relevant to generated files, logs, QA outputs, or artifacts.",
  };
}

export function createDefaultFilesystemMounts(input?: {
  skillsEnabled?: boolean;
}) {
  return [
    KNOWLEDGE_MOUNT,
    WORK_MOUNT,
    ...(input?.skillsEnabled ? [SKILLS_MOUNT] : []),
  ];
}
