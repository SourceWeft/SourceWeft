export type OpsAlertLevel = "warn" | "error" | "critical";

export type OpsAlertStatus = "open" | "resolved";

export type OpsRuntimeConfig = {
  alertsEnabled: boolean;
  alertEmails: string[];
  alertCooldownMinutes: number;
  alertMinLevel: OpsAlertLevel;
};

export type OpsAlertState = {
  id: string;
  alertKey: string;
  level: OpsAlertLevel;
  status: OpsAlertStatus;
  source: string;
  title: string;
  message: string;
  teamId: string | null;
  triggerCount: number;
  firstTriggeredAt: string;
  lastTriggeredAt: string;
  lastNotifiedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type OpsAlertTriggerInput = {
  alertKey: string;
  level: OpsAlertLevel;
  source: string;
  title: string;
  message: string;
  teamId?: string | null;
  metadata?: Record<string, unknown>;
};

export type OpsAlertTriggerResult = {
  alert: OpsAlertState | null;
  notified: boolean;
  skipped: boolean;
  reason?: string;
};
