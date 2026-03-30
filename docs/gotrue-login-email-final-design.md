# Better Auth Login + Unified Email Final Design (V2)

> Note: filename keeps `gotrue` for history, but this design fully replaces GoTrue with Better Auth.

## 1. Goal and scope

This document defines the final auth and email architecture for a new project that needs:

- Self-hosted authentication (no SaaS lock-in)
- Login support for Next.js web and Chrome extension (WXT)
- Google One Tap on web
- Team-first account model with workspace-level operation context
- Unified email delivery for auth and business events
- Pluggable email provider layer (initial provider: Plunk API)
- Self-built auth UI using `shadcn/ui` (no third-party auth UI package)

Out of scope in this phase:

- Building a third-party developer OAuth platform
- Runtime admin panel for editing auth secrets
- Implementing code in this step (design only)

---

## 2. Final decisions

1. Use `better-auth` as the authentication system.
2. Completely remove GoTrue from target architecture and operations.
3. Keep authentication headless and mount Better Auth in backend API.
4. Web supports all configured sign-in methods.
   - Default UI prominence order: Google One Tap, Email OTP
   - Additional methods panel: GitHub OAuth, Passkey, Password, Magic Link
5. Extension continues to use `Authorization Code + PKCE` as a public client.
6. Use Better Auth `organization` plugin as account boundary (Team boundary).
7. Keep `workspace` as business operation context (not auth primary boundary).
8. Workspace switching is a global shell component, not a dedicated route.
9. Build auth UI with `shadcn/ui` only.
10. Introduce pluggable mail provider architecture; initial provider is Plunk API.

---

## 3. High-level architecture

```txt
Internet
  |
  v
Gateway (TLS, routing)
  |- /api/*   -> Backend API (Hono)
  '- /        -> Next.js Web

Better Auth handler mounted at: /api/auth/*

Chrome Extension (WXT) ---> /api/auth/* (PKCE flow)
Web App (Next.js) -------> /api/auth/* (cookie session flow)

Backend API -----------> PostgreSQL
Backend API -----------> Redis/BullMQ (mail + async jobs)
Notification Worker ---> MailService ---> Plunk API

PostgreSQL:
  - auth tables (Better Auth core + organization plugin)
  - app tables (workspace + domain resources)
```

Core components:

- `gateway`: ingress and TLS
- `backend-api`: Hono service, mounts Better Auth handler
- `web`: Next.js frontend (custom auth pages + shell components)
- `extension`: WXT extension
- `notification-worker`: async business mail and retries
- `mail-service`: provider abstraction layer
- `postgres`: auth + app data
- `redis`: queue and background workloads

---

## 4. Identity and session model

### 4.1 Better Auth plugin set

Server plugin set:

- `organization` (account and governance boundary)
- `oneTap` (Google One Tap)
- `emailOTP` (passwordless email code)
- `passkey` (WebAuthn sign-in)
- `magicLink` (multi-method sign-in)
- `jwt` (token/JWKS for API-side verification)
- `bearer` (extension/API token style support)

Optional later:

- 2FA, api-key, sso/scim

### 4.2 Team-first boundary mapping

Boundary mapping for this product:

- Better Auth `organization` = domain `team` (account/billing/governance/isolation)
- Better Auth `member` = domain team membership identity edge
- App `workspace` = operation/collaboration context inside one organization

Key rule:

- Workspace is not an auth tenant primitive; it remains application domain data.

### 4.3 Active context strategy

- `activeOrganizationId`: stored in auth session (Better Auth supported field)
- `activeWorkspaceId`: stored in app context state (header/cookie/url state as needed)

Reason:

- Keeps auth core stable and generic
- Keeps workspace semantics product-specific

### 4.4 Session and token policy

- Web session: cookie-first (HttpOnly, secure, sameSite policy by deployment)
- Extension session: token-first (PKCE + refresh)
- Access token TTL: 10-15 minutes
- Refresh token TTL: 7-14 days
- Rotation: enabled
- Revoke on logout and suspicious activity

---

## 5. Login flow design

### 5.1 Web login flow (all methods supported)

Default UI prominence order:

