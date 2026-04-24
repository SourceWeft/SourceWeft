# Credits + Pages 方案（Individual V1，Team 预留）

## 1. 目的与状态

本文定义 SourceWeft 的计费与配额方案（V1）：

- 目标：在不限制功能能力的前提下，控制成本、保证可持续运营。
- 范围：仅启用 Individual（个人）方案；Team 计费能力暂不开发。
- 约束：必须与 `docs/team-first-final-architecture.md` 保持一致。

状态：

- 设计冻结（documentation only）
- 当前步骤不包含开发、不包含迁移执行

---

## 2. 外部参考与设计结论

参考平台：NoteGPT、YouMind、SurfSense、Manus、Monica。

抽象结论：

1. `SurfSense`：以 `pages of content` 控制导入容量，用户心智清晰。
2. `YouMind`：统一 credits 档位，沟通简单，便于扩容。
3. `NoteGPT`：Basic Quota + Premium Credit 双轨，适合多能力混合成本。
4. `Monica`：Advanced Credits 与能力强绑定，适合高成本能力统一结算。
5. `Manus`：按任务复杂度和时长消耗 credits，强调 usage 透明与退款规则。

最终采用：

- 双轨计量：`Pages + Credits`
- 能力不做 plan 功能限制：所有计划均可使用同一能力集合
- 仅通过配额与预算治理差异化计划

---

## 3. 核心设计决策

1. 账户边界仍是 Team：个人用户为 `personal team`。
2. 当前只启用个人商业化，不启用 team seats / team pooled billing。
3. 功能能力不限制：不按计划禁用模型、不按计划禁用功能。
4. 成本治理通过三层完成：
   - Pages（导入容量）
   - Credits（AI 计算成本）
   - Spend Limits（预算与风控）
5. 开源必须可关计费，支持 `disabled | shadow | enforced`。

---

## 4. Plan 家族与启用状态

与 `docs/team-first-final-architecture.md` 对齐，保留全部 plan family 枚举：

- `individual_free`（启用）
- `individual_pro`（启用）
- `team_standard`（预留，暂不实现）
- `team_premium`（预留，暂不实现）
- `enterprise_usage`（预留，暂不实现）

### 4.1 当前启用计划（V1）

| plan              | 价格（建议）           | Ingestion Pages | Credits                          | 能力访问   |
| ----------------- | ---------------------- | --------------- | -------------------------------- | ---------- |
| `individual_free` | $0                     | 300 / 月        | 3,000 / 月（可按日发放，月封顶） | 全能力可用 |
| `individual_pro`  | $20 / 月（年付可折扣） | 6,000 / 月      | 20,000 / 月                      | 全能力可用 |

说明：

- 差异只体现在配额、预算与支持等级，不体现在功能开关。
- 后续若新增 `individual_max`，仍保持“能力不限制”原则，仅提升配额与吞吐上限。

---

## 5. Credits 计量与结算规则

## 5.1 统一单位

- 建议基准：`1 credit = 0.002 USD`
- 可通过配置调整，不写死在业务代码。

## 5.2 扣费公式

`credits = ceil((provider_cost_usd + platform_cost_usd) * (1 + markup_rate) / credit_unit_usd)`

字段含义：

- `provider_cost_usd`：模型/API 实际成本（由 model gateway usage + price book 计算）
- `platform_cost_usd`：平台额外成本（检索、编排、存储、网络摊销）
- `markup_rate`：毛利系数（可按 feature 调整）
- `credit_unit_usd`：每 credit 对应美元价值（默认 0.002）

## 5.3 消耗范围

所有能力均可用，但都要计量 credits，包括但不限于：

- Chat / Agent / Deep Research
- Embedding / Rerank
- Image / Audio / Video 生成
- OCR / 文档解析 / 转写

## 5.4 扣减时机

- 同步请求：执行后即时 `consume`
- 异步任务：先 `reserve`，完成后 `finalize`（多退少补）
- 平台失败：`refund`

## 5.5 扣减顺序

推荐顺序（按最早到期优先）：

1. 当期月配 credits
2. 活动赠送 credits
3. 增购 add-on credits

## 5.6 刷新与过期

- 月配 credits：按订阅周期刷新，不结转。
- add-on credits：建议 12 个月有效。
- 订阅失效后：月配 credits 清零；add-on credits 可保留记录但不可用（恢复订阅后再激活）。

## 5.7 退款与争议策略

