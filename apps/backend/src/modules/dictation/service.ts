import { createHash } from "node:crypto";
import {
  DICTATION_ERROR_CODES,
} from "@sourceweft/contracts/dictation";
import { logger } from "../../shared/logger";
import { rateLimiter, type RateLimiter } from "../../shared/rate-limit";
import {
  resolveModelGatewayProfile,
  withBilledModelGateway,
} from "../../shared/model-gateway";
import { billingAdmission } from "../../shared/model-gateway/billing/admission";
import { settleModelCall } from "../../shared/model-gateway/billing/settle";
import type { ModelUsageContext } from "../../shared/model-gateway/billing/context";
import { ContentError } from "../content/errors";
import type { ContentBillingPort } from "../content/billing-port";
import { requireContentWorkspace } from "../workspace/guards";
import { workspaceService } from "../workspace";
import {
  DICTATION_SETTLE_THRESHOLD_SECONDS,
  dictationAccountKey,
  dictationAccrual,
  type DictationAccrual,
} from "./accrual";
import {
  dictationRateRules,
  dictationSlots,
  type DictationSlots,
} from "./limits";
import { readDictationWav } from "./wav";

/** Dictation is routed through its own, opt-in ASR profile — never the default. */
export const DICTATION_PROFILE_ALIAS = "asr-dictation";

export type DictationProfile = {
  gatewayConfigId: string;
  profileAlias: string;
  modelAlias: string;
};

async function defaultResolveProfile(): Promise<DictationProfile | null> {
  const profile = await resolveModelGatewayProfile({
    kind: "asr",
    requestedProfileAlias: DICTATION_PROFILE_ALIAS,
    defaultRequired: false,
  });
  if (!profile) return null;
  return {
    gatewayConfigId: profile.gatewayConfigId,
    profileAlias: profile.profileAlias,
    modelAlias: profile.modelAlias,
  };
}

/** Whether this deployment has an `asr-dictation` profile; dictation is hidden without one. */
export async function isDictationAvailable(
  resolveProfile: () => Promise<DictationProfile | null> = defaultResolveProfile,
): Promise<boolean> {
  return Boolean(await resolveProfile());
}

export type DictationSegmentResult =
  | { kind: "ok"; text: string; durationSec: number }
  | { kind: "limited"; retryAfterSeconds: number };

export type DictationDeps = {
  billing: ContentBillingPort;
  accrual?: DictationAccrual;
  slots?: DictationSlots;
  rateLimiter?: RateLimiter;
  resolveProfile?: () => Promise<DictationProfile | null>;
  transcribe?: (input: {
    audio: Uint8Array;
    profile: DictationProfile;
    context: ModelUsageContext;
    idempotencyKey: string;
  }) => Promise<{ text: string }>;
  admit?: typeof billingAdmission.admit;
  settle?: typeof settleModelCall;
};

/**
 * The default transcription path: one covered ASR call through the billed
 * gateway. It is covered rather than billed because dictation is charged by the
 * audio seconds that accrue across segments and settled in one metering, not
 * per call. `billing` is captured here because the injected `transcribe` dep
 * does not carry it.
 */
function createDefaultTranscribe(billing: ContentBillingPort) {
  return async (args: {
    audio: Uint8Array;
    profile: DictationProfile;
    context: ModelUsageContext;
    idempotencyKey: string;
  }): Promise<{ text: string }> => {
    const result = await withBilledModelGateway(
      {
        billing,
        gatewayConfigId: args.profile.gatewayConfigId,
        context: args.context,
      },
      (gateway) =>
        gateway.asr.transcribe(
          {
            model: args.profile.modelAlias,
            audio: args.audio,
            fileName: "segment.wav",
            mimeType: "audio/wav",
            responseFormat: "json",
          },
          {
            operation: "asr.transcribe",
            modelKind: "asr",
            gatewayConfigId: args.profile.gatewayConfigId,
            profileAlias: args.profile.profileAlias,
            modelAlias: args.profile.modelAlias,
            idempotencyKey: args.idempotencyKey,
            referenceId: args.idempotencyKey,
          },
        ),
    );
    return { text: result.text };
  };
}

/**
 * Transcribes one dictation segment and charges the time it measured.
 *
 * The duration that bills is the server's own measurement of the WAV, never a
 * figure from the provider's response. Each segment is a covered model call;
 * its seconds accrue against the speaker's team, and a single metering settles
 * the running total once it crosses `DICTATION_SETTLE_THRESHOLD_SECONDS`. No
 * audio is stored and no transcript is logged or attached to billing.
 */
