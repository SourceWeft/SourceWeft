import { config } from "../shared/config";

async function main() {
  if (!config.auth.extensionEnabled) {
    console.info(
      "Extension OAuth client disabled: AUTH_EXTENSION_ID is not configured",
    );
    return;
  }

  const [{ closeDatabase, database }, { createSourceweftAuth }, provisioner] =
    await Promise.all([
      import("@sourceweft/db"),
      import("../modules/auth/auth-config"),
      import("../modules/auth/extension-oauth-client"),
    ]);

  try {
    const migrationAuth = createSourceweftAuth({ mode: "migration" });
    await migrationAuth.$context;

    const result = await provisioner.provisionExtensionOAuthClient(database, {
      clientId: config.auth.extensionClientId,
      redirectUri: config.auth.extensionRedirectUri,
      resource: config.auth.baseUrl,
    });

    const status = result.createdClient
      ? "created"
      : result.createdLink
        ? "linked"
        : "verified";
    console.info(
      `Extension OAuth client ${status}: ${config.auth.extensionClientId}`,
    );
  } finally {
    await closeDatabase();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Extension OAuth client provisioning failed: ${message}`);
  process.exitCode = 1;
});
