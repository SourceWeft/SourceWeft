# Web 页面与 API 性能审查报告

审查时间：2026-05-17  
最近更新：2026-05-18
范围：`apps/web/app` 全部页面入口、`apps/backend/src/api/routes` 全部 Hono API 路由、相关 `packages/sdk`/`packages/contracts` 调用面。

## 摘要

本轮发现的主要性能风险集中在聊天工作台和观测页面：

- 聊天流式渲染存在高频 `flushSync` + 全量 `messages.map` 更新，长对话或高 token 速率下容易造成主线程卡顿。
- `SourcesHub`、`dashboard/chat/[threadId]`、`observability/page`、`dashboard-settings-center-modal` 是当前最大的客户端组件，承担了数据加载、状态管理、列表渲染和弹窗交互，后续维护和渲染成本都偏高。
- `/sources` 与 `/threads/:id/messages` 仍是全量读取路径；当 source 数、message 数和 metadata 变大时，payload、数据库扫描和客户端 render path 都会同步放大。
- SourcesHub 对 pending sources 使用每 4 秒 N 个 status 请求的轮询模型，批量上传或多 source 解析时会放大 API 压力。
- Observability 列表已分页，但详情接口会一次返回 trace 下全部 spans/generations，并且前端树、时间线、JSON/格式化视图都在同一大组件里渲染。

## 覆盖清单

### Web 页面入口

共 19 个页面入口：

- `apps/web/app/page.tsx`
- `apps/web/app/account/[path]/page.tsx`
- `apps/web/app/auth/[path]/page.tsx`
- `apps/web/app/auth/accept-invitation/page.tsx`
- `apps/web/app/auth/consent/page.tsx`
- `apps/web/app/auth/desktop-complete/page.tsx`
- `apps/web/app/auth/error/page.tsx`
- `apps/web/app/dashboard/page.tsx`
- `apps/web/app/dashboard/chat/page.tsx`
- `apps/web/app/dashboard/chat/[threadId]/page.tsx`
- `apps/web/app/dashboard/observability/page.tsx`
- `apps/web/app/dashboard/skills/page.tsx`
- `apps/web/app/dashboard/skills/[slug]/page.tsx`
- `apps/web/app/dashboard/billing/page.tsx`
- `apps/web/app/dashboard/billing/checkout/page.tsx`
- `apps/web/app/join/page.tsx`
- `apps/web/app/organization/[path]/page.tsx`
- `apps/web/app/privacy/page.tsx`
- `apps/web/app/terms/page.tsx`

### 大组件热点

- `apps/web/app/dashboard/chat/[threadId]/dashboard-chat-thread-page-client.tsx`：承接原 thread 页客户端实现；`page.tsx` 已收敛为动态导入入口。
- `apps/web/app/dashboard/chat/_components/sources-hub.tsx`：约 4518 行。
- `apps/web/app/dashboard/observability/page.tsx`：约 2336 行。
- `apps/web/app/dashboard/_components/dashboard-settings-center-modal.tsx`：约 2475 行。
- `apps/web/app/dashboard/chat/_components/chat-canvas/composer.tsx`：约 1440 行。
- `apps/web/app/dashboard/chat/_components/dashboard-chat-page-client.tsx`：约 1257 行。

## P0：高概率卡顿或放大的性能风险

### P0-1 聊天流式输出每小片段触发同步全量消息更新

影响位置：

- `apps/web/app/dashboard/chat/[threadId]/page.tsx:3303`
- `apps/web/app/dashboard/chat/[threadId]/page.tsx:3323`
- `apps/web/app/dashboard/chat/[threadId]/page.tsx:3374`
- `apps/web/app/dashboard/chat/[threadId]/page.tsx:3407`
- `apps/web/app/dashboard/chat/[threadId]/page.tsx:3442`
- `apps/web/app/dashboard/chat/[threadId]/page.tsx:3591`

触发场景：

- 长回答、高 token 速率、reasoning/tool call 频繁更新、长 thread 中已有大量历史消息。

