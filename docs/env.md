# Environment Variables

## Policy

- Keep one `.env.example` per app.
- Do not keep concrete env values in the repository root.
- Keep secrets in backend only.
- Frontend apps (`web`, `extension`, `desktop`) must use public-safe variables only.

## App Files

- `apps/backend/.env.example`
- `apps/web/.env.example`
- `apps/extension/.env.example`
- `apps/desktop/.env.example`
- `apps/docs/.env.example`

## Naming Conventions

- Backend: `BACKEND_*`, queue/runtime keys like `REDIS_URL`, `JOB_QUEUE_NAME`
- Backend AI runtime: `LITELLM_*`
- Backend auth: `BETTER_AUTH_*`, `AUTH_*`
- Backend mail: `MAIL_*`, provider-specific keys such as `PLUNK_*`
- Backend billing/payments: `BACKEND_BILLING_*`, `CREEM_*`
- Backend ops/alerts: `BACKEND_ALERTS_*`, `OPS_ALERT_*`
- Web (Next.js browser-safe): `NEXT_PUBLIC_*`
- Extension (WXT/Vite browser-safe): `VITE_*`
- Desktop frontend (Vite browser-safe): `VITE_*`

## Local Setup

Create `.env` files from examples inside each app directory.

Examples:

```bash
cp apps/backend/.env.example apps/backend/.env
cp apps/web/.env.example apps/web/.env.local
cp apps/extension/.env.example apps/extension/.env
cp apps/desktop/.env.example apps/desktop/.env
```
