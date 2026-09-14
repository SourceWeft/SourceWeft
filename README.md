<div align="center">

<img width="120" height="120" src="assets/logo.svg" alt="SourceWeft" />

# SourceWeft

**Your knowledge. Agents working together.**

An open-source AI workspace where agents work together with your knowledge and tools.

Self-hostable · Multi-model · Custom skills

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

[English](README.md) | [Simplified Chinese](README.zh-CN.md)

</div>

---

**SourceWeft** brings documents, web pages, notes, and working files into one AI workspace. Connect sources such as PDFs, YouTube, Notion, Google Drive, Gmail, and Slack, then ask questions grounded in your sources and check the citations.

Agents can delegate exploration, planning, and execution, using your sources, tools, and Skills to work through a task. Turn research into reports and presentations, review the outputs, and return to saved conversations and files to keep refining the results.

Choose from supported model providers, add custom Skills to reuse your working methods, and self-host your workspace.

<p align="center"><img src="assets/chat-page.png" alt="SourceWeft interface" width="800" /></p>

---

## Use Cases

**Research briefing.** Papers, web pages, and notes -> cited research briefings with key claims, evidence, and open questions.

**Learning guide.** Course material, videos, and PDFs -> study guides, FAQs, and quiz drafts.

**Content workspace.** Product docs, web pages, and team notes -> blog drafts, launch outlines, and image Artifacts.

**Team knowledge.** Drive, Gmail, Slack, Notion, and other connected sources -> traceable answers about decisions, projects, and shared context.

---

## Why SourceWeft

**Ground work in your knowledge.** Bring files, URLs, notes, YouTube, and connected sources together. Ask across selected materials and follow citations back to the source.

**Let agents divide the work.** Agents can delegate exploration, planning, and execution to specialized subagents, then use their findings to continue the task.

**Pick up where you left off.** Return to saved conversations and working files to review, revise, and continue your work.

**Make the workspace yours.** Choose supported models, self-host your workspace, and add built-in or custom Skills for reusable methods and task guidance.

---

## How to Use

1. **Create a workspace.** Start with a personal workspace, or invite teammates into a shared workspace with roles and shared billing.

2. **Add your sources.** Upload files, paste URLs, write notes, add YouTube links, or connect tools like Notion, Google Drive, Gmail, and Slack.

3. **Let SourceWeft index them.** Sources are parsed, chunked, embedded, and made searchable with hybrid retrieval.

4. **Ask, create, and refine.** Chat with selected sources, check citations, and let agents use tools and Skills to research, create, and refine your work.

5. **Use it everywhere.** Continue from the web app, desktop app, or browser extension with your sources and team workspace in sync.

## Sandbox Execution (Alpha)

SourceWeft can optionally run approved commands in an isolated, temporary sandbox runtime. The sandbox is a scratch execution environment; SourceWeft `/work` remains the durable working-file area.

Mental model:

- `/work` is durable SourceWeft workspace storage.
- Sandbox `/workspace` is temporary and disposable.
- Selected `/work` files may be copied into sandbox `/workspace/input` or `/workspace/work` only after explicit approval.
- `/kb` source evidence is not mounted or copied directly into the sandbox.
- Commands run in the sandbox only after human approval.
- Outputs are not durable until collected back into `/work` or published through a supported artifact pipeline.
- Sandbox-generated outputs are not citable evidence unless verified against citable sources.

The sandbox provider is an operator detail; users should think in terms of an isolated temporary execution environment rather than a specific provider.

---

## Self-host with Docker

The published image runs Web, API, background jobs, PostgreSQL, Redis and a default
private S3 store. No host Node/Rust installation or image rebuild is required.

Download the chosen Release's `sourceweft-selfhost-vX.Y.Z.tar.gz` asset and follow
[the Docker installation guide](docker/README.md). The initializer generates
passwords/secrets, then Compose starts the system at `http://localhost:3000`.
Register and sign in; configure a model Provider or BYOK for chat and model indexing.

Addresses and ports are runtime configuration. Keep `.env` and data volumes when
upgrading, and use Compose from the same release as the image. The guide includes
upgrade commands and an explicit override for older fixed-name volumes.

---

## Contributing

Bug reports, feature ideas, code, and design — all welcome.  
See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

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
