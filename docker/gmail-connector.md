# Gmail connector

The Gmail connector supports live mailbox search and reading, optional indexing of selected mail, and sending one reviewed plain-text message at a time. Attachments, drafts, replies, forwarding, bulk/background sends, and message mutations are not supported.

## Self-hosted OAuth setup

1. Create a Google Cloud project for the deployment and enable the Gmail API.
2. Configure the Google Auth Platform consent screen with the deployment's public homepage, privacy policy, support contact, and authorized domain.
3. Declare only these scopes in Data access:
   - `https://www.googleapis.com/auth/gmail.readonly` — live search/read and optional indexing.
   - `https://www.googleapis.com/auth/gmail.send` — a separately approved outbound message.
4. Create a Web application OAuth client. Register the exact redirect URI `https://<public-api-host>/v1/connectors/oauth/gmail/callback`. It must match the backend's `GMAIL_REDIRECT_URI` or the callback derived from its public base URL.
5. Set `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and, when needed, `GMAIL_REDIRECT_URI` on the backend. Set `GMAIL_CONNECTOR_ENABLED=true` only in an authorized test deployment or after the applicable production approval. Keep the client secret out of the repository, browser, connector configuration, and logs. Restart the backend after changing deployment variables.
6. During Testing, add each intended tester on the Audience page. Google limits Testing access and test-user authorizations; use a production project and complete Google's verification process before a public rollout.

Google's [OAuth publishing status guidance](https://support.google.com/cloud/answer/15549945) explains Testing limits and token expiry. [Gmail scope classifications](https://developers.google.com/workspace/gmail/api/auth/scopes) and [verification guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) explain the review required for public use.

## User controls

Connecting Gmail requests read and send permissions once. The connector records the scopes actually granted. If send permission is declined, reading can still work, but sending is blocked with an explicit permission error.

Live search is on after connection and can be disabled independently. Live results are fetched for the current request; they do not create indexed sources or sync jobs.

Indexing is off until enabled in Sources Hub. Choose labels, an optional starting date, and a maximum message count. Labels currently filter imports; indexed messages appear under one mailbox Messages directory. Run the initial sync manually. Scheduled sync is a separate opt-in setting. Disabling indexing stops future imports; use connector deletion with derived-content removal to remove indexed copies.

Before sending, SourceWeft shows the sender, all recipients, subject, and full body. The user must approve that exact message. A send approval cannot be reused for another message or automatically applied to future sends. An uncertain provider outcome is reported without automatic resend.

## Troubleshooting

- **OAuth configuration missing:** check the client ID, secret, and exact callback URI.
- **Testing access denied:** add the Google account as a test user or move a review-ready production app through verification.
- **Reauthorization required:** reconnect the account after revocation, expired test authorization, or changed grants.
- **Indexing scope unavailable:** reselect labels after a rename, deletion, or permission change.
- **Rate limit or Gmail outage:** the connector reports the provider failure. A failed sync retains its committed checkpoint so a later run can replay safely.
- **Send outcome uncertain:** check Gmail Sent Mail before composing a new send; SourceWeft does not automatically retry a potentially delivered message.