性能影响：

- 每个 `text-delta` 被拆成最多 24 个字符的 chunk 后进入 `deltaQueue`。
- 每个 drain 循环里执行 `flushSync`，并对 `messages` 做 `previous.map`，还会复制 `renderBlocks`。
- tool/thinking/citation 事件同样使用 `flushSync + setMessages + previous.map`。
- 在长 thread 中，单次 token 更新成本约为 `O(messageCount + renderBlockCount)`，会放大为高频主线程工作。

建议改法：

- 把 streaming assistant message 从全局 `messages` 数组中拆出独立 transient store，最终完成时再合并回 `messages`。
- 将 delta 更新改为按时间片批处理，例如 50-100ms 或每 animation frame 只 commit 一次完整 buffer，避免每 24 字符一次 React commit。
- 移除非必要 `flushSync`，仅在必须保持 DOM/selection 同步的场景使用。
- `renderBlocks` 使用 append-only ref 保存，React state 只保存版本号或当前可见文本。

验证方式：

- 构造 200 条历史消息、2000+ token 输出、10+ tool events 的场景，用 React Profiler 检查 commit 次数和单次 commit 时间。
- 验证连续流式输出时输入框、滚动和 SourcesHub 操作不卡顿。

### P0-2 `/sources` 全量返回，SourcesHub 首次加载和刷新会随 source 数线性膨胀

影响位置：

- `apps/backend/src/api/routes/content/sources.ts:53`
- `apps/backend/src/modules/content/sources/repository.ts:109`
- `apps/web/app/dashboard/chat/_components/sources-hub.tsx:2477`
- `apps/web/app/dashboard/chat/_components/sources-hub.tsx:2489`

触发场景：

- workspace 中 source 数达到几百或几千，或者目录树较深。

性能影响：

- API 无 `limit/cursor/fields`，仓储层 `.select()` 全量查询所有非 archived sources。
- 前端 `refreshSources` 每次全量 `listSources`，再 `mapSourcesToUi`、构建树、过滤、计数。
- Source 增删改、上传完成、轮询结束都会触发全量刷新。

建议改法：

- 新增兼容参数：`limit`、`cursor`、`parentSourceId`、`includeTree`、`fields=summary|detail`。
- SourcesHub 首屏只加载根节点或最近 N 条；展开目录时按需加载子节点。
- 需要全文搜索/mention 的场景继续走已分页的 `/sources/mentions`。

验证方式：

- 构造 500、2000、10000 sources 数据，分别测 `/sources` 响应时间、payload 大小、SourcesHub 打开耗时。
- 检查 sources 列表查询是否命中 `(team_id, workspace_id, status, updated_at)` 或等价组合索引。

### P0-3 Thread messages 全量读取，无分页或懒加载

影响位置：

- `apps/backend/src/modules/content/threads/message-repository.ts:85`
- `apps/backend/src/modules/content/threads/message-repository.ts:90`
- `apps/web/app/dashboard/chat/[threadId]/page.tsx:2231`
- `apps/web/app/dashboard/chat/[threadId]/page.tsx:2278`

触发场景：

- 长对话、多版本消息、metadata 中包含 toolCalls、citations、renderBlocks、images。

性能影响：

- 仓储层按 thread 全量读取并按 `createdAt` 排序。
- 前端加载后构造 `messageGroups`、active citations、thread citations，均会随 messages 数量增长。
- 流式更新期间又叠加 P0-1 的全量 `messages.map`。

建议改法：

- 为 `/threads/:id/messages` 增加 `limit/cursor/direction` 和 `include=metadata|contentJson|citations`。
- 首屏只加载最近消息，向上滚动加载历史。
- 对可折叠的历史版本、tool metadata、大 citation payload 延迟加载。

验证方式：

- 构造 100、500、2000 messages 的 thread，测进入页面耗时、JS heap、React commit。
- 验证历史分页不会破坏 edit/refresh/version branch 行为。

## P1：大组件、列表渲染与重复计算风险

