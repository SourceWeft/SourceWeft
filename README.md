<div align="center">

<img width="120" height="120" src="assets/logo.svg" alt="SourceWeft" />

# SourceWeft

**Open-source NotebookLM alternative: connect your sources, ask grounded questions, generate cited outputs, and extend deep knowledge work with Virtual FS and extensible Skills.**

Self-hosted and multi-model, with files, web pages, notes, YouTube, and SaaS connectors so teams stay in control of their data, models, and knowledge work.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

[English](README.md) | [简体中文](README.zh-CN.md)

</div>

---

**SourceWeft** is an open-source NotebookLM alternative for deep knowledge work. Connect PDFs, web pages, notes, YouTube, Notion, Google Drive, Gmail, Slack, and more into one organized source space, then ask questions with answers grounded in verifiable citations.

Beyond Q&A, SourceWeft helps you create study guides, FAQs, timelines, research briefings, drafts, audio overviews, image artifacts, and other knowledge outputs. Virtual FS, built-in Skills, custom Skills, web tools, and working files give agents the context and tools to read, search, create, organize, and refine work across your sources.

<p align="center"><img src="assets/chat-page.png" alt="SourceWeft interface" width="800" /></p>

---

## Use Cases

**Research briefing.** Papers, web pages, and notes -> cited research briefings with key claims, evidence, and open questions.

**Learning guide.** Course material, videos, and PDFs -> study guides, FAQs, and quiz drafts.

**Content workspace.** Product docs, web pages, and team notes -> blog drafts, launch outlines, and image Artifacts.

**Team knowledge.** Drive, Gmail, Slack, Notion, and other connected sources -> traceable answers about decisions, projects, and shared context.

---

## Why SourceWeft

**Connect all your sources.** Work across files, URLs, notes, YouTube, source trees, and SaaS connectors.

**Ground every answer.** Ask across selected sources and get cited, verifiable responses.

**Give agents a real workspace.** Virtual FS organizes sources, working files, Artifacts, and Skill instructions into navigable context.

**Extend agents with Skills.** Built-in and custom Skills add reusable domain methods, slash commands, tool defaults, and task-specific guidance.

Self-host SourceWeft, use your own models for chat, embeddings, rerank, image, and audio, and share workspaces with your team.

---

## How to Use

1. **Create a workspace.** Start with a personal workspace, or invite teammates into a shared workspace with roles and shared billing.

2. **Add your sources.** Upload files, paste URLs, write notes, add YouTube links, or connect tools like Notion, Google Drive, Gmail, and Slack.

3. **Let SourceWeft index them.** Sources are parsed, chunked, embedded, and made searchable with hybrid retrieval.

4. **Ask, create, and refine.** Chat with selected sources, generate cited outputs, use Skills, search the web, create Artifacts, and keep working from the same context.

5. **Use it everywhere.** Continue from the web app, desktop app, or browser extension with your sources and team workspace in sync.

---

## Self-host with Docker

Use Docker Compose when you want to run SourceWeft from the published container image.

```bash
git clone https://github.com/SourceWeft/SourceWeft.git
cd SourceWeft
cp docker/.env.example docker/.env
# Edit docker/.env — set MODEL_GATEWAY_ENCRYPTION_SECRET and at least one provider key
docker compose -f docker/docker-compose.yml up -d
```

Open **http://localhost:3000**, sign up, and start.

---

## Contributing

Bug reports, feature ideas, code, and design — all welcome.  
See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

<a href="https://github.com/SourceWeft/SourceWeft/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=SourceWeft/SourceWeft" />
</a>

## Community

- 💬 **Discord** — [Join our server](https://discord.gg/KNqTGh2qrk)
- 🐛 **Issues** — [github.com/SourceWeft/SourceWeft/issues](https://github.com/SourceWeft/SourceWeft/issues)

## License

[Apache License 2.0](LICENSE)
