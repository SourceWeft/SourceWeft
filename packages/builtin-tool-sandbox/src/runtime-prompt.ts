import {
  PREPARE_SANDBOX_TOOL_NAME,
  EXECUTE_TOOL_NAME,
  COLLECT_SANDBOX_OUTPUTS_TOOL_NAME,
} from "@sourceweft/contracts/agent-tools";
import {
  SOURCEWEFT_KB_ROOT,
  SOURCEWEFT_WORK_ROOT,
  type SandboxProviderPathPolicy,
} from "./runtime/types";

export interface SandboxRuntimePromptCapabilities {
  prepareToolAvailable: boolean;
  executeAvailable: boolean;
  collectToolAvailable: boolean;
  defaultEnvironmentAvailable?: boolean;
  pathPolicy?: SandboxProviderPathPolicy;
  /**
   * True when skill-bundle staging is configured for this turn
   * (docs/architecture/sandbox-skill-staging.md): activated skill bundles are
   * materialized read-only at /skills/<name>/ inside the sandbox on first
   * use, and execute commands may reference /skills paths directly. When
   * staging later fails for the sandbox, execute returns a recoverable
   * SANDBOX_SKILL_STAGING_UNAVAILABLE error with fallback guidance.
   */
  skillScriptsStaged?: boolean;
}

function formatRoots(roots: readonly string[]) {
  return roots.join(", ");
}

