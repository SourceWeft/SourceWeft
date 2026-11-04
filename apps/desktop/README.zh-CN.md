# 桌面应用（Tauri）

[English](README.md) | [简体中文](README.zh-CN.md)

此目录包含桌面应用。

- `src/`：前端入口和桌面 Web UI 连接代码。
- `src/lib/sdk.ts`：桌面前端共享 SDK 的初始化占位代码。
- `src-tauri/`：Rust 运行时与 Tauri 配置。

桌面前端应复用 `packages/ui`（`@sourceweft/ui-web`）和 `packages/sdk`。

环境变量模板：`apps/desktop/.env.example`。

PC 工作目录、文件面板、目录选择和升级说明见 [LOCAL_FILES.md](LOCAL_FILES.md)（英文）。

Linux 本地执行（`.deb` 与 AppImage 的安装设置、沙箱运行时下载、故障排查，以及沙箱可读取的工具链）见 [LINUX_SANDBOX.md](LINUX_SANDBOX.md)（英文）。Windows 本地执行（一次性的管理员设置及移除方法、所用 shell、命令可读取和访问的范围、Schannel 限制、故障排查）见 [WINDOWS_SANDBOX.md](WINDOWS_SANDBOX.md)（英文）。
