# Billing 独立商业 package 设计

日期：2026-09-08
状态：Implementation complete；定向验证见 docs/verification/billing-extraction/completion.md。生产发布与真实支付验证不在本次执行范围。
关联计划：[分阶段实施计划](../plans/2026-09-08-billing-package-extraction-implementation.md)

## 1. 目标与范围

将现有 billing 实现迁入一个单独商业授权的 `@sourceweft/billing` package。用户明确选择只拆 billing，其他云模块不纳入本轮。

硬性目标：从源码发行工作区物理移除 `enterprise/billing` 后，核心仍能安装、检查类型、构建、迁移数据库并启动 API、worker、scheduler 和 Web，完成注册、登录、团队协作、对话、BYOK、文档处理、连接器和产物生成。允许存在开放 billing DTO、错误码和历史表；不能存在商业实现的必需依赖。

本方案选定的核心行为是：不执行 credits/pages 商业账户、额度扣减和消费上限，保留用量与成本观测、身份权限及现有资源限制。这个行为不同于当前“支付关闭、额度计量仍开启”的自托管默认，必须写入版本变更与升级指引，不能称作行为完全不变。

不包含：其他模块商业化、独立 billing 微服务、独立数据库、新支付 Provider、重定价、新套餐、重写账务算法、License Server、联网激活、自动收费或生产发布。

## 2. 已核实的现状

| 位置 | 已核实事实 | 对设计的影响 |
| --- | --- | --- |
| `apps/backend/src/modules/billing` | 账户、订单、订阅、用量、账本、Webhook、对账已有内部服务分层；`index.ts` 装配全局实例 | 可以机械迁移服务；必须去除宿主单例依赖 |
| `modules/billing/store-port.ts`、`store.ts` | Store 有接口，但使用 `pg.PoolClient`、共享 DB 和组织成员查询 | 保留 PostgreSQL 事务；注入连接和组织接口 |
| `modules/billing/order-service.ts` | 直接依赖组织元数据和 `workspaceService` | 履约必须使用宿主提供的幂等组织创建接口 |
| `modules/auth/auth-config.ts`、`auth.migration.ts` | Creem 插件参与运行与 migration；成员钩子直接动态 import billing | Auth 工厂须接受 billing 扩展；迁移与运行扩展分离 |
| `api/app.ts` | 直接注册 billing 路由，并在 Auth 请求前处理特殊 Creem Webhook | HTTP adapter 和注册顺序都要迁移 |
| `modules/onboarding/service.ts` | 注册组织后创建计费账户 | 核心组织创建不能依赖商业账户 |
| `modules/content/billing-port.ts` | 目前接口含 `getSummary`、`meterConsume`、`meterIngestion` | 可作过渡接口；最终执行侧不能依赖套餐 summary |
| `shared/model-gateway/billing/admission.ts` | 模型执行前检查余额，明确不预留 credits | 本轮不能顺带引入预扣费、预留租约或新退款算法 |
| `shared/model-gateway/provider-cost-reconciliation.ts` | Provider 回查、观测更新和 billing 调账混在一起 | 拆“获得真实成本”与“调整商业账本” |
| `packages/credits-core` | 有通用计算，也有套餐配额和默认 credit 单价 | 套餐和商业默认值迁出；通用参数化算法开放 |
| `packages/contracts/src/pricing.ts` | 不只有类型，还有价格、套餐文案、额度和环境读取 | DTO 可开放，执行性的商业 catalog 必须迁出 |
| `apps/web/lib/auth-client.ts` | 静态导入 `creemClient()` | 只改服务端无法完成依赖隔离 |
| Web 侧边栏、settings、chat stream | 存在额度摘要请求、刷新事件和充值入口 | 不能只移动 billing 页面 |
| `apps/backend/tsup.config.ts` | 强制将 `@sourceweft/*` 打入 bundle | 不能把 tree-shaking 当作许可证边界 |
| `Dockerfile` | `turbo prune` 后复制 workspace 源码及依赖 | 必须从装配清单到最终镜像检查 |
| `apps/web/next.config.ts` | `typescript.ignoreBuildErrors` 已开启 | 独立类型检查是必需验收项 |

本次初始审阅时工作区已有 package 授权元数据和 LICENSE 等未提交变化。最终复核 HEAD 为 `d33c9df5`，根 LICENSE 已明确排除 `enterprise/` 并指向 `enterprise/LICENSE`，该目录尚不存在。实施时保留现有排除声明，补齐商业许可与 package 自带文件，不重复撤回或重写核心授权。提交存在不能用来推定该版本已对外发布。

