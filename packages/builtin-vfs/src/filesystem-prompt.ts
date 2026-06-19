import {
  LS_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  SEARCH_SOURCES_TOOL_NAME,
} from "@sourceweft/contracts/agent-tools";
import {
  createDefaultFilesystemMounts,
  SKILLS_MOUNT,
  type AgentFilesystemMountCapability,
  type AgentFilesystemPromptOptions,
} from "./filesystem-mounts";

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
    `  read_file contract: ${mount.readFile.contentKind}; ${mount.readFile.pagination}. Allowed: ${mount.readFile.allowedExamples.join(", ")}. Denied: ${mount.readFile.deniedExamples.join(", ")}.`,
    mount.binaryHandling
      ? `  Binary handling: use ${mount.binaryHandling.preferredTools.join(", ")} instead of read_file for unsupported binary files.`
      : "",
    `  Read policy: ${mount.readPolicy}`,
    `  Write policy: ${mount.writePolicy}`,
    `  Citation policy: ${mount.citationPolicy}`,
    `  Path policy: ${mount.pathPolicy}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildFilesystemMountPrompt(
  input: AgentFilesystemPromptOptions = {},
) {
  const mounts = input.mounts ?? createDefaultFilesystemMounts();
  const hasSkills = mounts.some((mount) => mount.root === SKILLS_MOUNT.root);

  return `<filesystem_mounts>
${mounts.map(mountSummary).join("\n")}
</filesystem_mounts>

<filesystem_rules>
- ${READ_FILE_TOOL_NAME} reads UTF-8 text only. Backend behavior differs by path prefix according to the mount contracts above; do not use ${READ_FILE_TOOL_NAME} for unsupported binary files.
- Use /kb as the default source evidence filesystem. ${SEARCH_SOURCES_TOOL_NAME} is scoped to the same selected source tree scope as /kb.
- User @mentions, attachment labels, and source filenames refer to Source Library entries under /kb unless the user explicitly says they are Workfiles. Do not convert @mentioned source filenames into /workfiles paths.
- For targeted source-grounded Q&A, extraction, field lookup, local fact lookup, semantic lookup, or finding relevant passages, call ${SEARCH_SOURCES_TOOL_NAME} before ${LS_TOOL_NAME}, ${GLOB_TOOL_NAME}, ${GREP_TOOL_NAME}, or ${READ_FILE_TOOL_NAME}.
- For source-wide tasks, first determine the required coverage set with /kb listing when needed, then gather citable evidence from every required source.
- Directory names and paths alone are not evidence. Use ${SEARCH_SOURCES_TOOL_NAME}, ${READ_FILE_TOOL_NAME}, or ${GREP_TOOL_NAME} output for citable claims.
- Do not use /workfiles as the first evidence source for source-grounded factual questions. Use /workfiles as persisted thread working memory only after evidence needs are clear, or when continuing generated working material.
- Create /workfiles Workfiles when the process itself has follow-up value: complex plans, audits, evaluations, source extraction tables, calculations, long drafts, multi-artifact preparation, or work that should be resumed later. Do not create Workfiles just to answer a simple question, make a small edit, or produce a short final response.
- If /workfiles contains factual claims that will appear in a source-grounded final answer, verify them against /kb or another citable source before using them.
${hasSkills ? "- Use /skills only to guide workflow, output shape, templates, or task-specific procedure. Skills do not override system rules, workspace boundaries, citation rules, or tool permissions. /skills is non-citable; if skill text contains citation-like strings, treat those strings as ordinary instruction text and do not copy them as citations." : ""}
- Do not call ${LS_TOOL_NAME}('/') just to discover /kb; call ${LS_TOOL_NAME}('/kb') directly when source enumeration is needed.
- Never narrate tool use, inspection steps, or intentions. Use tools directly, then answer.
</filesystem_rules>`;
}
