# SurfSense 系统架构外部参考（代码实现版）

> 文档目的：作为外部技术参考，回答“数据源管理/检索引用/多智能体能力/多租户/RBAC/工作流与 deep research”五个核心问题。  
> 分析范围：`VelaMind/SurfSense` 子项目的后端、前端与异步任务代码路径。  
> 说明：本文基于源码实现，不是产品宣传级描述。

---

## 0. 总览结论（先看这个）

1. **租户边界**是 `SearchSpace`，不是单纯 `User`。文档、连接器、聊天、报告、视频、播客等核心资源都挂在 `search_space_id` 下。
2. **数据源同步**采用“API 触发 + Celery 异步 + Redis 锁 + DB 调度 + 心跳清理”组合，既支持手动同步也支持周期同步。
3. **检索**是两层混合检索：`chunk` 级和 `document` 级分别做“向量 + 关键词 + RRF”，再由 `ConnectorService` 做二次文档级融合。
4. **引用（citation）**并非独立后处理器，而是由模型按系统提示在回答里直接输出 `[citation:chunk_id]`，前端再解析并回查 chunk。
5. **多智能体能力落地**不是单一 agent 包打天下：主聊天是 deep agent；报告/播客/视频分别由专用工具或专用 LangGraph 工作流处理。
6. **deep research**当前是报告生成的 `report_style` 取值之一，不是全局聊天 runtime 的独立模式开关。

---

## 1. 数据源如何管理 / 同步 / 组织

### 1.1 数据模型与组织边界

- 工作空间实体：`SearchSpace`，是数据隔离与协作边界。见 `SurfSense/surfsense_backend/app/db.py`。
- 连接器实体：`SearchSourceConnector`，关键字段：
  - `connector_type`（连接器类型）
  - `config`（认证/配置 JSON）
  - `is_indexable`
  - `last_indexed_at`
  - `periodic_indexing_enabled`
  - `indexing_frequency_minutes`
  - `next_scheduled_at`
- 文档实体：`Document`，关键字段：
  - `document_type`
  - `document_metadata`
  - `source_markdown`
  - `status`（JSONB 状态机：`pending/processing/ready/failed/...`）
  - `content_hash` / `unique_identifier_hash`
  - `connector_id`（追踪来源连接器）
- 分块实体：`Chunk`，保存 chunk 文本与 embedding。

参考路径：

- `SurfSense/surfsense_backend/app/db.py`

### 1.2 连接器创建与配置

- 统一连接器 CRUD 在 `search_source_connectors_routes.py`，按 `search_space_id` 做权限校验。
- 各 SaaS 连接器（Notion/Jira/Slack/Google 等）通常有独立 add connector route。
- OAuth 安全包含：state 签名、过期校验、token 加解密。

参考路径：

- `SurfSense/surfsense_backend/app/routes/search_source_connectors_routes.py`
- `SurfSense/surfsense_backend/app/utils/oauth_security.py`

### 1.3 手动同步链路（API -> Celery）

核心入口：`POST /search-source-connectors/{connector_id}/index`。

执行流程：

1. 路由层校验连接器存在与权限（`connectors:update`）。
2. 计算同步窗口（默认基于 `last_indexed_at` 到当前时间，部分连接器有特殊逻辑）。
3. 按连接器类型派发对应 Celery 任务（`*.delay(...)`）。
4. 后台统一走 `_run_indexing_with_notifications(...)` 管理通知、状态、锁、心跳。

参考路径：

- `SurfSense/surfsense_backend/app/routes/search_source_connectors_routes.py`
- `SurfSense/surfsense_backend/app/tasks/celery_tasks/connector_tasks.py`

### 1.4 周期同步链路（DB 调度 + Meta Scheduler）

- 不是给每个 connector 单独注册 Beat 任务，而是采用 **Meta Scheduler**：
  - Beat 固定触发一个检查任务
  - 检查 DB 中 `periodic_indexing_enabled=true` 且 `next_scheduled_at<=now` 的连接器
  - 批量触发对应 connector indexing task
  - 写回下次 `next_scheduled_at`
- 这样可避免动态 Beat 注册的运维复杂度。

参考路径：

- `SurfSense/surfsense_backend/app/utils/periodic_scheduler.py`
- `SurfSense/surfsense_backend/app/tasks/celery_tasks/schedule_checker_task.py`
- `SurfSense/surfsense_backend/app/celery_app.py`

### 1.5 并发控制与故障恢复

