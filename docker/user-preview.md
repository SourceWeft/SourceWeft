# User preview access

Preview eligibility is operator-managed data in the existing `user_settings.settings` JSONB document. It does not require a new table, authentication plugin, or database migration.

```json
{
  "appearance": { "theme": "system", "language": "system" },
  "preview": { "gmail": true }
}
```

The user settings API returns normalized preview flags but only accepts appearance updates. Users cannot grant themselves preview access. Missing flags are disabled. Only the boolean `true` grants access; malformed data is denied with a diagnostic, and database failures are surfaced rather than converted to an ordinary disabled flag.

## Deployment order

1. Deploy the preview-aware API, workers and scheduler. All processes that save user settings must use the atomic partial-update implementation before any preview grant is written. Older versions replace the complete JSON document and can erase grants when a user changes appearance.
2. Configure `GMAIL_CONNECTOR_ENABLED`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and the OAuth redirect URI on the backend. A user flag does not enable an unconfigured or disabled adapter.
3. Use the operator command to grant preview to a test user. Use a dedicated mailbox with test messages and an isolated workspace for review recordings.
4. Verify both an allowed account and an account without preview. Direct API calls and existing agent sessions must obey the same policy as the interface.

A rollback to an older application version restores its previous access behavior and whole-document settings writes. Before rolling back, disable Gmail at the deployment level and retain a backup of preview grants. Do not keep Gmail enabled on a version without the preview gate.

## Operator workflow

From a source checkout with backend dependencies and its database environment configured:

```sh
pnpm --filter @sourceweft/backend preview:user get --user-id USER_ID
pnpm --filter @sourceweft/backend preview:user grant --user-id USER_ID --feature gmail --actor OPERATOR --reason "Gmail review recording" --dry-run
pnpm --filter @sourceweft/backend preview:user grant --user-id USER_ID --feature gmail --actor OPERATOR --reason "Gmail review recording"
pnpm --filter @sourceweft/backend preview:user revoke --user-id USER_ID --feature gmail --actor OPERATOR --reason "Preview completed"
```

The target is a stable application user ID, not the Gmail mailbox address. Operator identity and reason are audit context; `--actor` is not an authentication mechanism. Protect command execution and database access with deployment/operator permissions. Retain structured operator logs in the deployment's log system; this feature does not create a durable audit table or a web administration endpoint.

## Access and revocation

Interactive Gmail operations require `preview.gmail === true` for the current user, alongside existing workspace permissions and OAuth grants. Background synchronization has no current user and checks the connection creator instead; a missing creator cannot be replaced with a system identity. Authorization is checked again at execution and synchronization boundaries rather than trusted from a previous UI response, login session or queued request.

Revoking eligibility prevents subsequent protected operations. It does not cancel a request already sent to Google or undo a sent email. Existing workspace permissions continue to allow disconnection and deletion after revocation. Restoring eligibility does not bypass OAuth expiration, workspace permissions, deployment activation, or explicit send approval.

## Content boundary

Preview is feature eligibility, not an additional confidentiality boundary for workspace content. Previously indexed mail, citations, chat messages and exported content retain their existing workspace access rules. Revoking preview neither deletes these records nor retracts content already shared. Delete derived content using existing connector/source controls when required.

## Google review

Application preview grants and Google OAuth Test users are independent. This feature does not publish the OAuth application, submit review materials, or remove restricted-scope security-assessment requirements.
