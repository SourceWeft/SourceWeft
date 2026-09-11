# Files and Sources implementation plan

日期：2026-09-10；2026-09-11 更新。状态：Release A 核心实现已落地，集成验收尚未完成。

最新约束：未正式发布，不处理历史数据，不提供兼容层。以下步骤使用新的统一契约。

## 当前实现与未完成项

- Sources 选择已独立持久化并使用 revision 控制更新；默认空，不读取历史消息或旧浏览器缓存。检索和 `/kb` 读取校验当前选择版本。
- 产品名称和公开路径已统一为 Files、`/files`；旧 API 和路径不提供别名。Cloud 使用 VFS，Local 使用绑定的真实目录。
- Cloud 支持二进制对象、字节校验、覆盖冲突和上传入口；Local 支持有界分块读取和宿主文本搜索。对象存储与 WebSocket/Redis 的真实链路验收仍待完成。
- `read_document`、`search_files`、`view_image` 已接入。文档读取覆盖文本、PDF、DOCX、PPTX、XLSX、CSV；图片和 PDF 页面的像素通过模型消息中间件注入。尚未完成真实模型视觉回答验收，当前仅支持本轮主模型自身具备视觉输入能力。
- File 引用独立于 Source chunk，包含 scope、内容 hash 与定位；预览校验当前内容版本。列表搜索框明确表示名称/路径过滤，内容检索使用 `search_files`。
- 当前解析缓存仅为单轮内存缓存；计划中的宿主持久派生缓存、Cloud scope cache、独立解析策略/计费和 Office 视觉 renderer 尚未实现。Cloud sandbox 的 `collect_sandbox_outputs` 仍只收集文本，二进制采集尚待接入。
- Local readonly Sources 尚未实现。静态原生 sandbox 无法撤销旧进程已有的工作目录写权限，因此重叠目录的 Live Sources 方案尚不能交付；等待确定 Snapshot Sources 或独立只读目录的 Live Sources。
- 2026-09-11：独立 E2E 数据库已迁移至 0038，当前工作目录的测试 API/worker 已启动。真实 HTTP 的 10 项验收通过（包括 >1 MiB 对象存储字节往返、覆盖 CAS、跨对话隔离、匿名拒绝和旧接口拒绝）。
- 真实默认模型回合已验证 search_files → read_document → 带版本的 File 引用，未调用 Sources/Web。默认模型不支持视觉；首次 view_image 导致整轮 HTTP 500，修复为结构化 VISION_UNAVAILABLE 工具结果后，同模型重跑正常完成文本任务并说明图片未读取。视觉成功路径仍未验收。
- 解锁续测：新增 SOURCEWEFT_NEXT_DIST_DIR，E2E 使用 `.next/files-e2e` 与 3400 端口，保留原 3000 开发服务。当前机器的 Watchpack 事件监听发生 EMFILE/目录删除重启循环，测试进程明确采用 WATCHPACK_POLLING=1000；仍使用标准 Next/Turbopack，但默认监听稳定性尚未验收。
- 测试前端已返回 200，更新后的原生测试应用已实际显示测试账号和对话列表；构建产物与安装二进制的 Mach-O UUID 一致（E18B49CB-9227-37B0-9E2D-75ED219F61C2）。进入本地对话期间 Mac 再次锁屏，宿主状态为离线。本地 FS 传输、目录显示和预览操作仍未验收通过。
- 后续解锁续测：宿主已在线；本地 Files 列表显示完整绑定目录及新建 fixture，文本预览实际显示精确 token，图片预览实际显示红色方块和蓝色圆形；关闭预览后原列表保留。文内搜索的按钮自动化未产生命中，因同类 submit 按钮也出现 AX 点击未触发表单、键盘提交正常的现象，需用真实点击/回车进一步复核，尚未据此修改搜索实现。
- 桌面真实发送本地检索任务后，审计证明 file.list/file.grep 命中正确文件；随后通用下载路径调用 GNU realpath -m，在 macOS 返回 illegal option，整轮失败。修复为 nativeFileOperations 使用宿主受根目录限制的不可变读取快照，不经过 GNU shell 探测，仍检查字节上限、取消与会话版本。回归测试 18 项通过、1 项 Linux 专属测试跳过，backend 类型检查通过；修复已加载到测试服务，但 Mac 再次锁屏，真实回合重跑待完成。
- 最新续测：修复后的本地桌面回合已成功，回答精确 token、实际 sha256 revision 和 File 引用，检索/读取覆盖完整。预览文内搜索经回车及实际鼠标点击均显示 1/1 并高亮；此前无命中并非搜索实现错误。1048833 字节本机文件通过 UI 下载，原件及下载副本 sha256 均为 2863365348a5ef27b6035a51ff1783a1303e28f78045001face85bee49b8caae。
- 引用原文件预览发现错误的 localRequest 参数位置：signal 被当成请求体，引发 POST/Not found。已改为无请求体 GET，并在目录返回后检查取消；新增 Local 引用回归测试，组件测试 3 项与 web 类型检查通过。最终桌面复验过程中环境磁盘耗尽，随后 PostgreSQL 5432 拒绝连接且 Docker CLI 不响应；已清理本任务旧副本的约 1 GiB 可重建前端缓存，但数据库尚未恢复。此项 UI 复验和视觉成功路径仍不能标记通过。

