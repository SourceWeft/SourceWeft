# Chat Workspace 对话界面设计稿（V1）

> 目标：对外统一为 **Chat 产品**（不出现 Notebook 概念），同时保留 NotebookLM 式的来源管理、引用追溯与产物沉淀能力。

## 1. 设计结论（已对齐）

- **产品语言统一**：`Workspace / Chats / Sources / Artifacts`。
- **布局结构**：`Workspace Rail + Chat Sidebar + Chat Canvas + Context Hub`。
- **右侧 Context Hub 不放 Studio**：仅承载来源上下文能力。
- **Sources 支持多 Tab**：`Library / In Chat / Citations / Connectors`。
- **生成能力在对话内触发**：Action Chips、`/` 命令、消息后置“转化”按钮。
- **风格方向**：`Graphite + Teal`，避免和 SurfSense 视觉过近。

---

## 2. 信息架构

### 一级结构

1. **Workspace Rail**（全局）
2. **Chats Sidebar**（当前 workspace 的会话管理）
3. **Chat Canvas**（核心消息与输入）
4. **Context Hub**（来源上下文中枢）

### Context Hub 二级 Tab（Sources only）

- `Library`：来源总览（上传/搜索/筛选/状态）
- `In Chat`：当前会话已纳入上下文的来源
- `Citations`：按消息维度追溯引用片段
- `Connectors`：连接器状态、同步、报错重试

---

## 3. 布局规范（Desktop First）

## 桌面默认（1440）

- Rail：`56`
- Sidebar：`296`（可缩至 240）
- Chat Canvas：自适应（最小建议 640）
- Context Hub：`420`（阅读态可扩展至 640）
- 外边距：`8`
- 面板圆角：`12`

```txt
┌ Rail(56) ┬ Sidebar(296) ┬──────────── Chat Canvas ────────────┬ Context Hub(420) ┐
│ WS切换    │ 新建/搜索/分组   │ 顶栏: 会话标题 / 模型 / 分享            │ Tabs: Library     │
│ 全局入口  │ Shared/Private  │ 消息流: 回答/引用/工具卡               │ In Chat           │
│ 个人      │ Archived        │ 输入区: chips + @source + send         │ Citations         │
│          │ 会话管理         │ 下方: 任务状态与提示                   │ Connectors        │
└──────────┴─────────────────┴───────────────────────────────────┴──────────────────┘
```

## 中屏（1024-1279）

- Context Hub 默认折叠，点击引用或 Sources 按钮右侧滑出
- Sidebar 可一键压缩成图标 + 标题短列

## 移动端（<768）

- 单列 Chat Canvas
- Sidebar、Context Hub 都改为底部抽屉
- 输入区固定底部，来源 Chips 横向滚动

---

## 4. 视觉系统（Graphite + Teal）

## 色板（建议）

- `--bg-0`: `#0B0F14`（页面底）
- `--bg-1`: `#121821`（面板底）
- `--bg-2`: `#18212D`（悬浮/二级面板）
- `--text-1`: `#E7EDF5`（主文字）
- `--text-2`: `#A8B4C5`（次文字）
- `--accent`: `#1FB6A6`（主强调 Teal）
- `--accent-soft`: `rgba(31,182,166,0.18)`
- `--warn`: `#F4B740`
- `--danger`: `#F06464`

## 组件风格

- 边框：`1px solid rgba(255,255,255,0.08)`
- 输入框：高 `48-56`，圆角 `14`
- 消息气泡：用户 `14` 圆角，助手内容无强气泡（阅读优先）
- 动效：`160-220ms`，只用于展开/切换/状态变更

---

## 5. 对话内“生成能力”放置方案（替代 Studio）

## 入口层级

1. **输入区 Action Chips（默认可见）**
   - `总结` `提炼要点` `生成报告` `生成幻灯片` `生成脑图` `生成播客`
2. **Slash 命令（高级用户）**
   - `/report` `/slides` `/mindmap` `/podcast`
3. **消息后置转化按钮（上下文最强）**
   - `转报告` `转大纲` `转幻灯片` `保存为 Artifact`

## 任务反馈

- 任务卡以内联形式出现在消息流
- 完成后自动收录到 `Artifacts Drawer`
- 失败卡片提供 `Retry`，并提示失败原因

---

