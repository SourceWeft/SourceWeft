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
- Backend AI bootstrap seed: `MODEL_GATEWAY_*`
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

## Model Gateway Notes

- `MODEL_GATEWAY_ENCRYPTION_SECRET` is required in backend runtime. It encrypts/decrypts gateway API keys stored in DB.
- `MODEL_GATEWAY_GLOBAL_CONFIG_PATH` is optional. When set, backend loads that JSON file on startup and syncs global gateway/profile config into DB.
- The example global config sets `chat-default` to `openrouter/minimax/minimax-2.7`, keeps `embed-default` on DeepInfra, and enables openai-compatible providers like SiliconFlow through provider-level DB sync.
- Runtime reads gateway/profile config from DB only; pricing sync remains on scheduler/worker jobs.
