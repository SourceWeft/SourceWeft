import {
  LS_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  SEARCH_SOURCES_TOOL_NAME,
} from "@sourceweft/contracts/agent-tools";
import {
  createDefaultFilesystemMounts,
  KB_READ_FILE_DEFAULT_LINE_LIMIT,
  KB_READ_FILE_MAX_LINE_LIMIT,
  type AgentFilesystemMountCapability,
  type AgentFilesystemPromptOptions,
} from "./filesystem-mounts";

function sentenceList(items: string[]) {
  return items.filter((item) => item.trim().length > 0).join(" ");
}

function readableMountRoots(mounts: AgentFilesystemMountCapability[]) {
  return mounts
    .filter((mount) => mount.readable)
    .map((mount) => mount.root)
    .join(", ");
}

function writableMountRoots(mounts: AgentFilesystemMountCapability[]) {
  const roots = mounts
    .filter((mount) => mount.writable)
    .map((mount) => mount.root);
  return roots.length > 0 ? roots.join(", ") : "none";
}

function getMount(mounts: AgentFilesystemMountCapability[], root: string) {
  return mounts.find((mount) => mount.root === root);
}

export function buildLsToolDescription(
  input: AgentFilesystemPromptOptions = {},
) {
  const mounts = input.mounts ?? createDefaultFilesystemMounts();
  return sentenceList([
    `Lists files in a directory across mounted filesystems: ${readableMountRoots(mounts)}.`,
    getMount(mounts, "/kb")
      ? `Use ${LS_TOOL_NAME}('/kb') when source identity, directory contents, file enumeration, or source-wide coverage matters. Do not call ${LS_TOOL_NAME}('/') just to discover /kb.`
      : "",
    getMount(mounts, "/workfiles")
      ? `Use ${LS_TOOL_NAME}('/workfiles') to find persisted Workfiles when continuing or managing generated work.`
      : "",
    getMount(mounts, "/skills")
      ? `Use ${LS_TOOL_NAME}('/skills') only to locate selected skill instruction files or templates.`
      : "",
    "Listing paths identifies files; it is not evidence for factual claims.",
  ]);
}

export function buildReadFileToolDescription(
  input: AgentFilesystemPromptOptions = {},
) {
  const mounts = input.mounts ?? createDefaultFilesystemMounts();
  return sentenceList([
    `Reads text files from mounted filesystems: ${readableMountRoots(mounts)}.`,
    `Do not use ${READ_FILE_TOOL_NAME} for binary files such as images, PDFs, PPTX decks, videos, archives, or generated slide screenshots; use a media-aware inspection, conversion, or artifact tool instead.`,
    getMount(mounts, "/kb")
      ? `/kb files are internal markdown virtual files backed by the source's canonical markdown. In /kb, ${READ_FILE_TOOL_NAME} offset and limit are source-line based, not chunk based; default limit is ${KB_READ_FILE_DEFAULT_LINE_LIMIT} source lines and explicit limits are capped at ${KB_READ_FILE_MAX_LINE_LIMIT}. Use it for source-wide coverage, full-document analysis, extraction, or surrounding context. Only /kb ${READ_FILE_TOOL_NAME} output may include valid [citation:cN] markers that must be copied exactly for supported final-answer claims.`
      : "",
    getMount(mounts, "/workfiles")
      ? "/workfiles are database-persisted, thread-scoped Workfiles. Read /workfiles to continue prior work, reuse drafts, inspect intermediate records, or supplement the current task with persisted working context. /workfiles is non-citable and must not be treated as source evidence."
      : "",
    getMount(mounts, "/skills")
      ? "/skills files are selected skill instructions and workflow resources. Read /skills only for procedure, templates, or output-shape guidance; /skills is non-citable."
      : "",
    "Use pagination with offset and limit when output is truncated and more content is needed; continue from the offset shown in the truncation reminder.",
  ]);
}

