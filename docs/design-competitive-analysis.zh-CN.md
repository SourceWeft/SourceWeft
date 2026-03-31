# SourceWeft 竞品视觉分析

> **版本**: V1  
> **分析日期**: 2026-03-27  
> **用途**: SourceWeft 设计系统的决策依据

本文档记录对 5 款 AI 笔记/知识工具产品的视觉设计分析，提炼 SourceWeft「冷黑精密」设计方案的竞品参照依据。

---

## 分析方法

- 直接访问各产品官网及应用界面
- 提取 CSS 自定义属性（CSS Custom Properties）
- 分析 Tailwind 配置、设计 token 体系
- 观察排版、间距、组件形态、深色模式实现

---

## 1. NotebookLM

**产品地址**: notebooklm.google.com  
**归属**: Google  
**设计语言**: Material You (GM3)

### 色板

| 角色           | 颜色                  | 备注                 |
| -------------- | --------------------- | -------------------- |
| 背景（浅色）   | `#ffffff` / `#f8f8f8` | 暖白，非纯白         |
| 背景（深色）   | `#1f1f1f`             | GM3 标准深色 surface |
| 卡片面         | `#f3f3f3`, `#e9e9e9`  | 微暖灰               |
| 主文字（浅色） | `rgba(31,31,31,1)`    | 暖近黑               |
| 主文字（深色） | `rgba(227,227,227,1)` | 暖浅灰               |
| 品牌强调色     | `#1a73e8`             | Google Blue          |
| 进度条         | `#0081f2`             | 亮蓝                 |

### 字体

- **Google Sans**（专有），fallback `system-ui`
- 字重：400、500、700
- 完全遵循 GM3 字体比例系统

### 圆角

- 大量使用 `12px–28px`（GM3 高圆角策略）
- 按钮：`rounded-full`（胶囊形）

### 设计特征

- **阴影分层**：用 elevation 而非 border 区分层级
- **backdrop-filter: blur** 遮罩
- **渐变登录页**：`linear-gradient` 从 `rgba(233,233,233,0)` 到 `rgb(233,233,233)`
- **自定义插画**：Google 风格彩色 hero 插画

### SourceWeft 的借鉴与规避

| 维度   | NotebookLM     | SourceWeft 选择          |
| ------ | -------------- | ------------------------ |
| 圆角   | 超高（28px）   | 低圆角（6px），更精密    |
| 强调色 | Google Blue    | 无彩色，消除品牌色依赖   |
| 阴影   | elevation 为主 | border 为主，减少模糊感  |
| 插画   | 彩色自定义插画 | 无彩色 icon 图，内容驱动 |

---

## 2. SurfSense

**产品地址**: surfsense.net  
**定位**: 开源 AI 搜索与笔记工具  
**设计语言**: Shadcn/UI + Fumadocs + Vercel 风格

### 色板

| 角色                | Light                   | Dark                    |
| ------------------- | ----------------------- | ----------------------- |
| 背景                | `#ffffff`               | `#0a0a0a`（接近纯黑）   |
| 卡片                | `#ffffff`               | `#0a0a0a`               |
| 前景                | `#0a0a0a`               | `#fafafa`               |
| 静默背景            | `#f5f5f5`               | `#262626`               |
| 主色（interactive） | `#171717`               | `#fafafa`               |
| 边框                | `#e5e5e5`               | `#262626`               |
| 文档前景            | `#171717`               | `#e6e6e6`               |
| 文档边框            | `rgba(204,204,204,0.5)` | `rgba(102,102,102,0.2)` |

### 字体

- 主站：**Roboto**
- 文档：**Geist Sans** + **Geist Mono**（Vercel 官方字体）

### 设计特征

- **高对比单色**：最极端的黑白对比，Dark 下 `#0a0a0a` 接近绝对黑
- **无装饰**：无渐变、无彩色、无插画
- **开发者密度**：信息密集，文档驱动
- **Fumadocs 框架**：侧边栏 + TOC 文档布局

### SourceWeft 的借鉴

- ✅ 借鉴无彩色策略
- ✅ 借鉴 border 为主的层级分隔
- ✅ 借鉴 Geist/monospace 等宽字体用于代码
- ⚠️ 规避：Dark mode 过于极黑（`#0a0a0a`），SourceWeft 用 `#09090b`（来自 Zinc-950，同级但语义更明确）
- ⚠️ 规避：文档工具感太强，SourceWeft 需要更高的组件温度

