import { jsonValuesEqual } from "./json-compare";

export type ConnectorActionApprovalCursor = {
  value: number;
};

export type ConnectorActionExecutionRef = {
  actionRunId: string;
  connectorId: string;
  requestJson?: Record<string, unknown>;
  toolName: string;
};

export type ConnectorActionExecutionCursor = {
  refs: ConnectorActionExecutionRef[];
  consumedActionRunIds?: Set<string>;
  value: number;
};

export type ConnectorActionApprovalIdempotencyContext = {
  actionApprovalCursor?: ConnectorActionApprovalCursor;
  actionExecutionCursor?: ConnectorActionExecutionCursor;
  actionApprovalScope?: string;
};

export function buildConnectorActionApprovalIdempotencyKey(input: {
  index: number;
  scope: string;
  toolName: string;
}) {
  return `agent-hitl:${input.scope}:${input.index}:${input.toolName}`;
}

export function buildConnectorActionApprovalScope(input: {
  checkpointId?: string | null;
  threadId: string;
}) {
  return input.checkpointId
    ? `${input.threadId}:${input.checkpointId}`
    : input.threadId;
}

export function resolveConnectorActionToolIdempotencyKey(
  context: ConnectorActionApprovalIdempotencyContext,
  input: {
    fallback?: string;
    toolName: string;
  },
) {
  if (context.actionApprovalScope && context.actionApprovalCursor) {
    const index = context.actionApprovalCursor.value;
    context.actionApprovalCursor.value += 1;
    return buildConnectorActionApprovalIdempotencyKey({
      index,
      scope: context.actionApprovalScope,
      toolName: input.toolName,
    });
  }
  return input.fallback;
}

export function resolveConnectorActionExecutionRef(
  context: ConnectorActionApprovalIdempotencyContext,
  input: {
    connectorId?: string;
    requestJson?: Record<string, unknown>;
    toolName: string;
  },
) {
  const ref = findConnectorActionExecutionRef(context, input);
  if (!ref) {
    return null;
  }
  const cursor = context.actionExecutionCursor;
  if (!cursor) {
    return null;
  }
  cursor.consumedActionRunIds ??= new Set<string>();
  cursor.consumedActionRunIds.add(ref.actionRunId);
  cursor.value = Math.max(
    cursor.value,
    cursor.refs.findIndex(
      (candidate) =>
        candidate.actionRunId === ref.actionRunId &&
        candidate.connectorId === ref.connectorId,
    ) + 1,
  );
  return ref;
}

export function peekConnectorActionExecutionRef(
  context: ConnectorActionApprovalIdempotencyContext,
  input: {
    connectorId?: string;
    requestJson?: Record<string, unknown>;
    toolName: string;
  },
) {
  return findConnectorActionExecutionRef(context, input);
}

function findConnectorActionExecutionRef(
  context: ConnectorActionApprovalIdempotencyContext,
  input: {
    connectorId?: string;
    requestJson?: Record<string, unknown>;
    toolName: string;
  },
) {
  const cursor = context.actionExecutionCursor;
  if (!cursor) {
    return null;
  }
  const ref = cursor.refs.find((candidate, index) => {
    if (
      index < cursor.value &&
      !candidate.requestJson &&
      !input.requestJson
    ) {
      return false;
    }
    if (cursor.consumedActionRunIds?.has(candidate.actionRunId)) {
      return false;
    }
    if (candidate.toolName !== input.toolName) {
      return false;
    }
    if (input.connectorId && candidate.connectorId !== input.connectorId) {
      return false;
    }
    if (
      input.requestJson &&
      candidate.requestJson &&
      !jsonValuesEqual(candidate.requestJson, input.requestJson)
    ) {
      return false;
    }
    return true;
  });
  return ref ?? null;
}