- **连接器互斥锁**：Redis key `indexing:connector_lock:{connector_id}` 防止同 connector 并发重复同步。
- **任务心跳**：Redis key `indexing:heartbeat:{notification_id}`，运行中持续刷新 TTL。
- **陈旧任务清理**：周期任务扫描 in-progress 通知但无心跳，自动标记失败并回写文档失败状态，避免前端长期“同步中”。

参考路径：

- `SurfSense/surfsense_backend/app/utils/indexing_locks.py`
- `SurfSense/surfsense_backend/app/tasks/celery_tasks/connector_tasks.py`
- `SurfSense/surfsense_backend/app/tasks/celery_tasks/document_tasks.py`
- `SurfSense/surfsense_backend/app/tasks/celery_tasks/stale_notification_cleanup_task.py`

### 1.6 文档上传与索引（两阶段）

- 文件上传采用两阶段：
  - **Phase 1**：立即创建 `pending` 文档（UI 可见）
  - **Phase 2**：Celery 处理 `pending -> processing -> ready/failed`
- 上传入口通过 `TaskDispatcher` 派发任务，便于测试替换实现。
- Connector 文档索引则统一走 `IndexingPipelineService`（prepare/index、去重、chunk、embedding、持久化）。

参考路径：

- `SurfSense/surfsense_backend/app/routes/documents_routes.py`
- `SurfSense/surfsense_backend/app/services/task_dispatcher.py`
- `SurfSense/surfsense_backend/app/tasks/celery_tasks/document_tasks.py`
- `SurfSense/surfsense_backend/app/indexing_pipeline/indexing_pipeline_service.py`

---

## 2. 数据如何检索与引用

### 2.1 检索架构：双层 Hybrid + 双重 RRF

检索不是单向量召回，而是融合链路：

1. `chunks_hybrid_search`：
   - chunk 向量检索（pgvector）
   - chunk 全文检索（Postgres FTS）
   - chunk 级 RRF 融合
   - 输出按 document 聚合后的 chunk 列表（保留真实 chunk_id）

2. `documents_hybrid_search`：
   - document 向量检索 + 全文检索 + RRF
   - 再补取该 document 的 chunk（有上限）

3. `ConnectorService._combined_rrf_search`：
   - 并行调用 chunk/doc 两路 retriever
   - 再做一次 **document 级 RRF** 融合

最终得到“可引用 chunk + 文档元数据”的结果结构。

参考路径：

- `SurfSense/surfsense_backend/app/retriever/chunks_hybrid_search.py`
- `SurfSense/surfsense_backend/app/retriever/documents_hybrid_search.py`
- `SurfSense/surfsense_backend/app/services/connector_service.py`

### 2.2 `search_knowledge_base` 工具行为

- 会规范化 connectors（仅搜可用连接器）。
- 对每个 connector 并行检索并聚合去重。
- 对退化查询（如 `*`）不做语义检索，而退化为按时间浏览（recency browse）。
- 输出按 XML 格式封装，核心是 `<chunk id='...'>`，用于模型引用。
- 对 live search 类型，citation id 可是 URL；本地 KB 常见为数字 chunk_id。

参考路径：

- `SurfSense/surfsense_backend/app/agents/new_chat/tools/knowledge_base.py`

### 2.3 引用生成机制（模型内联，不是后处理）

- 系统提示明确要求：事实陈述应带 `[citation:chunk_id]`。
- chunk_id 必须来自工具上下文里的 `<chunk id='...'>`，不可伪造。
- 因为是提示约束，所以引用与回答同流输出，不依赖额外“citation service”。

参考路径：

- `SurfSense/surfsense_backend/app/agents/new_chat/system_prompt.py`

### 2.4 前端引用解析与回查

- Markdown 层解析 `[citation:...]`：
  - 数字 ID：KB chunk
  - `doc-xxx`：SurfSense 文档库 chunk
  - URL：实时 web search 引用
- 点击引用后：
  - KB chunk -> `/api/v1/documents/by-chunk/{chunk_id}`
  - docs chunk -> `/api/v1/surfsense-docs/by-chunk/{chunk_id}`

参考路径：

- `SurfSense/surfsense_web/components/assistant-ui/markdown-text.tsx`
- `SurfSense/surfsense_web/components/assistant-ui/inline-citation.tsx`
- `SurfSense/surfsense_web/components/new-chat/source-detail-panel.tsx`
- `SurfSense/surfsense_web/lib/apis/documents-api.service.ts`
- `SurfSense/surfsense_backend/app/routes/documents_routes.py`
- `SurfSense/surfsense_backend/app/routes/surfsense_docs_routes.py`

---

## 3. 多智能体如何实现，以及视频 / PPT 等能力如何落地

