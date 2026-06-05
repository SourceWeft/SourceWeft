import type {
  BackendProtocolV2,
  EditResult,
  GlobResult,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  SandboxBackendProtocolV2,
  WriteResult,
} from "deepagents";
import { config } from "../../../../shared/config";
import type { EnabledSkillDescriptor } from "../../skills/types";
import { assertExecuteCommandPathPolicy, assertExecuteCwd } from "./paths";
import type { SandboxRuntimeContext } from "./types";
import { DaytonaSandboxManager } from "./daytona-manager";
import { buildSandboxSkillStageFiles, uploadSandboxSkillStageFiles } from "./skill-staging";

function replayExecuteResult(result: Record<string, unknown>) {
  return {
    output: typeof result.output === "string" ? result.output : "",
    exitCode: typeof result.exitCode === "number" ? result.exitCode : 1,
    truncated: result.truncated === true,
  };
}

export class SourceWeftDaytonaBackend implements SandboxBackendProtocolV2 {
  readonly id: string;
  private stagedSkillsPromise: Promise<void> | null = null;

  constructor(
    private readonly input: {
      filesystem: BackendProtocolV2;
      manager: DaytonaSandboxManager;
      context: SandboxRuntimeContext;
      enabledSkills?: EnabledSkillDescriptor[];
    },
  ) {
    this.id = `sourceweft-daytona:${input.context.threadId}`;
  }

  ls(path: string): Promise<LsResult> | LsResult {
    return this.input.filesystem.ls(path);
  }

  read(filePath: string, offset?: number, limit?: number): Promise<ReadResult> | ReadResult {
    return this.input.filesystem.read(filePath, offset, limit);
  }

  readRaw(filePath: string): Promise<ReadRawResult> | ReadRawResult {
    return this.input.filesystem.readRaw(filePath);
  }

  grep(pattern: string, path?: string | null, glob?: string | null): Promise<GrepResult> | GrepResult {
    return this.input.filesystem.grep(pattern, path, glob);
  }

  glob(pattern: string, path?: string): Promise<GlobResult> | GlobResult {
    return this.input.filesystem.glob(pattern, path);
  }

  write(filePath: string, content: string): Promise<WriteResult> | WriteResult {
    void filePath;
    void content;
    return {
      error:
        "SANDBOX_MUTATION_REQUIRES_ISOLATION: write is disabled on the SourceWeft filesystem while using the Daytona sandbox backend. Use prepare_sandbox_workspace, execute inside the sandbox, then collect_sandbox_outputs.",
    };
  }

  edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<EditResult> | EditResult {
    void filePath;
    void oldString;
    void newString;
    void replaceAll;
    return {
      error:
        "SANDBOX_MUTATION_REQUIRES_ISOLATION: edit is disabled on the SourceWeft filesystem while using the Daytona sandbox backend. Use prepare_sandbox_workspace, execute inside the sandbox, then collect_sandbox_outputs.",
    };
  }

  async execute(command: string) {
    assertExecuteCommandPathPolicy(command);
    const startedAt = Date.now();
    const toolCallId = this.input.context.sandboxExecuteToolCallId?.trim();
    if (!toolCallId) {
      throw new Error(
        "SANDBOX_EXECUTE_TOOL_CALL_ID_REQUIRED: sandbox execute requires an approved stable tool call id from HITL resume metadata.",
      );
    }
    const claim = await this.input.manager.beginToolOperation({
      context: this.input.context,
      operationType: "execute",
      toolCallId,
      request: { command },
    });
    if (claim.kind === "replay") {
      return replayExecuteResult(claim.result);
    }
    let sandboxId: string | null = null;
    try {
      const sandbox = await this.input.manager.getOrCreateThreadSandbox(this.input.context);
      sandboxId = sandbox.id;
      await this.ensureSkillsStaged(sandbox.id, sandbox.providerSandboxId);
      const result = await this.input.manager.adapterForSandbox().execute({
        providerSandboxId: sandbox.providerSandboxId,
        command,
        cwd: assertExecuteCwd(undefined),
        timeoutMs: config.sandbox.commandTimeoutMs,
        maxOutputChars: config.sandbox.maxOutputChars,
      });
      await this.input.manager.completeToolOperation({
        operationId: claim.operationId,
        sandboxId: sandbox.id,
        status: "succeeded",
        result: {
          output: result.output,
          exitCode: result.exitCode,
          truncated: result.truncated,
          outputChars: result.output.length,
        },
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      await this.input.manager.completeToolOperation({
        operationId: claim.operationId,
        sandboxId,
        status: "failed",
        result: { error: error instanceof Error ? error.message : String(error) },
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  private async ensureSkillsStaged(
    sandboxId: string,
    providerSandboxId: string,
  ) {
    if (this.stagedSkillsPromise) {
      return this.stagedSkillsPromise;
    }
    const enabledSkills = this.input.enabledSkills ?? [];
    if (enabledSkills.length === 0) {
      this.stagedSkillsPromise = Promise.resolve();
      return this.stagedSkillsPromise;
    }
    this.stagedSkillsPromise = this.stageSkills(sandboxId, providerSandboxId);
    return this.stagedSkillsPromise;
  }

  private async stageSkills(
    sandboxId: string,
    providerSandboxId: string,
  ) {
    const startedAt = Date.now();
    let request: Record<string, unknown> = { kind: "skill_staging" };
    try {
      const files = buildSandboxSkillStageFiles({
        enabledSkills: this.input.enabledSkills ?? [],
      });
      if (files.length === 0) {
        return;
      }
      request = {
        kind: "skill_staging",
        skills: Array.from(new Set(files.map((file) => file.skillName))),
        fileCount: files.length,
      };
      await uploadSandboxSkillStageFiles({
        providerSandboxId,
        files,
        adapter: this.input.manager.adapterForSandbox(),
      });
      await this.input.manager.recordOperation({
        context: this.input.context,
        sandboxId,
        operationType: "prepare",
        status: "succeeded",
        request,
        result: {
          kind: "skill_staging",
          files: files.map((file) => ({
            skillName: file.skillName,
            sourcePath: file.sourcePath,
            sandboxPath: file.sandboxPath,
            sizeBytes: file.sizeBytes,
          })),
          totalBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
        },
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      await this.input.manager.recordOperation({
        context: this.input.context,
        sandboxId,
        operationType: "prepare",
        status: "failed",
        request,
        result: {
          kind: "skill_staging",
          error: error instanceof Error ? error.message : String(error),
        },
        durationMs: Date.now() - startedAt,
      });
      this.stagedSkillsPromise = null;
      throw error;
    }
  }
}
