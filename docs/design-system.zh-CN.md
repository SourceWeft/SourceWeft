# SourceWeft 设计系统 — 「冷黑精密」

> **版本**: V1.1  
> **更新**: 2026-03-28  
> **竞品参照**: SurfSense · Linear · Vercel · Manus · NotebookLM · YouMind

---

## 1. 设计理念

### 核心主张

> **精密工具，无色干扰。**  
> SourceWeft 是一个知识工作台，界面本身应当隐退，让内容与思维成为焦点。

三个设计原则：

| 原则         | 含义                                               |
| ------------ | -------------------------------------------------- |
| **极简对比** | 黑白两极，用纯粹的明暗对比构建层次，不依赖色彩     |
| **内容优先** | 组件克制、字号准确、留白充足，阅读体验高于视觉冲击 |
| **精密边界** | 用 `1px` 边框代替阴影作为主要分隔手段，减少模糊感  |

### 竞品差异定位

| 产品       | 风格              | SourceWeft 的差异                      |
| ---------- | ----------------- | -------------------------------------- |
| SurfSense  | 冷极简，开发者向  | 相近基调，但更注重阅读态排版与组件温度 |
| Manus      | 暖纸张质感        | 我们选择冷调，更精密，更专注           |
| NotebookLM | Material You 圆润 | 我们选择方正低圆角，减少"消费品"感     |
| YouMind    | 白底编辑器        | 相似出发点，但我们无色彩点缀，更纯粹   |
| Linear     | 开发者工具精密    | 最接近的设计语言参照                   |

---

## 2. 色彩系统

### 设计决策

**全色板基于 Zinc（冷灰）色系**，所有颜色 hue = 0，chroma = 0。无任何有彩色渗入界面层（图表数据层除外）。

**为什么选 Zinc 而非纯 Gray？**  
Tailwind 的 `zinc` 比 `gray` 含有更微弱的蓝灰冷调，在屏幕显示时对比度更干净，适合长时间工作台使用。

---

### 2.1 Light Mode 色板

| 层级         | Token                      | Hex       | 用途                       |
| ------------ | -------------------------- | --------- | -------------------------- |
| **页面底**   | `--background`             | `#ffffff` | 主画布，纯白               |
| **卡片面**   | `--card`                   | `#fafafa` | 一级面板、卡片背景         |
| **次级填充** | `--secondary`              | `#f4f4f5` | 悬浮态、标签背景、次级按钮 |
| **柔和填充** | `--muted`                  | `#f4f4f5` | 占位、禁用区域             |
| **强调填充** | `--accent`                 | `#f4f4f5` | Hover/选中状态背景         |
| **边框主**   | `--border`                 | `#e4e4e7` | 所有 `1px` 分隔线          |
| **输入边框** | `--input`                  | `#e4e4e7` | 表单输入框 border          |
| —            | —                          | —         | —                          |
| **主文字**   | `--foreground`             | `#09090b` | 正文、标题                 |
| **卡片文字** | `--card-foreground`        | `#09090b` | 卡片内文字                 |
| **次要文字** | `--muted-foreground`       | `#71717a` | 副标题、描述、时间戳       |
| **次级文字** | `--secondary-foreground`   | `#18181b` | 次级按钮文字               |
| —            | —                          | —         | —                          |
| **主按钮底** | `--primary`                | `#09090b` | 黑色主按钮背景             |
| **主按钮字** | `--primary-foreground`     | `#fafafa` | 黑色按钮上的文字           |
| —            | —                          | —         | —                          |
| **危险色**   | `--destructive`            | `#ef4444` | 删除、错误状态             |
| **危险文字** | `--destructive-foreground` | `#fafafa` | 危险按钮上的文字           |
| **焦点环**   | `--ring`                   | `#09090b` | Focus outline              |

---

### 2.2 Dark Mode 色板

