# 桌面应用（Tauri）

[English](README.md) | [简体中文](README.zh-CN.md)

此目录包含桌面应用。

- `src/`：前端入口和桌面 Web UI 连接代码。
- `src/lib/sdk.ts`：桌面前端共享 SDK 的初始化占位代码。
- `src-tauri/`：Rust 运行时与 Tauri 配置。

桌面前端应复用 `packages/ui`（`@sourceweft/ui-web`）和 `packages/sdk`。

环境变量模板：`apps/desktop/.env.example`。

PC 工作目录、文件面板、目录选择和升级说明见 [LOCAL_FILES.md](LOCAL_FILES.md)（英文）。
