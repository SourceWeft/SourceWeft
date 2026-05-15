import { mailService } from "../../shared/mail";
import { logger } from "../../shared/logger";
import type {
  OpsAlertLevel,
  OpsAlertTriggerInput,
  OpsAlertTriggerResult,
  OpsRuntimeConfig,
} from "./types";
import { OpsAlertStore, opsAlertStore } from "./store";

const LEVEL_RANK: Record<OpsAlertLevel, number> = {
  warn: 1,
  error: 2,
  critical: 3,
};

export class OpsAlertService {
  constructor(
    private readonly runtimeConfig: OpsRuntimeConfig,
    private readonly store: OpsAlertStore = opsAlertStore,
  ) {}

  async trigger(input: OpsAlertTriggerInput): Promise<OpsAlertTriggerResult> {
    if (!this.runtimeConfig.alertsEnabled) {
      return {
        alert: null,
        notified: false,
        skipped: true,
        reason: "alerts_disabled",
      };
    }

    if (!this.shouldProcessLevel(input.level)) {
      return {
        alert: null,
        notified: false,
        skipped: true,
        reason: "below_min_level",
      };
    }

    const metadata = input.metadata ?? {};
    const existing = await this.store.getByAlertKey(input.alertKey);
    const alert = existing
      ? await this.store.touch({
          id: existing.id,
          level: input.level,
          source: input.source,
          title: input.title,
          message: input.message,
          teamId: input.teamId ?? null,
          metadata,
        })
      : await this.store.create({
          alertKey: input.alertKey,
          level: input.level,
          source: input.source,
          title: input.title,
          message: input.message,
          teamId: input.teamId ?? null,
          metadata,
        });

    this.writeAlertLog(input.level, input, alert.triggerCount);

    if (!this.shouldNotify(alert.lastNotifiedAt)) {
      return {
        alert,
        notified: false,
        skipped: false,
      };
    }

    const notified = await this.sendAlertMail(alert, input);
    if (notified) {
      await this.store.markNotified(alert.id, new Date().toISOString());
    }

    return {
      alert,
      notified,
      skipped: false,
    };
  }

  async resolve(alertKey: string) {
    return this.store.resolve(alertKey);
  }

  private shouldProcessLevel(level: OpsAlertLevel) {
    return LEVEL_RANK[level] >= LEVEL_RANK[this.runtimeConfig.alertMinLevel];
  }

  private shouldNotify(lastNotifiedAt: string | null) {
    if (this.runtimeConfig.alertEmails.length === 0) {
      return false;
    }

    if (!lastNotifiedAt) {
      return true;
    }

    const last = Date.parse(lastNotifiedAt);
    if (!Number.isFinite(last)) {
      return true;
    }

    const elapsedMs = Date.now() - last;
    const cooldownMs = this.runtimeConfig.alertCooldownMinutes * 60 * 1000;
    return elapsedMs >= cooldownMs;
  }

  private writeAlertLog(
    level: OpsAlertLevel,
    input: OpsAlertTriggerInput,
    triggerCount: number,
  ) {
    const meta = {
      alertKey: input.alertKey,
      source: input.source,
      teamId: input.teamId ?? null,
      triggerCount,
      message: input.message,
    };

    if (level === "warn") {
      logger.warn(input.title, meta);
      return;
    }

    logger.error(input.title, {
      ...meta,
      level,
    });
  }

  private async sendAlertMail(
    alert: {
      level: OpsAlertLevel;
      title: string;
      message: string;
      source: string;
      alertKey: string;
      teamId: string | null;
      triggerCount: number;
      metadata: Record<string, unknown>;
    },
    input: OpsAlertTriggerInput,
  ) {
    try {
      await mailService.sendTemplate({
        to: this.runtimeConfig.alertEmails,
        messageType: "ops.alert",
        templateId: "ops.alert",
        variables: {
          ...input.metadata,
          alertKey: alert.alertKey,
          level: alert.level,
          levelUpper: alert.level.toUpperCase(),
          message: alert.message,
          metadataJson: JSON.stringify(alert.metadata, null, 2),
          source: alert.source,
          teamLabel: alert.teamId || "n/a",
          title: alert.title,
          triggerCount: alert.triggerCount,
        },
      });

      return true;
    } catch (error) {
      logger.error("Failed to send ops alert email", {
        alertKey: alert.alertKey,
        source: alert.source,
        error: error instanceof Error ? error.message : String(error),
      });

      return false;
    }
  }
}