---

## 3. Open Notebook

**产品地址**: open-notebook.ai / GitHub: lfnovo/open-notebook  
**定位**: 开源 NotebookLM 替代品  
**设计语言**: VitePress 默认主题

### 色板

| 角色          | Light                 | Dark                     |
| ------------- | --------------------- | ------------------------ |
| 背景          | `#ffffff`             | `#1b1b1f`                |
| 背景 alt      | `#f6f6f7`             | `#161618`                |
| 背景 elevated | `#ffffff`             | `#202127`                |
| 主文字        | `rgba(60,60,67,1)`    | `rgba(255,255,245,0.86)` |
| 次文字        | `rgba(60,60,67,0.78)` | `rgba(235,235,245,0.6)`  |
| 品牌色        | `#3451b2`（靛蓝）     | `#a8b1ff`                |
| 边框          | `#c2c2c4`             | 对应深色值               |

### 字体

- **Inter**（Google Fonts via VitePress）
- Mono: `ui-monospace`, `Menlo`, `Monaco`, `Consolas`

### 设计特征

- VitePress **股票主题**，定制化程度低
- 靛蓝强调色（学术感）
- 卡片：`8–12px` 圆角，`border + box-shadow` 悬浮效果
- hover: `translateY(-2px)` 卡片浮起效果

### SourceWeft 参照价值

- 参照价值有限（基本为框架默认样式）
- **对比启示**：不做靛蓝强调，不做悬浮卡片动效

---

## 4. YouMind

**产品地址**: youmind.ai  
**定位**: AI 学习与知识管理，面向学习者/创作者  
**设计语言**: 温暖编辑风，消费产品感

### 色板

| 角色         | 颜色                                           |
| ------------ | ---------------------------------------------- |
| 背景         | `#ffffff`                                      |
| 卡片         | `#FAFAFA`                                      |
| 移动导航     | `#F7F7F8` + `backdrop-blur`                    |
| 主文字       | CSS var `--foreground`（近黑）                 |
| 次要文字     | CSS var `--secondary-fg`（静默灰）             |
| CTA 按钮底色 | `#121213`（近黑）                              |
| CTA 边框渐变 | `linear-gradient(90deg, --color-1~5)` 虹彩渐变 |

### 字体（最丰富的字体栈）

- **Inter**：基础 UI
- **Arvo**（衬线）：大标题 "Learn smarter. Create bolder."
- **Airbnb Cereal**：导航/正文（Black/Bold/Book/Light/Medium/ExtraBold）
- **Pacifico**（手写体）：装饰性使用

### 设计特征

- `rounded-[32px]` 卡片（极高圆角，消费品感强）
- 衬线大字标题：温暖编辑气质
- **虹彩渐变 CTA**：产品视觉签名，彩色渐变边框
- 图片主导的双栏特性介绍区
- 红色 ping 动效通知点

### SourceWeft 的借鉴与规避

| 维度 | YouMind      | SourceWeft 选择             |
| ---- | ------------ | --------------------------- |
| 圆角 | `32px` 极高  | `6px` 精密低圆角            |
| 字体 | 衬线标题混排 | 单一 Inter 无衬线，减少冲突 |
| CTA  | 虹彩渐变     | 纯黑/白，无彩色             |
| 风格 | 消费产品感   | 工具软件感                  |
| 卡片 | 纯白无边框   | 有 1px border，更精密       |

---

## 5. Manus

**产品地址**: manus.im  
**定位**: AI Agent 工作台  
**设计语言**: 暖中性精工，最完整的 token 体系

### 色板（最系统化）

**Light Mode**

