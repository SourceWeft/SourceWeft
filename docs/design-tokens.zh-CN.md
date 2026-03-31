# SourceWeft Design Tokens — CSS 变量速查表

> **版本**: V1  
> **更新**: 2026-03-27  
> **源文件**: `packages/ui/src/styles/globals.css`

所有 token 均通过 CSS 自定义属性（Custom Properties）定义，在 Tailwind 中通过 `@theme inline` 映射为工具类。

---

## 色彩 Token

### 背景与表面层

| CSS 变量       | Light     | Dark      | 说明                     |
| -------------- | --------- | --------- | ------------------------ |
| `--background` | `#ffffff` | `#09090b` | 页面主画布               |
| `--card`       | `#fafafa` | `#18181b` | 卡片、面板背景           |
| `--popover`    | `#ffffff` | `#18181b` | Popover、Dropdown 背景   |
| `--secondary`  | `#f4f4f5` | `#27272a` | 次级容器、悬浮填充       |
| `--muted`      | `#f4f4f5` | `#27272a` | 静默区域背景             |
| `--accent`     | `#f4f4f5` | `#27272a` | 强调填充（hover/active） |

### 文字色

| CSS 变量                 | Light     | Dark      | 说明                 |
| ------------------------ | --------- | --------- | -------------------- |
| `--foreground`           | `#09090b` | `#fafafa` | 主文字               |
| `--card-foreground`      | `#09090b` | `#fafafa` | 卡片内文字           |
| `--popover-foreground`   | `#09090b` | `#fafafa` | Popover 内文字       |
| `--secondary-foreground` | `#18181b` | `#fafafa` | 次级容器文字         |
| `--muted-foreground`     | `#71717a` | `#a1a1aa` | 辅助文字、描述、占位 |
| `--accent-foreground`    | `#18181b` | `#fafafa` | 强调区域文字         |

### 主色（Primary）

| CSS 变量               | Light     | Dark      | 说明                     |
| ---------------------- | --------- | --------- | ------------------------ |
| `--primary`            | `#09090b` | `#fafafa` | 主按钮背景（黑↔白翻转） |
| `--primary-foreground` | `#fafafa` | `#09090b` | 主按钮文字               |

### 危险色（Destructive）

| CSS 变量                   | Light     | Dark      | 说明         |
| -------------------------- | --------- | --------- | ------------ |
| `--destructive`            | `#ef4444` | `#f87171` | 危险操作背景 |
| `--destructive-foreground` | `#fafafa` | `#09090b` | 危险按钮文字 |

### 结构色

| CSS 变量   | Light     | Dark                     | 说明               |
| ---------- | --------- | ------------------------ | ------------------ |
| `--border` | `#e4e4e7` | `rgba(255,255,255,0.08)` | 所有分隔边框       |
| `--input`  | `#e4e4e7` | `rgba(255,255,255,0.10)` | 表单输入框边框     |
| `--ring`   | `#09090b` | `rgba(255,255,255,0.30)` | Focus outline 颜色 |

### 图表色（单色渐进）

| CSS 变量    | Light     | Dark      | Zinc 阶   |
| ----------- | --------- | --------- | --------- |
| `--chart-1` | `#18181b` | `#fafafa` | 900 / 50  |
| `--chart-2` | `#3f3f46` | `#d4d4d8` | 700 / 200 |
| `--chart-3` | `#71717a` | `#a1a1aa` | 500 / 400 |
| `--chart-4` | `#a1a1aa` | `#71717a` | 400 / 500 |
| `--chart-5` | `#d4d4d8` | `#3f3f46` | 200 / 700 |

---

## 侧边栏 Token

侧边栏单独维护一套 token，使其能在全局主题外独立调整（比如：固定深色侧边栏 + 浅色主区域的混合模式）。