### 3.1 运行时拓扑：一个主聊天 agent + 多个专用工作流 agent

- 主聊天：DeepAgents + LangGraph checkpointer（持久状态）。
- 专项能力：通过工具调用触发独立流程：
  - 报告：工具内 LLM 生成与版本化
  - 播客：Celery + `agents/podcaster` LangGraph
  - 视频：Celery + `agents/video_presentation` LangGraph

这是一种“主协调 agent + 专用子流程”的多智能体/多工作流架构。

参考路径：

- `SurfSense/surfsense_backend/app/agents/new_chat/chat_deepagent.py`
- `SurfSense/surfsense_backend/app/agents/new_chat/tools/registry.py`
- `SurfSense/surfsense_backend/app/agents/podcaster/graph.py`
- `SurfSense/surfsense_backend/app/agents/video_presentation/graph.py`

### 3.2 聊天主链路（SSE 流式）

1. 前端请求 `/api/v1/new_chat`。
2. 后端 `stream_new_chat`：加载 LLM 配置、连接器服务、checkpointer、可选 sandbox。
3. `create_surfsense_deep_agent(...)` 动态组装工具。
4. 以 SSE 输出思考步骤、文本增量、工具输入/输出、中断恢复事件。
5. 前端按 event 类型拼装 assistant message 与 tool UI。

参考路径：

- `SurfSense/surfsense_backend/app/routes/new_chat_routes.py`
- `SurfSense/surfsense_backend/app/tasks/chat/stream_new_chat.py`
- `SurfSense/surfsense_web/app/dashboard/[search_space_id]/new-chat/[[...chat_id]]/page.tsx`

### 3.3 工具系统与动态能力装配

- 工具由 registry 统一注册，支持 `enabled_tools/disabled_tools`。
- 根据连接器可用性动态关闭相关 action tools（如无 Notion/Linear connector 时禁用对应写操作工具）。
- 可加载 MCP tools，扩展外部能力。
- 有 sandbox 时额外注入 `execute` 工具。

参考路径：

- `SurfSense/surfsense_backend/app/agents/new_chat/tools/registry.py`
- `SurfSense/surfsense_backend/app/agents/new_chat/chat_deepagent.py`

### 3.4 报告能力（Report）

- `generate_report` 支持：
  - `source_strategy`: `provided` / `conversation` / `kb_search` / `auto`
  - 内部可并行触发 KB 检索后再写作
  - 版本化：`parent_report_id` 形成同组版本
  - `report_style`: `detailed` / `deep_research` / `brief`
- 导出由报告路由提供（pdf/docx/html/...）。

参考路径：

- `SurfSense/surfsense_backend/app/agents/new_chat/tools/report.py`
- `SurfSense/surfsense_backend/app/routes/reports_routes.py`

### 3.5 播客能力（Podcast）

- 工具先落库 `Podcast(status=pending)`，立即返回 `podcast_id` 供前端轮询。
- Celery 任务执行 `podcaster` 图：先生成脚本，再合成音频。
- 完成后状态变 `ready`，前端播放器渲染。

参考路径：

- `SurfSense/surfsense_backend/app/agents/new_chat/tools/podcast.py`
- `SurfSense/surfsense_backend/app/tasks/celery_tasks/podcast_tasks.py`
- `SurfSense/surfsense_backend/app/agents/podcaster/graph.py`

### 3.6 视频与 PPT 能力落地

- 工具 `generate_video_presentation` 先创建 `VideoPresentation(status=pending)`。
- Celery 后台执行视频图：
  - 生成 slides
  - 并行生成音频与主题
  - 生成 scene code
  - 回写 `slides` + `scene_codes`，状态 `ready`
- 前端拿到 scene code 后：
  - 使用 `@babel/standalone` 编译为组件
  - 用 Remotion Player 预览
  - 用 `@remotion/web-renderer` 在浏览器侧导出视频
  - 用 `dom-to-pptx` + Remotion Thumbnail 导出可编辑 PPTX

关键点：**最终视频/PPT 导出主要发生在前端浏览器，不是后端统一渲染服务。**

参考路径：

- `SurfSense/surfsense_backend/app/agents/new_chat/tools/video_presentation.py`
- `SurfSense/surfsense_backend/app/tasks/celery_tasks/video_presentation_tasks.py`
- `SurfSense/surfsense_backend/app/agents/video_presentation/graph.py`
- `SurfSense/surfsense_web/components/tool-ui/video-presentation/generate-video-presentation.tsx`
- `SurfSense/surfsense_web/components/tool-ui/video-presentation/combined-player.tsx`
- `SurfSense/surfsense_web/lib/remotion/compile-check.ts`

