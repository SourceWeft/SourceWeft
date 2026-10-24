import type { ParsedTool, StaticParseResult } from "../types";
import {
  mcpCategoryDefinitions,
  normalizeMcpCategorySlug,
} from "../taxonomy";
export {
  getMcpCategoryDefinition,
  mcpCategoryDefinitions,
  mcpTaxonomyVersion,
  nonCategorySlugs,
  normalizeMcpCategorySlug,
  sourceMarketSlugs,
  type McpCategoryDefinition,
} from "../taxonomy";

const categoryKeywords = new Map<string, RegExp[]>([
  [
    "developer-tools",
    [
      /\b(api|sdk|code|coding|developer|development|github|gitlab|git|repo|repository|issue|pull request|commit|ci|cd|ide|vscode|xcode|lint|debug|terminal|shell|cli)\b/,
      /\b(playwright|puppeteer|selenium|unit test|integration test|devtools)\b/,
    ],
  ],
  [
    "browser-automation",
    [/\b(browser|chrome|chromium|playwright|puppeteer|selenium|screenshot|web automation|dom|page testing|browser testing)\b/],
  ],
  [
    "web-search-scraping",
    [/\b(search|scrape|scraping|crawl|crawler|fetch|extract|firecrawl|tavily|exa|serp|web search|news|rss|page content|website)\b/],
  ],
  [
    "data-analytics",
    [/\b(data|analytics|analysis|chart|visualization|dashboard|etl|csv|spreadsheet|excel|dataframe|warehouse|dbt|metrics|report|notebook)\b/],
  ],
  [
    "databases",
    [/\b(database|postgres|postgresql|mysql|sqlite|mongodb|redis|clickhouse|supabase|sql|vector database|qdrant|pinecone|milvus|neo4j|duckdb)\b/],
  ],
  [
    "files-storage",
    [/\b(file|filesystem|folder|directory|drive|s3|storage|document|pdf|docx|dropbox|google drive|box|object storage|blob|minio|obsidian)\b/],
  ],
  [
    "knowledge-memory",
    [/\b(knowledge|memory|docs|documentation|rag|context|context7|wiki|semantic|retrieval|paper|papers|arxiv|academic|research|learning)\b/],
  ],
  [
    "productivity-workflow",
    [/\b(task|todo|calendar|schedule|workflow|automation|note|notes|project management|asana|trello|notion|reminder|zapier)\b/],
  ],
  [
    "communication-collaboration",
    [/\b(email|mail|slack|discord|telegram|chat|message|meeting|teams|zoom|twilio|whatsapp|sms|collaboration|confluence|jira|linear|social|twitter|x\.com|linkedin|reddit)\b/],
  ],
  [
    "business-commerce",
    [/\b(crm|sales|stripe|shopify|commerce|ecommerce|marketing|customer|zendesk|hubspot|salesforce|payment|invoice|order|product|inventory|ads|campaign|support)\b/],
  ],
  [
    "cloud-infrastructure",
    [/\b(cloud|aws|azure|gcp|cloudflare|kubernetes|k8s|docker|container|deploy|deployment|devops|terraform|network|server|hosting|vercel|netlify|lambda|virtualization|vm)\b/],
  ],
  [
    "security-monitoring",
    [/\b(security|secret|vulnerability|auth|oauth|identity|compliance|scanner|testing|validate|monitor|monitoring|observability|logs?|metrics?|traces?|alerts?|sentry|prometheus|grafana)\b/],
  ],
  [
    "finance",
    [/\b(finance|financial|stock|stocks|market data|trading|crypto|bitcoin|accounting|ledger|bank|banking|portfolio|quote|quotes)\b/],
  ],
  [
    "media-design",
    [/\b(image|video|audio|media|design|figma|canva|blender|3d|music|tts|speech|canvas|stable diffusion|creative|thumbnail)\b/],
  ],
  [
    "location-lifestyle",
    [/\b(location|map|maps|geo|geocode|weather|travel|transport|flight|hotel|health|medical|wellness|fitness|nutrition|restaurant|local|places?|poi)\b/],
  ],
  [
    "ai-ml",
    [/\b(ai|ml|llm|model|embedding|agent|openai|anthropic|ollama|huggingface|inference|langchain|llama|gemini|claude|deepseek|machine learning)\b/],
  ],
]);

function toolText(tools: ParsedTool[]) {
  return tools
    .flatMap((tool) => [tool.name, tool.title, tool.description])
    .filter(Boolean)
    .join(" ");
}

