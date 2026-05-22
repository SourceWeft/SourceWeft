import { ConnectorOAuthStartClient } from "./start-client";

type ConnectorOAuthStartSearchParams = {
  connector_type?: string;
  mode?: string;
  return_to?: string;
  workspace_id?: string;
};

export default async function ConnectorOAuthStartPage({
  searchParams,
}: {
  searchParams: Promise<ConnectorOAuthStartSearchParams>;
}) {
  const params = await searchParams;

  return (
    <ConnectorOAuthStartClient
      connectorType={params.connector_type ?? null}
      mode={params.mode ?? null}
      returnTo={params.return_to ?? null}
      workspaceId={params.workspace_id ?? null}
    />
  );
}
