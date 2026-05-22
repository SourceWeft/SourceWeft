export type ConnectorActionApprovalCursor = {
  value: number;
};

export type ConnectorActionExecutionRef = {
  actionRunId: string;
  connectorId: string;
  toolName: string;
};

export type ConnectorActionExecutionCursor = {
  refs: ConnectorActionExecutionRef[];
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
    toolName: string;
  },
) {
  const cursor = context.actionExecutionCursor;
  if (!cursor) {
    return null;
  }
  const index = cursor.value;
  const ref = cursor.refs[index];
  if (!ref) {
    return null;
  }
  if (ref.toolName !== input.toolName) {
    return null;
  }
  if (input.connectorId && ref.connectorId !== input.connectorId) {
    return null;
  }
  cursor.value += 1;
  return ref;
}
