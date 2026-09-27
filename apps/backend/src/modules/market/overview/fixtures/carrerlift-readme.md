<!--
Test fixture: a trimmed copy of README.md from
https://github.com/prakhar1605/carrerlift-mcp (commit b1c958ea511d93c56fbd1834de55562b5cd32fcb),
the repository of the MCP Registry entry io.github.prakhar1605/carrerlift.
Used only by the MCP overview unit tests.

MIT License

Copyright (c) 2026 Prakhar Pandey

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
-->
# Carrerlift MCP

Fresh Indian jobs and internships, plus international new-grad and intern roles, inside any AI assistant that speaks the [Model Context Protocol](https://modelcontextprotocol.io).

Ask Claude, ChatGPT, Cursor or VS Code things like:

- *"Find React internships in Bangalore posted this week."*
- *"Any remote data analyst roles for freshers?"*
- *"Show me ML internships in the USA at big tech companies."*

The assistant searches [carrerlift.in](https://www.carrerlift.in) live and answers with real listings, each linked to its page.

**Endpoint**

```
https://www.carrerlift.in/api/mcp
```

It's free, needs no sign-up or API key, and is read-only.

---

## Tools

| Tool | What it does |
|---|---|
| `search_jobs` | Searches live jobs and internships in India, newest first. You can filter by keywords (role, skill or company), city and type (Internship, Full-time, Full-time Internship, Apprenticeship). Returns up to 24 per page. |
| `get_job` | Returns one listing in full: the complete description, pay, and how to apply (apply link, HR email or WhatsApp, whichever the employer gave). Takes a slug or a `carrerlift.in/jobs/…` link. |
| `search_global_jobs` | Searches internships and new-grad roles abroad, mostly in the USA. The feed is merged from community-maintained GitHub job lists and refreshed a few times a day. |
| `list_job_filters` | Lists the cities and job types the Indian listings currently cover. |

Indian listings are refreshed every 30 minutes. Closed listings with an apply link are left out.

---

## Connect

### Claude (claude.ai and the desktop app)

1. Go to **Settings → Connectors → Add custom connector**.
2. Enter the name `Carrerlift` and the URL `https://www.carrerlift.in/api/mcp`.
3. Enable it in a chat from the tools menu.

### Claude Code

```bash
claude mcp add --transport http carrerlift https://www.carrerlift.in/api/mcp
```

### Cursor

Add this to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "carrerlift": {
      "url": "https://www.carrerlift.in/api/mcp"
    }
  }
}
```

---

## Details

- **Transport:** Streamable HTTP. The server is stateless and answers in JSON (no sessions, no SSE stream). `GET` returns `405`.
- **Privacy:** there's no login and no personal data. The server doesn't ask for or store anything about you. Links carry a `utm_source=mcp` tag so we can count visits that come from assistants.
- **Limits:** results are paged, and paging stops at page 20. Please use the filters instead of crawling.

## Feedback

Found a bug or have a tool request? [Open an issue](https://github.com/prakhar1605/carrerlift-mcp/issues).

## License

[MIT](LICENSE)
