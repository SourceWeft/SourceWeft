# modules

Purpose of this directory:

- Hold backend business modules.
- Keep domain-oriented folders such as `auth`, `workspace`, `content`, `jobs`, and `billing`.

Current MVP modules:

- `auth`: Better Auth server setup, plugin configuration, and auth email callbacks
- `workspace`: workspace creation/list/context services scoped by organization membership
- `mail`: provider-agnostic mail service with Plunk API adapter
- `billing`: team-scoped credits + pages metering and ledger services
- `ops`: alerting and operational notification orchestration
- `content`: source indexing + thread/message write paths

Each module should expose clear service-level interfaces and avoid cross-module coupling where possible.