已验证：数据库范围与约束 5 项、文件读取/图像/二进制 21 项、前端选择与引用 9 项、Agent runner/assembly/Files 132 项、VFS 26 项、sandbox 契约 12 项、原生二进制/文本搜索 3 项。PDF 测试包含实际页面渲染。此记录不是 Release A 或 Release B 验收通过声明。

设计：[Files, Sources, and scoped retrieval](../specs/2026-09-10-files-sources-retrieval-design.md)。

## 工作规则

- 按用户要求直接在本地 main 工作；不新建独立工作空间、不 push。
- 用户已授权实施。按以下依赖顺序执行，每步完成后提交自身改动。
- main 存在其他任务的 billing、preview、Hub、native chrome 等改动。开始每步前检查 diff，不覆盖、不顺带提交。
- 使用现有依赖和明确配置的服务。依赖、sandbox 或提供方缺失时报告具体阻塞；不得换模型、解析器、包管理器或测试方式掩盖失败。
- 不把“UI 已改名”“文本测试通过”或“类型检查通过”作为多模态、本机权限已完成的证据。

## 依赖与交付顺序

```text
P0 Baseline and scope inventory
  → P1 Source scope isolation
  → P2 File contracts and typed references
  → P3 Cloud binary + Local native file access
  → P4 Image reading
  → P5 Document reading and bounded search
  → P6 Citations, preview and Files UI
  → Release A acceptance
  → P7 Local read-only Sources
  → Release B acceptance and docs
```

P1 的检索边界是后续所有步骤的前置条件。P4/P5 不通过创建 Source 记录实现。P6 从 P2 开始可准备设计，但只有依赖能力通过后才能在 UI 中启用。

## P0 — 固定基线与能力清单

修改范围：验证记录，不改功能。

1. 记录 main HEAD、相关 dirty diff、已运行服务的工作目录和版本。核对正在开发的 `packages/preview`、`local-file-preview.ts`、`file-preview-dialog.tsx`，明确最终复用入口。
2. 检查 `packages/contracts`、`builtin-vfs`、`builtin-retrieval` 的注册/manifest 流程，避免新增 tool 未注册或名称重复。
3. 固定测试配置：独立账号、数据库、临时目录；不要使用开发者的其他目录。沿用已有测试授权范围，不扩大数据访问。
4. 列出 runtime 的模型能力、vision profile、parser/provider、Office renderer 和宿主传输上限；只记录非秘密诊断。
5. 收集基线测试结果。已有失败明确区分，不靠全量重装解决。

产物：验证记录中的 baseline 与 capability matrix。没有实际 renderer/vision 路径时，标记对应里程碑不能完成，其他独立步骤继续。

## P1 — Source scope isolation

重点路径：

- `apps/backend/src/modules/threads/turn/preparer.ts`
- `apps/backend/src/modules/threads/thread/repository.ts`
- `apps/backend/src/modules/sources/service.ts`
- `apps/backend/src/modules/sources/retrieval-repository.ts`
- `apps/backend/src/modules/threads/agent/turn/retrieval-runner.ts`
- `packages/builtin-retrieval/src/pipeline/prepare.ts` 及 candidate/range 查询
- `packages/contracts/src/threads.ts` 和当前 Source selection UI/state

实施：

