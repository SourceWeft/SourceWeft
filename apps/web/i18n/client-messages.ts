/**
 * Message namespaces each route area ships to the browser.
 *
 * `NextIntlClientProvider` serialises its `messages` prop into every RSC
 * payload, so handing it the whole catalog put ~210 KB of copy on every public
 * page. Server components read the catalog through `i18n/request.ts` and never
 * need the client provider; only client components do. The root layout therefore
 * provides just the shell, and the areas below replace it (a nested provider
 * overrides, it does not merge) with what their client components read.
 *
 * `client-messages.test.ts` walks the import graph of every area, collects the
 * namespaces its client code passes to `useTranslations`, and fails when one is
 * missing here. Dotted entries select a sub-tree (`"mcp.facts"` ships only
 * `messages.mcp.facts`).
 */
export const CLIENT_NAMESPACES = {
  /**
   * Shell shared by every route, plus the small routes that have no provider
   * of their own (artifact, guest-invite, join, organization, settings,
   * privacy, terms). `authLocale` feeds Better Auth's localization through
   * `useMessages()` in `app/providers.tsx`.
   */
  root: [
    "artifactShare",
    "authLocale",
    "authPages.additionalField",
    "authPages.guestInvite",
    "authProfile",
    "dashboardObservability",
    "footer",
    "header",
    "languageSwitcher",
    "mobileRouteSheet",
    "ui",
  ],
  /** `app/[locale]`: public marketing, MCP and Skills pages. */
  marketing: [
    "about",
    "catalogBadge",
    "changelog",
    "dashboardNav",
    "dashboardSettings",
    "dashboardSkillOverview.block",
    "dashboardSkillReports",
    "dashboardSkillReviews",
    "download",
    "footer",
    "header",
    "landing",
    "languageSwitcher",
    "market.overview",
    "mcp.aiOverview",
    "mcp.authMethod",
    "mcp.facts",
    "mcp.readme",
    "mcp.template",
    "pricing",
    "publicSkills.community.report",
    "publicSkills.community.reviews",
  ],
  /** `app/auth`: sign-in, invitations, consent, desktop hand-off. */
  auth: [
    "authPages.acceptInvitation",
    "authPages.additionalField",
    "authPages.consent",
    "authPages.desktopComplete",
    "authPages.desktopLogin",
    "authPages.mobileLogin",
    "authUi",
    "dashboardObservability",
  ],
  /** `app/dashboard`: the signed-in workspace and chat. */
  dashboard: [
    "authPages.desktopLogin",
    "catalogBadge",
    "chatRecovery",
    "dashboardAdmin",
    "dashboardChat",
    "dashboardChatCanvas",
    "dashboardChatFiles",
    "dashboardConnectors",
    "dashboardHome",
    "dashboardMcpClaim",
    "dashboardMcpPanel",
    "dashboardNav",
    "dashboardObservability",
    "dashboardPersonas",
    "dashboardSettings",
    "dashboardSkillOverview.admin",
    "dashboardSkillOverview.block",
    "dashboardSkillOverview.settings",
    "dashboardSkillReports",
    "dashboardSkillReviews",
    "dashboardSkillRunStats",
    "dashboardSkills",
    "dashboardSkillsClaim",
    "dashboardSkillsMarket",
    "dashboardSkillsMarketAdmin",
    "dashboardSourcesHub",
    "dashboardWindows",
    "market.overview",
    "mcp.aiOverview",
    "mcp.authMethod",
    "mcp.badges.runtime",
    "mcp.readme",
  ],
  /** `app/artifact-preview`: renders the chat canvas around a shared artifact. */
  artifactPreview: [
    "artifactShare.preview",
    "catalogBadge",
    "chatRecovery",
    "dashboardChat",
    "dashboardChatCanvas",
    "dashboardChatFiles",
    "dashboardMcpPanel",
    "dashboardSkills",
    "dashboardSkillsMarket",
    "dashboardSkillsMarketAdmin",
    "dashboardSourcesHub",
    "market.overview",
    "mcp.aiOverview",
    "mcp.authMethod",
    "mcp.badges.runtime",
    "mcp.readme",
  ],
} as const satisfies Record<string, readonly string[]>;

export type ClientMessageArea = keyof typeof CLIENT_NAMESPACES;

type MessageTree = Record<string, unknown>;

function isTree(value: unknown): value is MessageTree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Copies the sub-tree at each dotted path into a new tree; absent paths are skipped. */
export function pickMessages(
  messages: MessageTree,
  namespaces: readonly string[],
): MessageTree {
  const picked: MessageTree = {};
  for (const namespace of namespaces) {
    const path = namespace.split(".");
    let source: unknown = messages;
    for (const key of path) {
      source = isTree(source) ? source[key] : undefined;
    }
    if (source === undefined) continue;

    let target = picked;
    for (const key of path.slice(0, -1)) {
      const next = target[key];
      target = isTree(next) ? next : (target[key] = {});
    }
    const leaf = path[path.length - 1]!;
    target[leaf] = isTree(source) && isTree(target[leaf])
      ? mergeTrees(target[leaf] as MessageTree, source)
      : source;
  }
  return picked;
}

function mergeTrees(a: MessageTree, b: MessageTree): MessageTree {
  const merged: MessageTree = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const existing = merged[key];
    merged[key] =
      isTree(existing) && isTree(value) ? mergeTrees(existing, value) : value;
  }
  return merged;
}
