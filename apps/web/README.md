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

## Google Auth Notes

- Google One Tap is disabled unless `NEXT_PUBLIC_GOOGLE_ONE_TAP_ENABLED=true`
  and `NEXT_PUBLIC_GOOGLE_ONE_TAP_CLIENT_ID` is set.
- Use the same Google Web client id on the backend as
  `AUTH_GOOGLE_ONE_TAP_CLIENT_ID`; add the web origin, for example
  `https://sourceweft.com`, in Google Cloud.
- Browser redirect sign-in is configured on the backend with
  `AUTH_GOOGLE_SIGNIN_WEB_CLIENT_ID` and
  `AUTH_GOOGLE_SIGNIN_WEB_CLIENT_SECRET`; its callback is
  `<NEXT_PUBLIC_API_BASE_URL>/api/auth/callback/google`.
- `NEXT_PUBLIC_GOOGLE_MOBILE_CLIENT_ID` is only for the Tauri mobile host.