### P1-1 SourcesHub 组件职责过大，列表和树无虚拟化

影响位置：

- `apps/web/app/dashboard/chat/_components/sources-hub.tsx`
- 树构建：`apps/web/app/dashboard/chat/_components/sources-hub.tsx:345` 附近的 `buildSourceTree`
- 列表渲染与过滤：`apps/web/app/dashboard/chat/_components/sources-hub.tsx` 多处 `filtered.map`、`tree.map`

触发场景：

- 用户打开 Hub，sources/workfiles/artifacts/skills/citations/connectors 任一 tab 数据量较大。

性能影响：

- 单文件承载数据获取、缓存、搜索、拖拽、上传、目录树、弹窗和多个 tab。
- Search 每次输入会触发 filter/tree rebuild。
- 目录树和列表全量 render，无窗口化。

建议改法：

- 拆成 `SourcesTab`、`WorkfilesTab`、`ArtifactsTab`、`SkillsTab`、`CitationsTab`、`ConnectorsTab`。
- 对 sources tree 和 trace/message 列表引入虚拟列表。
- Search query 使用 `useDeferredValue` 或 debounce，避免每个 keypress 重建树。
- 把上传/编辑/移动/删除弹窗状态下沉到对应 tab。

验证方式：

- 500/2000 source 下输入搜索关键字，Profiler 观察 commit 时间。
- 打开/关闭 Hub 时比较 JS heap 和 interaction latency。

### P1-2 MessageList 渲染时为每个 group 重建 Map 和版本分支

影响位置：

- `apps/web/app/dashboard/chat/_components/chat-canvas/message-list.tsx:700`
- `apps/web/app/dashboard/chat/_components/chat-canvas/message-list.tsx:725`
- `apps/web/app/dashboard/chat/_components/chat-canvas/message-list.tsx:738`

触发场景：

- 长对话中每次流式 delta、active version 切换、citation 高亮、source 变更。

性能影响：

- 每个 message group 内部重复构建 `sourceById`。
- 每个版本 render 时执行 source expansion、map/filter 和 message text 解析。
- 与 P0-1 组合后，流式输出期间每帧都可能重算大量历史消息。

建议改法：

- 在上层按 `allSources` 建一次 `sourceById`，作为 prop 传入。
- 将单条 message/version 提取为 `React.memo` 组件，使用稳定 props。
- 对不可见历史消息进行窗口化渲染。

验证方式：

- 对 200 条消息开启 streaming，观察 MessageList commit 中实际重渲染的 message 数量。

### P1-3 Observability 详情页全量树和时间线渲染

影响位置：

- `apps/web/app/dashboard/observability/page.tsx:1671`
- `apps/web/app/dashboard/observability/page.tsx:1736`
- `apps/web/app/dashboard/observability/page.tsx:1759`
- `apps/web/app/dashboard/observability/page.tsx:1860`
- `apps/backend/src/shared/llm-observability/repository.ts:310`

触发场景：

- 单个 trace 下有大量 spans/generations，或 input/output/metadata 很大。

性能影响：

- 详情接口一次返回完整 trace、spans、generations。
- 前端在树、timeline、preview、formatted、json tab 中共享同一大组件状态。
- `TraceLogView` render 内直接 `buildTree(detail).sort(...)`。

建议改法：

- 详情接口增加 `summaryOnly`、`includePayload=false`、`observationLimit/cursor`。
- 打开 JSON/Formatted tab 时再渲染大 payload。
- Tree/timeline 使用 memo + 虚拟列表。

验证方式：

- 构造 500 observations 的 trace，测详情打开耗时和滚动 FPS。

## P2：请求策略、缓存与 bundle 边界

### P2-1 Pending source 状态轮询是 N 个请求

影响位置：

- `apps/web/app/dashboard/chat/_components/sources-hub.tsx:2687`
- `apps/web/app/dashboard/chat/_components/sources-hub.tsx:2693`
- `apps/web/app/dashboard/chat/_components/sources-hub.tsx:2695`

