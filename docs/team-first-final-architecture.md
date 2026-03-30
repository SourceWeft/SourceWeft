# Team-First Architecture (Final Design)

## 1. Purpose and Status

This document defines the final product and system architecture for a SurfSense/NotebookLM-like platform with:

- Individual and team usage
- Team billing and team administration
- Shared multi-company SaaS on one instance
- Dedicated hosting and self-hosted deployment options

Status:

- Design frozen
- Documentation only
- No implementation included in this step

---

## 2. Core Design Decisions

1. Top-level boundary is **Team** (single term, no separate tenant term).
2. Individuals are modeled as **personal teams**.
3. Team and workspace are different layers:
   - Team = account, billing, governance, isolation boundary
   - Workspace = collaboration and knowledge boundary inside a team
4. Architecture must support three deployment modes:
   - Shared SaaS (many teams on one platform)
   - Dedicated hosted (one team per isolated stack)
   - Self-hosted (customer-managed stack)
5. AI stack remains:
   - Hono + LangGraph.js + LangChain.js + LiteLLM (day 1)
   - PostgreSQL + pgvector + tsvector
   - Redis + BullMQ
   - S3 only (no MinIO)
6. Identity stack is Better Auth with organization plugin:
   - `organization` maps to Team account boundary
   - `workspace` remains domain-level operation context

---

## 3. Canonical Domain Model

```txt
User
  -> TeamMembership (team role)
Team (type: personal | organization)
  -> Workspace
  -> BillingAccount
  -> Subscription
  -> DeploymentBinding
Workspace
  -> Sources / Documents / Chunks / Threads / Messages / Citations
```

Relationship rules:

- A user can belong to multiple teams.
- Each user gets one personal team at signup.
- A team can contain multiple workspaces.
- A workspace belongs to exactly one team.
- All core resources must belong to one team and one workspace.

Identity mapping rules:

- Auth `organization` is the canonical identity-level representation of Team.
- Auth session stores `activeOrganizationId`.
- Workspace active context is stored in application context, not auth core.

---

## 4. Product Operating Model

### 4.1 Individual model

- Signup creates:
  - personal team
  - default workspace in that team
- Individual billing is attached to the personal team.
- Individual can later create organization teams.

### 4.2 Team model

- Organization team supports:
  - member invite and role management
  - centralized billing
  - spend and usage controls
  - workspace-level collaboration

### 4.3 Individual upgrades to team

- Creating a team does not replace personal team.
- Personal and organization contexts coexist.
- User switches active context in UI/API.
- Data migration from personal to team is explicit (copy/import), not automatic.

---

## 5. Billing and Plan Model

Billing is always team-scoped.

### 5.1 Team billing entities

- `billing_accounts` (1 per team)
- `subscriptions`
- `seat_assignments`
- `usage_ledgers`
- `spend_limits` (team-level and user-level)
- `invoices` and `invoice_items`

### 5.2 Plan families

- `individual_free`
- `individual_pro`
- `team_standard`
- `team_premium`
- `enterprise_usage`

### 5.3 Spend governance

- Hard and soft spend caps per team
- Optional per-user spend limits inside a team
- Quota policies by feature (chat, embeddings, rerank, ingestion)

---

## 6. Access Control Model

Two-level RBAC:

### 6.1 Team roles

- `owner`
- `admin`
- `billing_admin`
- `security_admin`
- `member`

### 6.2 Workspace roles

- `workspace_admin`
- `editor`
- `viewer`

Policy rules:

- Every workspace member must also be a team member.
- Request authorization sequence:
  1. Team membership and team role check
  2. Workspace membership and workspace role check
- Team-level policy can deny actions even if workspace role allows them.

### 6.3 Auth and context integration

- Better Auth handler is mounted in backend API (`/api/auth/*`) instead of a standalone auth service.
- Better Auth `organization/member/invitation` handles account identity lifecycle.
- Workspace lifecycle (create/switch/archive) stays in application APIs.
- Workspace switching is a shell component behavior (rail/dropdown/sheet), not a dedicated route.
- Switching workspace updates operation context and data scope, not account identity.