本文件及关联计划最初保存于 `.gitignore` 忽略的 `/docs/`。本实施分支仅显式纳管这两份规划及本任务进度记录，不修改整个目录的忽略规则，不纳入其他本地文档。

`docs/architecture/backend-module-ownership.md` 当前将 billing 标成 host-owned。本设计是用户本轮拆包要求带来的边界更新：它成为可选的应用服务 package，仍不是 agent capability，不加入 capability discovery，不新增 `sourceweft.capability.json`。

## 3. 决策及备选方案

| 方案 | 结果 |
| --- | --- |
| 单个商业 package、多子入口、同进程与同数据库 | 采用：一个授权边界、一次版本管理，不引入网络一致性问题 |
| 多个 billing-core/payment/store/ui 商业 package | 本轮不采用：版本与依赖成本高于当前收益 |
| 独立 billing 服务 | 本轮不采用：会改变失败模型、事务与部署拓扑 |

schema 暂留共享 DB 是明确设计取舍，不是拆包失败后的替代方案。所有收费策略和账务读写实现进入商业包；数据结构和历史 SQL 继续开放，以减少升级风险。

## 4. 目标结构与依赖规则

```text
packages/contracts/src/
  billing.ts                   公共 HTTP DTO 和原有枚举
  billing-runtime.ts           新增：宿主执行接口与结构化错误
  deployment-capabilities.ts   新增：非秘密的发行能力响应
  pricing.ts                   仅保留公共类型和无策略的转换契约
packages/credits-core/src/     通用、参数化计算
packages/sdk/src/              billing client 与能力查询 client
packages/db/                   当前 schema、连接与全部既有迁移

apps/backend/src/billing-host/
  core.ts                      明确的核心非商业计费策略
  ports.ts                     宿主接口实现装配
  bindings.ts                  核心版绑定，商业投影替换该文件
apps/web/lib/billing-edition/
  auth-client.ts               核心无支付插件，商业版绑定支付客户端
  client.tsx                   设置面板、侧边栏等客户端 UI 插槽
  server.tsx                   定价、checkout 路由等服务端 UI 插槽

enterprise/LICENSE            根许可证当前引用的商业许可入口
enterprise/billing/
  package.json / LICENSE / README.md
  src/server/                  账户、订单、订阅、用量、账本、catalog
  src/postgres/                Store 与事务实现
  src/integrations/http/       billing 路由及 Webhook adapter
  src/integrations/auth/       Auth 运行与 schema 扩展
  src/integrations/jobs/       billing 调账、订阅与订单对账
  src/providers/creem/         支付实现
  src/ui/                      浏览器 UI
  src/ui-server/               服务端 UI 与定价组件
  src/auth-client/             Creem 客户端扩展
  tests/                       单元、Store 数据库与商业集成测试
  edition/                     商业投影清单、薄绑定模板、专用 lockfile

scripts/editions/              核心所有的构建投影与检查脚本
```

目标只增加一个商业 package。上表为拟新增结构，不表示文件已经存在。

显式导出 `/server`、`/postgres`、`/integrations/http`、`/integrations/auth`、`/integrations/jobs`、`/ui`、`/ui-server`、`/auth-client`；不提供混合所有内容的根 barrel。React client 入口保留正确的 `use client` 边界；服务端入口不得被其传递导入。

依赖约束：

1. 核心业务依赖开放契约和注入对象，不依赖商业实现。核心默认 binding 只能引用核心策略。
2. 商业包可依赖 `contracts`、`credits-core`、`db`、`sdk`、共享 UI，以及所需第三方库，禁止导入 `apps/backend`、`apps/web` 的源码、tsconfig 或测试工具。
3. 只有商业发行版生成的薄 binding 可以直接 import 商业 package。binding 和其模板按商业条款分发，生成时保留许可证标识。
4. 配置、日志、告警、组织创建、会话和队列能力从宿主注入。商业包不得启动宿主进程或自行加载根 `.env`。
5. `@sourceweft/db`、contracts、SDK 不能反向 re-export 商业 package。
6. 公共 types/error codes 可以保留 billing 命名。边界检查按依赖与行为检查，不能用“没有 billing 字符串”作为判据。

## 5. 执行接口与核心策略

### 5.1 开放的运行接口

`billing-runtime.ts` 定义以下职责，具体类型由实施中的调用点编译验证收敛，不暴露 pg、Creem 或套餐数据库行：

