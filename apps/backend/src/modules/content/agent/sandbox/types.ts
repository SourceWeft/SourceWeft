import type { ExecuteResponse } from "deepagents";

export const DAYTONA_PROVIDER = "daytona" as const;
export const SANDBOX_WORKSPACE_ROOT = "/workspace";
export const SANDBOX_INPUT_ROOT = `${SANDBOX_WORKSPACE_ROOT}/input`;
export const SANDBOX_WORK_ROOT = `${SANDBOX_WORKSPACE_ROOT}/work`;
export const SANDBOX_OUTPUT_ROOT = `${SANDBOX_WORKSPACE_ROOT}/output`;
export const SANDBOX_SKILLS_ROOT = "/skills";
export const SANDBOX_TEMP_ROOT = "/tmp";
export const SOURCEWEFT_WORK_ROOT = "/work";
export const SOURCEWEFT_KB_ROOT = "/kb";

export type SandboxOperationType = "prepare" | "execute" | "collect";

export type SandboxRef = {
  id: string;
  provider: typeof DAYTONA_PROVIDER;
  providerSandboxId: string;
};

export type SandboxExecuteResult = ExecuteResponse;

export type SandboxPreparedFile = {
  sourcePath: string;
  sandboxPath: string;
  sizeBytes: number;
};

export type SandboxCollectedOutput = {
  sandboxPath: string;
  targetKind: "workfile" | "artifact";
  targetPath?: string;
  sizeBytes: number;
};

export type SandboxRuntimeContext = {
  teamId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  messageId: string;
  runId: string;
  sandboxExecuteToolCallId?: string;
};