触发场景：

- 批量上传多个文件，或多个 URL source 同时解析。

性能影响：

- 每 4 秒对每个 pending source 调一次 `/sources/:id/status`。
- 20 个 pending sources 就是每 4 秒 20 个请求，且完成后可能触发全量 `refreshSources`。

建议改法：

- 新增批量状态接口：`GET /sources/status?ids=a,b,c` 或 `POST /sources/status/batch`。
- 后续可升级为 SSE/job events，减少前端主动轮询。
- 批量上传完成后合并刷新，不为每个完成事件分别触发全量 `/sources`。

验证方式：

- 批量上传 20 个文件，比较请求数量和 SourcesHub 更新时间。

### P2-2 `/artifacts` 有 limit 但无 cursor，SourcesHub 固定取 100 条

影响位置：

- `apps/backend/src/api/routes/content/artifacts.ts:8`
- `apps/backend/src/api/routes/content/artifacts.ts:14`
- `apps/web/app/dashboard/chat/_components/sources-hub.tsx:2547`

触发场景：

- workspace artifact 数超过 100，或 artifact item metadata 较大。

性能影响：

- 前端只能拿最近 100 条，无法继续分页。
- 刷新 artifacts 时仍是完整替换列表。

建议改法：

- 增加 `cursor` 和 `fields=summary|detail`。
- SourcesHub Artifacts tab 增加“加载更多”或滚动加载。

验证方式：

- 构造 300 artifacts，验证分页和 preview 不回退。

### P2-3 dashboard bootstrap 聚合多个首屏数据，后续需要拆分缓存策略

影响位置：

- `apps/backend/src/api/routes/dashboard.ts:34`
- `apps/backend/src/api/routes/dashboard.ts:66`
- `apps/backend/src/api/routes/dashboard.ts:114`
- `apps/backend/src/api/routes/dashboard.ts:136`

触发场景：

- 组织 workspace 较多，model catalog 较大，用户频繁切换 workspace。

性能影响：

- bootstrap 返回 user、organization、workspaces、active workspace、private chats、model catalog。
- 当前 private chats 已限制 20 条，但 workspaces 和 modelCatalog 没有明显轻量模式。

建议改法：

- bootstrap 保持首屏最小字段，modelCatalog 可缓存或单独 lazy load。
- workspace 切换时避免重新取和当前 workspace 无关的字段。

验证方式：

- 组织 100 workspaces、model catalog 较大时测 bootstrap payload 和 TTFB。

### P2-4 动态导入边界主要覆盖新聊天页，旧 thread 页仍是大客户端入口

影响位置：

- `apps/web/app/dashboard/chat/_components/dashboard-chat-page-client.tsx:109`
- `apps/web/app/dashboard/chat/_components/dashboard-chat-page-client.tsx:120`
- `apps/web/app/dashboard/chat/[threadId]/page.tsx`
- `apps/web/app/dashboard/chat/[threadId]/dashboard-chat-thread-page-client.tsx`

触发场景：

- 进入已有 thread 页面。

性能影响：

- 新建聊天页已经对 ChatCanvas、SourcesHub、HeaderModelSelector 做动态导入。
- 原 `[threadId]/page.tsx` 直接导入多个重组件，且自身包含大量聊天逻辑。
- 2026-05-18 已将 route entry 收敛为薄入口，并把重客户端实现迁移到动态导入的 client module。

建议改法：

- 复用 `dashboard-chat-page-client` 的动态导入策略，逐步把 `[threadId]` 页面收敛到共享 client shell。
- 把流式状态机拆到 hook，减少页面入口 chunk。

验证方式：

- 使用 Next bundle analyzer 比较 `/dashboard/chat` 和 `/dashboard/chat/[threadId]` route chunk。

## P3：可维护性和度量建议

### P3-1 缺少前端性能回归基线

建议：

- 增加固定数据量的 Story/fixture 或 Playwright profile 场景：500 sources、200 messages、500 trace observations。
- 记录打开聊天页、打开 SourcesHub、发送消息、打开 observability detail 的基线指标。