## 6. 5 张页面线框规格

## Page 01 - Chat 空态（新 Workspace）

**目标**：首次进入即理解“先加来源，再开聊”。

**区域**

- Sidebar：显示“无对话”空态 + `New Chat`
- Canvas：欢迎语 + 大输入框 + Action Chips
- Context Hub / Library：空状态 CTA（上传、连接器、网页导入）

**关键文案**

- 标题：`Start with your sources, then ask anything.`
- 输入 placeholder：`Ask about your documents, links, or connected tools...`

---

## Page 02 - 对话进行中（核心工作态）

**目标**：高效问答 + 引用可信 + 可继续转化。

**区域**

- Canvas：多轮消息、引用标记 `[1][2]`、工具结果卡
- 消息操作：复制、重试、保存为 Artifact
- 输入区：@source、chips、web 搜索开关、发送按钮

**关键交互**

- 点击 citation -> Context Hub 自动切到 `Citations` 并定位
- 回答后点击 `转报告` -> 创建任务卡 + 收录 artifacts

---

## Page 03 - 多对话管理态（Sidebar 强交互）

**目标**：高频切换对话，不丢上下文。

**Sidebar 分区**

- `Shared Chats`
- `Private Chats`
- `Archived`

**能力**

- 搜索会话、置顶、重命名、归档、删除
- 会话条目展示：标题、更新时间、来源数、未读协作标记

**状态逻辑**

- 切换会话后保留 Context Hub 当前 tab（提升连续性）

---

## Page 04 - Sources 深度操作态（Context Hub 多 Tab）

**目标**：把“来源治理”集中到右侧，避免主对话被打断。

**Tab 细节**

- `Library`：来源表格/列表、搜索、文件类型筛选、索引状态
- `In Chat`：当前对话已启用来源（支持快速移除）
- `Citations`：按消息分组，列出引用片段 + 跳转原文
- `Connectors`：连接状态、最近同步时间、错误修复入口

**关键规则**

- Library 勾选来源 -> 立即出现在 In Chat
- In Chat 移除来源 -> 下轮请求不再带入上下文

---

## Page 05 - Artifacts 抽屉态（结果沉淀）

**目标**：把生成结果集中管理，但不占用右侧来源空间。

**触发**

- 顶栏 `Artifacts` 按钮（带数量 badge）
- 消息内“保存为 Artifact”后自动弹轻提示

**内容结构**

- 时间线分组：Today / This Week / Earlier
- 类型标签：Report / Slides / Mindmap / Podcast
- 卡片动作：打开、重命名、分享、删除、重试

---

## 7. 关键交互规范

## A. 来源纳入上下文

1. 在 `Library` 选择来源
2. 来源进入 `In Chat`
3. 输入区出现来源 chips
4. 发送消息时自动带上来源 ID 列表

## B. 引用追溯

1. 回答中点击 `[n]`
2. Hub 自动切换到 `Citations`
3. 高亮片段 + 滚动定位
4. 支持“跳到原文上下文”

## C. 对话内转化

1. 用户选中消息或点击消息动作
2. 触发转化命令（报告/幻灯片/脑图/播客）
3. 生成任务以内联卡显示
4. 完成后沉淀到 Artifacts

---

## 8. 差异化策略（避免与 SurfSense 过像）

- **视觉差异**：蓝色主强调改为 Teal；降低玻璃感，提升信息密度。
- **结构差异**：右侧固定为 Sources Hub（多 tab），不混入 Studio。
- **交互差异**：生成动作主要在对话内，不靠右侧功能卡入口。
- **文案差异**：仅用 Chat 语义，不出现 Notebook 概念。

---

## 9. 设计交付清单（给 Figma）

- 页面：Page 01 ~ Page 05（对应上文）
- 组件：Rail、Sidebar、Message、Composer、Context Hub Tabs、Artifact Card
- 变量：Color / Radius / Spacing / Elevation / Motion
- 状态：Empty / Loading / Error / Running / Ready / No-result

---

## 10. 下一步实现建议（前端）

1. 先落地布局：`Rail + Sidebar + Canvas + Context Hub` 固定框架
2. 实现 Context Hub 多 tab 与 citation 联动
3. 在 Composer 接入 Action Chips 和 `/` 命令
4. 最后加 Artifacts 抽屉与任务卡统一状态