---

## 4. 多租户设计（用户 + team/workspace + RBAC）

### 4.1 租户模型

- `SearchSpace` 即 workspace/tenant 主体。
- “team 协作”由成员关系和角色来表达，而不是独立 Team 表。
- 大部分资源带 `search_space_id`，并以此做数据隔离。

参考路径：

- `SurfSense/surfsense_backend/app/db.py`

### 4.2 成员与角色

- 角色：`SearchSpaceRole`（支持系统角色与自定义角色）。
- 成员：`SearchSpaceMembership`（用户-空间-角色绑定，含 `is_owner`）。
- 邀请：`SearchSpaceInvite`（邀请码、过期、次数、默认角色等）。
- 新建 search space 时自动创建 `Owner/Editor/Viewer` 与 owner membership。

参考路径：

- `SurfSense/surfsense_backend/app/db.py`
- `SurfSense/surfsense_backend/app/routes/search_spaces_routes.py`
- `SurfSense/surfsense_backend/app/routes/rbac_routes.py`

### 4.3 权限系统（RBAC）

- `Permission` 枚举覆盖文档/聊天/连接器/成员/角色/设置/公开分享等维度。
- `Owner` 通过 `*`（`FULL_ACCESS`）全权限；`Editor` 与 `Viewer` 是预置权限集。
- 路由层通过 `check_permission(...)` 强制校验。

参考路径：

- `SurfSense/surfsense_backend/app/db.py`
- `SurfSense/surfsense_backend/app/utils/rbac.py`
- `SurfSense/surfsense_backend/app/routes/rbac_routes.py`

### 4.4 Chat 可见性与分享

- 线程可见性：`PRIVATE` 与 `SEARCH_SPACE`（空间内共享）。
- 另有 public snapshot 能力（不可变快照 URL，用于外部分享）。
- Snapshot 会裁剪内容并过滤工具类型，保证公开视图安全与自包含。

参考路径：

- `SurfSense/surfsense_backend/app/db.py`
- `SurfSense/surfsense_backend/app/routes/new_chat_routes.py`
- `SurfSense/surfsense_backend/app/services/public_chat_service.py`
- `SurfSense/surfsense_backend/app/routes/public_chat_routes.py`

---

## 5. 工作流如何管理，是否有 deep research，以及如何区分

### 5.1 工作流分层

可以理解为三层：

1. **交互层（同步）**：`new_chat` SSE 流，主 deep agent 做工具编排与文本输出。
2. **能力层（异步）**：Celery 执行长任务（连接器索引、文档处理、播客、视频等）。
3. **治理层（调度/恢复）**：Beat 定时检查、锁、心跳、stale cleanup、超时告警。

参考路径：

- `SurfSense/surfsense_backend/app/tasks/chat/stream_new_chat.py`
- `SurfSense/surfsense_backend/app/celery_app.py`
- `SurfSense/surfsense_backend/app/tasks/celery_tasks/*.py`

### 5.2 deep research 现状与区分

结论：

- 有 `deep_research`，但它当前是 **报告风格参数**（`report_style`）层面的语义标签。
- 代码层明确分支目前主要是 `brief` 的长度约束；`deep_research` 没有单独 runtime 引擎分支。
- 也就是说，当前“deep research”更像 prompt/写作风格约束，不是“开启另一套全局 agent pipeline”的模式。

参考路径：

- `SurfSense/surfsense_backend/app/db.py`
- `SurfSense/surfsense_backend/app/agents/new_chat/tools/report.py`

---

## 6. 三条关键端到端时序（简化）

### 6.1 Connector 同步

1. 前端调用 `POST /search-source-connectors/{id}/index`。
2. 后端检查权限并派发对应 Celery task。
3. Worker 拿 Redis connector lock。
4. 创建/更新 notification，写 heartbeat。
5. 拉取源数据 -> 进入 indexing pipeline -> 写 `Document/Chunk`。
6. 完成后更新 `last_indexed_at`、notification 状态并清除 heartbeat/lock。
7. 若 worker 崩溃，stale cleanup 检测心跳缺失并收敛状态。

### 6.2 提问到引用展示

1. 用户在 chat 提问，前端连接 SSE。
2. deep agent 调 `search_knowledge_base`，获得 `<chunk id='...'>` 上下文。
3. 模型生成回答并内联 `[citation:xxx]`。
4. 前端 markdown 解析 citation 并渲染可点击 badge。
5. 点击 badge 回查 by-chunk API，侧栏展示 source chunk 全文。

