<div align="center">

<img width="120" height="120" src="assets/logo.svg" alt="SourceWeft" />

# SourceWeft

**Your knowledge. Agents working together.**

An open-source AI workspace where agents work together with your knowledge and tools.

Self-hostable · Multi-model · Custom skills

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

[English](README.md) | [简体中文](README.zh-CN.md)

</div>

---

**SourceWeft** connects your sources, files, and tools in one AI workspace. Let agents divide up research, planning, and execution, check the results against your sources, and return to saved conversations and files to keep work moving.

<p align="center"><img src="assets/chat-page.png" alt="SourceWeft interface" width="800" /></p>

---

## Features

- **Knowledge & citations.** Connect PDFs, web pages, notes, YouTube, Notion, Google Drive, Gmail, Slack, and more. Ask across selected sources and follow citations back to the evidence.
- **Agent collaboration.** Delegate exploration, planning, and execution to specialized subagents, then use their findings to continue the task.
- **Tools & Skills.** Extend agents with web tools, MCP integrations, and reusable built-in or custom Skills.
- **Creation & working files.** Create reports, presentations, learning guides, audio overviews, and image artifacts. Review outputs and return to saved conversations and files to keep refining them.
- **Models & self-hosting.** Choose supported model providers and deploy your own workspace.
- **Shared workspaces.** Organize sources and conversations with your team, with roles and access control.

Optional sandbox command execution is **Alpha** and requires a configured runtime and approval. See [execution details](docker/sandbox-execution.md).

## Use Cases

| Start with                        | Work toward                                                       |
| --------------------------------- | ----------------------------------------------------------------- |
| Papers, web pages, and notes      | Research briefings with key claims, citations, and open questions |
| Course material, videos, and PDFs | Study guides, FAQs, and quiz drafts                               |
| Product docs and team notes       | Reports, presentations, blog drafts, and launch materials         |
| Connected team sources            | Traceable answers about decisions, projects, and shared context   |

## Get Started

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