| 层级         | Token                  | Hex / RGBA               | 用途                   |
| ------------ | ---------------------- | ------------------------ | ---------------------- |
| **页面底**   | `--background`         | `#09090b`                | 近纯黑画布             |
| **卡片面**   | `--card`               | `#18181b`                | 一级面板，比背景亮一级 |
| **导航底**   | `--sidebar`            | `#111113`                | 比卡片更深，形成压底感 |
| **次级填充** | `--secondary`          | `#27272a`                | 悬浮、次级容器         |
| **柔和填充** | `--muted`              | `#27272a`                | 占位背景               |
| **强调填充** | `--accent`             | `#27272a`                | Hover/选中             |
| **边框主**   | `--border`             | `rgba(255,255,255,0.08)` | 毛玻璃式细线边框       |
| **输入边框** | `--input`              | `rgba(255,255,255,0.10)` | 输入框边框略深         |
| —            | —                      | —                        | —                      |
| **主文字**   | `--foreground`         | `#fafafa`                | 正文                   |
| **次要文字** | `--muted-foreground`   | `#a1a1aa`                | Zinc-400，柔和灰       |
| —            | —                      | —                        | —                      |
| **主按钮底** | `--primary`            | `#fafafa`                | 白色主按钮背景（翻转） |
| **主按钮字** | `--primary-foreground` | `#09090b`                | 白色按钮上的黑字       |
| —            | —                      | —                        | —                      |
| **危险色**   | `--destructive`        | `#f87171`                | 暗色下稍亮的红         |
| **焦点环**   | `--ring`               | `rgba(255,255,255,0.30)` | 柔和的白色焦点环       |

---

### 2.3 图表色阶（单色渐进）

图表层面保持黑白灰单色体系，用明度差异区分数据序列。

| 名称    | Light     | Dark      | Zinc 阶        |
| ------- | --------- | --------- | -------------- |
| chart-1 | `#18181b` | `#fafafa` | Zinc-900 / 50  |
| chart-2 | `#3f3f46` | `#d4d4d8` | Zinc-700 / 200 |
| chart-3 | `#71717a` | `#a1a1aa` | Zinc-500 / 400 |
| chart-4 | `#a1a1aa` | `#71717a` | Zinc-400 / 500 |
| chart-5 | `#d4d4d8` | `#3f3f46` | Zinc-200 / 700 |

> 如需数据可视化使用彩色，请单独建立 data-viz token，不影响界面层色板。

---

### 2.4 功能状态色

状态色仅用于功能语义，不用于装饰。

| 状态                | Light     | Dark      |
| ------------------- | --------- | --------- |
| Success             | `#22c55e` | `#4ade80` |
| Warning             | `#f59e0b` | `#fbbf24` |
| Error / Destructive | `#ef4444` | `#f87171` |
| Info                | `#3b82f6` | `#60a5fa` |

---

## 3. 圆角系统

基础值 `--radius: 0.375rem`（6px）。比默认 shadcn 的 `0.625rem` 更方正，强化精密工具感。

| Token          | 计算值     | px 约等 | 典型使用                   |
| -------------- | ---------- | ------- | -------------------------- |
| `--radius-sm`  | `0.225rem` | 3.6px   | 徽章、小标签、tooltip      |
| `--radius-md`  | `0.300rem` | 4.8px   | 输入框内部元素             |
| `--radius-lg`  | `0.375rem` | 6px     | **标准容器，卡片，输入框** |
| `--radius-xl`  | `0.525rem` | 8.4px   | 下拉菜单、popover          |
| `--radius-2xl` | `0.675rem` | 10.8px  | 模态框，抽屉               |
| `--radius-3xl` | `0.825rem` | 13.2px  | 大面板                     |
| `--radius-4xl` | `0.975rem` | 15.6px  | 全屏侧边栏顶部区域         |

> 按钮使用 `--radius-lg`，不使用 `rounded-full`（避免消费产品感）。

---

## 4. 阴影系统

「冷黑精密」风格以**边框**为主要分隔手段，**最小化阴影使用**。

| 级别         | CSS 值                         | 使用场景                       |
| ------------ | ------------------------------ | ------------------------------ |
| **无阴影**   | `none`                         | 绝大多数卡片（用 border 代替） |
| **悬浮阴影** | `0 1px 3px rgba(0,0,0,0.08)`   | 悬浮按钮、工具条               |
| **卡片阴影** | `0 2px 8px rgba(0,0,0,0.06)`   | 需要与背景分离的白卡片         |
| **浮层阴影** | `0 8px 24px rgba(0,0,0,0.12)`  | Popover、Dropdown、Command     |
| **模态阴影** | `0 24px 64px rgba(0,0,0,0.20)` | Dialog、Sheet                  |

Dark mode 下阴影乘数 ×1.5（深色背景下阴影更难察觉）。

---

## 5. 字体系统

### 5.1 字体栈

```css
/* 界面字体 — 优先系统字体，降低加载成本 */
font-family:
  "Inter",
  ui-sans-serif,
  system-ui,
  -apple-system,
  BlinkMacSystemFont,
  "Segoe UI",
  sans-serif;

/* 等宽字体 — 代码、命令、路径 */
font-family:
  "Geist Mono", ui-monospace, "Fira Code", "Cascadia Code", Menlo, Monaco,
  Consolas, monospace;
```

