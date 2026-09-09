# Billing 拆包实施计划

日期：2026-09-08
状态：Implementation complete；定向验证见 docs/verification/billing-extraction/completion.md。生产发布与真实支付验证不在本次执行范围。
设计依据：[Billing 独立商业 package 设计](../specs/2026-09-08-billing-package-extraction-design.md)

本文件给出实现顺序、修改位置、测试与交付条件。文档制定阶段未修改业务代码；用户随后明确要求独立工作区和分支开始实现。当前进度见 `docs/verification/billing-extraction/progress.md`，尚未生产部署。本实施分支仅显式纳管本方案、计划和任务进度，不修改 `/docs/` 的整体忽略规则。

## 1. 固定实施约束

- 一个商业 package：`enterprise/billing`，名称 `@sourceweft/billing`；server、Postgres、Auth、HTTP、jobs、UI 为子入口。
- core 可以没有该目录；不运行 credits/pages 商业账本，保留观测、权限和资源限制。这是明确的自托管行为变更。
- commercial 缺包或初始化失败必须失败，不能 fallback 为 core。
- 同进程、同 PostgreSQL；schema 和历史 migrations 暂留 `packages/db`，不重建账务数据。
- 保留现有商业价格、额度、rounding、幂等键、付费周期、席位、Webhook 和扣费语义；特别是模型 preflight 仍非预扣费。
- 保留 GLOBAL Provider activation 与 BYOK 边界；不通过启用新的 Provider 保证 core 演示成功。
- 其他 cloud、market、blog、sandbox Provider 的业务拆分不在本轮范围。
- 不新增 License Server。许可文本、贡献来源与发行管理单独验收。
- 按仓库 fallback policy 执行：依赖/网络/数据库/支付环境不可用时报告确切阻碍，请求所需访问；不能换模型、Provider、数据源或测试策略并称作验证通过。
- 保留实施时的用户修改，只提交本任务清楚归属的变化。最终复核 HEAD 为 `d33c9df5`，根 LICENSE 已排除 `enterprise/`，但该目录尚不存在；此提交不等于 package 商业条款、代码权属和正式发布条件已全部完成。

## 2. 阶段与任务依赖

| 阶段 | 任务 | 前置条件 | 里程碑 |
| --- | --- | --- | --- |
| P0 基线 | T00 | 无 | 调用点、环境、测试、账务语义与授权基线可追溯 |
| P1 边界 | T01、T02 | T00 | 新接口接入原实现，开始有无 billing 模式的行为验证 |
| P2 包迁移 | T03、T04 | T01、T02 | 商业实现与 Postgres adapter 独立，无 backend 反向 import |
| P3 宿主接入 | T05、T06、T07 | T03、T04 | Auth/注册/模型/来源/三进程完整装配 |
| P4 前端与发行 | T08、T09 | T05–T07 | UI 隔离，两个确定的源码投影与 frozen build |
| P5 协议与清理 | T10 | T08、T09 | 文件归属、文档、许可及依赖边界完整 |
| P6 验收 | T11、T12 | T00–T10 | 正向、负向、干净安装、老库和回滚证据齐全 |

P1/P2 可形成便于审查的中间变更，但不单独作为可发布的“拆包已完成”。任何阶段都不能删除仍被核心调用的旧入口，必须先有等价新路径并完成验证。

## 3. 任务清单

### T00：建立迁移与行为基线

**位置**：本计划的附录、`apps/backend/src/modules/billing`、相关调用方、现有 env/Docker/测试、授权文件与 Git 历史。

步骤：

1. 记录源提交、工作区 diff、实际 Node/pnpm 版本。识别已有用户修改，不 reset 或覆盖。
2. 基于附录 A 重新扫描静态、动态 import、SDK 请求、队列处理、配置、schema 和测试依赖。扫描结果随实施变化更新，不只使用目录名匹配。
3. 汇总实际生效的商业默认配置和 catalog，包括 `credits-core`、`contracts/pricing` 与后端 config 的重复信息。比较时标出当前差异；拆包不顺便修正价格不一致。
4. 列出每个模型/解析计费入口、现有 covered/BYOK/model-kind 跳过原因、幂等键、错误传播与并发行为。
5. 运行现有相关测试与类型检查，记录已存在失败。确认真实 PostgreSQL/pgvector、Redis 与支付沙箱访问条件，不读取或输出 secret。
6. 记录 Auth migration 当前 schema、Drizzle journal 和 SQL 校验摘要；记录受支持的 1.7 基线。核对既有迁移是否引用 Creem Auth 对象。
7. 建立授权来源清单：原文件、历史许可、贡献来源、拟移入商业范围、第三方 notice。无法确认的权属记录为发布前置项，不虚构主体名称或许可授权。