---

## 7. Isolation Model (Shared SaaS Safety)

### 7.1 Data isolation

- Every core table includes `team_id` (not nullable).
- Workspace-scoped tables include both `team_id` and `workspace_id`.
- All queries must filter by `team_id` first.

### 7.2 Retrieval isolation

- Vector and lexical retrieval must include team/workspace filters.
- No cross-team retrieval under any mode.
- Cross-workspace retrieval is opt-in and only within same team.

### 7.3 Queue isolation

- Every job payload contains `team_id` and `workspace_id`.
- Scheduler and workers enforce per-team concurrency and fairness.

### 7.4 Object storage isolation

S3 key structure:

- `raw/{teamId}/{workspaceId}/{sourceId}/...`
- `parsed/{teamId}/{workspaceId}/{sourceId}/...`
- `artifacts/{teamId}/{workspaceId}/{threadId}/...`

### 7.5 Database hardening

- Phase 1: strict app-layer team filters + audit checks
- Phase 2: PostgreSQL RLS on team-scoped tables

---

## 8. Deployment Modes

### 8.1 Shared SaaS

- Multiple teams share control plane and data plane.
- Isolation relies on team-aware app logic + DB policies.
- Best for standard SaaS growth.

### 8.2 Dedicated hosted

- One team gets isolated data plane:
  - dedicated DB
  - dedicated Redis
  - dedicated S3 prefix/bucket policy
  - optional dedicated LiteLLM gateway
- Operated by platform team.

### 8.3 Self-hosted

- Customer runs stack in its own infrastructure.
- Product behavior and data model stay same.
- Operational profile differs (secrets, upgrades, monitoring ownership).

---

## 9. Runtime and Service Architecture

### 9.1 Fixed stack

- API: `Hono`
- Orchestration: `LangGraph.js`
- LLM integration: `LangChain.js`
- Gateway: `LiteLLM`
- Data: `PostgreSQL + pgvector + tsvector`
- Queue: `BullMQ + Redis`
- Storage: `AWS S3`
- Parsing: `Docling`

### 9.2 Service boundary

```txt
Client
  -> Hono API
     -> LangGraph flows
     -> internal LiteLLM SDK
     -> LiteLLM proxy
     -> PostgreSQL
     -> Redis/BullMQ

Worker
  -> S3 read
  -> Docling parse
  -> embedding/rerank via LiteLLM
  -> PostgreSQL writes
```

### 9.3 Identity subsystem boundary

- Better Auth runs inside backend runtime and shares PostgreSQL.
- Auth concerns: identity, session, org membership, invitation.
- Domain concerns: workspace model, RAG resources, billing, business authorization.
- This separation keeps identity generic and product semantics explicit.

---

## 10. RAG Design (Team-Scoped)

### 10.1 Ingestion

1. Register source metadata (team/workspace scoped)
2. Read object from S3
3. Parse with Docling
4. Normalize and chunk content
5. Generate embeddings via `embed-default`
6. Persist docs/chunks with team/workspace IDs

### 10.2 Retrieval and answer generation

1. Query rewrite
2. Dense retrieval (`pgvector`) with team/workspace filter
3. Lexical retrieval (`tsvector`) with same filter
4. RRF fusion
5. Rerank via `rerank-default`
6. Context packing with token budget
7. Generation via `chat-default`
8. Citation guard and evidence validation

Output constraints:

- Claims must map to citations.
- If evidence is insufficient, return explicit insufficiency.

---

## 11. LiteLLM-First Strategy

### 11.1 Gateway policy

- App code never calls provider SDKs directly.
- All model traffic routes through LiteLLM.
- Model usage uses aliases only:
  - `chat-default`
  - `embed-default`
  - `rerank-default`

### 11.2 Internal SDK

Use internal package `packages/litellm-sdk` for:

