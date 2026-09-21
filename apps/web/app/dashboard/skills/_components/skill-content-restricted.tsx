import { ExternalLink, Lock } from "lucide-react";
import { skillsMarketCopy } from "./skills-market-copy";

const copy = skillsMarketCopy.detail;

/**
 * Shown in place of a community skill's SKILL.md / README when the server
 * withheld them (`contentRestricted`). That only happens for a skill that is
 * NOT publicly listed (restricted, or withdrawn from the market) and that this
 * viewer has no claim to — they have not installed it, did not submit it and
 * are not a market admin. A public skill always carries its full text. The
 * listing around the notice — description, license, scan state, files — is
 * complete either way.
 */
export function SkillContentRestricted({
  description,
  sourceUrl,
}: {
  /** The listing's own summary, for the overview tab. */
  description?: string;
  sourceUrl?: string | null;
}) {
  return (
    <div className="min-w-0 space-y-4 text-sm">
      {description ? <p className="leading-7">{description}</p> : null}
      <p
        className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-4 py-3 text-muted-foreground"
        role="note"
      >
        <Lock className="mt-0.5 size-4 shrink-0" />
        <span>
          {copy.restrictedNotice}
          {sourceUrl ? (
            <>
              {copy.restrictedSourceJoin}
              <a
                className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
                href={sourceUrl}
                rel="noreferrer noopener"
                target="_blank"
              >
                {copy.restrictedSourceLink}
                <ExternalLink className="size-3.5" />
              </a>
            </>
          ) : null}
          .
        </span>
      </p>
    </div>
  );
}