| 方法组 | 输入与职责 | 结果语义 |
| --- | --- | --- |
| `admitModelScope` | 已授权团队、成员、执行模式和现有 covered/metered intent；保持现有一次 scope 检查 | 核心 allowed + billing-not-installed；商业返回原有准入结论 |
| `settleModelUsage` | team/user/workspace、feature、model kind、已解析 Provider 成本/来源、调用引用与原有幂等键 | settled、skipped 或明确错误；不伪造余额 |
| `meterIngestion` | 解析事实、物理页来源/文本量、引用和原有幂等键 | 商业按原规则扣页；核心 skipped |
| `reconcileProviderCost` | 原扣费键、回查任务键、Provider receipt、trace/span、最终成本 | 商业幂等调账；核心不触及账本 |
| 组织生命周期 hooks | 组织已创建通知、邀请/加入前检查、现有成员变化流程 | 核心只维持身份/成员业务；商业执行现有额度与席位规则 |

结果采用可辨别联合类型：`settled` 才携带账务结果；`skipped` 携带原因，如 `billing_not_installed`、`byok`、现有 `covered`/model-kind 原因。禁止以 `availableCredits = Infinity`、免费套餐或假 ledger id 表达核心模式。

商业管理 API 的 `BillingSummaryResponse` 等保持现有语义；不能为了核心模式把所有余额字段改成可空。核心执行调用从该 DTO 解耦。过渡期可让旧 `ContentBillingPort` 适配新接口，但最终不得要求核心实现伪造 summary。

已有预留、释放、退款字段和实际调用点按 P0 清单保留；模型 preflight 本身不改成 reserve。本轮不创建当前业务不存在的预留机制。

### 5.2 宿主提供给商业包的接口

- `IdentityAccess`：session actor、组织 membership、owner/admin/billing_admin 权限；用户输入不能自行指定可扣费 actor。
- `OrganizationDirectory`：成员和待处理邀请查询。事务内使用的查询必须接收同一事务上下文，不能在锁外随意替换。
- `OrganizationProvisioning`：创建组织、创建默认 workspace、现有 `billingOrderId` 幂等元数据。组织命名与通用 metadata 结构归宿主，订单关联语义归 billing。
- `Logger`、`AlertSink`：结构化日志和告警，保持原来告警失败不改变已提交账务的语义。
- `JobHost`：注册/提交现有任务；不改变队列命名、重试和账务幂等键。
- PostgreSQL 连接池：`PoolClient` 仅在商业 Postgres adapter 和必要的事务宿主接口内部使用，不进入客户端契约。
- 配置参数与应用 URL：只接收所需配置，不能接收包含无关 secrets 的整个全局 config。

### 5.3 装配时序

API、worker、scheduler 共用同一装配函数：读取发行元数据 → 验证配置 → 构建 billing/core 策略 → 构建接入该策略的业务服务 → 注册 Auth/路由/任务 → 开放监听或消费队列。

拆除会在 import 阶段创建 billing/global auth 单例的链路；初始化期间不执行 checkout、迁移、网络取商品或组织创建。依赖错误不能捕获后替换核心策略。core.ts 仅由核心 binding 显式选择。

## 6. 行为、配置与故障矩阵

| 情况 | 必须行为 |
| --- | --- |
| core + 无 billing package | 正常运行；不建账户、不扣费、不提供套餐购买 |
| core + 无支付密钥 | 正常；不要求 Creem 商品或 secret |
| core + 残留单独支付密钥 | 不激活能力；日志不输出密钥；部署预检提示未使用配置 |
| core + 明确要求 SaaS checkout/team billing/reconcile，或显式非 disabled 商业计量 | 配置冲突，报错；不能忽略既有运营意图 |
| commercial + 缺 package/绑定/依赖 | 构建失败，不能生成免计费镜像 |
| commercial + 支付关闭 | 可运行原有账本与计量模式；不开放 checkout |
| commercial + checkout 打开但缺必需配置 | 启动前失败；仅要求实际启用产品所需商品映射 |
| commercial + 强制计费调用失败 | 保持现有强制结算/准入错误；不得改为 skipped |
| 已有 covered scope 或 shadow/disabled mode | 精确保留当前专属语义；不能扩大为任意故障时放行 |

拟新增构建参数 `--edition=core|commercial`，默认 core；产物内嵌不可变 `edition` 与 `billingRuntimeApiVersion: 1`。运行变量 `SOURCEWEFT_EDITION` 如果提供，只能用于校验与产物一致，不能把核心镜像转换成商业镜像。