- chat complete/stream
- embedding
- rerank
- stream normalization
- provider compatibility handling
- unified error model and retry policy

Every request must include metadata:

- `team_id`
- `workspace_id`
- `user_id`
- `thread_id` (if chat)
- `feature`

---

## 12. API Contract Shape (Team-First)

### 12.1 Team APIs

- `POST /v1/teams`
- `GET /v1/teams`
- `GET /v1/teams/:teamId`
- `POST /v1/teams/:teamId/invites`
- `POST /v1/teams/:teamId/members/:userId/role`

### 12.2 Workspace APIs

- `POST /v1/teams/:teamId/workspaces`
- `GET /v1/teams/:teamId/workspaces`
- `POST /v1/workspaces/:workspaceId/members`

Notes:

- There is no `workspace switch` route.
- Switch action is a global UI component behavior that updates active workspace context.

### 12.3 Billing APIs

- `GET /v1/teams/:teamId/billing/summary`
- `GET /v1/teams/:teamId/billing/usage`
- `POST /v1/teams/:teamId/billing/spend-limits`

### 12.4 RAG/Chat APIs

- `POST /v1/workspaces/:workspaceId/uploads/presign`
- `POST /v1/workspaces/:workspaceId/sources`
- `POST /v1/workspaces/:workspaceId/sources/:id/index`
- `POST /v1/workspaces/:workspaceId/threads`
- `POST /v1/workspaces/:workspaceId/threads/:id/stream`

---

## 13. Data Model (Core Tables)

- `users`
- `teams`
- `team_memberships`
- `team_domains`
- `workspaces`
- `workspace_memberships`
- `sources`
- `documents`
- `chunks`
- `threads`
- `messages`
- `citations`
- `billing_accounts`
- `subscriptions`
- `seat_assignments`
- `usage_ledgers`
- `spend_limits`
- `deployment_bindings`
- `audit_logs`

Required indexes include:

- `chunks.embedding` HNSW
- `chunks.search_tsv` GIN
- composite indexes on `(team_id, workspace_id)` for core resource tables
- query-path indexes for `(team_id, created_at)` and `(workspace_id, created_at)`

---

## 14. Security and Compliance

- Team-scoped audit logging for admin, billing, and data actions
- SSO/SAML and SCIM for organization teams
- Domain verification/capture for enterprise teams
- KMS-backed encryption for S3 and sensitive credentials
- Optional IP allowlisting and regional controls for enterprise profiles
- Policy hooks for restricted tools and data egress controls

---

## 15. Observability and Cost Governance

Track by team/workspace/user:

- request latency and error rates
- token and model usage
- rerank and retrieval performance
- ingestion throughput and failure classes
- budget burn rate and limit breaches

Dashboards must support:

- team-level chargeback
- workspace-level usage trend
- user-level productivity and cost distribution

---

## 16. Migration and Rollout Plan

### Phase 1: Team foundation

- Introduce team entities and memberships
- Create personal team for existing users
- Add Better Auth organization mapping and team context to auth/session layer

### Phase 2: Data and API propagation

- Add team_id to all core resource tables
- Upgrade API routes to team-first contract
- Update S3 key schema to team/workspace format

### Phase 3: Runtime hardening

- Enforce worker and queue team fairness
- Add team-aware cost controls in LiteLLM metadata path
- Add retrieval guard checks for team/workspace scope

### Phase 4: Enterprise deployment profiles

- Dedicated hosted provisioning path
- Self-hosted packaging and lifecycle docs
- Compliance options and operational controls

---

## 17. Non-Goals for This Design Step

- No implementation code
- No migration execution
- No DB DDL rollout in this step
- No endpoint behavior change in runtime

---

## 18. Acceptance Criteria

This architecture is considered complete when:

1. Team is the only top-level account term across product and backend.
2. Individual and organization workflows are both first-class.
3. Team billing and team governance are separate from workspace collaboration.
4. Shared SaaS and private deployment modes use the same domain model.
5. All RAG and AI calls are safely team-scoped and auditable.
