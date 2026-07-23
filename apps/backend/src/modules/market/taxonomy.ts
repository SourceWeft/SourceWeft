export type McpCategoryDefinition = {
  aliases: string[];
  description: string;
  name: string;
  slug: string;
};

export const sourceMarketSlugs = new Set([
  "mcp-so",
  "mcpservers",
  "mcp-servers",
]);

export const nonCategorySlugs = new Set([
  ...sourceMarketSlugs,
  "all",
  "featured",
  "official",
  "verified",
]);

export const mcpCategoryDefinitions: McpCategoryDefinition[] = [
  {
    slug: "developer-tools",
    name: "Developer Tools",
    description: "Code, Git, APIs, SDKs, CI/CD, developer workflows, and local developer tooling.",
    aliases: ["developer", "development", "dev", "code", "coding", "api", "sdk", "git", "repo", "repository", "version-control", "api-development"],
  },
  {
    slug: "browser-automation",
    name: "Browser Automation",
    description: "Browser control, page inspection, screenshots, web tests, and automation.",
    aliases: ["browser", "web-automation", "chrome", "playwright", "puppeteer"],
  },
  {
    slug: "web-search-scraping",
    name: "Web Search & Scraping",
    description: "Search, news retrieval, crawling, scraping, extraction, and public web collection.",
    aliases: ["search", "web", "web-search", "scraping", "web-scraping", "crawler", "data-collection"],
  },
  {
    slug: "data-analytics",
    name: "Data & Analytics",
    description: "Data analysis, BI, reports, metrics, ETL, spreadsheets, and visualization.",
    aliases: ["analytics", "analysis", "data", "bi", "reporting"],
  },
  {
    slug: "databases",
    name: "Databases",
    description: "SQL, NoSQL, graph, vector, cache, and database administration.",
    aliases: ["database", "db", "sql", "database-management"],
  },
  {
    slug: "files-storage",
    name: "Files & Storage",
    description: "Local files, documents, PDFs, object storage, cloud drives, and storage systems.",
    aliases: ["file-system", "file-systems", "filesystem", "files", "storage", "cloud-storage", "documents"],
  },
  {
    slug: "knowledge-memory",
    name: "Knowledge & Memory",
    description: "RAG, knowledge bases, documentation retrieval, memory, semantic search, and contextual recall.",
    aliases: ["memory", "knowledge", "docs", "documentation", "rag", "learning-documentation", "science-education"],
  },
  {
    slug: "productivity-workflow",
    name: "Productivity & Workflow",
    description: "Tasks, calendars, notes, automation workflows, project management, and personal productivity.",
    aliases: ["productivity", "workflow", "calendar", "calendar-management", "tasks", "todo", "utility"],
  },
  {
    slug: "communication-collaboration",
    name: "Communication & Collaboration",
    description: "Email, chat, messaging, meetings, social channels, and team collaboration.",
    aliases: ["communication", "collaboration", "collaboration-communication", "collaboration-tools", "social", "social-media"],
  },
  {
    slug: "business-commerce",
    name: "Business & Commerce",
    description: "CRM, support, sales, marketing, ecommerce, payments, customer data, and business SaaS.",
    aliases: ["business", "commerce", "e-commerce", "ecommerce", "marketing", "marketing-automation", "business-services"],
  },
  {
    slug: "cloud-infrastructure",
    name: "Cloud & Infrastructure",
    description: "Cloud providers, hosting, Kubernetes, Docker, Terraform, networking, deployment, and operations.",
    aliases: ["cloud", "infrastructure", "cloud-service", "deployment", "deployment-devops", "devops", "virtualization"],
  },
  {
    slug: "security-monitoring",
    name: "Security & Monitoring",
    description: "Security, identity, secrets, compliance, testing, logs, monitoring, alerts, and observability.",
    aliases: ["security", "monitoring", "observability", "security-testing", "monitoring-observability", "testing"],
  },
  {
    slug: "finance",
    name: "Finance",
    description: "Stocks, crypto, trading, accounting, banking, markets, and financial data.",
    aliases: ["financial", "stocks", "stocks-finance", "finance-commerce"],
  },
  {
    slug: "media-design",
    name: "Media & Design",
    description: "Images, video, audio, TTS, design tools, 3D, and creative workflows.",
    aliases: ["media", "design", "media-generation", "design-tools", "creative"],
  },
  {
    slug: "location-lifestyle",
    name: "Location & Lifestyle",
    description: "Maps, location, weather, travel, transport, health, wellness, and local services.",
    aliases: ["location", "lifestyle", "location-travel", "location-services", "travel", "travel-transport", "weather", "health", "wellness", "health-wellness"],
  },
  {
    slug: "ai-ml",
    name: "AI & ML",
    description: "LLM providers, agents, models, embeddings, inference, and machine learning workflows.",
    aliases: ["ai", "ml", "llm", "ai-chatbot", "data-science-ml", "machine-learning"],
  },
  {
    slug: "other",
    name: "Other",
    description: "MCP servers that do not fit a primary SourceWeft category yet.",
    aliases: ["other", "misc"],
  },
];

const categoryBySlug = new Map(
  mcpCategoryDefinitions.map((category) => [category.slug, category]),
);
const aliasToSlug = new Map<string, string>();
for (const category of mcpCategoryDefinitions) {
  aliasToSlug.set(category.slug, category.slug);
  for (const alias of category.aliases) {
    aliasToSlug.set(alias, category.slug);
  }
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeMcpCategorySlug(value: string) {
  const slug = slugify(value);
  if (!slug || nonCategorySlugs.has(slug)) {
    return undefined;
  }
  return aliasToSlug.get(slug) ?? (categoryBySlug.has(slug) ? slug : undefined);
}

export function getMcpCategoryDefinition(slug: string) {
  return categoryBySlug.get(slug);
}
