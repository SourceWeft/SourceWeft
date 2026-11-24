"use client";

import { useEffect, useId, useState } from "react";
import { ExternalLink, Quote } from "lucide-react";
import type { GroundedEvidence } from "@sourceweft/contracts/grounded-evidence";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { useGroundedHost } from "./host";

type EvidenceCheck = "checking" | "current" | "changed";

function EvidenceEntry({
  evidence,
  workspaceId,
  artifactId,
  interactive,
}: {
  evidence: GroundedEvidence;
  workspaceId: string;
  artifactId: string;
  interactive: boolean;
}) {
  const host = useGroundedHost();
  const t = host.useTranslate();
  const [check, setCheck] = useState<EvidenceCheck>(
    interactive ? "checking" : "current",
  );

  useEffect(() => {
    if (!interactive) return;
    let cancelled = false;
    host
      .currentQuoteHash(evidence, { workspaceId, artifactId })
      .then((hash) => {
        // A missing chunk (null) or moved text both mean the snapshot is all we have.
        if (!cancelled) {
          setCheck(hash === evidence.quoteHash ? "current" : "changed");
        }
      })
      .catch(() => {
        if (!cancelled) setCheck("current");
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId, evidence, host, interactive, workspaceId]);

  return (
    <li className="space-y-1.5 rounded-lg border bg-muted/40 p-3 text-sm">
      {evidence.headingPath ? (
        <p className="text-xs font-medium text-muted-foreground">
          {evidence.headingPath}
        </p>
      ) : null}
      <blockquote className="border-l-2 pl-3 whitespace-pre-wrap text-foreground">
        {evidence.quote}
      </blockquote>
      {check === "changed" ? (
        <p className="text-xs text-amber-700 dark:text-amber-400" role="status">
          {t("study.evidence.sourceChanged")}
        </p>
      ) : null}
      {interactive ? (
        <Button
          onClick={() => host.openEvidence(evidence, { workspaceId, artifactId })}
          size="xs"
          type="button"
          variant="ghost"
        >
          <ExternalLink aria-hidden />
          {t("study.evidence.openSource")}
        </Button>
      ) : null}
    </li>
  );
}

/**
 * An item's evidence behind a disclosure button: heading path and the quote
 * snapshot, plus "open source" when the viewer is interactive. When the source
 * text has moved or its chunk is gone, the snapshot is still shown with a
 * "source changed" note.
 */
export function EvidencePopover({
  evidence,
  workspaceId,
  artifactId,
  interactive,
  defaultOpen = false,
}: {
  evidence: readonly GroundedEvidence[];
  workspaceId: string;
  artifactId: string;
  /** Defaults to the host's `interactive`. */
  interactive?: boolean;
  defaultOpen?: boolean;
}) {
  const host = useGroundedHost();
  const t = host.useTranslate();
  const [open, setOpen] = useState(defaultOpen);
  const regionId = useId();
  const canInteract = host.interactive && interactive !== false;
  if (evidence.length === 0) return null;

  return (
    <div className="space-y-2" data-study-evidence>
      <Button
        aria-controls={regionId}
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        size="xs"
        type="button"
        variant="outline"
      >
        <Quote aria-hidden />
        {t(open ? "study.evidence.hide" : "study.evidence.show")}
      </Button>
      {open ? (
        <ul className="space-y-2" id={regionId}>
          {evidence.map((entry, index) => (
            <EvidenceEntry
              artifactId={artifactId}
              evidence={entry}
              interactive={canInteract}
              key={`${entry.chunkId}-${index}`}
              workspaceId={workspaceId}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
