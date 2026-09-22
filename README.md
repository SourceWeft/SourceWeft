<div align="center">

<img width="120" height="120" src="assets/logo.svg" alt="SourceWeft" />

# SourceWeft

**Your AI workstation. Built to get work done.**

Research. Plan. Create. Execute.

Bring your models, agents, knowledge, and tools together in one open-source workstation.

Put agents and specialized sub-agents to work. Expand their capabilities with a rich skill library, MCP integrations, and sandboxed execution. Pick up your work across devices, or deploy a shared workstation for your entire team.

**Your models. Your tools. Your infrastructure.**

Multi-agent & Sub-agents · Skills & MCP · Sandbox · Cross-platform · Self-hostable

[![Download macOS Apple Silicon](https://img.shields.io/badge/Download-macOS_Apple_Silicon-111111?style=for-the-badge)](https://github.com/SourceWeft/SourceWeft/releases/download/v0.3.0-rc.1/SourceWeft_0.3.0-rc.1_aarch64.dmg)
[![Download Windows x64](https://img.shields.io/badge/Download-Windows_x64-0078D4?style=for-the-badge)](https://github.com/SourceWeft/SourceWeft/releases/download/v0.3.0-rc.1/SourceWeft_0.3.0-rc.1_x64-setup.exe)
[![Download Linux x64](https://img.shields.io/badge/Download-Linux_x64-E95420?style=for-the-badge)](https://github.com/SourceWeft/SourceWeft/releases/download/v0.3.0-rc.1/SourceWeft_0.3.0-rc.1_amd64.AppImage)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

[English](README.md) | [简体中文](README.zh-CN.md)

</div>

---

**SourceWeft** connects conversations, knowledge, working files, and task execution in one workstation. Describe the work, let agents break it down and use the right tools, then review and refine what they produce. Your conversations and files stay together so each result becomes the starting point for the next task.

<p align="center"><img src="assets/chat-page.png" alt="SourceWeft interface" width="800" /></p>

---

## Features

- **Multi-agent collaboration & sub-agents.** Delegate research, exploration, planning, and execution to focused sub-agents. Bring their findings together and keep the task moving with shared working context.
- **A skill library you can build on.** Explore the [skill library](https://sourceweft.com/skills), use built-in Skills for presentations, HTML pages, images, meeting summaries, and learning, or add custom Skills to reuse your own ways of working.
- **MCP & connected tools.** Extend agents with MCP servers, web search, and web extraction. Connect external tools and services so agents can gather information and act on it within the task.
- **Sandboxed execution.** Run approved commands and process files in an isolated, temporary execution environment, then collect outputs back into your working files. Requires a configured runtime and approval; see the [execution guide](docker/sandbox-execution.md).
- **Multiple models & BYOK.** Choose supported model providers and bring your own API keys. Configure models for chat and indexing to fit your deployment.
- **Across devices & remote access.** Work through the web app or macOS, Windows, and Linux desktop clients. Access your deployed workstation remotely and return to saved conversations and files across devices.
- **Creation & working files.** Produce reports, presentations, HTML pages, learning guides, audio overviews, and images. Review results, ask for changes, and keep refining the work in the same place.
- **Knowledge & verifiable citations.** Bring in PDFs, web pages, notes, YouTube, Notion, Google Drive, Gmail, Slack, and more. Give agents the sources a task needs and follow citations back to the original material.
- **Self-hosting & team collaboration.** Deploy for yourself or your organization, manage your database and file storage, and organize shared workspaces with roles and access controls. External models and tools process the data sent to them according to your configuration.

## Use Cases

| Start with                        | Work toward                                                       |
| --------------------------------- | ----------------------------------------------------------------- |
| Papers, web pages, and notes      | Research briefings with key claims, citations, and open questions |
| Course material, videos, and PDFs | Study guides, FAQs, and quiz drafts                               |
| Product docs and team notes       | Reports, presentations, blog drafts, and launch materials         |
| Connected team sources            | Traceable answers about decisions, projects, and shared context   |

## Get Started

### Download a client

Use the download badges above for macOS (Apple Silicon), Windows (x64), or Linux (x64). They link to the published `v0.3.0-rc.1` installers. Check [Releases](https://github.com/SourceWeft/SourceWeft/releases) for other versions.

### Self-host with Docker

Download `sourceweft-selfhost-vX.Y.Z.tar.gz` from the [Releases page](https://github.com/SourceWeft/SourceWeft/releases) and follow the [Docker installation guide](docker/README.md).

The release bundle runs the web app, API, background jobs, database, and file storage without a host Node/Rust installation or image rebuild. Initialize the configuration, start Compose, then open `http://localhost:3000` and configure a model Provider or BYOK for chat and indexing.

### Start your first task

1. **Create a workspace** for yourself or your team.
2. **Add sources** by uploading files, pasting URLs, writing notes, or connecting your existing tools.
3. **Ask and create.** Check citations, let agents use tools and Skills, and refine the results in your saved conversations and files.

Use the web app, or find desktop installers in [Releases](https://github.com/SourceWeft/SourceWeft/releases). Desktop connection details are in the [desktop guide](apps/desktop/README.md).

Deployment configuration and upgrades are covered in the [Docker guide](docker/README.md).

---

## Contributing

Bug reports, feature ideas, code, and design — all welcome.  
Open an [issue](https://github.com/SourceWeft/SourceWeft/issues) to report a bug or discuss an improvement.

<a href="https://github.com/SourceWeft/SourceWeft/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=SourceWeft/SourceWeft&1=1" alt="SourceWeft contributors" />
</a>

## Community

- 💬 **Discord** — [Join our server](https://discord.gg/KNqTGh2qrk)
- 🐛 **Issues** — [github.com/SourceWeft/SourceWeft/issues](https://github.com/SourceWeft/SourceWeft/issues)

## License

[Apache License 2.0](LICENSE)

Content under `enterprise/`, if present, is excluded and governed by its separate license. See [LICENSE](LICENSE) for the scope.

Billing is optional. The default core build runs without credits/pages billing.
Commercial subscription, payment and billing UI are provided by `enterprise/billing`;
see [billing build and migration instructions](enterprise/billing/README.md).