商业包解析现有 `BACKEND_BILLING_*`、credits/pages、Creem 和 catalog 配置；保留现有默认数值和已有合法模式。不将 API key、`SOURCEWEFT_SAAS_ENABLED` 或前端开关视作许可证。

核心部署配置不再默认注入 `BACKEND_BILLING_MODE=enforced` 等商业额度设置。旧 Compose/env 升级必须显式选择：继续计费使用 commercial，停止商业账本使用 core 并清理冲突配置。此变化写入迁移说明，不能自动判断。

新增非秘密 `GET /v1/deployment/capabilities`，结构包含 `edition`、`billing.available`、计量模式，以及 checkout/team subscriptions/top-up 是否可用。它描述部署功能，角色权限仍在每个管理请求中验证；不得含密钥、商品 secret 或许可证内容。

核心对已知 billing 管理路由，在保持身份校验后返回 HTTP 501、稳定错误码 `BILLING_UNAVAILABLE`；其他未知路径照常 404。支付 Provider 的专用 Webhook 不注册为可成功处理的接口。商业接口保留现有 URL、请求/响应和错误码。

Web 未取得 capability 时显示加载或错误状态，不推断核心、不伪造余额。后端能力为准，前端旗标只能进一步控制展示，不能开启后端未提供的能力。

## 7. 计量与 Provider 成本边界

核心保留 model observation、实际 usage 采集、实际 Provider 成本的来源/缺失标记、trace/span、回查网络权限和密钥解密。商业包处理实际成本到 credits 的换算、markup、最低扣费、非用户计费 model kind/covered 政策与账本调整。

`provider-cost-reconciliation.ts` 拆为核心 receipt 获取/观测更新和商业 `reconcileProviderCost` 调用。继续使用原 job name、payload 和 idempotency key；不要因 billing 拆出便停止核心成本回查。核心只处理核心产生的观测任务；旧商业队列不得交给 core 消费。

sources 保留事实提取（MIME、可信物理页数、文本/token 数、invalid metadata 错误），商业包拥有计费页数换算政策。物理页和逻辑页不能混同，不能因核心不收费就降低解析事实校验。

GLOBAL/BYOK 严格按仓库 AGENTS：

- GLOBAL Provider 的 enabled/configured/globalReady、catalog 同步原子性和配置 fingerprint 不变。
- BYOK credentials/models 的 DB 激活、授权和解密不变；global key 不满足 BYOK。
- 同一 System Provider 处于 GLOBAL disabled 时，符合条件的 BYOK 仍可运行。
- commercial 延续现有 BYOK 不扣模型 credits 的分类，包括执行模式及现有 `isBYOK` 成本归属标记；不扩展为 BYOK 文档解析免费等新政策。
- core 不收费不等于 Provider 就绪：无有效 GLOBAL/BYOK 目标仍应返回原有安全错误。

## 8. 数据库与迁移

本轮不搬数据、不改表名、不改 account 主键、不重排 migrations。

| 内容 | 所有权 |
| --- | --- |
| billing_accounts、usage_ledgers、spend_limits、billing_orders、subscriptions、billing_webhook_events 的 schema 与原迁移 | 共享 `packages/db`，Apache-2.0 |
| 上述表的计费查询、事务、写入及业务映射 | 商业 billing Postgres adapter |
| Better Auth user/session/organization 与插件表、字段 | Better Auth migration owner |
| 核心 LLM 观测、组织、工作区表 | 原有核心 owner |

billing 包依赖 `@sourceweft/db`，DB 不依赖 billing。新的 billing 业务字段若将来需要变更，仍走共享 DB 单一迁移链并由 billing 维护者审阅。本次提取预期不需要业务 DDL；若出现必须修改表结构的证据，先报告并独立评估，不能夹带。

核心全新数据库可以由历史 Drizzle SQL 创建空 billing 表；核心运行不得初始化或查询账户，也不得触发续期/扣费。验收用“无账务业务读写”，不要求所有 SQL 文件没有 billing 文字。

Auth 核心 migration 不依赖 Creem package；商业 migration 通过 billing 的 schema-only 插件贡献保留 `user.creemCustomerId`、`user.hadTrial`、`creem_subscription`。不能把 Auth 插件字段挪入 Drizzle，不能在 migration 模式注册 Webhook、发邮件或创建 workspace。