> 如需引入 Inter，建议通过 `next/font` 本地化加载，避免 FOUT。

---

### 5.2 字号阶梯（Type Scale）

基于 `16px` 基准，1.25 比例递进（Major Third）。

| 名称        | 大小 | 行高 | 字重    | 用途                     |
| ----------- | ---- | ---- | ------- | ------------------------ |
| `text-xs`   | 12px | 1.5  | 400     | 标签、时间戳、tooltip    |
| `text-sm`   | 14px | 1.5  | 400/500 | 次要正文、表格行、描述   |
| `text-base` | 16px | 1.6  | 400     | **主正文**               |
| `text-lg`   | 18px | 1.5  | 500     | 卡片标题、section 小标题 |
| `text-xl`   | 20px | 1.4  | 600     | 页面副标题               |
| `text-2xl`  | 24px | 1.3  | 600/700 | 页面主标题               |
| `text-3xl`  | 30px | 1.2  | 700     | 大标题，空态欢迎语       |
| `text-4xl`  | 36px | 1.2  | 700     | Landing / Hero（营销页） |

### 5.3 字重使用原则

- `400` — 正文、描述
- `500` — 导航项、按钮（非主按钮）、表格列头
- `600` — 卡片标题、小节标题
- `700` — 页面标题、空态大字
- **禁止** 使用 `800/900`（与冷精密风格不符）

---

## 6. 间距系统

基于 `4px` 基础单元（Tailwind 默认）。

| Token      | px   | 典型使用                   |
| ---------- | ---- | -------------------------- |
| `space-1`  | 4px  | 图标与文字间距             |
| `space-2`  | 8px  | 标签内 padding、小按钮 gap |
| `space-3`  | 12px | 列表项 padding-y           |
| `space-4`  | 16px | **卡片内标准 padding**     |
| `space-5`  | 20px | 输入框 padding-y（较高）   |
| `space-6`  | 24px | 卡片之间的 gap             |
| `space-8`  | 32px | 区块间距                   |
| `space-10` | 40px | 大区块分隔                 |
| `space-12` | 48px | 页面顶部 padding           |
| `space-16` | 64px | Landing 区块间距           |

---

## 7. 动效规范

「冷黑精密」不做炫技动效，只做**功能性过渡**。

| 场景              | 时长    | Easing                      |
| ----------------- | ------- | --------------------------- |
| 颜色/透明度变化   | `150ms` | `ease-out`                  |
| 展开/收起（高度） | `200ms` | `cubic-bezier(0.4,0,0.2,1)` |
| 侧边栏滑出        | `240ms` | `cubic-bezier(0.4,0,0.2,1)` |
| 模态框出现        | `200ms` | `cubic-bezier(0,0,0.2,1)`   |
| 页面转场          | `180ms` | `ease-in-out`               |

**禁止**：弹簧动效、旋转入场、视差滚动（影响信息密度感知）。

---

## 8. 布局框架

沿用 Chat Workspace 布局（详见 `chat-workspace-ui-design.zh-CN.md`），在此补充本设计系统下的具体数值。

| 区域           | 宽度                     | 背景 Token     | 边框                        |
| -------------- | ------------------------ | -------------- | --------------------------- |
| Workspace Rail | 56px                     | `--sidebar`    | 右侧 `1px --sidebar-border` |
| Chat Sidebar   | 280px（可缩至 240px）    | `--sidebar`    | 右侧 `1px --border`         |
| Chat Canvas    | 自适应                   | `--background` | 无                          |
| Context Hub    | 400px（可扩至 620px）    | `--card`       | 左侧 `1px --border`         |
| 面板圆角       | `--radius-3xl`（13.2px） | —              | —                           |
| 外边距         | 8px                      | —              | —                           |

---

## 9. 无障碍（Accessibility）

| 要求                    | 实现                                                   |
| ----------------------- | ------------------------------------------------------ |
| 对比度 WCAG AA          | `--foreground #09090b` 在 `#ffffff` 上：21:1 ✅        |
| 对比度 WCAG AA（Muted） | `--muted-foreground #71717a` 在 `#ffffff` 上：4.6:1 ✅ |
| Focus 可见              | `outline: 2px solid var(--ring); outline-offset: 2px`  |
| 禁用状态                | 透明度 `opacity-50`，不仅依赖颜色区分                  |
| 最小触控区域            | 44×44px（移动端）                                      |

---

## 10. 使用指南

### 在 Tailwind 中使用 Token

所有 token 通过 shadcn 约定的语义类名使用：