| CSS 变量                       | Light     | Dark                     | 说明                     |
| ------------------------------ | --------- | ------------------------ | ------------------------ |
| `--sidebar`                    | `#f4f4f5` | `#111113`                | 侧边栏背景               |
| `--sidebar-foreground`         | `#18181b` | `#fafafa`                | 侧边栏文字               |
| `--sidebar-primary`            | `#09090b` | `#fafafa`                | 侧边栏主按钮             |
| `--sidebar-primary-foreground` | `#fafafa` | `#09090b`                | 侧边栏主按钮文字         |
| `--sidebar-accent`             | `#e4e4e7` | `#27272a`                | 侧边栏 hover/active 背景 |
| `--sidebar-accent-foreground`  | `#18181b` | `#fafafa`                | 侧边栏 active 文字       |
| `--sidebar-border`             | `#e4e4e7` | `rgba(255,255,255,0.06)` | 侧边栏分隔线             |
| `--sidebar-ring`               | `#09090b` | `rgba(255,255,255,0.30)` | 侧边栏 Focus ring        |

---

## 圆角 Token

| CSS 变量       | 计算值     | px 约等       |
| -------------- | ---------- | ------------- |
| `--radius`     | `0.375rem` | 6px（基础值） |
| `--radius-sm`  | `0.225rem` | ~3.6px        |
| `--radius-md`  | `0.300rem` | ~4.8px        |
| `--radius-lg`  | `0.375rem` | 6px           |
| `--radius-xl`  | `0.525rem` | ~8.4px        |
| `--radius-2xl` | `0.675rem` | ~10.8px       |
| `--radius-3xl` | `0.825rem` | ~13.2px       |
| `--radius-4xl` | `0.975rem` | ~15.6px       |

---

## Tailwind 工具类映射

通过 `@theme inline` 将 CSS 变量映射到 Tailwind，可直接使用以下类名：

### 背景色

```
bg-background      → var(--background)
bg-card            → var(--card)
bg-popover         → var(--popover)
bg-primary         → var(--primary)
bg-secondary       → var(--secondary)
bg-muted           → var(--muted)
bg-accent          → var(--accent)
bg-destructive     → var(--destructive)
bg-sidebar         → var(--sidebar)
```

### 文字色

```
text-foreground              → var(--foreground)
text-card-foreground         → var(--card-foreground)
text-muted-foreground        → var(--muted-foreground)
text-primary-foreground      → var(--primary-foreground)
text-secondary-foreground    → var(--secondary-foreground)
text-accent-foreground       → var(--accent-foreground)
text-destructive-foreground  → var(--destructive-foreground)
text-sidebar-foreground      → var(--sidebar-foreground)
```

### 边框色

```
border-border          → var(--border)
border-input           → var(--input)
border-sidebar-border  → var(--sidebar-border)
```

### 圆角

```
rounded-sm   → var(--radius-sm)  (~3.6px)
rounded-md   → var(--radius-md)  (~4.8px)
rounded-lg   → var(--radius-lg)  (6px) ← 标准
rounded-xl   → var(--radius-xl)  (~8.4px)
rounded-2xl  → var(--radius-2xl) (~10.8px)
rounded-3xl  → var(--radius-3xl) (~13.2px)
rounded-4xl  → var(--radius-4xl) (~15.6px)
```

---

## Zinc 扩展色阶（来自 tailwind-config）

```
--color-zinc-950  → #09090b   (最深近黑)
--color-zinc-1000 → #000000   (绝对黑，特殊场景)
```

---

## 使用示例

### 标准卡片

```tsx
<div className="bg-card text-card-foreground border border-border rounded-lg p-4">
  <h3 className="text-sm font-medium text-foreground">标题</h3>
  <p className="text-sm text-muted-foreground mt-1">描述文字</p>
</div>
```

### 主按钮

```tsx
<button
  className="bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-medium
                   hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring"
>
  确认
</button>
```

### 次级按钮

```tsx
<button
  className="bg-secondary text-secondary-foreground border border-border rounded-lg px-4 py-2 text-sm font-medium
                   hover:bg-accent"
>
  取消
</button>
```

### 输入框

```tsx
<input
  className="bg-background text-foreground border border-input rounded-lg px-3 py-2 text-sm
                  placeholder:text-muted-foreground
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
/>
```

### 侧边栏导航项

```tsx
<a
  className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-sidebar-foreground
              hover:bg-sidebar-accent hover:text-sidebar-accent-foreground
              aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground"
>
  导航项
</a>
```