**基线命令**（现有命令，依赖就绪后执行）：

```sh
pnpm --filter @sourceweft/backend test src/modules/billing
pnpm --filter @sourceweft/backend test src/modules/content/model-billing.test.ts src/modules/sources/billing-pages.test.ts src/modules/threads/agent/turn/turn-billing-scope.test.ts src/modules/threads/turn/error-turn-billing.test.ts
pnpm --filter @sourceweft/backend check-types
pnpm --filter web check-types
pnpm --filter @sourceweft/contracts check-types
pnpm --filter @sourceweft/credits-core check-types
```

**退出条件**：有实际结果、故障分类和迁移清单；测试环境不满足的项目明确标为未验证。不得把基线失败计入后续成功。

### T01：建立开放契约与结构化错误

**修改/新增**：

- `packages/contracts/src/billing-runtime.ts`（新增）
- `packages/contracts/src/deployment-capabilities.ts`（新增）
- `packages/contracts/src/billing.ts`、`index.ts`、`package.json`
- `packages/sdk/src/billing-client.ts`、`client-factory.ts`、`index.ts`；新增 capability client
- `apps/backend/src/modules/content/billing-port.ts`
- `apps/backend/src/api/response/api-response.ts`
- `apps/backend/src/modules/threads/turn/error-turn-billing.ts`

步骤：

1. 定义模型准入、用量结算、页数计量、Provider 成本调账的窄接口及 settled/skipped 结果。核心模式不使用假余额。
2. 定义宿主组织生命周期 hook、非秘密 capabilities 与稳定 `BILLING_UNAVAILABLE` 错误契约。
3. 将宿主确实需要辨认的 billing 错误码/结构移入开放契约；商业内部异常细节留在实现。跨 bundle 判定使用经过校验的结构，不只依赖同一 class 的 `instanceof`。
4. 旧 `BillingSummaryResponse` 和商业 SDK URL/响应保留语义；不把所有字段改为 nullable 来适配 core。
5. 用旧服务实现过渡 adapter，使现有调用先通过接口编译。记录 adapter 的删除条件。
6. 公共客户端仅提供调用方法，构造 client 不自动查询账户或加载支付插件。

**验证**：契约序列化/错误 guard、跨团队/actor 输入验证、SDK capabilities 请求；contracts/SDK/backend typecheck。

**退出条件**：宿主可表达“明确未安装”而不读取商业 summary；接口无 pg/Creem/商业 package import；原商业 DTO 没有被无意破坏。

### T02：建立核心策略与确定的初始化路径

**修改/新增**：

- `apps/backend/src/billing-host/core.ts`、`ports.ts`、`bindings.ts`（新增）
- `apps/backend/src/shared/config.ts`
- `apps/backend/src/modules/billing/index.ts`（过渡工厂）
- `apps/backend/src/api/routes/deployment-capabilities.ts`（新增）
- 相关宿主模块的构造/装配入口

步骤：

1. core policy 准入允许、结算返回 billing_not_installed；不注入虚假的 BillingService 或内存财务账本。
2. 原 billing 服务改成显式 factory，停止在模块 import 时读取配置、实例化全局商业状态。
3. 确定 edition/config 初始化顺序，先初始化策略再让依赖服务可用；解决 Auth→billing→workspace→Auth 的单例/动态 import 环。
4. 商业 config parser 与核心配置解耦；核心只检查发行配置冲突，不加载商业默认套餐。
5. `SOURCEWEFT_EDITION` 若设置只校验内嵌版本；core 明确要求计费、商业缺包、错误枚举均报错。
6. 增加 capabilities route。已知 billing 管理路由的 core response 保留认证边界并返回 501/BILLING_UNAVAILABLE。

**验证**：无 package factory 的核心初始化、import 无副作用；core/checkout 配置冲突；策略加载抛错时不替换 core；未登录与已登录 API 返回语义。

**退出条件**：明确选择 core 与商业故障是两条不同路径；核心无账务业务读写。此时仍不声称全仓无商业依赖。

### T03：迁移商业服务、catalog 与测试

**来源**：`apps/backend/src/modules/billing/**`；`packages/credits-core/src/{plans,credits,types,index}.ts`；`packages/contracts/src/pricing.ts`；`apps/backend/src/checks/billing-catalog.ts`。

