<div align="center">

<img width="120" height="120" src="assets/logo.svg" alt="SourceWeft" />

# SourceWeft

**你的 AI 工作站，让想法成为成果。**

研究、规划、创作、执行。

将模型、智能体、知识与工具汇聚到同一个开源工作站。

让多智能体与专业子 Agent 分工推进任务，通过丰富的技能库、MCP 集成与沙箱执行拓展能力。跨设备继续工作，也可以为整个团队部署一套。

**模型自己选，工具自由接，工作站自己部署。**

多智能体与子 Agent · 技能库与 MCP · 沙箱执行 · 多端支持 · 自托管

[![Download macOS Apple Silicon](https://img.shields.io/badge/Download-macOS_Apple_Silicon-111111?style=for-the-badge)](https://github.com/SourceWeft/SourceWeft/releases/download/v0.3.0-rc.1/SourceWeft_0.3.0-rc.1_aarch64.dmg)
[![Download Windows x64](https://img.shields.io/badge/Download-Windows_x64-0078D4?style=for-the-badge)](https://github.com/SourceWeft/SourceWeft/releases/download/v0.3.0-rc.1/SourceWeft_0.3.0-rc.1_x64-setup.exe)
[![Download Linux x64](https://img.shields.io/badge/Download-Linux_x64-E95420?style=for-the-badge)](https://github.com/SourceWeft/SourceWeft/releases/download/v0.3.0-rc.1/SourceWeft_0.3.0-rc.1_amd64.AppImage)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/SourceWeft/SourceWeft?style=social)](https://github.com/SourceWeft/SourceWeft/stargazers)

[English](README.md) | [简体中文](README.zh-CN.md)

</div>

---

**SourceWeft** 将对话、知识、工作文件与任务执行连接在同一个工作站中。交代你要完成的工作，让 Agent 拆解任务、调用工具，再检查并持续完善成果。对话与文件保存在一起，让每一项成果成为下一步工作的起点。

<p align="center"><img src="assets/chat-page.png" alt="SourceWeft interface" width="800" /></p>

---

## 核心功能

- **多智能体协作与子 Agent。** 将研究、探索、规划和执行委派给专门的子 Agent，结合工作上下文汇总结果，持续推进任务。
- **丰富的技能库，持续扩展的能力。** 探索[技能库](https://sourceweft.com/skills)，使用演示、HTML 页面、图像、会议纪要和学习等内置 Skills，也可以添加自定义 Skills，复用自己的工作方法。
- **MCP 与工具集成。** 通过 MCP 服务、网页搜索和内容抓取扩展 Agent，连接外部工具与服务，让信息获取和实际操作融入任务过程。
- **沙箱执行。** 在隔离的临时执行环境中运行经批准的命令、处理文件，再将输出收集回工作文件。需要配置执行环境并获得批准，参见[执行说明](docker/sandbox-execution.zh-CN.md)。
- **多模型与 BYOK。** 自由选择受支持的模型 Provider，使用自己的 API Key，按部署需要配置聊天与索引模型。
- **多端使用与远程访问。** 通过网页端或 macOS、Windows、Linux 桌面客户端开展工作。远程访问已部署的工作站，在不同设备上回到保存的对话与文件继续推进。
- **内容创作与工作文件。** 生成报告、演示、HTML 页面、学习指南、音频概览和图像。检查成果、提出修改，在同一个工作站中持续完善。
- **知识接入与来源核对。** 接入 PDF、网页、笔记、YouTube、Notion、Google Drive、Gmail、Slack 等资料源，为任务提供所需背景，通过引用回到原文核对。
- **自主部署与团队协作。** 为自己或企业部署工作站，自主管理数据库与文件存储，通过共享工作空间、角色与访问控制开展协作。外部模型与工具会根据你的配置处理发送给它们的数据。

## 使用场景

| 带入材料             | 完成工作                                   |
| -------------------- | ------------------------------------------ |
| 论文、网页和笔记     | 整理研究简报，包含关键结论、引用和待解问题 |
| 课程资料、视频和 PDF | 制作学习指南、FAQ 和测验草稿               |
| 产品文档和团队笔记   | 撰写报告、制作演示、整理博客草稿和发布材料 |
| 已连接的团队资料源   | 获取关于决策、项目和共享上下文的可追溯回答 |

## 开始使用

### 下载客户端

点击上方下载 badge，获取 macOS（Apple Silicon）、Windows（x64）或 Linux（x64）客户端。按钮指向已发布的 `v0.3.0-rc.1` 安装包，其他版本见 [Releases](https://github.com/SourceWeft/SourceWeft/releases)。

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
欢迎通过 [Issues](https://github.com/SourceWeft/SourceWeft/issues) 报告问题或讨论改进建议。Issue 与 PR 流程参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

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
