<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Icon sources

- General interface icons come from `lucide-react`; reuse its named exports instead of drawing page-local SVG replacements. Size and color may vary by context.
- Apple, Google, and GitHub brand icons come from `app/_components/brand-icons.tsx`, which re-exports the same artwork used by Better Auth web sign-in. Do not substitute Lucide's fruit Apple, an outlined GitHub icon, or a letter G.
- MCP and Skill navigation/category icons come from `app/_components/site-icons.tsx`. Skill uses BookOpen, matching the global `skill` icon. Import this module directly; do not add page-specific forwarding modules.
- Serialized tool/skill/connector icons use the shared UI `GlobalIcon` and `/public/icons/*.svg`. Reuse the existing `iconName` for the same entity; retain custom registry/provider logos for individual entries.
- SourceWeft marks and generated app/favicon assets retain their existing shared components and `scripts/generate-icons.mjs` pipeline. Distinct product wordmarks, AI product logos, charts, and user-provided logos are not interchangeable interface icons.
