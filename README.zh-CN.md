<div align="center">

<img width="120" height="120" src="assets/logo.svg" alt="SourceWeft" />

# SourceWeft

**让 Agent 协作，把你的知识用起来。**

连接知识与 Agent 协作的开源 AI 工作空间。

支持自托管 · 多模型 · 自定义 Skills

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/SourceWeft/SourceWeft?style=social)](https://github.com/SourceWeft/SourceWeft/stargazers)

[English](README.md) | [简体中文](README.zh-CN.md)

</div>

---

**SourceWeft** 将资料、文件与工具连接到同一个 AI 工作空间。让 Agent 分工研究、规划和执行，结合来源核对结果，再回到保存的对话与文件中继续推进工作。

<p align="center"><img src="assets/chat-page.png" alt="SourceWeft interface" width="800" /></p>

---

## 核心功能

- **资料与引用。** 接入 PDF、网页、笔记、YouTube、Notion、Google Drive、Gmail、Slack 等资料源。围绕选定资料提问，通过引用回到来源核对。
- **Agent 协作。** 将探索、规划和执行委派给专门的子 Agent，再结合返回的结果继续处理任务。
- **工具与 Skills。** 通过 Web 工具、MCP 集成、内置和自定义 Skills 扩展 Agent，复用工作方法。
- **创作与工作文件。** 生成报告、演示、学习指南、音频概览和图像成果。检查输出，再回到保存的对话与文件中继续完善。
- **多模型与自托管。** 选择受支持的模型 Provider，自行部署工作空间。
- **共享工作空间。** 与团队组织资料和对话，通过角色与访问控制开展协作。

可选的沙箱命令执行目前处于 **Alpha** 阶段，需要配置执行环境并获得批准。参见[执行说明](docker/sandbox-execution.zh-CN.md)。

## 使用场景

| 带入材料             | 完成工作                                   |
| -------------------- | ------------------------------------------ |
| 论文、网页和笔记     | 整理研究简报，包含关键结论、引用和待解问题 |
| 课程资料、视频和 PDF | 制作学习指南、FAQ 和测验草稿               |
| 产品文档和团队笔记   | 撰写报告、制作演示、整理博客草稿和发布材料 |
| 已连接的团队资料源   | 获取关于决策、项目和共享上下文的可追溯回答 |

## 开始使用

### Docker 自托管

从 [Releases 页面](https://github.com/SourceWeft/SourceWeft/releases) 下载 `sourceweft-selfhost-vX.Y.Z.tar.gz`，按 [Docker 安装说明](docker/README.zh-CN.md) 部署。

发布包包含 Web、API、后台任务、数据库及文件存储，不需要本机 Node/Rust 或自行构建镜像。初始化配置并启动 Compose 后，打开 `http://localhost:3000`，配置用于聊天与索引的模型 Provider 或 BYOK。

### 开始第一个任务

1. **创建工作空间**，用于个人工作或团队协作。
2. **添加资料**，上传文件、粘贴 URL、编写笔记，或连接已有工具。
3. **提问与创作**，核对引用，让 Agent 使用工具和 Skills，并在保存的对话与文件中完善结果。

可使用网页端，也可从 [Releases](https://github.com/SourceWeft/SourceWeft/releases) 获取桌面安装包。桌面端连接方式参见[桌面端说明](apps/desktop/README.zh-CN.md)。

部署配置和升级参见 [Docker 说明](docker/README.zh-CN.md)。

---

## 贡献

Bug 报告、功能建议、代码和设计——都欢迎。  
欢迎通过 [Issues](https://github.com/SourceWeft/SourceWeft/issues) 报告问题或讨论改进建议。

<a href="https://github.com/SourceWeft/SourceWeft/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=SourceWeft/SourceWeft&1=1" alt="SourceWeft contributors" />
</a>

## 社区

- 💬 **Discord** — [加入 Discord](https://discord.gg/KNqTGh2qrk)
- 🐛 **Issues** — [github.com/SourceWeft/SourceWeft/issues](https://github.com/SourceWeft/SourceWeft/issues)

## 许可证

[Apache License 2.0](LICENSE)

`enterprise/` 目录（如存在）不适用上述许可，按其独立许可证授权。具体范围见 [LICENSE](LICENSE)。

计费为可选模块：默认核心构建不运行 credits/pages 商业账本。订阅、支付和计费界面由 `enterprise/billing` 提供，见[构建与迁移说明](enterprise/billing/README.md)。
