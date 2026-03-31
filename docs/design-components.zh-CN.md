# SourceWeft 组件规范

> **版本**: V1  
> **更新**: 2026-03-27  
> **依赖**: shadcn/ui + Tailwind CSS v4 + 本项目 design tokens

本文档定义 SourceWeft 核心 UI 组件的视觉规范、状态规范与 Tailwind 类名约定。所有组件基于 `packages/ui/src` 内的 shadcn 组件二次封装。

---

## 1. Button（按钮）

### 变体规范

| 变体          | 背景                               | 文字                          | 边框            | 使用场景               |
| ------------- | ---------------------------------- | ----------------------------- | --------------- | ---------------------- |
| `default`     | `bg-primary` (`#09090b`/`#fafafa`) | `text-primary-foreground`     | 无              | 主操作，每区域唯一     |
| `secondary`   | `bg-secondary`                     | `text-secondary-foreground`   | `border-border` | 次级操作               |
| `outline`     | `transparent`                      | `text-foreground`             | `border-border` | 辅助操作，配合主按钮   |
| `ghost`       | `transparent`                      | `text-foreground`             | 无              | 工具栏、导航内操作     |
| `destructive` | `bg-destructive`                   | `text-destructive-foreground` | 无              | 危险操作（删除、清空） |
| `link`        | `transparent`                      | `text-foreground underline`   | 无              | 纯文字链接行为         |

### 尺寸规范

| 尺寸      | 高度    | padding-x | 字号      | 圆角         |
| --------- | ------- | --------- | --------- | ------------ |
| `sm`      | 32px    | 12px      | `text-xs` | `rounded-md` |
| `default` | 36px    | 16px      | `text-sm` | `rounded-lg` |
| `lg`      | 40px    | 24px      | `text-sm` | `rounded-lg` |
| `icon`    | 36×36px | —         | —         | `rounded-lg` |

### 状态规范

```
默认   → 标准颜色
Hover  → opacity-90（主按钮） / bg-accent（outline/ghost）
Active → opacity-80 / scale-[0.98]
Focus  → ring-2 ring-ring ring-offset-2 ring-offset-background
禁用   → opacity-50 cursor-not-allowed
加载中 → opacity-70 + 左侧 spinner icon（16px）
```

### 禁止事项

- 不使用 `rounded-full` 按钮（避免消费品感）
- 不使用 `text-800/900` 字重
- 主按钮在同一视图内不超过 1 个
- 不在按钮内使用彩色图标（保持单色）

---

## 2. Card（卡片）

### 标准卡片结构

```
Card
├── CardHeader
│   ├── CardTitle      (text-base font-semibold)
│   └── CardDescription (text-sm text-muted-foreground)
├── CardContent        (主体内容)
└── CardFooter         (操作按钮区，可选)
```

### 样式规范

| 属性    | 值                                       |
| ------- | ---------------------------------------- |
| 背景    | `bg-card`                                |
| 文字    | `text-card-foreground`                   |
| 边框    | `border border-border`                   |
| 圆角    | `rounded-lg`                             |
| padding | `p-4`（内容）/ `p-4 pb-0`（header）      |
| 阴影    | 默认无阴影，需与背景分离时用 `shadow-sm` |

### 卡片变体

**Flat Card**（默认，绝大多数场景）

```tsx
<div className="bg-card border border-border rounded-lg p-4">
```

**Elevated Card**（需要强调分离感，如弹出面板）

```tsx
<div className="bg-card border border-border rounded-xl shadow-md p-4">
```

**Interactive Card**（可点击、可 hover）

```tsx
<div className="bg-card border border-border rounded-lg p-4 cursor-pointer
                transition-colors hover:bg-accent hover:border-accent-foreground/10">
```

---

## 3. Input（输入框）

### 标准输入框

| 属性    | 值                                                |
| ------- | ------------------------------------------------- |
| 高度    | 36px（`h-9`）                                     |
| padding | `px-3 py-2`                                       |
| 背景    | `bg-background`                                   |
| 边框    | `border border-input`                             |
| 圆角    | `rounded-lg`                                      |
| 字号    | `text-sm`                                         |
| 占位色  | `placeholder:text-muted-foreground`               |
| Focus   | `focus-visible:ring-2 focus-visible:ring-ring`    |
| 禁用    | `disabled:opacity-50 disabled:cursor-not-allowed` |