1. 在 `threads` 增加 `source_selection_json`（revision/selectedSourceIds），独立于通用 chat preferences；使用 expected revision 更新，不以每轮历史扫描代替当前状态。
2. 区分 omitted、`[]` 和非空列表；默认空选择，不读取历史消息或浏览器旧缓存初始化。Turn 请求仅允许缩小当前选择。
3. 固定 TurnSourceScope：effectiveSourceIds、source revisions、scopeRevision。Folder 展开是权限过滤后的集合。
4. 在 retrieval、/kb read、grep、anchors、邻近片段、citation fetch 各入口检查 scope。空集合在模型/embedding 调用前返回空范围状态。
5. 模型提交的 source IDs 必须为有效集合子集；mentions 不绕过 deselection。删除/撤权立即校验，不能只依赖已准备的 turn snapshot。
6. 取消选择后的 UI 与下一轮请求保持一致，显示共享 Source 的关联来源。

测试与验收：真实数据库跨 workspace/thread 拒绝；empty/omitted/history/anchor/mention/descendant 的组合；显式清空后不调用扩大范围的查询；同名 Files 不出现在 Source hits。对应新增测试放在现有 Vitest、builtin-retrieval 测试结构中。

提交边界：scope contracts + persistence/migration + backend + selection UI + 对应测试，独立于 Files 扩展。

## P2 — File contracts and typed references

重点路径：`packages/contracts/src`、`packages/builtin-vfs/src`、`apps/backend/src/modules/threads/agent/filesystem-capabilities.ts`、`working-files-backend.ts`、`citation-registry.ts`。

实施：

1. 定义 FileRef/FileRevision/FileCapabilities/FileSearchCoverage、locator union 和 file operation error codes。新增模块采用现有 export/registry 规范。
2. 在现有文件访问模块上形成 File access service，隔离 scope authorization、backend adapter 与内容 reader。不要在调用方复制两套权限判断。
3. 将用户可见 label 定为 Files，公开路径统一为 `/files`，工具名按新能力定义，不增加旧接口别名。将“文件能被引用”和“属于 Source evidence”拆开。
4. 引用类型加入 File reference；标记必须由工具读取注册。继续拒绝工作文件内伪造的 Source citation。
5. 固定工具路由：显式 `/kb` 使用 SourceScope；当前 FS/VFS 使用 FileScope；禁止 `/` 跨挂载内容搜索。
6. 注册 `read_document`、`search_files`、`view_image`，按 capability 提供工具；尚未完成的实现不得对 Agent 宣告可用。

测试：adapter contract tests、scope spoof、cross-mount、引用注入、新 Source/Web/File citation 契约，以及 capability/prompt 一致性。此步不为新增 citation 而伪造 Source 数据。

## P3 — Cloud binary and Local native access

Cloud 重点路径：`packages/db/src/schema/threads.ts`、迁移目录、`modules/working-files/{service,repository}.ts`、`api/routes/content/working-files.ts`、对象存储现有入口。

1. 增加 payload kind/object reference/hash/revision/provenance，定义 inline text/object bytes 互斥约束；不做历史数据回填。
2. 实现上传暂存、MIME/size/hash 校验、metadata 提交与孤立对象清理。扩展通用 binary read，禁止 UTF-8 解码二进制。
3. expectedRevision 控制覆盖；冲突不自动改名或覆写。沿用文件数限制，引入公开配置的 binary 大小和空间配额。
4. 验证 Cloud sandbox 与持久 VFS 的明确传输边界，不能把 sandbox 文件误报为已持久化。

Local 重点路径：`devices/{provider,gateway,access}.ts`、`api/routes/local-devices.ts`、`apps/desktop/src-tauri/src/local_host/{files,execution,mod}.rs`、设备协议 contracts。

5. 增加 native bounded filename/text search，返回命中与覆盖；继承路径规范、ignore 规则和链接限制。
6. 单独实现 binary read session/chunks、取消、超时和 hash/revision 校验。不要直接扩大所有文本工具的返回内容。
7. 检查每个 transport 的消息限制；跨窗口 UI 如依赖已存在的主窗 relay，使用其已验证协议，不把 session/proof 复制给子窗。不顺带继续 Hub 几何/窗口修复。
8. 搜索与读取保护真实 root；文件增长、替换、硬链接、符号链接、目录重命名、特殊文件均有确定结果。