### P3-2 API 慢查询和 payload 大小缺少统一观测

建议：

- Hono middleware 记录 endpoint、status、duration、response size、workspace/team 维度。
- Postgres 开启慢查询日志或在关键仓储函数添加 explain 样例。
- 对大 JSON payload 增加字段体积保护和 truncation 策略，尤其 observability input/output/metadata。

## 四阶段优化路线

### 第一阶段：无接口破坏的前端优化

1. 优先处理聊天流式渲染：批处理 delta，移除非必要 `flushSync`，把 streaming message 状态从 `messages` 数组拆出。
2. 拆分 SourcesHub tab，给搜索加 debounce 或 `useDeferredValue`。
3. MessageList 单条消息组件 `React.memo`，上层缓存 `sourceById`。
4. Observability tree/timeline 计算 memo 化，JSON/Formatted tab 懒渲染。

验收：

- 长回答时 React commit 频率下降，输入和滚动无明显卡顿。
- 500 sources 搜索时无明显输入延迟。

### 第二阶段：API payload 与分页优化

1. `/sources` 增加分页、字段裁剪、按 parent 加载。
2. `/threads/:id/messages` 增加消息分页和 metadata include 参数。
3. `/artifacts` 增加 cursor。
4. observability detail 增加 `summaryOnly/includePayload/observationLimit`。

验收：

- 大 workspace 首屏 payload 明显下降。
- 长 thread 进入页面只加载最近消息，历史消息按需加载。

### 第三阶段：数据库和后台任务优化

1. 为 sources、messages、llm_traces、llm_spans、llm_generations 的高频查询确认组合索引。
2. 将 source status 轮询改为批量接口或事件推送。
3. 检查 observability `summarizeTraceObservations` 中按 trace page 构造 `or(...)` 的查询在 50-200 limit 下的执行计划。
4. 删除/更新 source 时的 citation preservation SQL 加 explain，确认 chunks/citations 索引。

验收：

- 常见列表接口 P95 latency 有明确基线并下降。
- 批量上传 source 时请求数不随 pending 数线性增长。

### 第四阶段：度量和回归保护

1. 建立 Web Vitals 和交互指标：聊天页 FCP/INP、SourcesHub 打开耗时、streaming commit 次数。
2. API middleware 统一记录慢请求和 response size。
3. 加入性能 fixture，作为发布前手动或 CI 检查项。
4. 对 observability payload 和 chat metadata 设置合理截断或按需加载策略。

验收：

- 每次优化有可对比指标。
- 大数据量场景不会在后续迭代中悄悄退化。

## 推荐实施顺序

1. `P0-1` 聊天流式渲染批处理。
2. `P0-2` `/sources` 分页与 SourcesHub 按需加载。
3. `P0-3` messages 分页与长 thread 虚拟化。
4. `P2-1` source status 批量查询。
5. `P1-3` observability 详情按需加载。

## 当前推进进展

截至 2026-05-18，已落地的优化：