**目标**：`enterprise/billing/src/{server,providers}`、商业测试及 package 配置。

步骤：

1. 创建唯一商业 package，显式子入口；版本、TypeScript、Vitest 与现有仓库依赖兼容，不升级第三方依赖。
2. 提前交付 T09 所需 `scripts/editions/prepare.mjs` 的基础投影能力、商业 manifest 清单和初版商业 lockfile，以便本任务就能在真实 commercial 投影中安装和运行 package 测试。T09 继续完善它，不另建临时 workspace、测试 alias 或第二套构建方法；每次依赖变更显式更新对应 lockfile 后 frozen 验证。
3. 搬账户、订阅、订单、用量、ledger、page-ledger、helpers、Provider 等实现，保持计算与事务调用顺序。
4. 将日志、records helper、告警等对 backend 的 import 转成参数或最小包内纯 helper；禁止把整个 shared 目录复制进商业包。
5. 把套餐和定价实现、商业 credit 单价默认值移入 catalog；通用算法参数化，所有商业调用显式传原默认值。
6. 公共枚举/DTO 留在 contracts；清除 credits-core 对商业套餐数据的依赖；修正相关跨包 exports，临时 shim 不得反向导出商业实现。
7. 将原 billing 单元测试、MemoryBillingStore 和 fixtures 一起迁移，禁止遗留从 backend 源码导入 fixture。
8. package 先设置清晰的拟定许可文件归属，正式商业 LICENSE 在 T10 审定后落地；不得凭移文件宣称旧授权已失效。

**验证**：原 billing 行为测试全部继续执行；数学边界、套餐投影、会员额度、rounding 与基线一致；扫描包内 backend/web import。

**退出条件**：商业业务实现独立，tests 无宿主源码依赖；至少一个真实宿主 adapter 跑通新 package。临时旧入口只作过渡并登记。

### T04：隔离 Postgres Store 并验证财务原子性

**修改**：旧 `store.ts`、`store-port.ts` → 商业 `/postgres`；`packages/db` schema 保持单一所有权。

步骤：

1. `createPostgresBillingStore(pool, organizationDirectory)` 接收连接，不从 backend/global singleton 获取。
2. 保留 `PoolClient`、row lock 和事务边界；把事务内成员查询也绑定相同事务，禁止变成独立连接的最终一致查询。
3. ledger append、余额更新、Webhook 状态、订单唯一键与现有映射原样保留；不顺便变更 integer/numeric 类型。
4. Store 自身的真实 PG 测试放商业包。将确需共用的最小隔离数据库测试辅助提取到 DB 的测试入口，不能让商业测试 import backend 测试工具；不得把共享测试工具变成运行依赖。
5. 通过双连接与显式同步点测试同成员竞争、不同成员隔离、重复幂等键、失败事务回滚、Provider 成本回退原桶。以当前真实行为为断言，不承诺当前实现没有的新超支保护。
6. 校验原 migrations 与 journal 摘要不变；禁止生成删表 migration。

**退出条件**：真实 DB 测试通过，原表和账务数据格式不变。MemoryBillingStore 测试通过不能替代本任务。

### T05：接入组织、Auth、HTTP 与迁移入口

**修改位置**：

- `modules/auth/auth-config.ts`、`auth.ts`、`auth.migration.ts`
- `modules/onboarding/service.ts`
- `modules/workspace/service.ts`、`store.ts` 中已被履约使用的窄接口
- `api/app.ts`、`api/routes/billing.ts`
- 商业 `/integrations/auth`、`/integrations/http`、`/providers/creem`

步骤：

1. 把组织 metadata、命名与 workspace 创建通过 ports 注入，保持 billingOrderId 幂等元数据和既有创建顺序。
2. 将席位检查作为明确的 before hooks；不得把核心组织 RBAC 与成员合法性判断搬到 billing。
3. core onboarding 只创建组织/workspace；commercial hook 延续账户初始化语义。所有入口，包括 connector webhook 导入，使用同一装配策略。
4. 将 Creem Auth runtime 插件与各订阅回调迁入商业 integration；core Auth plugin 数组不含 Creem。
5. 将 scheduled-cancel Webhook bypass 随包迁移，保持原始请求 body、签名验证和位于通用 Auth handler 前的顺序。
6. HTTP routes 接受宿主的 session/organization role adapter；保留原 billing_admin/owner/admin 权限及现有 URL。
7. Auth migration 使用独立 schema-only 扩展；commercial 保留插件字段，core 不加载 Creem、不运行 runtime side effect。
8. 生成并对比两种 Auth schema。确认历史 Drizzle baseline 对 core 仍可应用；如出现必须依赖 Creem DDL 的证据，先报告并修订方案，不能私自用 Drizzle 接管 Auth 表。

