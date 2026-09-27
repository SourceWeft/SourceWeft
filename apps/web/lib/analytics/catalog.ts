// The single source of truth for analytics events. Every event name and
// parameter the web app sends is declared here; the dispatcher validates
// against it and the GA4 registration checklist is generated from it.
// Kept free of browser and React imports so server-side senders can reuse it.

export type ParamKind = "dimension" | "metric" | "ga4_standard";

export const ANALYTICS_PARAMS = {
  // Dimensions: registered in GA4 as event-scoped custom dimensions.
  method: { kind: "dimension" },
  action: { kind: "dimension" },
  surface: { kind: "dimension" },
  source: { kind: "dimension" },
  scope: { kind: "dimension" },
  plan: { kind: "dimension" },
  billing_interval: { kind: "dimension" },
  command_used: { kind: "dimension" },
  has_images: { kind: "dimension" },
  has_sources: { kind: "dimension" },
  connector_type: { kind: "dimension" },
  gmail_mode: { kind: "dimension" },
  auth_type: { kind: "dimension" },
  kind: { kind: "dimension" },
  edition: { kind: "dimension" },
  platform: { kind: "dimension" },
  app_version: { kind: "dimension" },
  // Metrics: registered in GA4 as custom metrics.
  seat_count: { kind: "metric" },
  skill_count: { kind: "metric" },
  source_count: { kind: "metric" },
  tool_count: { kind: "metric" },
  // GA4 recommended ecommerce parameters: no registration needed.
  value: { kind: "ga4_standard" },
  currency: { kind: "ga4_standard" },
  items: { kind: "ga4_standard" },
  transaction_id: { kind: "ga4_standard" },
} as const satisfies Record<string, { kind: ParamKind }>;

export type AnalyticsParamName = keyof typeof ANALYTICS_PARAMS;

type EventDefinition = {
  params: readonly AnalyticsParamName[];
  keyEvent: boolean | "optional";
};

export const ANALYTICS_EVENTS = {
  sign_up: { params: ["method"], keyEvent: true },
  login: { params: ["method"], keyEvent: false },
  auth_error: { params: ["action", "method", "surface"], keyEvent: false },
  begin_checkout: {
    params: [
      "plan",
      "billing_interval",
      "seat_count",
      "source",
      "value",
      "currency",
      "items",
    ],
    keyEvent: "optional",
  },
  checkout_error: {
    params: ["plan", "billing_interval", "source"],
    keyEvent: false,
  },
  purchase: {
    params: [
      "transaction_id",
      "value",
      "currency",
      "items",
      "plan",
      "billing_interval",
    ],
    keyEvent: true,
  },
  billing_portal_opened: { params: ["scope", "source"], keyEvent: false },
  chat_message_sent: {
    params: [
      "command_used",
      "has_images",
      "has_sources",
      "skill_count",
      "source_count",
      "tool_count",
      "surface",
    ],
    keyEvent: false,
  },
  skill_selected: { params: ["skill_count", "surface"], keyEvent: false },
  source_attached: { params: ["source_count", "surface"], keyEvent: false },
  team_invitation_accepted: { params: ["source"], keyEvent: false },
  connector_connected: {
    params: ["connector_type", "gmail_mode"],
    keyEvent: false,
  },
  mcp_server_installed: { params: ["source", "auth_type"], keyEvent: false },
  source_added: { params: ["kind", "source_count"], keyEvent: false },
  artifact_shared: { params: [], keyEvent: false },
  skill_installed: { params: ["surface"], keyEvent: false },
  workspace_created: { params: [], keyEvent: false },
  team_created: { params: ["edition"], keyEvent: false },
} as const satisfies Record<string, EventDefinition>;

export type AnalyticsEventName = keyof typeof ANALYTICS_EVENTS;

/** Added to every event by the dispatcher; never declared per event. */
export const CONTEXT_PARAMS = ["platform", "app_version"] as const;

export type AnalyticsPrimitive = string | number | boolean | null | undefined;
export type AnalyticsValue =
  | AnalyticsPrimitive
  | Record<string, AnalyticsPrimitive>[];

export type EventParams<N extends AnalyticsEventName> = Partial<
  Record<(typeof ANALYTICS_EVENTS)[N]["params"][number], AnalyticsValue>
>;

function isEventName(name: string): name is AnalyticsEventName {
  return Object.hasOwn(ANALYTICS_EVENTS, name);
}

/** Returns why the event is invalid, or null when it matches the catalog. */
export function validateEvent(
  name: string,
  params: Record<string, AnalyticsValue>,
): string | null {
  if (!isEventName(name)) {
    return `Unknown analytics event "${name}"`;
  }
  const declared: readonly string[] = ANALYTICS_EVENTS[name].params;
  const context: readonly string[] = CONTEXT_PARAMS;
  for (const [key, value] of Object.entries(params)) {
    if (!declared.includes(key) && !context.includes(key)) {
      return `Analytics event "${name}" does not declare param "${key}"`;
    }
    if (Array.isArray(value) && key !== "items") {
      return `Analytics param "${key}" on "${name}" must be a primitive`;
    }
  }
  return null;
}

function paramsOfKind(kind: ParamKind) {
  return Object.entries(ANALYTICS_PARAMS)
    .filter(([, param]) => param.kind === kind)
    .map(([name]) => name)
    .sort();
}

function bulletList(items: string[]) {
  return items.map((item) => `- ${item}`).join("\n");
}

/** GA4 admin setup derived from the catalog; committed as ga4-checklist.md. */
export function renderGa4Checklist(): string {
  const events = Object.entries(ANALYTICS_EVENTS);
  const keyEvents = [
    ...events
      .filter(([, event]) => event.keyEvent === true)
      .map(([name]) => name)
      .sort(),
    ...events
      .filter(([, event]) => event.keyEvent === "optional")
      .map(([name]) => `${name} (optional)`)
      .sort(),
  ];

  return [
    "# GA4 checklist",
    "",
    "Generated from `catalog.ts` by `catalog.test.ts`. Register these in GA4",
    "(Admin → Custom definitions / Key events) before shipping events that use",
    "them: registrations do not apply to data collected earlier.",
    "",
    "## Custom dimensions (event scope)",
    "",
    bulletList(paramsOfKind("dimension")),
    "",
    "## Custom metrics",
    "",
    bulletList(paramsOfKind("metric")),
    "",
    "## User properties",
    "",
    bulletList(["platform"]),
    "",
    "## Key events",
    "",
    bulletList(keyEvents),
    "",
  ].join("\n");
}