```tsx
// 正确 — 使用语义 token
<div className="bg-background text-foreground border-border">
<button className="bg-primary text-primary-foreground">

// 避免 — 直接使用 Zinc 固定值（破坏 dark mode 自动切换）
<div className="bg-zinc-950 text-zinc-50">
```

### Dark Mode 切换

项目使用 `.dark` class 切换（shadcn 标准），通过 `next-themes` 管理。  
`ThemeProvider` 已在 `apps/web/app/providers.tsx` 中全局注册，`defaultTheme="system"` 跟随系统偏好。

```tsx
// 在组件中使用切换按钮
import { useTheme } from "next-themes";
const { theme, setTheme } = useTheme();
setTheme("dark"); // 强制深色
setTheme("light"); // 强制浅色
setTheme("system"); // 跟随系统
```

Navbar 的 `ThemeToggle` 组件位于 `apps/web/app/_landing/v1/theme-toggle.tsx`，点击在 `light` 和 `dark` 之间切换，渲染太阳/月亮图标。组件内部延迟 `mounted` 以避免 hydration mismatch。

**关键配置**

| 配置项                      | 值         | 说明                         |
| --------------------------- | ---------- | ---------------------------- |
| `attribute`                 | `"class"`  | 在 `<html>` 加 `.dark` class |
| `defaultTheme`              | `"system"` | 默认跟随 OS 深浅色偏好       |
| `enableSystem`              | `true`     | 允许 system 选项             |
| `disableTransitionOnChange` | `true`     | 切换时禁止过渡，避免闪烁     |

`layout.tsx` 的 `<html>` 需加 `suppressHydrationWarning`，防止服务端/客户端 class 不一致报错。

### Landing Page 双主题适配规范

Landing Page 完全跟随主题切换，不再使用硬编码的 `bg-[#09090b] text-white`。

**根节点**

```tsx
// 正确 — 跟随 CSS 变量自动切换
<div className="min-h-screen bg-background text-foreground">

// 错误 — 硬编码强制深色，切换主题无效
<div className="min-h-screen bg-[#09090b] text-white">
```

**颜色写法模式**

所有 Landing Page 颜色使用 `浅色优先 + dark:深色覆盖` 模式：

```tsx
// 文字
className = "text-zinc-900 dark:text-white"; // 主标题
className = "text-zinc-500 dark:text-zinc-400"; // 描述文字
className = "text-zinc-400 dark:text-zinc-600"; // 次要/注脚

// 背景
className = "bg-white dark:bg-zinc-900/80"; // 卡片
className = "bg-zinc-50 dark:bg-zinc-900/40"; // 次级面板
className = "bg-zinc-100 dark:bg-zinc-700/80"; // 用户消息气泡

// 边框
className = "border-zinc-200 dark:border-white/8"; // 标准边框
className = "border-zinc-200/80 dark:border-white/[0.06]"; // 微弱分隔线

// 按钮
className =
  "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100";
```

**Navbar 毛玻璃效果**

```tsx
className =
  "border-zinc-200/80 bg-white/85 backdrop-blur-[12px] dark:border-white/[0.06] dark:bg-zinc-950/85";
```

### 新增颜色的原则

1. **优先扩展灰度**，不引入新的 hue
2. 如确实需要功能色（如状态指示），加入 `功能状态色` 区块，并记录使用场景
3. **不在界面层引入彩色装饰**（渐变、彩色背景块等）

---

## 11. 文件关联

| 文件                                         | 说明                              |
| -------------------------------------------- | --------------------------------- |
| `packages/ui/src/styles/globals.css`         | CSS 变量定义，本文档的实现文件    |
| `packages/tailwind-config/shared-styles.css` | 扩展 Zinc 色阶 token              |
| `apps/web/app/globals.css`                   | Web 端 body 基础样式              |
| `apps/web/app/providers.tsx`                 | ThemeProvider 全局注册            |
| `apps/web/app/layout.tsx`                    | `<html suppressHydrationWarning>` |
| `apps/web/app/_landing/v1/theme-toggle.tsx`  | Navbar 主题切换按钮组件           |
| `apps/web/app/_landing/v1/index.tsx`         | Landing Page 双主题实现           |
| `apps/web/app/auth/[path]/page.tsx`          | 登录页 `bg-background` 统一       |
| `docs/design-tokens.zh-CN.md`                | 所有 CSS 变量完整速查表           |
| `docs/design-components.zh-CN.md`            | 基于本系统的组件规范              |
| `docs/design-competitive-analysis.zh-CN.md`  | 竞品分析原始数据                  |