**验证**：注册登录、邀请、加入、组织创建重试；未授权 checkout/跨租户账单拒绝；Creem 签名与特殊取消 Webhook；core/commercial 空库和重复 Auth migration；已存在插件字段不被删除。

**退出条件**：登录/注册/协作不再要求商业包；商业订阅、权限和履约流程保持原语义；Auth/Drizzle 没有双重 owner。

### T06：接入模型执行、解析和成本观测

**修改位置**：`modules/content/{billing-port,model-billing,provider-cost}.ts`；`shared/model-gateway/{billed-client,agent-tool-client,provider-cost-reconciliation}.ts` 与 `billing/*`；`modules/sources`；`modules/connectors`；`modules/threads`；`worker/deliverable-host/context.ts`。

步骤：

1. 将旧的 summary→商业准入判断移到商业实现；模型 wrapper 只采集 facts、传递执行 context 和调用接口。
2. 保留一次 scope preflight、stream 收尾、错误 turn、取消、重试、工具、标题、子任务/长任务原有结算位置和原幂等键。
3. 拆 sources 页数事实与计费换算；可信 PDF/image 页数校验在核心保留，文本换算和扣页政策进入商业包。
4. 覆盖 connector sync/webhook、解析轮询、重复索引、工具和 deliverable 所有入口，不能只接 HTTP 对话。
5. 将 Provider receipt 网络调用/观测回填与 credits adjustment 分离，前者核心保留、后者通过商业接口；既有 payload/trace/span/idempotency 不变。
6. core 分支不查询账单或创建账户。commercial `enforced` 错误继续传播，covered/shadow/disabled 的既有特例不扩散。
7. GLOBAL/BYOK 分类从宿主传入，经可信模型身份确定，不能接受客户端伪造“BYOK 免扣费”。

**验证**：普通/流式/中断/重试/失败后结算；标题和工具；源解析与 connector；model kind 与 covered；Provider receipt 二次校正；全局 disabled Provider 的有效 BYOK 与无 BYOK secret 拒绝。

**退出条件**：核心对话和解析不读写 billing 表；商业观测与扣费都保留；没有以“无 billing”消除 Provider 配置错误。

### T07：接入 worker、scheduler 与运维检查

**修改位置**：`api/main.ts`、`worker/main.ts`、`scheduler/main.ts`；`scheduler/schedules/reconcile-team-subscriptions.ts`；`worker/processors/thread-title.ts`；`checks/index.ts`；商业 jobs integration；相关 scripts。

步骤：

1. 三个进程都在开放监听或消费前验证相同的 edition/config，并注入同一语义策略。
2. 订阅、订单对账只在 commercial 按开关注册；纯 Provider receipt 回查继续属于核心观测任务。
3. 保留原 job name、payload、retry、告警与 audit 语义；未知任务仍报错，不能返回成功吞掉遗留 billing job。
4. 将 Creem 商品脚本、billing catalog check 和纯商业计费审计脚本迁入商业包。AnyDoc 解析测试保留核心部分，计费 E2E 入口归商业。
5. core 环境检查不要求商品、支付配置；commercial 开启的功能必须完整配置。
6. 部署预检验证三进程版本/edition 一致；队列换版策略写入 T12 演练，不让 core 接管旧商业队列。

**退出条件**：三个 core 进程独立启动、核心任务执行正常；commercial 对账和异常路径完整；无残留动态导入旧 billing 路径。

### T08：前端 UI、Auth client 和 SDK 使用方迁移

**修改位置**：附录 A 的 Web 清单；`packages/contracts/src/pricing.ts`；商业 `/ui`、`/ui-server`、`/auth-client`；宿主三个 edition binding。

步骤：

1. 先提取 billing-utils 中通用的组织 helper，保持 trust-rules 与组织切换开放。
2. 迁移 billing panel、plan actions、checkout/success、team checkout dialog、套餐展示与余额 sidebar 子组件。宿主保留展示插槽，计费页面路由仅由商业版模板生成。
3. 通过 props/context adapter 注入 SDK、组织信息和导航；商业 UI 禁止 app 相对 import。
4. 分开 client、server、Auth 插件入口，保持 React client directive 和 Next server 边界；实施前按 `apps/web/AGENTS.md` 阅读安装版本的本地 Next 文档。
5. `lib/auth-client.ts` 由绑定贡献 Creem client；core 空贡献不丢失其他插件或推导类型。
6. 余额刷新事件、chat stream 通知、settings usage、侧边栏、定价 CTA 和 checkout URL 参数都依据 capabilities。core 不发 summary/订阅请求、不显示假余额；能力获取失败显示错误。
7. core 隐藏计费和额度入口，删除旧账单页面及跳转兼容，计费路由仅在 commercial 生成。commercial 保持原购买与账单行为，校验前后端 edition 不匹配。
8. SDK/client 构造不自动加载支付功能；回归 desktop/mobile/extension 的共享入口。

