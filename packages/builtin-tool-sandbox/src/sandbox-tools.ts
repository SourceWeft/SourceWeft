import {
  PREPARE_SANDBOX_TOOL_NAME,
  EXECUTE_TOOL_NAME,
  COLLECT_SANDBOX_OUTPUTS_TOOL_NAME,
} from "@sourceweft/contracts/agent-tools";
import {
  SOURCEWEFT_WORK_ROOT,
  type SandboxProviderPathPolicy,
} from "./runtime/types";
import { z } from "zod";

function formatRoots(roots: readonly string[]) {
  return roots.join(", ");
}

export const sandboxToolDescriptions = {
  prepareSandboxWorkspace: `Materialize explicitly selected SourceWeft DB-backed VFS ${SOURCEWEFT_WORK_ROOT} Workfile content as ordinary provider sandbox files under provider-allowed prepare target roots. Put generated code, data files, plans, and QA notes in ${SOURCEWEFT_WORK_ROOT} first, then prepare only files needed for sandbox execution. /kb and /skills are SourceWeft DB-backed VFS roots, not transfer sources. A file entry may instead name a ready workspace artifact by artifactId to stage its primary bytes (for example a generated image) into the sandbox.`,
  execute: `Execute a shell command in the provider sandbox filesystem. Never include SourceWeft DB-backed VFS logical paths such as ${SOURCEWEFT_WORK_ROOT}, /kb, or /skills in an execute command; they are not sandbox paths even for mkdir, ls, cat, test, node, python, or shell redirection. Use prepare_sandbox_workspace to materialize selected Workfiles under provider sandbox paths before execution. Files that SourceWeft must later read, inspect, collect, or publish must be written under the current provider read/write roots.`,
  collectSandboxOutputs: `Persist explicitly selected provider sandbox text outputs from provider-allowed collect source roots into SourceWeft DB-backed VFS ${SOURCEWEFT_WORK_ROOT} Workfiles. Do not use this tool for binary outputs such as .pptx, .pdf, .zip, or .xlsx files; publish binary outputs with publish_artifact using artifactType=slides for PPTX decks or artifactType=file for generic downloadable files.`,
} as const;

export function buildSandboxToolDescriptions(
  pathPolicy?: SandboxProviderPathPolicy,
) {
  if (!pathPolicy) {
    return sandboxToolDescriptions;
  }
  return {
    prepareSandboxWorkspace: `${sandboxToolDescriptions.prepareSandboxWorkspace} Current provider prepare target roots: ${formatRoots(pathPolicy.prepareTargetRoots)}.`,
    execute: `${sandboxToolDescriptions.execute} Current provider default cwd: ${pathPolicy.defaultCwd}. Current provider read/write roots: ${formatRoots(pathPolicy.readWriteRoots)}.`,
    collectSandboxOutputs: `${sandboxToolDescriptions.collectSandboxOutputs} Current provider collect source roots: ${formatRoots(pathPolicy.collectSourceRoots)}.`,
  } as const;
}

export const sandboxToolInterruptDescriptions = {
  [PREPARE_SANDBOX_TOOL_NAME]: `Materialize selected SourceWeft DB-backed ${SOURCEWEFT_WORK_ROOT} Workfile content as ordinary provider sandbox files. Review paths and sizes before transfer.`,
  [EXECUTE_TOOL_NAME]:
    "Execute a shell command in the provider sandbox filesystem. Review command intent, network access, and expected outputs before running.",
  [COLLECT_SANDBOX_OUTPUTS_TOOL_NAME]: `Persist selected provider sandbox text outputs into SourceWeft DB-backed ${SOURCEWEFT_WORK_ROOT} Workfiles. Review destination paths before persisting output.`,
} as const;

export const prepareSandboxWorkspaceSchema = z.object({
  files: z
    .array(
      z
        .object({
          sourcePath: z.string().min(1).optional(),
          /**
           * Stage a ready workspace artifact's primary bytes instead of a
           * Workfile — the only route binary outputs (generated images) have
           * into the sandbox, since the DB-backed VFS is text-oriented.
           */
          artifactId: z.string().min(1).optional(),
          artifactVersionId: z.string().min(1).optional(),
          sandboxPath: z.string().min(1),
        })
        .refine((file) => !file.artifactVersionId || Boolean(file.artifactId), {
          message: "artifactVersionId requires artifactId",
        })
        .refine(
          (file) => Boolean(file.sourcePath) !== Boolean(file.artifactId),
          {
            message: "each file names exactly one of sourcePath or artifactId",
          },
        ),
    )
    .min(1)
    .max(20),
});

export const collectSandboxOutputsSchema = z.object({
  outputs: z
    .array(
      z.object({
        sandboxPath: z.string().min(1),
        target: z.object({
          kind: z.literal("workfile"),
          path: z.string().min(1),
          overwrite: z.boolean().optional(),
        }),
      }),
    )
    .min(1)
    .max(20),
});

export type PrepareSandboxWorkspaceInput = z.infer<
  typeof prepareSandboxWorkspaceSchema
>;
export type CollectSandboxOutputsInput = z.infer<
  typeof collectSandboxOutputsSchema
>;