迁移顺序保持：本发行版 Auth migrate → 共享 Drizzle migrate → 现有 extension OAuth provision。测试四条路径：core 空库、commercial 空库、当前支持的 1.7 schema 老库升级 commercial、core 库增加 commercial。重复 migrate 必须幂等。

从已有 commercial 数据库运行 core migration 时，必须先输出差异并阻止对遗留插件表/字段的破坏性删除。不能声称 billing 拆包支持既有文档明确不支持的 Better Auth 1.6→1.7 回填。

账务不变量：金额精度与 rounding 不变；余额及 ledger 原子写入；原幂等键与唯一约束不变；每成员分账不变；付费周期确认源不变；订单外部支付成功/内部履约失败的可恢复状态不变；重复和乱序 Webhook 不重复授予；Provider 回查调账退还原有余额桶。

## 9. Web、SDK 与其他客户端

将 billing panel、plan actions、checkout/success、team-checkout-dialog、套餐 UI 与余额组件迁入商业包。Next page 保留宿主路由薄壳，商业 server/client binding 注入对应实现。

UI 使用 props 注入 SDK、组织上下文、导航/刷新回调；不得 import app 的 authClient、lib/sdk 或相对 app 路径。共用 React、Next 和 Better Auth 的兼容 peer/type 边界，不能用 `any` 丢失 Auth 插件推导类型。

`apps/web/lib/auth-client.ts` 通过 auth-client binding 接收插件贡献，core 是空贡献、commercial 是 Creem client；三类 binding 分离防止 client 间接导入 server。

补充处理：侧边栏 credits、settings 的 usage/账单混排、聊天流结束刷新、定价 CTA、URL 参数进入 checkout、账务错误展示。核心保留现有用量观测入口，不承诺另建一个新的分析产品。

`trust-rules-panel` 使用 `billing-utils` 中的组织解析是命名耦合：先将通用组织解析迁到开放宿主 helper，再搬计费工具。不能把信任规则一起变成商业能力。

`contracts/pricing` 的价格/配额数据及有策略的函数移到商业 catalog；公共 PlanConfig 等形状可留。`credits-core` 移出套餐与默认单价，保留显式参数化的数学运算；所有调用点显式传入原商业数值，避免改变 rounding。

SDK 的 billing API 保持开放，新加 capabilities client，旧商业 URL 不改。桌面、移动和 extension 通过共享 Web/SDK 使用的相关入口做回归；不能只验证浏览器而忽略被共享的 UI。

## 10. 安装、构建与发行隔离

### 10.1 两个确定的源码投影

根工作区作为 core 源码，常规 `pnpm install --frozen-lockfile` 不要求 enterprise 包存在。`pnpm-workspace.yaml` 保持 core 的 apps/packages 范围，不能无条件把 commercial 依赖加进 core app manifests。

拟新增 `scripts/editions/prepare.mjs`，仅依赖 Node 内置库，可在 pnpm install 之前运行。输入 `--edition`、显式输出目录；根据受审查的 allowlist 复制所需源码/config/patches，禁止复制 `.git`、`.env*` 实际 secret 文件、node_modules、build/cache 或父目录。env example 可按清单复制。

core 投影无需读取 enterprise 中的清单。commercial 投影显式读取 `enterprise/billing/edition`，将 package 加入生成工作区，替换三个 Web binding 与一个 backend binding，在生成的 app manifests 中加入商业依赖，保留许可标识。输出目录不存在或由本工具拥有；禁止覆盖源工作区或任意用户目录。

根 lockfile 仅服务 core；`enterprise/billing/edition/pnpm-lock.yaml` 服务完整 commercial 投影。两者都提交且 CI frozen install。维护依赖时显式在相应投影刷新 lockfile，不在 Docker/CI 中临时重新解析依赖，也不手工文本修补 lockfile。生成 manifests 与对应 lockfile 不匹配则失败。

开发 commercial 使用同一投影流程与明确的源码同步，不从投影反向覆盖原始文件。测试与 typecheck 在实际投影中执行，不靠测试专用 alias 绕过产品边界。

### 10.2 构建与运行检查

Docker 的 prune 输入改为选定投影，再执行现有 build 流程。core 最终 stage 不含 commercial package、Creem 运行接入或商业 binding。商业源码模板若出现在 bundle/sourcemap 中同样受商业许可。

核心源码发行档应包含构建所需全部脚本、配置、patches 和 LICENSE；从该档解压后仍能安装。根源码删除 enterprise 但借用已安装依赖缓存的测试不算通过，必须 fresh install 并检查实际依赖闭包。