**验证**：Web 独立 typecheck、原相关 tests、浏览器真实导航；核心 Auth 无 Creem 依赖；core 网络请求没有 billing summary；未认证、非管理员和错误 capability 分支；client bundle 不含服务端代码。

**退出条件**：核心 UI 无商业静态依赖，commercial 购买流程保持；单纯隐藏按钮不算通过。

### T09：源码投影、锁文件与双发行构建

**新增/修改**：`scripts/editions/prepare.mjs` 与检查脚本；`enterprise/billing/edition/*`；根/app manifests 与 core lockfile；商业投影 lockfile；`Dockerfile`、`docker/docker-compose.yml`、CI build 配置、env examples。

步骤：

1. 完成根工作区的 core 化，manifest 不依赖 commercial，移除已迁走的 Creem app 直接依赖。core 的 workspace globs 不无条件加载 enterprise。
2. 完善 T03 已投入使用的 Node 内置投影脚本，按受审查的 allowlist 生成 core/commercial 投影；core 不读取 enterprise 文件，commercial 缺目录明确失败。
3. 保留 patches、TypeScript/Turbo/Next 配置和构建资源；拒绝复制 secrets、.git、node_modules、缓存。保护输出目录，拒绝覆盖源码或非工具拥有目录。
4. commercial 在投影中添加 package 和三个 Web/一个 backend binding，使用商业模板和许可标识；原始核心文件不被就地重写。
5. 提交 root core lockfile 和 commercial 投影 lockfile，建立对应更新流程。CI 与镜像只能 frozen install，锁文件与 manifest 不符即失败。
6. 商业开发也使用该投影和明确同步流程，禁止临时运行时探测包是否存在或测试 alias 偷渡。
7. Docker prune 输入限定为所选投影；分别检查生产源码、bundle、source map 和依赖闭包。目标镜像命名明确区分 core/commercial。
8. 在完全没有 enterprise 的源码副本上，用 fresh node_modules 安装，执行全部 core 构建/迁移与 smoke，证明不是借用缓存依赖。

**拟新增命令接口**（仅在实现脚本之后可执行）：

```sh
node scripts/editions/prepare.mjs --edition=core --out=/tmp/sourceweft-billing-core
node scripts/editions/prepare.mjs --edition=commercial --out=/tmp/sourceweft-billing-commercial
```

各投影内运行：

```sh
pnpm install --frozen-lockfile
pnpm --filter @sourceweft/backend check-types
pnpm --filter web check-types
pnpm --filter @sourceweft/backend build
pnpm --filter web build
```

commercial 投影额外运行（package/scripts 为本计划交付物，当前不存在）：

```sh
pnpm --filter @sourceweft/billing check-types
pnpm --filter @sourceweft/billing test
```

**退出条件**：两套 frozen install 和实际构建通过；移除商业源码的 core 发行档仍可复现；client/server 分离与最终镜像许可清单通过。

### T10：许可证、文档与临时路径清理

**修改**：`enterprise/LICENSE`、`enterprise/billing/LICENSE`、商业 README/package metadata；根许可证说明；中英文 README；`docs/saas-env-configuration.md`；`apps/backend/docs/auth-migrations.md`；`docs/architecture/backend-module-ownership.md`；相关 package README/env/examples/scripts。

步骤：

1. 根据 T00 来源清单审定商业许可及贡献规则；保留既有第三方与历史许可，不能用批量改 header 抹去原权利。
2. 商业 package 标注 `SEE LICENSE IN LICENSE`，补齐根声明已引用的 `enterprise/LICENSE` 并与 package LICENSE 保持一致。保留当前根目录排除声明，补充生成绑定在投影 app 目录中的许可适用范围，不重复修改 Apache 正文。
3. 区分部署软件授权、租户订阅和 Provider 账号；明确没有技术激活系统，不宣称 env 开关可证明授权。
4. 文档说明 core 无额度账本的行为变化、商业模式选择、旧 env 清理、有限资源约束与实际上游费用之间的区别。
5. 更新原 billing host-owned 分类，说明这是应用服务 package 而非 capability；其他模块分类不动。
6. 删除 T01–T03 的临时 shim，逐个记录原路径、替代入口、剩余 importer 扫描与验证证据。
7. 扫描动态 import、barrel、类型引用、test setup、Docker、源码复制和前端 auth client，防止开放包反向依赖商业实现。

