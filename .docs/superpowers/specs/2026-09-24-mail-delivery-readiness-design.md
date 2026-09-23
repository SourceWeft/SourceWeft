# Mail delivery readiness and public URL

Status: approved for implementation on 2026-09-24.

## Incident

Production provides `PUBLIC_WEB_BASE_URL=https://sourceweft.com`, but mail template rendering reads only `NEXT_PUBLIC_WEB_BASE_URL` and `BASE_URL`. Rendering an email OTP in the production API container fails before the configured Plunk provider is called. Better Auth returns `success: true` while its background-task logger reports an error without a useful message.

## Design

Restore service first by setting `NEXT_PUBLIC_WEB_BASE_URL` to the same public URL on the API application and redeploying only that application. Preserve the current image, environment state, and deployment record for rollback. Verify rendering without sending, then send one OTP to the authorized test address and inspect provider acceptance and recipient delivery.

For the durable fix, resolve the public web URL once for mail rendering with this precedence: trusted per-message `variables.baseUrl`, `PUBLIC_WEB_BASE_URL`, legacy `NEXT_PUBLIC_WEB_BASE_URL`, then legacy `BASE_URL`. Keep the production missing-URL error; update its message to name the canonical setting. This URL and template rendering are provider independent. Provider selection remains explicit through `MAIL_PROVIDER`; no automatic fallback is introduced.

Move template rendering inside `MailService.sendTemplate`'s error boundary so a rendering failure is logged with message type and template ID before rethrowing. Serialize Better Auth `Error` arguments into safe name/message/stack fields so background failures are diagnosable, without logging OTPs, credentials, or request bodies. Provider acceptance is distinct from inbox delivery; the UI's `success: true` is not delivery evidence.

## Verification

Cover canonical URL precedence, legacy compatibility, and fail-fast behavior when production has no public URL. Cover template-rendering failure logging and Better Auth error serialization without secret values. Run focused tests and backend type checks. For production, confirm healthy API, successful dry rendering, provider acceptance log, and recipient receipt; report each separately. If the temporary configuration deployment fails, restore its prior environment and image. If the permanent release fails, roll back its image while retaining the working temporary URL configuration.
