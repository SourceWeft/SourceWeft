import {
  buildCapabilityCommandList,
  type CapabilityCommandListConfig,
  type CapabilityCommandListItem,
} from "@sourceweft/capability-runtime";
import { ContentError } from "../../content/errors";
import type { EnabledSkillDescriptor } from "../../skills/types";
import { evaluateInvocationPolicy } from "../../invocations/policy-evaluator";
import { runInvocationPipeline } from "../../invocations/pipeline";
import type { WorkspaceMcpInstall } from "../../invocations/mcp-install";
import { createSelectableInvocationRegistry } from "../../invocations/registry";
import type {
  SelectableInvocationProvider,
  SelectableInvocationRegistry,
} from "../../invocations/registry";
import type { InvocationEnvelope } from "../../invocations/types";
import { createCapabilityToolInvocationProvider } from "../../invocations/providers/capability-tools";
import { createWorkspaceMcpInvocationProvider } from "../../invocations/providers/workspace-mcp";
import { listCapabilityCommands } from "./capability-command-workflows";
import type { ResolvedThreadInvocation } from "./types";

export function buildInvocationAugmentedText(input: {
  readonly invocation: ResolvedThreadInvocation | null;
  readonly text: string;
}) {
  if (!input.invocation) {
    return input.text;
  }
  if (input.invocation.kind === "context_injection") {
    return `<sourceweft_invocation id="${input.invocation.selectableId}" kind="context_injection">\n${input.invocation.instruction}\n</sourceweft_invocation>\n\n<user_request>\n${input.invocation.userInput}\n</user_request>`;
  }
  return `<sourceweft_invocation id="${input.invocation.selectableId}" kind="fixed_tool_choice" tool="${input.invocation.toolName}">\nUse the backend-selected tool for this request. Do not infer runtime semantics from the client payload.\n</sourceweft_invocation>\n\n<user_request>\n${input.invocation.userInput}\n</user_request>`;
}

export function buildTurnInvocationRegistry(input: {
  readonly capabilityCommands?: readonly CapabilityCommandListItem[];
  readonly capabilityConfig?: CapabilityCommandListConfig;
  readonly enabledSkills: readonly EnabledSkillDescriptor[];
  readonly providers?: readonly SelectableInvocationProvider[];
  readonly workspaceMcpInstalls?: readonly WorkspaceMcpInstall[];
}) {
  const capabilityCommands =
    input.capabilityCommands ??
    buildCapabilityCommandList([], input.capabilityConfig);
  return createSelectableInvocationRegistry({
    providers: [
      ...(input.providers ?? [
        createCapabilityToolInvocationProvider({
          commands: capabilityCommands,
        }),
        createWorkspaceMcpInvocationProvider({
          installs: [...(input.workspaceMcpInstalls ?? [])],
        }),
      ]),
    ],
  });
}

export async function buildDefaultTurnInvocationRegistry(input: {
  readonly capabilityConfig?: CapabilityCommandListConfig;
  readonly enabledSkills: readonly EnabledSkillDescriptor[];
  readonly workspaceMcpInstalls?: readonly WorkspaceMcpInstall[];
}) {
  return buildTurnInvocationRegistry({
    capabilityCommands: await listCapabilityCommands(input.capabilityConfig),
    capabilityConfig: input.capabilityConfig,
    enabledSkills: input.enabledSkills,
    workspaceMcpInstalls: input.workspaceMcpInstalls,
  });
}

export function resolveThreadInvocation(input: {
  readonly envelope?: InvocationEnvelope;
  readonly registry: SelectableInvocationRegistry;
  readonly workspaceId: string;
  readonly userId: string;
}): ResolvedThreadInvocation | null {
  if (!input.envelope) {
    return null;
  }
  const output = runInvocationPipeline({
    registry: input.registry,
    envelope: input.envelope,
    workspaceId: input.workspaceId,
    userId: input.userId,
    policyEvaluator: (context) => evaluateInvocationPolicy({ plan: context.plan }),
  });
  if (output.status === "error") {
    throw new ContentError(400, output.error.code, output.error.message, {
      details: output.error.details,
      recoverable: output.error.recoverable,
      sourceRef: output.error.sourceRef,
    });
  }
  if (output.status === "approval_required") {
    throw new ContentError(
      409,
      "INVOCATION_APPROVAL_REQUIRED",
      output.decision.reason,
      {
        recoverable: true,
        sourceRef: output.decision.sourceRef,
      },
    );
  }
  if (output.status === "direct_execute_ready") {
    throw new ContentError(
      400,
      "INVOCATION_UNSUPPORTED_PLAN",
      "Direct MCP invocation execution is not available in thread turns",
      {
        sourceRef: output.plan.sourceRef,
      },
    );
  }
  if (output.plan.kind === "bind_tool_choice") {
    return {
      kind: "fixed_tool_choice",
      selectableId: output.plan.selectableId,
      target: output.plan.semantics.target,
      toolName: output.plan.semantics.toolName,
      sourceRef: output.plan.sourceRef,
      userInput: output.plan.userInput,
      events: output.events,
    };
  }
  if (output.plan.kind === "inject_context") {
    return {
      kind: "context_injection",
      selectableId: output.plan.selectableId,
      sourceRef: output.plan.sourceRef,
      instruction: output.plan.semantics.workflow.replaceAll(
        "$ARGUMENTS",
        output.plan.userInput,
      ),
      userInput: output.plan.userInput,
      events: output.events,
    };
  }
  throw new ContentError(
    400,
    "INVOCATION_UNSUPPORTED_PLAN",
    "Invocation selection cannot be prepared for a thread turn",
    {
      sourceRef: output.plan.sourceRef,
    },
  );
}