**退出条件**：实现/文档/产物许可一致，无旧实现副本及 shim。权属或正式条款若尚未确认，技术交付可继续，但商业许可发布状态必须保持未完成。

### T11：完整验收与证据归档

在两个实际源码投影中执行下方验收矩阵。形成实现阶段新增的 `docs/verification/billing-extraction/` 记录，包含源提交、edition、运行环境、命令、实际结果、未验证原因和产物摘要；不得保存支付密钥、用户私密数据或真实 DB dump。

已有测试迁移后保持场景映射，不只比较测试数量。新增测试优先覆盖真实边界：依赖缺失、事务并发、跨租户、迁移、构建闭包、错误降级。

**退出条件**：所有必须项实际通过；被环境阻碍的项标记未验证且不能据此批准发布。不得通过 `--passWithNoTests` 或 Web build 忽略类型错误来满足门槛。

### T12：受支持老库升级与回滚演练

使用独立、脱敏或合成的测试数据集，不在制定计划时操作生产。

1. 从当前支持的 1.7 schema 和原商业实现建立样本：成员账户、月度/add-on 余额、活跃订阅、待履约订单、重复/失败 Webhook、待成本调账任务。
2. 保存余额、ledger 数量/键集合、订单/订阅状态、migration journal 等可比较摘要。
3. 暂停新 checkout/商业工作进入，保留旧版本接收 Webhook；排空或明确接续在途任务。若停旧端点，必须实际验证 Provider 重试或持久接收机制，不假定自动可靠重投。
4. 运行 commercial Auth schema-only migrate、Drizzle migrate、extension provision；再次运行验证幂等，无账户回填或账本重写。
5. 成套切换 API/worker/scheduler，使用旧 payload 完成履约、重放和调账；比较摘要，变化只能来自演练明确触发的业务。
6. 回切上一套 commercial 镜像与兼容配置，保留已确认支付和账本；验证没有双重消费和重复 grants。
7. 单独验证 core→commercial 建表/插件扩展；已有商业库使用 core migration 时不得删除插件字段。
8. commercial→core 只出停止计费的独立运行手册，要求先处理存量订阅/订单/队列及数据保留，不自动取消订阅，不当作回滚路径。

**退出条件**：升级与回滚均有可重复证据；不破坏财务数据；上线资格与实际执行上线区分记录。

## 4. 验收矩阵

| ID | 场景 | 通过要求 | 层级 |
| --- | --- | --- | --- |
| C01 | core 源码物理无 enterprise | fresh frozen install、typecheck、build、迁移、三进程与 Web 正常 | 发行/E2E |
| C02 | core 注册/组织/邀请 | 成功且 billing account 无业务读写，权限保持 | 集成/真实 DB |
| C03 | core 对话/流式/标题/工具/长任务 | 功能完成，无 summary、ledger 或支付请求 | 集成/E2E |
| C04 | core 文档/连接器/产物 | 成功，事实校验与资源限制保持 | 集成/E2E |
| C05 | core UI/旧账单 URL | UI 无提示、无计费入口，core 无计费页面路由；API 保持 unavailable 契约 | Web/API |
| C06 | core 显式要求 commercial | 配置/构建失败而非忽略 | 负向 |
| C07 | core 用量与成本回查 | 观测仍写入，缺失成本有标记，不调用商业调账 | 集成 |
| B01 | commercial 所有原 billing 场景 | 与基线的账务不变量一致 | 单元/集成 |
| B02 | 同成员并发/不同成员隔离 | 真实 PG row lock、同事务 ledger、幂等与回滚成立 | 数据库 |
| B03 | 订单/充值/付费周期/席位 | 原规则与原 Provider 确认源不变 | 单元/集成 |
| B04 | Webhook 签名/重放/乱序/特殊取消 | 不伪造成功，不重复授予，不降低签名验证 | 集成/支付沙箱 |
| B05 | 结算失败与 covered/shadow/disabled | 精确保留各模式，不扩大故障放行 | 故障注入 |
| B06 | Provider 回查补扣/退款/重复任务 | 幂等、退款原桶、trace/span 保留 | 数据库/集成 |
| B07 | 缺 commercial package/绑定/必需配置 | 启动或构建失败，绝不自动 core | 负向 |
| B08 | 未认证/非管理员/跨租户 | 原权限维持，不能伪造计费 actor 或 BYOK 标记 | 安全回归 |
| G01 | 全局 disabled、DB BYOK 有效 | BYOK 成功，不扣模型 credits | 集成 |
| G02 | BYOK 无密钥但 GLOBAL 有密钥 | BYOK 拒绝，全局密钥不越界 | 集成 |
| G03 | GLOBAL 无 ready target | 安全失败，不启用其他 Provider | 集成 |
| G04 | Provider 配置与 catalog | activation/default/hash/atomic sync 规则不退化 | 原回归套件 |
| D01 | core/commercial 空库 | Auth→Drizzle→provision 成功、重复幂等 | 迁移 |
| D02 | 支持的老库升级/回滚 | 无删表、无 journal 重排、无账本改写 | 迁移/演练 |
| F01 | core 依赖与镜像 | 无商业实现、Creem 接入、商业 source map/绑定 | 产物检查 |
| F02 | UI 子入口 | client 不包含 server/DB/secret；Web 独立 tsc 通过 | 构建/类型 |
| F03 | SDK/桌面/移动/扩展共享入口 | 不因移除 Creem/billing UI 影响 auth 或核心导航 | 定向回归 |
| F04 | 两版本锁文件 | manifests 匹配，CI 不临时解析依赖 | 安装 |
| L01 | 授权范围和发布依据 | 商业包/绑定/镜像许可一致；历史权利与来源已核对 | 发布审查 |

