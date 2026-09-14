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

**SourceWeft** 将文档、网页、笔记和工作文件组织在同一个 AI 工作空间。你可以接入 PDF、YouTube、Notion、Google Drive、Gmail、Slack 等资料源，基于选定资料提问，并通过引用核对出处。

Agent 可以分工探索、规划和执行，结合你的资料、工具与 Skills 处理任务。从研究到报告和演示，检查成果后，再回到保存的对话与文件中继续修改完善。

支持多模型选择，通过内置和自定义 Skills 复用工作方法，也可以自行部署整个工作空间。

<p align="center"><img src="assets/chat-page.png" alt="SourceWeft interface" width="800" /></p>

---

## 使用场景

**研究简报。** 论文、网页和笔记 -> 带引用的研究简报，包含关键结论、证据和开放问题。

**学习指南。** 课程资料、视频和 PDF -> 学习指南、FAQ 和测验草稿。

**内容工作区。** 产品文档、网页和团队资料 -> 博客草稿、发布大纲和图像 Artifacts。

**团队知识。** Drive、Gmail、Slack、Notion 等连接资料源 -> 关于历史决策、项目上下文和共享知识的可追溯回答。

---

## 为什么选择 SourceWeft

**基于你的知识工作。** 汇聚文件、URL、笔记、YouTube 和连接资料源。围绕选定材料提问，通过引用回到来源核对。

**让 Agent 分工处理。** Agent 可以将探索、规划和执行委派给专门的子 Agent，再结合返回的结果继续处理任务。

**接着上次的工作继续。** 回到保存的对话和工作文件，检查结果、修改内容并继续推进。

**按你的方式工作。** 选择受支持的模型、自托管工作空间，通过内置或自定义 Skills 复用工作方法与任务指导。

---

## 如何使用

1. **创建工作空间。** 从个人工作空间开始，也可以邀请团队成员进入共享工作空间，配置角色和共享计费。

2. **添加你的资料。** 上传文件、粘贴 URL、编写笔记、添加 YouTube 链接，或连接 Notion、Google Drive、Gmail、Slack 等工具。

3. **让 SourceWeft 完成索引。** 资料会被解析、切分、向量化，并通过混合检索变成可搜索的知识库。

4. **提问、创作、持续迭代。** 基于选定资料对话、核对引用，让 Agent 借助工具和 Skills 开展研究、创作内容并完善成果。

5. **随处继续。** 在网页端、桌面端或浏览器扩展中继续使用，同步你的资料、上下文和团队工作空间。

---

## Docker 自托管

使用发布镜像即可启动 Web、API、后台任务、数据库及默认文件存储，不需要本机 Node/Rust 或自行构建。

下载所选 Release 的 `sourceweft-selfhost-vX.Y.Z.tar.gz` 并解压，按 [Docker 安装说明](docker/README.zh-CN.md) 运行配置初始化和 Compose 启动命令。
初始化自动生成密码/密钥；随后打开 `http://localhost:3000` 注册登录。聊天与模型索引需要显式配置模型 Provider 或 BYOK。

地址和端口可以在运行时修改，不需要重新构建镜像。升级时保留 `.env` 和数据卷，使用与镜像同版本的 Compose；详见安装说明中的升级与旧卷迁移步骤。

---

## 贡献

Bug 报告、功能建议、代码和设计——都欢迎。  
参见 [CONTRIBUTING.md](CONTRIBUTING.md) 开始。

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