export function buildSandboxRuntimePrompt(
  capabilities: SandboxRuntimePromptCapabilities | undefined,
) {
  if (!capabilities?.executeAvailable) {
    return "";
  }
  const pathPolicy = capabilities.pathPolicy;
  const defaultCwd = pathPolicy?.defaultCwd ?? "the provider default cwd";
  const prepareTargetRoots = pathPolicy
    ? formatRoots(pathPolicy.prepareTargetRoots)
    : "the provider-allowed prepare target roots";
  const collectSourceRoots = pathPolicy
    ? formatRoots(pathPolicy.collectSourceRoots)
    : "the provider-allowed collect source roots";

  const bridgeInstructions = [
    capabilities.prepareToolAvailable
      ? `- ${PREPARE_SANDBOX_TOOL_NAME} reads explicitly selected SourceWeft DB-backed ${SOURCEWEFT_WORK_ROOT} Workfile content and materializes it as ordinary sandbox files under provider-allowed prepare targets: ${prepareTargetRoots}. Put command inputs such as generated code, data files, plans, and QA notes in ${SOURCEWEFT_WORK_ROOT} first, then prepare only the files needed for sandbox execution.`
      : null,
    `- ${EXECUTE_TOOL_NAME} runs commands in the provider sandbox filesystem and uses ${defaultCwd} by default.`,
    capabilities.collectToolAvailable
      ? `- ${COLLECT_SANDBOX_OUTPUTS_TOOL_NAME} persists explicitly selected sandbox text outputs from provider-allowed collect sources (${collectSourceRoots}) into SourceWeft DB-backed ${SOURCEWEFT_WORK_ROOT} Workfiles. Do not use it for binary outputs such as .pptx, .pdf, .zip, or .xlsx files; publish binary outputs with publish_artifact using artifactType=slides for PPTX decks or artifactType=file for generic downloadable files.`
      : null,
  ].filter((line): line is string => line !== null);

  const virtualPathExecutionRule = capabilities.prepareToolAvailable
    ? `- ${EXECUTE_TOOL_NAME} commands use provider sandbox filesystem paths. Use ${PREPARE_SANDBOX_TOOL_NAME} first when command execution needs selected SourceWeft DB-backed ${SOURCEWEFT_WORK_ROOT} Workfile content.`
    : `- ${EXECUTE_TOOL_NAME} commands use provider sandbox filesystem paths.`;
  const environmentSummary = capabilities.defaultEnvironmentAvailable
    ? `
<sandbox_environment>
- The default SourceWeft sandbox image already includes Node.js 22, pnpm 10, and Python 3.11.
- Global npm packages include pptxgenjs, playwright, @marp-team/marp-cli, sharp, react, react-dom, and react-icons.
- Python packages include markitdown[pptx], python-pptx, python-docx, pandas, numpy, matplotlib, plotly, and openpyxl.
- System and browser tools include LibreOffice, pandoc, poppler-utils, ffmpeg, Noto fonts, and Chromium via Playwright.
- Prefer these preinstalled tools first. Do not run installs such as npm install pptxgenjs or pip install markitdown[pptx] unless a required version or package is missing.
- Install any extra task-specific dependency locally under a task directory inside ${defaultCwd} instead of changing global packages.
</sandbox_environment>`
    : "";
  const providerPolicyLines = pathPolicy
    ? [
        `- Provider sandbox workspace root: ${pathPolicy.workspaceRoot}.`,
        `- Provider sandbox default cwd: ${pathPolicy.defaultCwd}.`,
        `- Provider sandbox read/write roots: ${formatRoots(pathPolicy.readWriteRoots)}.`,
        `- Provider sandbox prepare targets: ${formatRoots(pathPolicy.prepareTargetRoots)}.`,
        `- Provider sandbox collect sources: ${formatRoots(pathPolicy.collectSourceRoots)}.`,
      ].join("\n")
    : "- Provider sandbox allowed roots are defined by the active sandbox provider; use the current tool descriptions and runtime context for exact roots.";

  // Skill-staging branches (docs/architecture/sandbox-skill-staging.md).
  // Each conditional replaces its line(s) IN PLACE so the unstaged prompt
  // stays byte-identical to the pre-staging prompt.
  const skillsVfsLine = capabilities.skillScriptsStaged
    ? `- /skills is SourceWeft skill content: readable through SourceWeft file tools, and materialized read-only at the same /skills/<name>/ paths inside the sandbox, so ${EXECUTE_TOOL_NAME} commands may run bundled skill scripts directly (for example python3 /skills/<name>/scripts/tool.py).`
    : "- /skills is SourceWeft DB-backed VFS skill guidance accessed only through SourceWeft file tools.";
  const executeNamespaceLines = capabilities.skillScriptsStaged
    ? `- ${SOURCEWEFT_WORK_ROOT} and ${SOURCEWEFT_KB_ROOT} inside execute are provider sandbox filesystem paths only; they do not access SourceWeft VFS.
- Never include ${SOURCEWEFT_WORK_ROOT} or ${SOURCEWEFT_KB_ROOT} in an ${EXECUTE_TOOL_NAME} command. They are not sandbox paths, even for mkdir, ls, cat, test, node, python, or shell redirection.
- Never write to /skills from ${EXECUTE_TOOL_NAME} commands: it is platform-managed and read-only. prepare and collect cannot target /skills.`
    : `- ${SOURCEWEFT_WORK_ROOT}, ${SOURCEWEFT_KB_ROOT}, and /skills inside execute are provider sandbox filesystem paths only; they do not access SourceWeft VFS.
- Never include ${SOURCEWEFT_WORK_ROOT}, ${SOURCEWEFT_KB_ROOT}, or /skills in an ${EXECUTE_TOOL_NAME} command. They are not sandbox paths, even for mkdir, ls, cat, test, node, python, or shell redirection.`;
  const skillsPrepareRule = capabilities.skillScriptsStaged
    ? `- ${SOURCEWEFT_KB_ROOT} is not prepared directly into the sandbox. If source content needs command processing, extract the minimum necessary content into ${SOURCEWEFT_WORK_ROOT} first, then explicitly prepare that Workfile. Skill bundles are already staged under /skills and need no preparation.`
    : `- ${SOURCEWEFT_KB_ROOT} and /skills are not prepared directly into the sandbox. If source content needs command processing, extract the minimum necessary content into ${SOURCEWEFT_WORK_ROOT} first, then explicitly prepare that Workfile.`;

  return `<sandbox_rules>
- SourceWeft VFS and the provider sandbox filesystem are separate namespaces.
- ${SOURCEWEFT_WORK_ROOT} is SourceWeft DB-backed VFS Workfiles: database-persisted, thread-scoped working files accessed only through SourceWeft file tools.
- ${SOURCEWEFT_KB_ROOT} is SourceWeft DB-backed VFS source evidence accessed only through SourceWeft source/file tools.
${skillsVfsLine}
- SourceWeft VFS logical paths are not mounted into sandbox command execution and are not automatically synced with the sandbox filesystem.
- Preparing files is explicit selected-content materialization, not a ${SOURCEWEFT_WORK_ROOT} directory mount, mirror, root-level copy, or bidirectional sync.
${executeNamespaceLines}
${providerPolicyLines}
- Sandbox files become SourceWeft durable state only when explicitly collected back into ${SOURCEWEFT_WORK_ROOT} as text Workfiles or published through explicit artifact pipelines.
- Put all scratch files, QA renders, thumbnails, and artifacts that SourceWeft may need to read, inspect, collect, or publish under the provider sandbox read/write roots, normally ${defaultCwd}. Do not use /tmp for those files.
- Use the sandbox for command execution, dependency installation, format conversion, batch processing, testing, or computation.
${bridgeInstructions.join("\n")}
- Commands needing Workfiles should prepare the selected ${SOURCEWEFT_WORK_ROOT}/... files into one of the provider prepare target roots, then explicitly work from those sandbox paths.
${virtualPathExecutionRule}
${skillsPrepareRule}
- Prepared files, collected Workfiles, and sandbox outputs are not citable evidence.
- Verify factual claims against ${SOURCEWEFT_KB_ROOT}, retrieval, web, or another citable source before final answers.
</sandbox_rules>${environmentSummary}`;
}