export async function transcribeDictationSegment(
  input: {
    workspaceId: string;
    userId: string;
    sessionId: string;
    seq: number;
    audio: Uint8Array;
  },
  deps: DictationDeps,
): Promise<DictationSegmentResult> {
  const workspace = await requireContentWorkspace({
    workspaceId: input.workspaceId,
    userId: input.userId,
  });
  const teamId = await workspaceService.resolveBillingOrganizationId({
    workspaceId: workspace.id,
    userId: input.userId,
    workspaceOrganizationId: workspace.organizationId,
  });

  const resolveProfile = deps.resolveProfile ?? defaultResolveProfile;
  const profile = await resolveProfile();
  if (!profile) {
    throw new ContentError(
      404,
      DICTATION_ERROR_CODES.unavailable,
      "Voice dictation is not available on this deployment.",
    );
  }

  // The server measures the segment; this is what accrues and what is returned.
  const { durationSec } = readDictationWav(input.audio);

  const limiter = deps.rateLimiter ?? rateLimiter;
  const verdict = await limiter.consume(
    dictationRateRules({ userId: input.userId }),
  );
  if (!verdict.allowed) {
    return { kind: "limited", retryAfterSeconds: verdict.retryAfterSeconds };
  }

  const slots = deps.slots ?? dictationSlots;
  const release = await slots.acquire(input.userId);
  if (!release) {
    return { kind: "limited", retryAfterSeconds: 1 };
  }

  try {
    const admit = deps.admit ?? billingAdmission.admit;
    const decision = await admit({
      billing: deps.billing,
      teamId,
      userId: input.userId,
    });
    if (!decision.allowed) {
      throw new ContentError(
        402,
        DICTATION_ERROR_CODES.insufficientCredits,
        "There are not enough credits to transcribe dictation.",
      );
    }

    const idempotencyKey = `dictation:${input.sessionId}:${input.seq}`;
    const context: ModelUsageContext = {
      teamId,
      workspaceId: workspace.id,
      actorUserId: input.userId,
      feature: "chat.dictation",
      intent: { mode: "covered", coveredBy: "settled_by_dictation_accrual" },
      scopeKind: "api-request",
      scopeId: `dictation:${input.sessionId}`,
    };
    const transcribe =
      deps.transcribe ?? createDefaultTranscribe(deps.billing);
    const result = await transcribe({
      audio: input.audio,
      profile,
      context,
      idempotencyKey,
    });

    // Charged work accrues; observation-only modes (disabled) never do.
    if (decision.billingMode !== "disabled") {
      const accrual = deps.accrual ?? dictationAccrual;
      // The digest keys the idempotency marker so a genuine retry (same bytes
      // under the same session and sequence) is counted once, while different
      // audio reusing that pair accrues its own seconds.
      const digest = createHash("sha256").update(input.audio).digest("hex");
      try {
        const first = await accrual.markSegment(
          input.sessionId,
          input.seq,
          digest,
        );
        if (first) {
          const key = dictationAccountKey({ teamId, userId: input.userId });
          const total = await accrual.add(key, durationSec);
          if (total >= DICTATION_SETTLE_THRESHOLD_SECONDS) {
            const taken = await accrual.take(key);
            if (taken > 0) {
              await settleAccruedSeconds({
                taken,
                key,
                teamId,
                workspaceId: workspace.id,
                userId: input.userId,
                sessionId: input.sessionId,
                profile,
                accrual,
                settle: deps.settle ?? settleModelCall,
                billing: deps.billing,
              });
            }
          }
        }
      } catch (error) {
        // A Redis failure after a successful transcription must not fail the
        // request or lose the text. Like a failed settlement, the seconds are
        // simply not counted this time; no transcript is ever logged.
        logger.warn("dictation accrual failed; segment not counted", {
          teamId,
          workspaceId: workspace.id,
          userId: input.userId,
          sessionId: input.sessionId,
          seq: input.seq,
          durationSec,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info("dictation segment transcribed", {
      teamId,
      workspaceId: workspace.id,
      userId: input.userId,
      sessionId: input.sessionId,
      seq: input.seq,
      durationSec,
      model: profile.modelAlias,
    });

    return { kind: "ok", text: result.text.trim(), durationSec };
  } finally {
    await release();
  }
}

/**
 * Settles the accrued audio seconds as one billed metering. A settlement
 * failure never fails the segment request: the seconds are restored so the next
 * crossing tries again, and a warning is logged.
 */
async function settleAccruedSeconds(args: {
  taken: number;
  key: string;
  teamId: string;
  workspaceId: string;
  userId: string;
  sessionId: string;
  profile: DictationProfile;
  accrual: DictationAccrual;
  settle: typeof settleModelCall;
  billing: ContentBillingPort;
}): Promise<void> {
  const settlementId = crypto.randomUUID();
  const settleRef = `dictation-settle:${settlementId}`;
  try {
    const trace = await args.settle({
      billing: args.billing,
      context: {
        teamId: args.teamId,
        workspaceId: args.workspaceId,
        actorUserId: args.userId,
        feature: "chat.dictation",
        intent: { mode: "billed" },
        scopeKind: "api-request",
        scopeId: settlementId,
      },
      options: {
        operation: "asr.dictation.settle",
        modelKind: "asr",
        gatewayConfigId: args.profile.gatewayConfigId,
        profileAlias: args.profile.profileAlias,
        modelAlias: args.profile.modelAlias,
      },
      usage: { inputAudioSeconds: args.taken },
      idempotencyKey: settleRef,
      referenceId: settleRef,
    });
    if (trace?.billingStatus === "meter_failed") {
      await args.accrual.restore(args.key, args.taken);
      logger.warn("dictation settlement did not meter; seconds restored", {
        teamId: args.teamId,
        userId: args.userId,
        sessionId: args.sessionId,
        seconds: args.taken,
      });
    }
  } catch (error) {
    await args.accrual.restore(args.key, args.taken);
    logger.warn("dictation settlement failed; seconds restored", {
      teamId: args.teamId,
      userId: args.userId,
      sessionId: args.sessionId,
      seconds: args.taken,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