- 平台可验证技术故障：全额 credits 退款。
- 主观不满意、外部第三方故障、用户指令不清：默认不退款。

---

## 6. Ingestion Pages 计量规则

`pages` 只控制“导入与索引容量”，不控制功能访问。

## 6.1 计量流程

1. 预估页数（导入前）
2. 校验剩余额度（超限直接拒绝）
3. 导入成功后核算实际页数
4. 最终记账：`max(estimated_pages, actual_pages)`

## 6.2 换算口径

- PDF/DOCX/PPT：优先真实页数（PPT 1 slide = 1 page）
- URL/TXT/MD/OCR：`standard_page = ceil(parsed_tokens / 1000)`
- 最低计量单位：每个成功导入对象至少 1 page

## 6.3 例外处理

- 同 `content_hash` 重复导入不重复计页
- 仅新增/变更内容计页
- 失败导入不计页

---

## 7. 预算治理（Spend Governance）

虽然当前仅个人计划，仍按 team-scoped 模型实现预算治理（personal team）：

- `soft_cap`：到达比例告警（建议 50% / 80%）
- `hard_cap`：超过即阻断
- 错误码：`BILLING_LIMIT_EXCEEDED`、`CREDITS_EXHAUSTED`、`PAGES_LIMIT_EXCEEDED`

---

## 8. 开源计费开关（必须支持）

遵循 `docs/env.md` 命名约定，统一使用 `BACKEND_*`：

- `BACKEND_BILLING_MODE=disabled|shadow|enforced`
- `BACKEND_BILLING_SCOPE=individual_only`
- `BACKEND_CREDITS_ENABLED=true|false`
- `BACKEND_PAGES_ENABLED=true|false`
- `BACKEND_BILLING_PROVIDER=none|stripe|manual`
- `BACKEND_BILLING_ENFORCE_LIMITS=true|false`
- `BACKEND_TEAM_BILLING_ENABLED=false`

推荐默认值：

- Shared SaaS: `enforced`
- Dedicated Hosted: `enforced`
- Self-hosted: `disabled`（可切 `shadow`）

---

## 9. 数据模型（V1 文档定义）

本方案复用 team-first 文档已定义核心实体，不引入新的顶层术语。

## 9.1 关键表

- `billing_accounts`
- `subscriptions`
- `usage_ledgers`
- `spend_limits`

## 9.2 usage ledger 事件模型

`usage_ledgers` 建议字段（核心）：

- `id`, `team_id`, `workspace_id`, `user_id`
- `event_type`: `grant|reserve|consume|release|refund|expire|adjust`
- `unit_type`: `credit|page`
- `delta`（正负数）
- `balance_after`
- `feature`
- `reference_id`（thread/job/source 等）
- `idempotency_key`（唯一）
- `metadata`（JSON）
- `created_at`

要求：

- 流水不可变（append-only）
- 所有扣减必须幂等
- 必须可追溯到 team/workspace/user/feature

---

## 10. API 合约（保持 team-first）

即使当前只做个人，也保持 team-scoped API 形态：

- `GET /v1/teams/:teamId/billing/summary`
- `GET /v1/teams/:teamId/billing/usage`
- `GET /v1/teams/:teamId/billing/ledger`
- `POST /v1/teams/:teamId/billing/spend-limits`
- `POST /v1/teams/:teamId/billing/topups/checkout`

说明：

- V1 中 `teamId` 实际为 personal team。
- Team 商业化开启后，无需改路径形态。

---

## 11. 用户侧展示要求

至少提供以下可视化项：

- 当前周期 `pages_used / pages_limit`
- 当前 credits 余额、周期发放、已消耗
- 最近流水（时间、能力、变化值、余额）
- 超限原因与下一步操作（升级/增购/等待刷新）

---

## 12. 当前非目标（明确不做）

- 不实现 team seats 计费
- 不实现团队 credits 池化与成员分账
- 不实现 enterprise 合同计费
- 不实现任何开发、迁移、上线动作（本步骤仅文档）

---

## 13. 后续演进（V2+）

当需要启用团队商业化时，按以下顺序扩展：

1. 开启 `BACKEND_TEAM_BILLING_ENABLED=true`
2. 启用 `team_standard` / `team_premium`
3. 接入 `seat_assignments` 与团队预算
4. 增加组织级 usage 仪表盘与 chargeback

本 V1 方案无需推倒重来，可直接平滑升级。