### Textarea（多行输入）

- 最小高度：`min-h-[80px]`
- 可垂直调整：`resize-y`
- 其余与 Input 一致

### 大型 Composer 输入框（Chat 场景）

```tsx
<textarea
  className="w-full min-h-[52px] max-h-[240px] bg-background border border-border
             rounded-xl px-4 py-3 text-sm text-foreground
             placeholder:text-muted-foreground resize-none overflow-y-auto
             focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
/>
```

---

## 4. Badge（徽章/标签）

### 变体规范

| 变体          | 背景                | 文字                        | 使用场景        |
| ------------- | ------------------- | --------------------------- | --------------- | -------- |
| `default`     | `bg-primary`        | `text-primary-foreground`   | 状态、计数      |
| `secondary`   | `bg-secondary`      | `text-secondary-foreground` | 分类、标签      |
| `outline`     | `transparent`       | `text-foreground`           | `border-border` | 只读标签 |
| `destructive` | `bg-destructive/15` | `text-destructive`          | 错误状态        |

### 尺寸

| 属性    | 值               |
| ------- | ---------------- |
| 高度    | 20px（`h-5`）    |
| padding | `px-2`           |
| 字号    | `text-xs` (12px) |
| 字重    | `font-medium`    |
| 圆角    | `rounded-sm`     |

> Badge 不使用 `rounded-full`，与按钮保持一致的方正风格。

---

## 5. Navigation（导航）

### 5.1 Workspace Rail（最左侧工作区切换栏）

| 属性     | 值                                                                          |
| -------- | --------------------------------------------------------------------------- |
| 宽度     | 56px                                                                        |
| 背景     | `bg-sidebar`                                                                |
| 右边框   | `border-r border-sidebar-border`                                            |
| 图标尺寸 | 20×20px                                                                     |
| 图标按钮 | 40×40px，`rounded-lg`                                                       |
| 图标颜色 | `text-sidebar-foreground opacity-60`                                        |
| 激活状态 | `bg-sidebar-accent text-sidebar-accent-foreground opacity-100`              |
| Tooltip  | 右侧出现，`text-xs`，`bg-popover border border-border rounded-md px-2 py-1` |

### 5.2 Sidebar 导航项

```tsx
<a
  className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm
              text-sidebar-foreground
              hover:bg-sidebar-accent hover:text-sidebar-accent-foreground
              data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground
              transition-colors duration-150"
>
  <Icon size={16} />
  <span className="truncate">导航文字</span>
</a>
```

### 5.3 分组标题

```tsx
<div className="px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
  分组名称
</div>
```

---

## 6. Dialog / Sheet（模态框 / 抽屉）

### Dialog

| 属性     | 值                                                        |
| -------- | --------------------------------------------------------- |
| 遮罩     | `bg-black/60 backdrop-blur-sm`                            |
| 内容背景 | `bg-background`                                           |
| 边框     | `border border-border`                                    |
| 圆角     | `rounded-2xl`                                             |
| 阴影     | `shadow-xl`（`0 24px 64px rgba(0,0,0,0.20)`）             |
| 宽度     | `max-w-md`（默认），`max-w-lg`（大），`max-w-2xl`（超大） |
| padding  | `p-6`                                                     |
| 动效     | `200ms cubic-bezier(0,0,0.2,1)`                           |

### Sheet（右侧抽屉）

| 属性   | 值                                         |
| ------ | ------------------------------------------ |
| 背景   | `bg-background`                            |
| 左边框 | `border-l border-border`                   |
| 宽度   | `w-[400px]`（默认），`w-[620px]`（宽）     |
| 动效   | `240ms cubic-bezier(0.4,0,0.2,1)` 右侧滑入 |

---

## 7. Dropdown Menu / Popover（下拉 / 气泡）