验收：相同 fixture 在 Cloud/Local 得到同样文件描述、相同字节 hash；大于 1 MiB 文件成功传输；中途修改/取消不会成功提交混合版本；其他目录和其他对话被拒绝；本地搜索不传输整个目录文件内容。

## P4 — Image reading

重点路径：新增 File image reader、`threads/turn/preparer.ts` 的图片准备逻辑、`message-image-parts.ts`、Agent tool result → model message adapter、model gateway 的 image utilities。

1. 将附件视觉流程中可复用的 capability resolution、图片校验、计费和审计抽成共享函数，不让 tool images 冒充用户重新上传的附件。
2. 实现 `view_image`：authorized bytes → format/pixel validation → optional explicit crop/normalization → true image content 或明确 vision profile。
3. 支持图像工具结果的 runtime 路径必须验证最终模型请求真的携带图像。文本 Base64、路径字符串、浏览器预览均不算视觉读取。
4. 不支持主模型视觉时，只采用预先配置且显示的 vision policy；未配置则失败。现有附件 fallback 不直接作为新 Files 工具的隐式规则。
5. File image citations 绑定 revision，审计记录模型身份、范围、结果状态，不记录完整原图/base64到普通日志。

验收：使用文件名无法推断内容的本地/Cloud 图片，确认图像实际进入模型请求，并进行一次真实视觉回答；text-only/no-vision、oversize、animated GIF、错误 MIME 和取消均有明确结果。不通过临时换模型获得通过。

## P5 — Document reading and bounded content search

重点路径：`packages/builtin-document-parsers/src`、`modules/sources/parsers/providers`、新增 File document/cache service、native host 派生缓存。

1. 抽出以 bytes/revision/options 为输入的 parser interface，Source ingestion 保留 revision/indexing 责任，File read 不依赖 sourceId。
2. 按格式返回 locator；文本读取/搜索与非文本解析分开；PDF pages、slides、paragraphs、sheet cells 不互相伪装。
3. 执行设计中的预算、continuation、partial coverage，取消搜索同时取消相关解析与暂存传输。
4. 实现 local-host 私有派生缓存及 Cloud scope cache，覆盖版本变化、LRU、撤权清理；默认使用 backend 解析 runtime，通过受限 cache RPC 将结果存回宿主，明确数据处理位置。禁止将 Local Files 全量解析结果自动写入 Source index。
5. 图表/PDF 页面视觉通过同一 `view_image` 路径；Office renderer 不存在时准确报告，不把 text-only 结果描述成完整视觉读取。
6. 配置 parser policy、数据传输说明和独立计费 intent；不能把 Files 解析调用伪装成已付费的 Source ingestion。

验收：已有 parser fixtures 中 text/scan/hybrid PDF、DOCX、PPTX、XLSX/CSV；直接读取一个 PDF 后 Source 记录数保持不变；内容搜索报告真实覆盖；外部改动导致缓存更新；无 parser/provider 时明确失败。

## P6 — Files UI, citations and Artifacts references

重点路径：`sources-hub/index.tsx`、`sources-hub/workfiles/*`、`local-files-panel.tsx`、`file-preview-dialog.tsx`、`source-preview-panel.tsx`、引用呈现/持久化 contracts、已有 preview registry。

1. 所有用户可见 Workfiles label 更新为 Files；Sources/Artifacts 保留英文。引用旧消息的原文字面不做全库替换。
2. Files 展示实际 Cloud/Local backend、真实目录/对话作用域和 capability 状态；不创建第二份目录树或将 Files 复制进 Sources。
3. Tab 内搜索明确区分名称过滤与内容搜索。Source selection、file path scope、coverage/loading/offline 状态可见。
4. 复用正在形成的共享 preview 实现，增加图片、文档定位及 `File changed since cited`。列表焦点、返回目录、取消时的迟到响应沿用已有保护。
5. Citation fetch 每次鉴权；引用类型明确显示 Sources/Files/Web 和定位；无旧原图时不展示新图替代。
6. Local Artifact 指向实际文件；原有发布/分享保持明确动作，点击预览不上传。

验收：组件测试覆盖权限和状态变化，而非重复 CSS；真实 UI 验证目录浏览、文本/图片/PDF、引用定位、搜索范围、外部修改、离线恢复和打开成果。受影响的共享文件需先与当前 diff 对齐，不覆盖并行工作。

## Release A — 集成验收与发布边界

使用独立 fixture workspace：

