import { ConnectorOAuthCompleteClient } from "./complete-client";

type ConnectorOAuthCompleteSearchParams = {
  account_id?: string;
  connector_oauth?: string;
  connector_type?: string;
  error?: string;
  mode?: string;
  return_to?: string;
  workspace_id?: string;
};

export default async function ConnectorOAuthCompletePage({
  searchParams,
}: {
  searchParams: Promise<ConnectorOAuthCompleteSearchParams>;
}) {
  const params = await searchParams;

  return (
    <ConnectorOAuthCompleteClient
      accountId={params.account_id ?? null}
      connectorOAuth={params.connector_oauth ?? null}
      connectorType={params.connector_type ?? null}
      error={params.error ?? null}
      mode={params.mode ?? null}
      returnTo={params.return_to ?? null}
      workspaceId={params.workspace_id ?? null}
    />
  );
}
