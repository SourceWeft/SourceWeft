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
      ? `- ${PREPARE_SANDBOX_TOOL_NAME} reads explicitly selected SourceWeft DB-backed ${SOURCEWEFT_WORK_ROOT} Workfile content and materializes it as ordinary sandbox files under provider-allowed prepare targets: ${prepareTargetRoots}.`
      : null,
    `- ${EXECUTE_TOOL_NAME} runs commands in the provider sandbox filesystem and uses ${defaultCwd} by default.`,
    capabilities.collectToolAvailable
      ? `- ${COLLECT_SANDBOX_OUTPUTS_TOOL_NAME} persists explicitly selected sandbox text outputs from provider-allowed collect sources (${collectSourceRoots}) into SourceWeft DB-backed ${SOURCEWEFT_WORK_ROOT} Workfiles. Do not use it for binary outputs such as .pptx files; publish supported binary artifacts with explicit artifact pipelines such as publish_sandbox_artifact for PPTX slides.`
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
- Install any extra task-specific dependency locally under a task directory inside ${defaultCwd} or a provider-allowed temp/project directory instead of changing global packages.
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

  return `<sandbox_rules>
- SourceWeft VFS and the provider sandbox filesystem are separate namespaces.
- ${SOURCEWEFT_WORK_ROOT} is SourceWeft DB-backed VFS Workfiles: database-persisted, thread-scoped working files accessed only through SourceWeft file tools.
- ${SOURCEWEFT_KB_ROOT} is SourceWeft DB-backed VFS source evidence accessed only through SourceWeft source/file tools.
- /skills is SourceWeft DB-backed VFS skill guidance accessed only through SourceWeft file tools.
- SourceWeft VFS logical paths are not mounted into sandbox command execution and are not automatically synced with the sandbox filesystem.
- Preparing files is explicit selected-content materialization, not a ${SOURCEWEFT_WORK_ROOT} directory mount, mirror, root-level copy, or bidirectional sync.
- ${SOURCEWEFT_WORK_ROOT}, ${SOURCEWEFT_KB_ROOT}, and /skills inside execute are provider sandbox filesystem paths only; they do not access SourceWeft VFS.
${providerPolicyLines}
- Sandbox files become SourceWeft durable state only when explicitly collected back into ${SOURCEWEFT_WORK_ROOT} as text Workfiles or published through explicit artifact pipelines.
- Use the sandbox for command execution, dependency installation, format conversion, batch processing, testing, or computation.
${bridgeInstructions.join("\n")}
- Commands needing prepared Workfiles should explicitly work under one of the provider prepare target roots.
${virtualPathExecutionRule}
- ${SOURCEWEFT_KB_ROOT} and /skills are not prepared directly into the sandbox. If source content needs command processing, extract the minimum necessary content into ${SOURCEWEFT_WORK_ROOT} first, then explicitly prepare that Workfile.
- Prepared files, collected Workfiles, and sandbox outputs are not citable evidence.
- Verify factual claims against ${SOURCEWEFT_KB_ROOT}, retrieval, web, or another citable source before final answers.
</sandbox_rules>${environmentSummary}`;
}
