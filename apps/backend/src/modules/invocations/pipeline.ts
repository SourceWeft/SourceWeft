import { createInvocationEvent } from "./events";
import { resolveInvocationSelection } from "./resolver";
import type { SelectableInvocationRegistry } from "./registry";
import type {
  InvocationEnvelope,
  InvocationEvent,
  InvocationPlan,
  NormalizedInvocationError,
} from "./types";
import type {
  InvocationPolicyContext,
  InvocationPolicyDecision,
} from "./policy";

export type InvocationPipelineOutput =
  | {
      status: "handoff_ready";
      plan: InvocationPlan;
      events: InvocationEvent[];
    }
  | {
      status: "direct_execute_ready";
      plan: Extract<InvocationPlan, { kind: "direct_execute" }>;
      events: InvocationEvent[];
    }
  | {
      status: "approval_required";
      decision: Extract<InvocationPolicyDecision, { decision: "ask" }>;
      events: InvocationEvent[];
    }
  | {
      status: "error";
      error: NormalizedInvocationError;
      events: InvocationEvent[];
    };

export function runInvocationPipeline(input: {
  registry: SelectableInvocationRegistry;
  envelope: InvocationEnvelope;
  directExecuteEligible?: boolean;
  policyEvaluator: (
    context: InvocationPolicyContext,
  ) => InvocationPolicyDecision;
  workspaceId?: string;
  userId?: string;
}): InvocationPipelineOutput {
  const events: InvocationEvent[] = [];
  const resolved = resolveInvocationSelection({
    registry: input.registry,
    envelope: input.envelope,
    directExecuteEligible: input.directExecuteEligible,
  });
  if (!resolved.ok) {
    events.push(
      createInvocationEvent({
        type: "error",
        selectableId: input.envelope.selectableId,
        error: resolved.error,
      }),
    );
    return { status: "error", error: resolved.error, events };
  }

  events.push(
    createInvocationEvent({
      type: "resolve",
      selectableId: input.envelope.selectableId,
      sourceRef: resolved.plan.sourceRef,
    }),
  );
  const decision = input.policyEvaluator({
    workspaceId: input.workspaceId ?? "workspace",
    userId: input.userId ?? "user",
    plan: resolved.plan,
  });
  events.push(
    createInvocationEvent({
      type: "policy",
      selectableId: input.envelope.selectableId,
      sourceRef: resolved.plan.sourceRef,
      decision: decision.decision,
    }),
  );

  if (decision.decision === "ask") {
    events.push(
      createInvocationEvent({
        type: "approval_required",
        selectableId: input.envelope.selectableId,
        sourceRef: decision.sourceRef,
        approvalRef: decision.approvalRef,
        reason: decision.reason,
      }),
    );
    return { status: "approval_required", decision, events };
  }
  if (decision.decision === "deny") {
    events.push(
      createInvocationEvent({
        type: "error",
        selectableId: input.envelope.selectableId,
        sourceRef: resolved.plan.sourceRef,
        error: decision.error,
      }),
    );
    return { status: "error", error: decision.error, events };
  }

  if (resolved.plan.kind === "direct_execute") {
    events.push(
      createInvocationEvent({
        type: "direct_execute",
        selectableId: input.envelope.selectableId,
        sourceRef: resolved.plan.sourceRef,
      }),
    );
    return { status: "direct_execute_ready", plan: resolved.plan, events };
  }
  if (resolved.plan.kind === "bind_tool_choice") {
    events.push(
      createInvocationEvent({
        type: "tool_choice_bound",
        selectableId: input.envelope.selectableId,
        sourceRef: resolved.plan.sourceRef,
        toolName: resolved.plan.semantics.toolName,
      }),
    );
  }
  if (resolved.plan.kind === "inject_context") {
    events.push(
      createInvocationEvent({
        type: "context_injected",
        selectableId: input.envelope.selectableId,
        sourceRef: resolved.plan.sourceRef,
        instruction: resolved.plan.semantics.workflow,
      }),
    );
  }
  events.push(
    createInvocationEvent({
      type: "deepagents_handoff",
      selectableId: input.envelope.selectableId,
      sourceRef: resolved.plan.sourceRef,
      boundary: "deepagents",
    }),
  );
  return { status: "handoff_ready", plan: resolved.plan, events };
}