测试使用已有技术栈。真实 PG 与支付沙箱未完成时，不把 memory tests 或 HTTP mock 描述为 E2E。只对变更相关项目运行完整必要套件，失败后针对原因修复，不反复无理由扩展测试。

## 5. 完成报告要求

最终实施报告必须分别回答：

1. 一个商业 package 是否已形成，哪些开放 DTO/算法/schema 保留在核心。
2. 没有商业目录的 fresh core 构建是否实际通过，核心行为与旧默认有哪些变化。
3. commercial 账务语义、权限、GLOBAL/BYOK、Auth 与 migration 验证结果。
4. Web/三个进程/SDK/共享客户端是否完成接入，临时 shim 是否已删除。
5. 两个发行产物依赖闭包与许可证扫描结果。
6. 老库升级、商业回滚和未验证事项；当前是否只有技术交付完成，或许可发布前置条件也已完成。

不能以“已移动文件”“关闭开关能启动”“单元测试通过”替代完整完成标准。实施任务交付不等于执行生产发布。

## 附录 A：文件迁移与调用方清单

以下是审阅时发现的路径。目录组需在 T00 展开为实际文件，并在各任务结束扫描遗漏；此处不是自动移动所有文件的脚本。

| 原路径/组 | 目标或处理 | 任务 |
| --- | --- | --- |
| `apps/backend/src/modules/billing/{account-service,subscription-service,order-service,usage-service,webhook-service,reconcile-service,service}.ts` | 商业 server 服务 | T03 |
| billing `{catalog,ledger,page-ledger,service-helpers,types,errors}.ts` | 商业政策/账务；开放错误形状留 contracts | T01/T03 |
| billing `{store,store-port}.ts` | 商业 postgres | T04 |
| billing `providers/*`、`provider.ts` | 商业 Provider 和接入 adapter | T03/T05 |
| billing `index.ts` | factory 与宿主 binding，删除原商业 singleton | T02/T03 |
| billing `*.test.ts`、`test-fixtures.ts` | 商业 tests | T03/T04 |
| `packages/credits-core/src/plans.ts` | 商业 catalog | T03 |
| `packages/credits-core/src/credits.ts` | 算法开放，默认单价迁商业配置 | T03 |
| `packages/contracts/src/pricing.ts` | 类型开放，价格/配额/策略函数迁商业 | T03/T08 |
| `packages/contracts/src/{billing,misc,sources,stream}.ts` | 保留协议，校验新结果/错误兼容，不引入商业 import | T01/T06 |
| `packages/sdk/src/{billing-client,client-factory,index}.ts` | 保留开放 API，新增 capabilities | T01/T08 |
| `packages/db/src/schema/billing.ts`、历史 `drizzle/*` | 保留开放和历史，业务访问迁包 | T04 |
| `modules/auth/{auth-config,auth,auth.migration}.ts` | 注入运行/迁移扩展，组织权限保留 | T05 |
| `modules/onboarding/service.ts` | core 组织初始化与 commercial account hook 分离 | T05 |
| `modules/workspace/{service,store}.ts`、auth organization metadata | 暴露现有履约窄接口，组织 owner 不迁移 | T05 |
| `api/{app,main}.ts`、`api/routes/billing.ts`、`api/response/api-response.ts` | route/error 扩展与正确注册顺序 | T01/T05/T07 |
| `modules/content/{index,billing-port,model-billing,provider-cost}.ts` | 执行事实与收费政策分离 | T06 |
| `shared/model-gateway/{billed-client,agent-tool-client,index}.ts`、`billing/*` | 观测/上下文在宿主，准入/结算接接口 | T06 |
| `shared/model-gateway/provider-cost-reconciliation.ts` | 核心 receipt 回查，商业调账 | T06/T07 |
| `modules/llm-observability/sink.ts` | 保留观测，不依赖商业结算 | T06 |
| `modules/sources/{index,billing-pages,indexing-service,parsing-service}.ts`、`parsers/*types.ts` | 保留解析事实、注入计量政策 | T06 |
| `modules/connectors/{index,sync-orchestrator,webhook-service}.ts` | 所有 sync/webhook 接入统一策略 | T05/T06 |
| `modules/threads/index.ts`、`durable/runner.ts` | 消除直接 billingService import | T06 |
| threads `agent/turn/*`、`agent/capability-tools/types.ts`、`turn/*`、`stream/*`、`thread/title-generation.ts` | scope/错误/中断/结算接口及共享类型 | T01/T06 |
| `worker/{main,processors/thread-title,deliverable-host/context}.ts` | 任务装配与模型结算接入 | T06/T07 |
| `scheduler/main.ts`、`schedules/reconcile-team-subscriptions.ts` | 商业注册，不动其他 schedule | T07 |
| `checks/{billing-catalog,index}.ts` | 商业检查扩展 | T03/T07 |
| scripts `create-creem-product.ts`、`delete-creem-product.ts`、`audit-chat-metering.ts`、`anydoc-billing-e2e.ts` | 商业命令归包；解析 core fixtures 保留 | T07 |
| `apps/web/lib/{auth-client,deployment-config,sdk}.ts` | edition 插槽和 capabilities | T08 |
| Web `app/dashboard/billing/**`、`app/_components/team-checkout-dialog.tsx` | 计费路由由商业模板生成，共享展示插槽装配商业 UI | T08 |
| settings-center `billing-*`、`use-billing-plan-action.ts`、`usage-panel.tsx`、`types.ts` | 商业账单与核心观测分离 | T08 |
| settings-center `trust-rules-panel.tsx`、`settings-center-shell.tsx`、settings modal | 通用组织 helper 提取，导航能力化 | T08 |
| `dashboard-sidebar-chat-panel.tsx`、`dashboard-billing-summary-refresh.ts`、chat stream runner control | 可选余额展示与刷新，不影响聊天 | T08 |
| Web `_landing/pricing-config.ts`、`_landing/v1/pricing-toggle.tsx` 及导入方 | 商业 catalog 插槽，core CTA 不引导购买 | T08 |
| `apps/backend/tsup.config.ts`、Web Next 配置、TS/Turbo/工作区配置 | 实际投影和子入口构建检查 | T09 |
| `Dockerfile`、`docker/docker-compose.yml`、env examples、CI | 双发行与配置一致性 | T09/T10 |

## 附录 B：测试迁移保留清单

原 billing 套件至少覆盖并继续保留：`catalog`、`provider`、`creem-webhook`、`subscription-lifecycle`、`team-seats`、`order-fulfillment`、`page-ledger`、`page-ledger.clawback`、`ingestion-existing-rule`、`usage-reconciliation`。

宿主定向回归包括现有 `model-billing.test.ts`、`billing-pages.test.ts`、`turn-billing-scope.test.ts`、`error-turn-billing.test.ts`、`workspace/billing-org.test.ts`、model gateway 相关 usage/embedding/Provider 激活测试、Auth 与 Web 对应测试。

以实际测试内容区分：纯商业规则测试迁商业 tests；业务调用开放接口的 core 测试留宿主并注入测试策略；涉及完整商业装配的集成测试放商业投影运行。不能让 core 默认 test 扫描到必需商业源码的测试。

测试数据库必须显式隔离，关闭生产连接误用；现有测试设置默认关闭的 observability 写入，在 C07 等观测验收用例中要显式开启并提供隔离 DB，否则无法证明观测保留。