export function buildGlobToolDescription(
  input: AgentFilesystemPromptOptions = {},
) {
  const mounts = input.mounts ?? createDefaultFilesystemMounts();
  return sentenceList([
    `Finds files matching a glob pattern across mounted filesystems: ${readableMountRoots(mounts)}.`,
    getMount(mounts, "/kb")
      ? `Use ${GLOB_TOOL_NAME} under /kb to narrow selected sources by filename, directory, or path pattern, then gather citable evidence with ${SEARCH_SOURCES_TOOL_NAME}, ${READ_FILE_TOOL_NAME}, or ${GREP_TOOL_NAME}.`
      : "",
    getMount(mounts, "/workfiles")
      ? `Use ${GLOB_TOOL_NAME} under /workfiles to find persisted Workfiles, drafts, notes, extracted records, outlines, calculations, or candidate outputs.`
      : "",
    getMount(mounts, "/skills")
      ? `Use ${GLOB_TOOL_NAME} under /skills only to locate skill instruction or template files.`
      : "",
    "Glob results identify files; they are not evidence for factual claims.",
  ]);
}

export function buildGrepToolDescription(
  input: AgentFilesystemPromptOptions = {},
) {
  const mounts = input.mounts ?? createDefaultFilesystemMounts();
  return sentenceList([
    `Searches mounted filesystems with a case-insensitive regular expression: ${readableMountRoots(mounts)}.`,
    getMount(mounts, "/kb")
      ? `Use ${GREP_TOOL_NAME} on /kb when the user asks for literal text matching, occurrence counts, line/location search, a quoted/known string, or exact textual verification after ${SEARCH_SOURCES_TOOL_NAME}. Only /kb ${GREP_TOOL_NAME} matches may include valid [citation:cN] markers that must be copied exactly for supported final-answer claims.`
      : "",
    getMount(mounts, "/workfiles")
      ? `Use ${GREP_TOOL_NAME} on /workfiles to inspect persisted Workfiles. /workfiles matches are non-citable and must not be used as source evidence without /kb or other citable verification.`
      : "",
    getMount(mounts, "/skills")
      ? `Use ${GREP_TOOL_NAME} on /skills only to locate workflow instructions. /skills matches are non-citable.`
      : "",
    `Do not use ${GREP_TOOL_NAME} as the first tool for general source-grounded Q&A, extraction, field lookup, semantic lookup, or finding relevant passages; use ${SEARCH_SOURCES_TOOL_NAME} first for those tasks.`,
  ]);
}

export function buildWriteFileToolDescription(
  input: AgentFilesystemPromptOptions = {},
) {
  const mounts = input.mounts ?? createDefaultFilesystemMounts();
  return sentenceList([
    `Writes content to a file. Writable mounts: ${writableMountRoots(mounts)}.`,
    getMount(mounts, "/workfiles")
      ? "Use /workfiles for database-persisted, thread-scoped Workfiles such as process notes, scratchpads, plans, drafts, extracted intermediate data, calculations, or candidate final outputs. Create a Workfile when the task is complex, multi-step, resumable, or the intermediate material will likely be reused; avoid creating one for simple one-shot answers. Do not intentionally write runtime [citation:cN] markers to /workfiles; when such markers are present in Workfile content, the backend rewrites them to Markdown footnote references that preserve source association without creating citable evidence."
      : "",
    "Writing a Workfile does not publish an Artifact and does not create citable evidence.",
    "Do not write to read-only mounts.",
  ]);
}

export function buildEditFileToolDescription(
  input: AgentFilesystemPromptOptions = {},
) {
  const mounts = input.mounts ?? createDefaultFilesystemMounts();
  return sentenceList([
    `Edits an existing file by replacing exact text. Writable mounts: ${writableMountRoots(mounts)}.`,
    getMount(mounts, "/workfiles")
      ? `Use ${EDIT_FILE_TOOL_NAME} on /workfiles to update database-persisted, thread-scoped Workfiles.`
      : "",
    "Read-only mounts cannot be edited. Workfiles are not source evidence and are not citable.",
  ]);
}

export function buildFilesystemToolDescriptions(
  input: AgentFilesystemPromptOptions = {},
) {
  const mounts = input.mounts ?? createDefaultFilesystemMounts();
  return {
    [LS_TOOL_NAME]: buildLsToolDescription({ mounts }),
    [READ_FILE_TOOL_NAME]: buildReadFileToolDescription({ mounts }),
    [GLOB_TOOL_NAME]: buildGlobToolDescription({ mounts }),
    [GREP_TOOL_NAME]: buildGrepToolDescription({ mounts }),
    [WRITE_FILE_TOOL_NAME]: buildWriteFileToolDescription({ mounts }),
    [EDIT_FILE_TOOL_NAME]: buildEditFileToolDescription({ mounts }),
  };
}