API、worker、scheduler 和 Web 都带 edition/version 标识；Web 与 API 不匹配时管理 UI 显示部署不一致，服务器仍独立校验。部署预检核对三个服务进程来自同一发行配置；禁止 core worker 消费 commercial 业务队列。

## 11. 授权与发布规则

代码公开可读的商业 package 与 Apache 核心分区。参考 LiteLLM 的目录例外及独立 enterprise package；不把它的商标、主体名称、seat 定价或修改版权归属条款机械复制到 SourceWeft。

拟定许可政策：开发和测试可用；生产运行商业包需要约定授权；分发、OEM、代运营和对外托管权利由合同明确。核心继续允许 Apache 条款下的商业、自托管与托管服务使用。

本轮使用 `license: "SEE LICENSE IN LICENSE"` 标注 npm 商业 package；补齐现有根声明指向的 `enterprise/LICENSE`，package 自带 `enterprise/billing/LICENSE`，两份商业条款保持同一版本且不得冲突。LICENSE 随源码、打包文件和镜像分发。`private: true` 只控制发布流程，不是许可证。源码 SPDX/custom 标识须与正式条款一致，保留第三方 notice 与既有适用声明。

保留根 LICENSE/README 已有的 `enterprise/` 例外；补充 `enterprise/billing` package 及由其生成、位于投影 app 目录的商业绑定适用范围，不能把混合仓库或商业镜像整体宣称为纯 Apache。商业包可以依赖开放包；公共 SDK 并不因调用商业 API 而改协议。

本轮不做 License Server 或 license-key 校验。checkout env、用户订阅和部署软件授权是三个不同概念，不能让拥有某个 Creem 订单成为运行商业包的许可证明。

正式发布的前置条件：确认发布主体、代码权属/第三方贡献、历史已授予许可、商业贡献规则以及条款审定。无法确认时允许完成技术拆包，但不得标记新的商业授权发布完成。已按 Apache 对外授予的权利不因移动目录撤回；新增/修改部分的许可须与保留原许可义务一致。

参考资料（2026-09-08 核对）：

- [LiteLLM enterprise LICENSE.md](https://github.com/BerriAI/litellm/blob/main/enterprise/LICENSE.md)：生产授权及开发测试例外。
- [LiteLLM enterprise package](https://github.com/BerriAI/litellm/blob/main/enterprise/pyproject.toml)：独立包及 license 文件元数据。
- [Apache-2.0 第 2/4/5 条](https://www.apache.org/licenses/LICENSE-2.0)：既有授权、分发义务与贡献规则。

## 12. 升级、回滚与完成定义

首个拆包版本锁定原商业计费规则与数据格式。部署前备份、记录账务摘要、暂停新商业工作进入并排空在途任务；Webhook 由旧版本继续接收，或使用经过验证的持久化接收/上游重试安排，不能靠一段未验证的停机窗口丢事件。

API/worker/scheduler 成套切换同一 commercial 版本，原队列名称和 payload 继续兼容。计费版本回滚使用上一套 commercial 镜像与兼容配置；不回滚已确认支付、ledger 和 fulfillment 数据，不用 core 镜像充当故障回滚。

commercial→core 是停止商业计费的显式运营变更，不是代码回滚。必须先安排已有订阅、未完成订单/Webhook、欠结算任务和账户导出，停止接收新收费工作，隔离原队列并保存数据，才可运行 core；本轮不自动取消外部订阅。

完成标准：

1. 物理移除 enterprise 的 fresh core 源码发行包能安装、检查类型、构建、迁移与运行全部核心流程。
2. core 流程不执行账务读写、不访问 billing summary，不要求 Creem，不显示虚假余额；权限与资源限制不退化。
3. commercial 的原单元、真实 Postgres 事务、宿主集成与支付沙箱场景通过，账务不变量保持。
4. 强制计费异常、缺商业依赖、发行不匹配、配置冲突都有明确失败，绝不自动切换 core。
5. GLOBAL/BYOK 回归通过，观测与实际成本回查保留。
6. core 的 bundle、sourcemap、依赖和镜像无商业实现；商业产物许可证齐全。
7. 空库和受支持老库升级、重复迁移与 commercial 回滚演练有证据。
8. 所有临时 shim 删除，原 ownership/docs/env 更新，测试结果区分已通过、失败和未验证；没有以 mock 替代真实数据库或支付环境验证。

技术拆包完成与商业许可正式发布分别记录，不把法务资料尚未齐备误报为技术失败，也不把技术测试通过误报为已经取得发布权。