/**
 * Keywords that appear in far too many descriptions to place a server on
 * their own: "server", "api", "search", "file", "data"… One of them is not
 * evidence of a category; two different ones are. Anything not listed here
 * (a product or technology name: postgres, slack, playwright) is specific
 * enough to count alone.
 */
const weakKeywords = new Set([
  "api", "sdk", "code", "coding", "developer", "development", "issue", "commit",
  "ci", "cd", "ide", "debug", "terminal", "shell", "cli", "git", "github",
  "gitlab", "repo", "repository", "dom", "fetch", "extract", "search", "news",
  "website", "data", "analysis", "report", "metrics", "metric", "notebook",
  "dashboard", "chart", "file", "folder", "directory", "drive", "storage",
  "document", "box", "knowledge", "memory", "docs", "documentation", "context",
  "wiki", "semantic", "research", "learning", "paper", "papers", "task", "todo",
  "note", "notes", "schedule", "workflow", "automation", "reminder", "email",
  "mail", "chat", "message", "meeting", "teams", "social", "collaboration",
  "customer", "product", "order", "support", "marketing", "ads", "payment",
  "cloud", "server", "network", "deploy", "deployment", "container", "hosting",
  "vm", "security", "auth", "identity", "testing", "validate", "monitor",
  "monitoring", "log", "logs", "trace", "traces", "alert", "alerts", "quote",
  "quotes", "bank", "image", "video", "audio", "media", "design", "music",
  "canvas", "creative", "location", "map", "maps", "local", "health", "place",
  "places", "ai", "ml", "model", "agent", "claude", "gemini", "inference",
  "embedding", "page content", "project management", "web search",
  "machine learning", "geo",
]);

/** Fewer words than this say too little to file a server anywhere. */
const MIN_CLASSIFIABLE_WORDS = 5;

function categoryEvidence(patterns: RegExp[], haystack: string) {
  const strong = new Set<string>();
  const weak = new Set<string>();
  for (const pattern of patterns) {
    const global = new RegExp(pattern.source, "g");
    for (const match of haystack.matchAll(global)) {
      const keyword = (match[1] ?? match[0]).toLowerCase();
      (weakKeywords.has(keyword) ? weak : strong).add(keyword);
    }
  }
  return { strong: strong.size, weak: weak.size };
}

/**
 * Keyword-classify free text into up to three category slugs. Any explicit slugs
 * are normalized and pinned first; the rest are scored by keyword evidence over
 * the text. Falls back to ["other"] when nothing qualifies. Shared by the
 * submission parser (rich repo text) and registry federation
 * (name/title/description).
 *
 * A guess needs evidence: a text of fewer than five words files nothing, and a
 * category qualifies only through one specific keyword (a product or
 * technology name) or two different generic ones, never through a single
 * generic word such as "server" or "search".
 */
export function classifyByText(
  text: string,
  explicitCategories: string[] = [],
): string[] {
  const explicit = explicitCategories
    .map(normalizeMcpCategorySlug)
    .filter((category): category is string => Boolean(category));
  const ordered = new Map<string, number>();
  for (const category of explicit) {
    ordered.set(category, 100);
  }

  const haystack = text.toLowerCase();
  const words = haystack.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length >= MIN_CLASSIFIABLE_WORDS) {
    for (const category of mcpCategoryDefinitions) {
      if (category.slug === "other" || ordered.has(category.slug)) {
        continue;
      }
      const { strong, weak } = categoryEvidence(
        categoryKeywords.get(category.slug) ?? [],
        haystack,
      );
      if (strong >= 1 || weak >= 2) {
        ordered.set(category.slug, strong * 2 + weak);
      }
    }
  }

  const sorted = [...ordered.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([slug]) => slug);
  return sorted.length > 0 ? sorted.slice(0, 3) : ["other"];
}

export function inferMcpCategories(parsed: StaticParseResult, categories: string[]) {
  const text = [
    parsed.serverJson?.content.name,
    parsed.serverJson?.content.title,
    parsed.serverJson?.content.description,
    parsed.readme?.mcpName,
    parsed.readme?.summary,
    parsed.source.owner,
    parsed.source.repo,
    parsed.source.subpath,
    parsed.connections.map((connection) => connection.identifier).join(" "),
    toolText(parsed.readme?.tools ?? []),
    toolText(parsed.sourceTools),
  ]
    .filter(Boolean)
    .join(" ");
  return classifyByText(text, categories);
}