| Token                     | 值                 | 说明                   |
| ------------------------- | ------------------ | ---------------------- |
| `--background-gray-main`  | `#f8f8f7`          | 暖米白主背景           |
| `--background-white-main` | `#ffffff`          | 纯白表面               |
| `--background-card`       | `#fafafa`          | 卡片背景               |
| `--background-canvas-bg`  | `#f0f0ef`          | 类纸张工作区           |
| `--background-nav`        | `#ebebeb`          | 导航栏背景             |
| `--text-primary`          | `#34322d`          | 暖棕近黑（核心差异！） |
| `--text-secondary`        | `#5e5e5b`          | 暖中灰                 |
| `--text-tertiary`         | `#858481`          | 暖浅灰                 |
| `--text-blue`             | `#0081f2`          | 唯一彩色（功能蓝）     |
| `--border-main`           | `rgba(0,0,0,0.06)` | 极淡边框               |
| `--Button-primary-black`  | `#1a1a19`          | 主按钮近黑（偏暖）     |

**Dark Mode**

| Token                     | 值        |
| ------------------------- | --------- |
| `--background-gray-main`  | `#272728` |
| `--background-white-main` | `#161618` |
| `--background-card`       | `#383739` |
| `--background-nav`        | `#212122` |
| `--text-primary`          | `#dadada` |

### 阴影体系（9级）

- XS 至 L，`rgba(0,0,0,0.06)` 至 `rgba(0,0,0,0.24)`
- Inner shadow tokens（内阴影）
- Drop shadow tokens（投影）
- Highlight glow：`--shadows-highlight-1: #cce5ff`

### 字体

- 近黑文字色 `#34322d`（带暖棕），与冷黑的 `#09090b` 形成明显差异
- Logo 颜色 token = `--logo-color: #34322d`，确认品牌基调偏暖

### SourceWeft 的借鉴

- ✅ **最大借鉴来源**：分层 token 体系（background-gray / white / card / canvas 分级）
- ✅ Sidebar 独立 token 体系的思路
- ✅ 卡片与背景的色阶分离策略
- ⚠️ **关键差异**：Manus 用暖色调（`#f8f8f7`, `#34322d`），SourceWeft 选冷调（`#ffffff`, `#09090b`）
- ⚠️ Manus 保留功能蓝 `#0081f2`，SourceWeft 全色无彩（连功能色都克制）

---

## 综合对比矩阵

| 维度           | NotebookLM     | SurfSense      | Open Notebook    | YouMind            | Manus               | **SourceWeft**       |
| -------------- | -------------- | -------------- | ---------------- | ------------------ | ------------------- | -------------------- |
| 浅色背景       | 暖白 `#f8f8f8` | 纯白 `#ffffff` | 柔白 `#f6f6f7`   | 纯白 `#ffffff`     | 暖米 `#f8f8f7`      | **纯白 `#ffffff`**   |
| 深色背景       | `#1f1f1f`      | `#0a0a0a`      | `#1b1b1f`        | 无深色             | `#272728`           | **`#09090b`**        |
| 主文字（浅色） | 暖近黑         | `#0a0a0a`      | `rgba(60,60,67)` | 近黑               | 暖棕 `#34322d`      | **冷近黑 `#09090b`** |
| 强调色         | Google Blue    | 无             | 靛蓝             | 虹彩渐变           | 功能蓝              | **无（全无彩）**     |
| 圆角           | 高（28px）     | 中（6–8px）    | 中（8–12px）     | 极高（32px）       | 中（参考 Tailwind） | **低（6px）**        |
| 边框策略       | 阴影为主       | 边框为主       | 边框+阴影        | 无边框（背景区分） | 超淡边框            | **1px 边框为主**     |
| 字体           | Google Sans    | Roboto/Geist   | Inter            | Arvo+Cereal        | 系统字体            | **Inter**            |
| 风格定位       | 圆润企业       | 冷开发者       | 文档学术         | 温暖消费           | 暖专业工台          | **冷精密工具**       |

---

## 设计决策总结

SourceWeft「冷黑精密」方案的核心选择依据：

1. **纯白背景**（取自 SurfSense/YouMind）而非暖白（Manus），强化冷调
2. **Zinc 色板**而非自定义暖色（对比 Manus 的暖棕），选择 Tailwind 生态标准色
3. **全无彩色**（超越 SurfSense 的「无装饰彩色」），连功能蓝也不保留
4. **低圆角 6px**（SurfSense 水平），而非 GM3/YouMind 的高圆角
5. **1px border 为主**（对比 NotebookLM 的 elevation 阴影），视觉更精密锋利
6. **Sidebar 独立 token**（借鉴 Manus 的分层 token 策略）