1. Google One Tap
2. Email OTP
3. Additional methods panel: GitHub OAuth, Passkey, Password, and Magic Link

Design note:

- This order is presentation preference, not capability restriction.
- Product-level requirement is to support all configured methods.

One Tap flow:

1. Web renders GIS prompt.
2. GIS returns `credential`.
3. Web sends credential to backend auth endpoint.
4. Better Auth validates and creates session.
5. BFF returns authenticated state with secure cookie.

Nonce rule:

- Always use nonce for One Tap to prevent replay.

Browser compatibility note:

- One Tap is not Chrome-only, but runtime availability depends on browser capabilities and privacy settings.
- If One Tap cannot be shown, keep Google OAuth button and other sign-in methods visible.

### 5.2 Extension login flow

1. Extension generates PKCE verifier/challenge.
2. Launch browser auth flow with `chrome.identity.launchWebAuthFlow`.
3. Callback target is `https://<EXTENSION_ID>.chromiumapp.org/*`.
4. Exchange code for access/refresh token at auth endpoint.
5. Refresh with token endpoint, no client secret.

Rules:

- Extension is always public client.
- Redirect allowlist includes web and extension callbacks only.

### 5.3 Backend authorization

- Validate JWT via Better Auth JWKS endpoint.
- Validate `iss`, `aud`, `exp`, `sub`, signature, and key id.
- Keep domain authorization in application policy layer.

---

## 6. Self-built auth UI with shadcn

No third-party auth UI package is used.

### 6.1 Routes for auth pages

Auth pages kept:

- `/auth/sign-in`
- `/auth/sign-up`
- `/auth/verify-email`
- `/auth/forgot-password`
- `/auth/reset-password`
- `/auth/accept-invitation`

Notes:

- No `/workspace/switch` route.
- Workspace switching is shell component behavior.

### 6.2 Workspace UX model (SurfSense-style reference)

Workspace is managed by global layout components:

- Desktop: left `WorkspaceRail` component (avatars + active state + create button)
- Mobile: sheet panel with workspace list and create action
- Context menu/long press for workspace actions (settings/leave/delete)
- `CreateWorkspaceDialog` (shadcn dialog + form)

This mirrors the operational pattern used in SurfSense:

- global context switch in shell
- create/switch in component interaction
- not a dedicated switch page

### 6.3 UI component set

Suggested component set in shared UI layer:

- `AuthMethodCard`
- `OneTapEntry`
- `EmailOtpForm`
- `GithubOAuthButton`
- `PasskeyEntry`
- `PasswordMethodPanel`
- `MagicLinkMethodPanel`
- `OrganizationSwitcher`
- `WorkspaceRail`
- `CreateWorkspaceDialog`

---

## 7. Organization and workspace lifecycle

### 7.1 Signup bootstrap

When a user signs up:

1. Create user account
2. Create personal organization (team)
3. Create default workspace under that organization
4. Set active organization and active workspace in app context

### 7.2 Organization operations

Organization handles:

- membership
- invitations
- governance roles
- billing ownership boundary

### 7.3 Workspace operations

Workspace handles:

- collaboration context
- knowledge/data scope
- thread/document/source operations

Role rule:

- Workspace member must be organization member first.

---

## 8. Email architecture (pluggable provider, Plunk first)

### 8.1 Core principle

All outgoing mail goes through one internal `MailService` abstraction.

No module sends email directly to provider SDK.

### 8.2 Provider interface

Interface shape:

```ts
interface MailProvider {
  send(input: SendMailInput): Promise<SendMailResult>;
}
```

`SendMailInput` includes:

- `to`
- `subject`
- `html` and optional `text`
- `templateId`
- `variables`
- `messageType` (for observability)

### 8.3 Initial provider: Plunk API

Provider implementation:

- `PlunkApiProvider` as first production adapter
- API key from secret manager
- request id and provider message id logged for traceability

### 8.4 Mail event taxonomy

Auth events:

- `auth.verify-email`
- `auth.email-otp`
- `auth.reset-password`
- `auth.magic-link`
- `org.invitation`

Business events:

