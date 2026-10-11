import type { TranslatedCatalogCategory } from "../../shared/catalog-category-text";

/**
 * The version of the category list below. Bump it when a category is added,
 * removed or redefined: AI classifications record the version they were made
 * under, and MCP overviews written under another one are regenerated. A
 * translation (`zhCN`) does not change what a category means: leave it be.
 */
export const mcpTaxonomyVersion = "2026-05-23-v2";

export type McpCategoryDefinition = TranslatedCatalogCategory & {
  aliases: string[];
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
    zhCN: {
      name: "开发者工具",
      description: "代码、Git、API、SDK、CI/CD、开发工作流与本地开发工具。",
    },
    aliases: ["developer", "development", "dev", "code", "coding", "api", "sdk", "git", "repo", "repository", "version-control", "api-development"],
  },
  {
    slug: "browser-automation",
    name: "Browser Automation",
    description: "Browser control, page inspection, screenshots, web tests, and automation.",
    zhCN: {
      name: "浏览器自动化",
      description: "浏览器控制、页面检查、截图、网页测试与自动化。",
    },
    aliases: ["browser", "web-automation", "chrome", "playwright", "puppeteer"],
  },
  {
    slug: "web-search-scraping",
    name: "Web Search & Scraping",
    description: "Search, news retrieval, crawling, scraping, extraction, and public web collection.",
    zhCN: {
      name: "网页搜索与抓取",
      description: "搜索、新闻检索、网页爬取、内容抓取与提取，以及公开网页数据采集。",
    },
    aliases: ["search", "web", "web-search", "scraping", "web-scraping", "crawler", "data-collection"],
  },
  {
    slug: "data-analytics",
    name: "Data & Analytics",
    description: "Data analysis, BI, reports, metrics, ETL, spreadsheets, and visualization.",
    zhCN: {
      name: "数据与分析",
      description: "数据分析、BI、报表、指标、ETL、电子表格与可视化。",
    },
    aliases: ["analytics", "analysis", "data", "bi", "reporting"],
  },
  {
    slug: "databases",
    name: "Databases",
    description: "SQL, NoSQL, graph, vector, cache, and database administration.",
    zhCN: {
      name: "数据库",
      description: "SQL、NoSQL、图数据库、向量数据库、缓存与数据库管理。",
    },
    aliases: ["database", "db", "sql", "database-management"],
  },
  {
    slug: "files-storage",
    name: "Files & Storage",
    description: "Local files, documents, PDFs, object storage, cloud drives, and storage systems.",
    zhCN: {
      name: "文件与存储",
      description: "本地文件、文档、PDF、对象存储、云盘与存储系统。",
    },
    aliases: ["file-system", "file-systems", "filesystem", "files", "storage", "cloud-storage", "documents"],
  },
  {
    slug: "knowledge-memory",
    name: "Knowledge & Memory",
    description: "RAG, knowledge bases, documentation retrieval, memory, semantic search, and contextual recall.",
    zhCN: {
      name: "知识与记忆",
      description: "RAG、知识库、文档检索、记忆、语义搜索与上下文召回。",
    },
    aliases: ["memory", "knowledge", "docs", "documentation", "rag", "learning-documentation", "science-education"],
  },
  {
    slug: "productivity-workflow",
    name: "Productivity & Workflow",
    description: "Tasks, calendars, notes, automation workflows, project management, and personal productivity.",
    zhCN: {
      name: "效率与工作流",
      description: "任务、日历、笔记、自动化工作流、项目管理与个人效率。",
    },
    aliases: ["productivity", "workflow", "calendar", "calendar-management", "tasks", "todo", "utility"],
  },
  {
    slug: "communication-collaboration",
    name: "Communication & Collaboration",
    description: "Email, chat, messaging, meetings, social channels, and team collaboration.",
    zhCN: {
      name: "沟通与协作",
      description: "邮件、聊天、消息、会议、社交渠道与团队协作。",
    },
    aliases: ["communication", "collaboration", "collaboration-communication", "collaboration-tools", "social", "social-media"],
  },
  {
    slug: "business-commerce",
    name: "Business & Commerce",
    description: "CRM, support, sales, marketing, ecommerce, payments, customer data, and business SaaS.",
    zhCN: {
      name: "商业与电商",
      description: "CRM、客服、销售、营销、电商、支付、客户数据与企业 SaaS。",
    },
    aliases: ["business", "commerce", "e-commerce", "ecommerce", "marketing", "marketing-automation", "business-services"],
  },
  {
    slug: "cloud-infrastructure",
    name: "Cloud & Infrastructure",
    description: "Cloud providers, hosting, Kubernetes, Docker, Terraform, networking, deployment, and operations.",
    zhCN: {
      name: "云端与基础设施",
      description: "云端服务商、托管、Kubernetes、Docker、Terraform、网络、部署与运维。",
    },
    aliases: ["cloud", "infrastructure", "cloud-service", "deployment", "deployment-devops", "devops", "virtualization"],
  },
  {
    slug: "security-monitoring",
    name: "Security & Monitoring",
    description: "Security, identity, secrets, compliance, testing, logs, monitoring, alerts, and observability.",
    zhCN: {
      name: "安全与监控",
      description: "安全、身份、密钥、合规、测试、日志、监控、告警与可观测性。",
    },
    aliases: ["security", "monitoring", "observability", "security-testing", "monitoring-observability", "testing"],
  },
  {
    slug: "finance",
    name: "Finance",
    description: "Stocks, crypto, trading, accounting, banking, markets, and financial data.",
    zhCN: {
      name: "金融",
      description: "股票、加密货币、交易、会计、银行、市场行情与金融数据。",
    },
    aliases: ["financial", "stocks", "stocks-finance", "finance-commerce"],
  },
  {
    slug: "media-design",
    name: "Media & Design",
    description: "Images, video, audio, TTS, design tools, 3D, and creative workflows.",
    zhCN: {
      name: "媒体与设计",
      description: "图像、视频、音频、语音合成、设计工具、3D 与创意工作流。",
    },
    aliases: ["media", "design", "media-generation", "design-tools", "creative"],
  },
  {
    slug: "location-lifestyle",
    name: "Location & Lifestyle",
    description: "Maps, location, weather, travel, transport, health, wellness, and local services.",
    zhCN: {
      name: "位置与生活",
      description: "地图、位置、天气、旅行、交通、健康、养生与本地生活服务。",
    },
    aliases: ["location", "lifestyle", "location-travel", "location-services", "travel", "travel-transport", "weather", "health", "wellness", "health-wellness"],
  },
  {
    slug: "ai-ml",
    name: "AI & ML",
    description: "LLM providers, agents, models, embeddings, inference, and machine learning workflows.",
    zhCN: {
      name: "AI 与机器学习",
      description: "大模型提供商、智能体、模型、嵌入、推理与机器学习工作流。",
    },
    aliases: ["ai", "ml", "llm", "ai-chatbot", "data-science-ml", "machine-learning"],
  },
  {
    slug: "other",
    name: "Other",
    description: "MCP servers that do not fit a primary SourceWeft category yet.",
    zhCN: {
      name: "其他",
      description: "暂未归入 SourceWeft 主要分类的 MCP 服务。",
    },
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
