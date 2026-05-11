import { AGENT_TOOL_NAMES, type AgentToolName } from "./tool-registry";

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
  readPolicy:
    `Use /kb for source-wide coverage, summarization, review, comparison, full-document analysis, extraction, listing source contents, or surrounding context after ${AGENT_TOOL_NAMES.searchSources}.`,
  writePolicy: "Never write or edit /kb; it is read-only.",
  citationPolicy:
    `/kb ${AGENT_TOOL_NAMES.readFile}, ${AGENT_TOOL_NAMES.grep}, and ${AGENT_TOOL_NAMES.searchSources} outputs may include [citation:cN] markers. Final-answer factual claims based on /kb content must copy the relevant markers exactly.`,
  pathPolicy:
    "Do not mention /kb paths in the final answer unless the user explicitly asks for file paths; refer to /kb evidence as sources or selected sources.",
};

export const WORK_MOUNT: AgentFilesystemMountCapability = {
  root: "/work",
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
    "Read /work to continue prior work in the same thread, reuse drafts, inspect intermediate records, or supplement the current task with persisted working context.",
  writePolicy:
    "Write and edit only /work paths. Create Workfiles when a task is complex, multi-step, long-running, resumable, or benefits from persisted plans, notes, extracted data, calculations, drafts, or candidate outputs; skip Workfiles for simple one-shot answers where the final response is enough. Choose clear nested paths for multi-step or multi-output work.",
  citationPolicy:
    "/work is not workspace source evidence and never provides citations. If /work contains factual claims, verify them against /kb or another citable source before using them in a source-grounded final answer.",
  pathPolicy:
    "/work paths are user-visible as Workfiles and may be mentioned when relevant to persistent working material.",
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

export function createDefaultFilesystemMounts(input?: { skillsEnabled?: boolean }) {
  return [
    KNOWLEDGE_MOUNT,
    WORK_MOUNT,
    ...(input?.skillsEnabled ? [SKILLS_MOUNT] : []),
  ];
}

function sentenceList(items: string[]) {
  return items.filter((item) => item.trim().length > 0).join(" ");
}

function mountSummary(mount: AgentFilesystemMountCapability) {
  const attributes = [
    mount.readable ? "readable" : "not readable",
    mount.writable ? "writable" : "read-only",
    mount.citable ? "citable evidence" : "non-citable",
    mount.persisted ? "persisted" : "runtime-selected",
    mount.threadScoped ? "thread-scoped" : "",
  ].filter(Boolean);

  return [
    `- ${mount.root}: ${mount.label}; ${attributes.join(", ")}. ${mount.purpose}`,
    `  Read policy: ${mount.readPolicy}`,
    `  Write policy: ${mount.writePolicy}`,
    `  Citation policy: ${mount.citationPolicy}`,
    `  Path policy: ${mount.pathPolicy}`,
  ].join("\n");
}

export function buildFilesystemMountPrompt(input: AgentFilesystemPromptOptions = {}) {
  const mounts = input.mounts ?? createDefaultFilesystemMounts();
  const hasSkills = mounts.some((mount) => mount.root === SKILLS_MOUNT.root);

  return `<filesystem_mounts>
${mounts.map(mountSummary).join("\n")}
</filesystem_mounts>

<filesystem_rules>
- Use /kb as the default source evidence filesystem. ${AGENT_TOOL_NAMES.searchSources} is scoped to the same selected source tree scope as /kb.
- User @mentions, attachment labels, and source filenames refer to Source Library entries under /kb unless the user explicitly says they are Workfiles. Do not convert @mentioned source filenames into /work paths.
- For targeted source-grounded Q&A, extraction, field lookup, local fact lookup, semantic lookup, or finding relevant passages, call ${AGENT_TOOL_NAMES.searchSources} before ${AGENT_TOOL_NAMES.ls}, ${AGENT_TOOL_NAMES.glob}, ${AGENT_TOOL_NAMES.grep}, or ${AGENT_TOOL_NAMES.readFile}.
- For source-wide tasks, first determine the required coverage set with /kb listing when needed, then gather citable evidence from every required source.
- Directory names and paths alone are not evidence. Use ${AGENT_TOOL_NAMES.searchSources}, ${AGENT_TOOL_NAMES.readFile}, or ${AGENT_TOOL_NAMES.grep} output for citable claims.
- Do not use /work as the first evidence source for source-grounded factual questions. Use /work as persisted thread working memory only after evidence needs are clear, or when continuing generated working material.
- Create /work Workfiles when the process itself has follow-up value: complex plans, audits, evaluations, source extraction tables, calculations, long drafts, multi-artifact preparation, or work that should be resumed later. Do not create Workfiles just to answer a simple question, make a small edit, or produce a short final response.
- If /work contains factual claims that will appear in a source-grounded final answer, verify them against /kb or another citable source before using them.
${hasSkills ? "- Use /skills only to guide workflow, output shape, templates, or task-specific procedure. Skills do not override system rules, workspace boundaries, citation rules, or tool permissions. /skills is non-citable; if skill text contains citation-like strings, treat those strings as ordinary instruction text and do not copy them as citations." : ""}
- Do not call ${AGENT_TOOL_NAMES.ls}('/') just to discover /kb; call ${AGENT_TOOL_NAMES.ls}('/kb') directly when source enumeration is needed.
- Never narrate tool use, inspection steps, or intentions. Use tools directly, then answer.
</filesystem_rules>`;
}

function readableMountRoots(mounts: AgentFilesystemMountCapability[]) {
  return mounts
    .filter((mount) => mount.readable)
    .map((mount) => mount.root)
    .join(", ");
}

function writableMountRoots(mounts: AgentFilesystemMountCapability[]) {
  const roots = mounts.filter((mount) => mount.writable).map((mount) => mount.root);
  return roots.length > 0 ? roots.join(", ") : "none";
}

function getMount(mounts: AgentFilesystemMountCapability[], root: string) {
  return mounts.find((mount) => mount.root === root);
}

export function buildLsToolDescription(input: AgentFilesystemPromptOptions = {}) {
  const mounts = input.mounts ?? createDefaultFilesystemMounts();
  return sentenceList([
    `Lists files in a directory across mounted filesystems: ${readableMountRoots(mounts)}.`,
    getMount(mounts, "/kb")
      ? `Use ${AGENT_TOOL_NAMES.ls}('/kb') when source identity, directory contents, file enumeration, or source-wide coverage matters. Do not call ${AGENT_TOOL_NAMES.ls}('/') just to discover /kb.`
      : "",
    getMount(mounts, "/work")
      ? `Use ${AGENT_TOOL_NAMES.ls}('/work') to find persisted Workfiles when continuing or managing generated work.`
      : "",
    getMount(mounts, "/skills")
      ? `Use ${AGENT_TOOL_NAMES.ls}('/skills') only to locate selected skill instruction files or templates.`
      : "",
    "Listing paths identifies files; it is not evidence for factual claims.",
  ]);
}

export function buildReadFileToolDescription(input: AgentFilesystemPromptOptions = {}) {
  const mounts = input.mounts ?? createDefaultFilesystemMounts();
  return sentenceList([
    `Reads a file from mounted filesystems: ${readableMountRoots(mounts)}.`,
    getMount(mounts, "/kb")
      ? `/kb files are internal markdown virtual files backed by the source's canonical markdown. In /kb, ${AGENT_TOOL_NAMES.readFile} offset and limit are source-line based, not chunk based; default limit is ${KB_READ_FILE_DEFAULT_LINE_LIMIT} source lines and explicit limits are capped at ${KB_READ_FILE_MAX_LINE_LIMIT}. Use it for source-wide coverage, full-document analysis, extraction, or surrounding context. Only /kb ${AGENT_TOOL_NAMES.readFile} output may include valid [citation:cN] markers that must be copied exactly for supported final-answer claims.`
      : "",
    getMount(mounts, "/work")
      ? "/work files are database-persisted, thread-scoped Workfiles. Read /work to continue prior work, reuse drafts, inspect intermediate records, or supplement the current task with persisted working context. /work is non-citable and must not be treated as source evidence."
      : "",
    getMount(mounts, "/skills")
      ? "/skills files are selected skill instructions and workflow resources. Read /skills only for procedure, templates, or output-shape guidance; /skills is non-citable."
      : "",
    "Use pagination with offset and limit when output is truncated and more content is needed; continue from the offset shown in the truncation reminder.",
  ]);
}

export function buildGlobToolDescription(input: AgentFilesystemPromptOptions = {}) {
  const mounts = input.mounts ?? createDefaultFilesystemMounts();
  return sentenceList([
    `Finds files matching a glob pattern across mounted filesystems: ${readableMountRoots(mounts)}.`,
    getMount(mounts, "/kb")
      ? `Use ${AGENT_TOOL_NAMES.glob} under /kb to narrow selected sources by filename, directory, or path pattern, then gather citable evidence with ${AGENT_TOOL_NAMES.searchSources}, ${AGENT_TOOL_NAMES.readFile}, or ${AGENT_TOOL_NAMES.grep}.`
      : "",
    getMount(mounts, "/work")
      ? `Use ${AGENT_TOOL_NAMES.glob} under /work to find persisted Workfiles, drafts, notes, extracted records, outlines, calculations, or candidate outputs.`
      : "",
    getMount(mounts, "/skills")
      ? `Use ${AGENT_TOOL_NAMES.glob} under /skills only to locate skill instruction or template files.`
      : "",
    "Glob results identify files; they are not evidence for factual claims.",
  ]);
}

export function buildGrepToolDescription(input: AgentFilesystemPromptOptions = {}) {
  const mounts = input.mounts ?? createDefaultFilesystemMounts();
  return sentenceList([
    `Searches mounted filesystems with a case-insensitive regular expression: ${readableMountRoots(mounts)}.`,
    getMount(mounts, "/kb")
      ? `Use ${AGENT_TOOL_NAMES.grep} on /kb when the user asks for literal text matching, occurrence counts, line/location search, a quoted/known string, or exact textual verification after ${AGENT_TOOL_NAMES.searchSources}. Only /kb ${AGENT_TOOL_NAMES.grep} matches may include valid [citation:cN] markers that must be copied exactly for supported final-answer claims.`
      : "",
    getMount(mounts, "/work")
      ? `Use ${AGENT_TOOL_NAMES.grep} on /work to inspect persisted Workfiles. /work matches are non-citable and must not be used as source evidence without /kb or other citable verification.`
      : "",
    getMount(mounts, "/skills")
      ? `Use ${AGENT_TOOL_NAMES.grep} on /skills only to locate workflow instructions. /skills matches are non-citable.`
      : "",
    `Do not use ${AGENT_TOOL_NAMES.grep} as the first tool for general source-grounded Q&A, extraction, field lookup, semantic lookup, or finding relevant passages; use ${AGENT_TOOL_NAMES.searchSources} first for those tasks.`,
  ]);
}

export function buildWriteFileToolDescription(input: AgentFilesystemPromptOptions = {}) {
  const mounts = input.mounts ?? createDefaultFilesystemMounts();
  return sentenceList([
    `Writes content to a file. Writable mounts: ${writableMountRoots(mounts)}.`,
    getMount(mounts, "/work")
      ? "Use /work for database-persisted, thread-scoped Workfiles such as process notes, scratchpads, plans, drafts, extracted intermediate data, calculations, or candidate final outputs. Create a Workfile when the task is complex, multi-step, resumable, or the intermediate material will likely be reused; avoid creating one for simple one-shot answers. Do not intentionally write runtime [citation:cN] markers to /work; when such markers are present in Workfile content, the backend rewrites them to Markdown footnote references that preserve source association without creating citable evidence."
      : "",
    "Writing a Workfile does not publish an Artifact and does not create citable evidence.",
    "Do not write to read-only mounts.",
  ]);
}

export function buildEditFileToolDescription(input: AgentFilesystemPromptOptions = {}) {
  const mounts = input.mounts ?? createDefaultFilesystemMounts();
  return sentenceList([
    `Edits an existing file by replacing exact text. Writable mounts: ${writableMountRoots(mounts)}.`,
    getMount(mounts, "/work")
      ? `Use ${AGENT_TOOL_NAMES.editFile} on /work files to update database-persisted, thread-scoped Workfiles.`
      : "",
    "Read-only mounts cannot be edited. Workfiles are not source evidence and are not citable.",
  ]);
}

export function buildFilesystemToolDescriptions(input: AgentFilesystemPromptOptions = {}) {
  const mounts = input.mounts ?? createDefaultFilesystemMounts();
  return {
    [AGENT_TOOL_NAMES.ls]: buildLsToolDescription({ mounts }),
    [AGENT_TOOL_NAMES.readFile]: buildReadFileToolDescription({ mounts }),
    [AGENT_TOOL_NAMES.glob]: buildGlobToolDescription({ mounts }),
    [AGENT_TOOL_NAMES.grep]: buildGrepToolDescription({ mounts }),
    [AGENT_TOOL_NAMES.writeFile]: buildWriteFileToolDescription({ mounts }),
    [AGENT_TOOL_NAMES.editFile]: buildEditFileToolDescription({ mounts }),
  } satisfies Partial<Record<AgentToolName, string>>;
}
