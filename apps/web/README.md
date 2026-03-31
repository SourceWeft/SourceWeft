# Web App

Next.js web client for SourceWeft.

## MVP Features

- Better Auth UI multi-method sign-in (`/auth/login`)
  - Google One Tap
  - Email OTP
  - GitHub OAuth
  - Passkey
  - Password
  - Magic Link
- Organization creation/switching
- Workspace creation/switching via shell component (`/app`)

## Local Run

```bash
pnpm --filter web dev
```

Required environment variables are in `apps/web/.env.example`.