### 6.3 视频生成到导出

1. agent 调 `generate_video_presentation`，先创建 pending 记录。
2. Celery 跑视频图并将 slides/scene_codes 入库。
3. 前端轮询状态到 ready。
4. 前端编译 scene code，Remotion 预览。
5. 用户可下载视频（web-renderer）或导出 PPTX（dom-to-pptx）。

---

## 7. 关注点与实施建议（面向后续演进）

1. `deep_research` 若要产品化成独立模式，建议增加明确 runtime 分支和可观测指标，而非仅依赖 `report_style` 文本标签。
2. citation 目前高度依赖模型遵循提示，建议补充服务端 citation 校验器（chunk_id 存在性、格式修正）提升稳定性。
3. 前端侧视频导出对浏览器能力要求高，可考虑增加服务端渲染 fallback（任务队列化）作为兜底。
4. connector 同步链路已具备锁与心跳，建议进一步暴露“重试次数/失败分层原因”到观测面板，便于运维。
5. `SearchSpace` 作为租户模型已经清晰，后续若接入企业组织（Org）层，可在其上再加一层目录结构，不必推翻现有 RBAC。

---

## 8. 关键代码索引（按问题维度）

### 数据源管理与同步

- `SurfSense/surfsense_backend/app/db.py`
- `SurfSense/surfsense_backend/app/routes/search_source_connectors_routes.py`
- `SurfSense/surfsense_backend/app/tasks/celery_tasks/connector_tasks.py`
- `SurfSense/surfsense_backend/app/tasks/celery_tasks/schedule_checker_task.py`
- `SurfSense/surfsense_backend/app/tasks/celery_tasks/stale_notification_cleanup_task.py`
- `SurfSense/surfsense_backend/app/utils/indexing_locks.py`
- `SurfSense/surfsense_backend/app/utils/periodic_scheduler.py`
- `SurfSense/surfsense_backend/app/routes/documents_routes.py`
- `SurfSense/surfsense_backend/app/indexing_pipeline/indexing_pipeline_service.py`

### 检索与引用

- `SurfSense/surfsense_backend/app/retriever/chunks_hybrid_search.py`
- `SurfSense/surfsense_backend/app/retriever/documents_hybrid_search.py`
- `SurfSense/surfsense_backend/app/services/connector_service.py`
- `SurfSense/surfsense_backend/app/agents/new_chat/tools/knowledge_base.py`
- `SurfSense/surfsense_backend/app/agents/new_chat/system_prompt.py`
- `SurfSense/surfsense_backend/app/routes/documents_routes.py`
- `SurfSense/surfsense_backend/app/routes/surfsense_docs_routes.py`
- `SurfSense/surfsense_web/components/assistant-ui/markdown-text.tsx`
- `SurfSense/surfsense_web/components/assistant-ui/inline-citation.tsx`
- `SurfSense/surfsense_web/components/new-chat/source-detail-panel.tsx`

### 多智能体与能力落地

- `SurfSense/surfsense_backend/app/routes/new_chat_routes.py`
- `SurfSense/surfsense_backend/app/tasks/chat/stream_new_chat.py`
- `SurfSense/surfsense_backend/app/agents/new_chat/chat_deepagent.py`
- `SurfSense/surfsense_backend/app/agents/new_chat/tools/registry.py`
- `SurfSense/surfsense_backend/app/agents/new_chat/tools/report.py`
- `SurfSense/surfsense_backend/app/agents/new_chat/tools/podcast.py`
- `SurfSense/surfsense_backend/app/agents/new_chat/tools/video_presentation.py`
- `SurfSense/surfsense_backend/app/tasks/celery_tasks/podcast_tasks.py`
- `SurfSense/surfsense_backend/app/tasks/celery_tasks/video_presentation_tasks.py`
- `SurfSense/surfsense_backend/app/agents/podcaster/graph.py`
- `SurfSense/surfsense_backend/app/agents/video_presentation/graph.py`
- `SurfSense/surfsense_web/components/tool-ui/video-presentation/generate-video-presentation.tsx`

### 多租户与 RBAC

- `SurfSense/surfsense_backend/app/db.py`
- `SurfSense/surfsense_backend/app/utils/rbac.py`
- `SurfSense/surfsense_backend/app/routes/search_spaces_routes.py`
- `SurfSense/surfsense_backend/app/routes/rbac_routes.py`
- `SurfSense/surfsense_backend/app/routes/new_chat_routes.py`
- `SurfSense/surfsense_backend/app/services/public_chat_service.py`

---

（完）