- `biz.invoice`
- `biz.notification`
- `biz.security-alert`

### 8.5 Template strategy

- Keep templates versioned
- Support auth and business templates in one repo
- Render template in app layer, then send via provider

Example structure:

```txt
email-templates/
  auth/
    verify-email.v1.html
    email-otp.v1.html
    reset-password.v1.html
    magic-link.v1.html
    invitation.v1.html
  biz/
    invoice.v1.html
    notification.v1.html
```

---

## 9. Environment variable strategy

### 9.1 Core variables

```env
# Public URLs
APP_PUBLIC_URL=https://app.example.com
API_PUBLIC_URL=https://api.example.com
EXTENSION_ID=abcdefghijklmnopabcdefghijklmnop

# Better Auth
BETTER_AUTH_URL=${API_PUBLIC_URL}
BETTER_AUTH_SECRET=replace_me
BETTER_AUTH_TRUSTED_ORIGINS=${APP_PUBLIC_URL},https://${EXTENSION_ID}.chromiumapp.org

# Google / One Tap
AUTH_GOOGLE_CLIENT_ID=web_client_id.apps.googleusercontent.com
AUTH_GOOGLE_CLIENT_SECRET=replace_me
NEXT_PUBLIC_GOOGLE_ONE_TAP_ENABLED=true
NEXT_PUBLIC_GOOGLE_ONE_TAP_CLIENT_ID=web_client_id.apps.googleusercontent.com

# GitHub OAuth
AUTH_GITHUB_CLIENT_ID=replace_me
AUTH_GITHUB_CLIENT_SECRET=replace_me

# Mail provider
MAIL_PROVIDER=plunk
MAIL_FROM_ADDRESS=noreply@example.com
MAIL_FROM_NAME=YourApp
PLUNK_API_KEY=replace_me
PLUNK_API_BASE_URL=https://api.useplunk.com

# Template versioning
MAIL_TEMPLATE_VERSION=v1
```

### 9.2 Variable ownership

- Auth and backend runtime read from one env source
- Web reads public-safe subset only
- Extension reads public-safe subset only

---

## 10. Runtime update policy

No standalone auth daemon exists now, so runtime policy changes:

- Template-only changes can be released independently
- Provider key rotation via secret manager + rolling deploy
- Auth config changes by standard backend rollout strategy

Operational recommendation:

- keep deployments small and frequent
- avoid mutable in-memory config hacks

---

## 11. Validation and test suite

Required test scripts before production:

1. `auth:test:web-one-tap`
   - One Tap success path, nonce validation, cookie issuance
2. `auth:test:web-email-otp`
   - OTP request, resend limits, login completion
3. `auth:test:web-github`
   - GitHub OAuth login path
4. `auth:test:web-passkey`
   - passkey register and sign-in path
5. `auth:test:web-password-magic-link`
   - password and magic-link sign-in path
6. `auth:test:extension-pkce`
   - extension callback and token refresh path
7. `auth:test:org-invite`
   - invite send, accept, org membership provisioning
8. `auth:test:workspace-context`
   - create multiple workspaces and switch via shell component
9. `mail:test:plunk-send`
   - provider auth, send success, response id capture
10. `mail:smoke`
    - aggregate auth and business mail checks

---

## 12. Security and operations checklist

- Enforce HTTPS in all non-local environments
- Strict callback allowlist for web and extension only
- One Tap nonce and trusted origin validation
- No secrets in extension build output
- Rate limit OTP, login, invitation, and reset endpoints
- Audit log for login, invite, org switch, workspace switch
- Rotate Better Auth and provider secrets regularly
- SPF, DKIM, DMARC configured for sender domain
- Monitor mail failure ratio and auth anomaly metrics

---

## 13. Why this is the final recommended approach

- Replaces GoTrue with a lighter embedded auth architecture
- Keeps self-hosted control while reducing deployment complexity
- Matches Team-first model using Better Auth organization plugin
- Preserves workspace as product-native operation boundary
- Delivers modern login UX: One Tap + OTP with multiple supported sign-in methods
- Avoids lock-in by introducing provider-agnostic mail architecture
- Ships with clear operational and security baselines
