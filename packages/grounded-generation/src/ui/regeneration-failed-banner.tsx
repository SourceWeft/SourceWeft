"use client";

import { LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { groundedErrorCodeSchema } from "@sourceweft/contracts/grounded-generation";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { useGroundedHost, type GroundedVersionRef } from "./host";
import { usePendingAction } from "./pending-action";

/** A regeneration the job could not finish: the ready version stays. */
export type RegenerationFailure = { errorCode: string };

/**
 * The failed regeneration the job recorded beside the ready version
 * (`payload_json.<namespace>.regeneration`), or null. A later regeneration
 * overwrites the record and a successful one replaces the payload.
 */
export function readRegenerationFailure(
  payload: unknown,
  namespace: "study" | "table",
): RegenerationFailure | null {
  if (!payload || typeof payload !== "object") return null;
  const state = (payload as Record<string, unknown>)[namespace];
  if (!state || typeof state !== "object") return null;
  const regeneration = (state as Record<string, unknown>).regeneration;
  if (!regeneration || typeof regeneration !== "object") return null;
  const { status, errorCode } = regeneration as Record<string, unknown>;
  if (status !== "failed") return null;
  return { errorCode: typeof errorCode === "string" ? errorCode : "UNKNOWN" };
}

/**
 * Says that the last regeneration failed and why, so the person knows they
 * are still looking at the previous version. It offers the host's regenerate
 * action when there is one.
 */
export function RegenerationFailedBanner({
  failure,
  version,
}: {
  failure: RegenerationFailure;
  version: GroundedVersionRef;
}) {
  const host = useGroundedHost();
  const t = host.useTranslate();
  const [regenerating, trackRegenerate] = usePendingAction();
  if (!host.interactive) return null;
  const code = groundedErrorCodeSchema.safeParse(failure.errorCode);
  const regenerate = host.requestRegenerate;

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm"
      role="alert"
    >
      <TriangleAlert aria-hidden className="size-4 text-destructive" />
      <span className="min-w-0 flex-1">
        {t("study.regenerationFailed.message")}{" "}
        {t(`study.error.code.${code.success ? code.data : "UNKNOWN"}`)}
      </span>
      {regenerate ? (
        <Button
          aria-busy={regenerating || undefined}
          disabled={regenerating}
          onClick={() => trackRegenerate(regenerate(version))}
          size="xs"
          type="button"
          variant="outline"
        >
          {regenerating ? (
            <LoaderCircle aria-hidden className="animate-spin" />
          ) : (
            <RefreshCw aria-hidden />
          )}
          {t("study.stale.regenerate")}
        </Button>
      ) : null}
    </div>
  );
}
