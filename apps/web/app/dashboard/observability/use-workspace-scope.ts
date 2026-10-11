"use client";

import { useCallback, useEffect, useState } from "react";

export const ALL_WORKSPACES = "__all__";

export function useObservabilityWorkspaceScope({
  organizationId,
  workspaceId,
  workspaces,
}: {
  organizationId: string | null;
  workspaceId: string | null;
  workspaces: ReadonlyArray<{ id: string }>;
}) {
  const defaultScope = organizationId
    ? workspaces.some((workspace) => workspace.id === workspaceId)
      ? workspaceId
      : ALL_WORKSPACES
    : null;
  const [selection, setSelection] = useState({
    organizationId,
    scope: defaultScope,
  });
  // Derive the safe scope during render. Merely resetting it in an effect
  // still lets this render's loading effects issue a request for the old team.
  const scope =
    selection.organizationId === organizationId &&
    (selection.scope === ALL_WORKSPACES ||
      workspaces.some((workspace) => workspace.id === selection.scope))
      ? selection.scope
      : defaultScope;

  useEffect(() => {
    if (
      selection.organizationId !== organizationId ||
      selection.scope !== scope
    )
      setSelection({ organizationId, scope });
  }, [organizationId, scope, selection]);

  const setScope = useCallback(
    (next: string) => setSelection({ organizationId, scope: next }),
    [organizationId],
  );
  return [scope, setScope] as const;
}