- `P0-1`：聊天流式输出已移除非必要 `flushSync`，delta 改为批量 commit；streaming assistant message 已从主 `messages` 数组拆成 `streamingAssistantSnapshot` transient state，流式过程只更新当前 assistant snapshot，结束或失败时再合并回 `messages`，并处理临时 id 到服务端 id 的替换去重；本轮进一步把流式 delta 队列、renderBlocks 拼装和 SSE chunk 解析拆到独立轻量模块，页面侧只保留网络事件分发与 React state 同步。
- `P0-2`：`/sources` 已支持 `includeContent=false`、`limit/cursor`、`parentSourceId` 兼容参数；SourcesHub 首屏只加载根目录分页，目录展开时再按 `parentSourceId` 懒加载子节点，并为每个目录独立维护 cursor/loading/error 状态；README 编辑改为按需拉取详情。
- `P0-3`：`/threads/:id/messages` 已支持 `limit/cursor/include`，聊天页首屏默认只加载最近消息，并提供历史消息加载入口。
- `P1-1`：SourcesHub 搜索已使用 deferred query；sources tree 复用父子索引，选择态改为一次性 state map 计算；超大 tree 增加窗口化渲染路径；tab 级组件拆分已完成，`SourcesTab`、`WorkfilesTab`、`ArtifactsTab`、`SkillsTab`、`CitationsTab`、`ConnectorsTab` 均已从主组件渲染体中拆出；Add Source、Create Folder、Move Source、README、Workfile Preview、删除确认等弹窗 JSX 已下沉为独立局部组件；本轮进一步把 Add Source 表单 open/tab/text/url/files/progress/drag state 抽到 `useAddSourceDialogState` hook。
- `P1-2`：MessageList 已完成 message group 级 `React.memo` 拆分，并增加自定义 props 比较，避免流式输出和高亮变化时无关历史 group 跟随重渲染；超长历史消息列表增加保守折叠；source expansion 结果已缓存，避免每个 version render 重复展开同一批 selected sources。更深一层的 version/body 级拆分可作为后续可维护性优化。
- `P1-3`：Observability trace list 已使用 summary payload；detail 前端已复用 trace view model，JSON/Formatted/Log tab 改为激活后渲染；详情接口已支持 `summaryOnly/includePayload/observationLimit/observationCursor` 兼容参数，前端默认轻量加载 trace detail，observations 支持 cursor 加载更多，`observationLimit` 已下推到 repository 查询层；本轮为 trace tree 与 trace log/timeline 增加前端虚拟行渲染。
- `P2-1`：pending source 状态轮询已改为批量 status 接口。
- `P2-2`：artifacts 已支持 cursor 分页，SourcesHub Artifacts tab 已支持加载更多。
- `P2-3`：dashboard bootstrap 已支持 `includeModelCatalog=false` 轻量模式，前端首屏延迟加载 model catalog，workspace 切换保留轻量线程列表策略。
- `P2-4`：聊天页多个重组件已动态导入，模型选择器纯工具已拆到轻量模块；`dashboard/chat/[threadId]/page.tsx` 已瘦身为 route skeleton + 动态 client 入口，重实现迁移到 `dashboard-chat-thread-page-client.tsx`；流式 assistant transient snapshot/alias 合并状态已拆到 `streaming-assistant-state.ts` hook，delta/render buffer 已拆到 `streaming-render-buffer.ts`，SSE parser 已拆到 `streaming-event-parser.ts`；run/stop 控制面已拆到 `chat-stream-runner-control.ts`，stream request body 构造已拆到 `streaming-request-body.ts`；`start`、`text-delta/text-replace/text-interrupted`、`tool-call-*`、`thinking-step`、`reasoning`、`citations`、`thread-title-*`、`error`、`assistant-message`、`finish` 事件分支已拆到 `streaming-event-handlers.ts`，并通过 `createStreamingEventHandlerContext` 收敛共享依赖，避免页面侧为高频分支重复传递大批状态和 normalizer。
- `P2-5`：主要 App Router 页面已补齐 route-level skeleton loading，包括首页、dashboard、chat/new、chat/thread、observability、skills、billing、auth、account、organization、join、privacy、terms；聊天页动态导入 fallback 也换成结构化 SourcesHub/Chat skeleton。
- `P3-2`：API 已增加慢请求/大响应 threshold logging，统一 JSON 响应会设置 `content-length`，便于记录 payload 大小；schema 与 Drizzle migration 已补 sources/messages/observability cursor 查询关键组合索引。

仍待继续推进：

- 代码层面的审查报告事项已基本收尾；剩余为度量型验收：用本地大数据 fixture 跑 React Profiler / Web Vitals / API P95 latency 基线，并保存可回归对比的指标。可维护性层面完整 stream 事件分支和共享依赖 context 已从 `dashboard-chat-thread-page-client` 外移，后续若继续瘦身，可把网络 read loop 与少量同步函数再迁成更独立的 runner module。