| 属性           | 值                                            |
| -------------- | --------------------------------------------- |
| 背景           | `bg-popover`                                  |
| 边框           | `border border-border`                        |
| 圆角           | `rounded-xl`                                  |
| 阴影           | `shadow-lg`（`0 8px 24px rgba(0,0,0,0.12)`）  |
| 内边距         | `p-1`（菜单项之间的容器 padding）             |
| 菜单项高度     | 32px（`h-8`）                                 |
| 菜单项 padding | `px-2 py-1.5`                                 |
| 菜单项字号     | `text-sm`                                     |
| 菜单项 hover   | `bg-accent text-accent-foreground rounded-md` |
| 分隔线         | `bg-border h-px my-1`                         |

---

## 8. Tooltip

| 属性     | 值                                  |
| -------- | ----------------------------------- |
| 背景     | `bg-foreground` (黑/白，与主题反转) |
| 文字     | `text-background`                   |
| 圆角     | `rounded-md`                        |
| padding  | `px-2.5 py-1`                       |
| 字号     | `text-xs`                           |
| 最大宽度 | `max-w-[220px]`                     |
| 出现延迟 | `400ms`                             |
| 动效     | `150ms fade-in`                     |

---

## 9. Skeleton（骨架屏）

```tsx
<div
  className="bg-muted animate-pulse rounded-md"
  style={{ height: "...", width: "..." }}
/>
```

- 颜色：`bg-muted`（`#f4f4f5` light / `#27272a` dark）
- 动效：`animate-pulse`（内置 Tailwind）
- 不使用渐变扫光效果（与精密风格不符）

---

## 10. Empty State（空态）

### 结构

```
EmptyState
├── Icon（40×40px，text-muted-foreground）
├── Title（text-sm font-medium text-foreground）
├── Description（text-sm text-muted-foreground，max-w-[280px]）
└── CTA Button（可选，variant="outline"）
```

### 规范

- 居中对齐，垂直排列
- Icon 使用 outline 风格，`opacity-40`
- 文案：标题简洁（≤10字），描述引导行动
- 不使用彩色插画（保持纯黑白风格）

---

## 11. Message Bubble（消息气泡 — Chat 场景）

### 用户消息

```tsx
<div
  className="ml-auto max-w-[75%] bg-secondary text-secondary-foreground
                rounded-2xl rounded-br-sm px-4 py-3 text-sm"
>
  用户输入内容
</div>
```

### AI 回复消息

AI 消息采用**无气泡阅读优先**风格（参照 Manus / Perplexity），内容直接渲染在画布上：

```tsx
<div className="max-w-[90%] text-sm text-foreground leading-relaxed">
  {/* Markdown 渲染区 */}
</div>
```

### 引用标记

```tsx
<sup
  className="inline-flex items-center justify-center w-4 h-4 text-[10px] font-medium
                bg-secondary text-secondary-foreground rounded-sm cursor-pointer
                hover:bg-accent ml-0.5"
>
  1
</sup>
```

---

## 12. 状态指示器

### 加载状态（Spinner）

```tsx
<svg className="animate-spin h-4 w-4 text-muted-foreground" .../>
```

颜色固定为 `text-muted-foreground`，不使用彩色 spinner。

### 状态点（Status Dot）

| 状态        | 颜色                         | 大小 |
| ----------- | ---------------------------- | ---- |
| 在线 / 成功 | `bg-[#22c55e]`               | 8px  |
| 处理中      | `bg-[#f59e0b] animate-pulse` | 8px  |
| 错误        | `bg-[#ef4444]`               | 8px  |
| 离线        | `bg-muted-foreground`        | 8px  |

---

## 13. 组件使用禁忌清单

| 禁止行为                   | 原因                         |
| -------------------------- | ---------------------------- |
| `rounded-full` 按钮        | 消费品感，与精密工具风格冲突 |
| 彩色背景块（装饰）         | 破坏无彩色体系               |
| `box-shadow` 作为主要分隔  | 用 `border` 代替，更精密     |
| 大量渐变背景               | 影响内容可读性，与极简风不符 |
| `font-black`（weight 900） | 过于厚重，破坏排版平衡       |
| 多种颜色混用在同一视图     | 造成视觉噪声                 |
| 超过 2 级嵌套的阴影层      | 模糊层级关系                 |