- 选中 Source 中放 `POLICY_SELECTED`，未选 Source 放 `POLICY_UNSELECTED`。
- 当前 Files 放 `FILES_CURRENT`，其他 thread/未授权目录放 `FILES_FORBIDDEN`。
- 放入同名不同内容的文件，以及 >1 MiB 图片、扫描 PDF、带图表 PDF、DOCX/PPTX/XLSX。

通过真实 Agent turn 检查工具 trace、有效范围、模型输入和输出引用；仅答案偶然正确不算范围验证通过。Source-only 请求不得发起 Files/Web 查询；指定文件请求不得创建 Sources；混合任务必须分别调用两条链路。

检查新建 Cloud 文本/二进制文件、新引用、本地目录绑定以及文件工具和命令共用根目录。native build 后实际重启本测试应用，确认运行二进制版本，避免只验证 Rust 源码。

Release A 完成不代表 Local Sources 已支持；UI 不显示尚未可用的 Add local source action。

## P7 — Local read-only Sources（Release B）

重点路径：Source contracts/schema、local device grants/access、Source ingestion/retrieval、`local_host/sandbox.rs` 和命令策略、Sources UI。

1. 新增 readonly Source grants，原 native picker 安全授权链复用。与 working-directory grant 权限分开，不让模型创建 grant。
2. 本地 Source metadata 关联 owner/device/grant/resource/revision；组织共享不自动授权设备。索引保存 cloud derived content，明确告知，原件不作为 Cloud Files 复制。
3. 实现受限 Source folder discovery、显式索引任务和更新 revision；索引写入保持现有原子发布规则。
4. Source 查询在使用索引前验证 grant、设备在线和版本；外部修改后旧 revision 不再作为当前答案依据。
5. 将 readonly 路径规则传入 native file tools 和真实 shell sandbox。重叠目录 readonly 优先，防止同文件别名/链接绕过。运行中的任务排空后新策略才生效。
6. 支持撤权、Source 删除、设备离线、丢失原文件和来源更新状态。无可证明 sandbox 隔离的平台不宣告支持。

验收：真实 sandbox shell 的覆写、rename、unlink、replace、链接绕过均失败；普通 Files 写入成功。撤权后历史 cache/citation fetch 拒绝；离线检索不默用索引；源更新后只返回验证过的新 revision。

## 数据结构与启用

- 按新契约修改 schema 并生成结构迁移；Source selection 默认空，不做历史回填、浏览器缓存恢复、旧引用读取或旧接口别名。
- 新功能只在依赖能力通过验证后启用。关闭功能不切换到另一个 backend，也不自动恢复旧接口。
- 不自动移动、上传或删除用户本地原件，不批量将 Files 导入 Sources。
- 清理仅限可确认的暂存对象和派生缓存。正式验收使用新建测试会话与隔离数据。

## 验证执行方式

使用工作区已安装、与 lockfile 一致的依赖，不重装：

| 位置 | 命令 |
| --- | --- |
| `apps/backend` | `./node_modules/.bin/vitest run <本步骤相关测试>`；`./node_modules/.bin/tsc --noEmit` |
| `apps/web` | `./node_modules/.bin/vitest run <本步骤相关测试>`；需要时先 `./node_modules/.bin/next typegen`，再 `./node_modules/.bin/tsc --noEmit` |
| `packages/builtin-vfs` | `./node_modules/.bin/tsx --test tests/*.test.ts`；`./node_modules/.bin/tsc --noEmit` |
| `packages/builtin-retrieval` | 同上，执行本 package 的测试 |
| `packages/builtin-document-parsers` | 同上；真实 parser/provider 验证另行记录，不能以 mock 代替 |
| repository root | `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml`；对应 `cargo check --locked` |

实际测试名在新增测试时固定到该步骤的验证记录，表中的命令参数表示只运行相关测试集合，并非调用一个不存在的脚本。数据库迁移测试仅运行独立测试 DB；native 权限必须跑真实隔离，UI 通过现有 CUA 工具操作测试应用。

文档交付只检查 Markdown、链接、代码路径、依赖顺序和 git diff，不为本次文档修改运行功能测试。

## 完成标准

Release A 和 Release B 分别满足设计中的验收条目，附带实际测试记录、未支持能力和运行版本。每个里程碑只提交其已验证的变更，不把尚未实现的工具、权限或视觉能力写成已交付。
