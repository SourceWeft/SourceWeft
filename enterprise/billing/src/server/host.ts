export interface BillingLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface BillingAlertSink {
  trigger(input: {
    alertKey: string;
    level: "warn" | "error" | "critical";
    source: string;
    title: string;
    message: string;
    teamId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
  resolve(alertKey: string): Promise<unknown>;
}

export interface BillingServiceHost {
  logger: BillingLogger;
  organizationMetadata(kind: "team"): Record<string, unknown>;
  createTeamOrganization(input: {
    name: string;
    slug: string;
    userId: string;
    metadata: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<{ id: string; created: boolean }>;
  ensureMembershipWorkspace(input: {
    organizationId: string;
    userId: string;
  }): Promise<unknown>;
}
