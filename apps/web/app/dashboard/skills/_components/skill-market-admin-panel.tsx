"use client";

import * as React from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import type {
  SkillCatalogCategory,
  SkillMarketStanding,
} from "@sourceweft/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@sourceweft/ui-web/components/ui/alert-dialog";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Switch } from "@sourceweft/ui-web/components/ui/switch";
import { cn } from "@sourceweft/ui-web/lib/utils";
import {
  delistSkill,
  getSkillMarketStanding,
  isSkillMarketAdminUnavailable,
  listSkillPublicly,
  setSkillCategories,
  setSkillVerified,
} from "../../../../lib/skill-market-admin";
import { formatInstallCount } from "./skills-market-browse";
import {
  canSaveSkillCategories,
  SKILL_CATEGORY_LIMIT,
  skillStandingKind,
  toggleSkillCategory,
} from "./skill-market-standing";
import { skillsMarketCopy } from "./skills-market-copy";

const copy = skillsMarketCopy.adminPanel;

function formatDate(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}

function errorCode(error: unknown) {
  return (error as { code?: unknown } | null)?.code;
}

/**
 * Market-admin controls for one community skill. Whether the viewer is an
 * admin is answered by the standing request itself: 403/404 renders nothing —
 * no error, no toast — so everyone else never learns the panel exists. After
 * every action the standing is fetched again rather than patched locally.
 */
export function SkillMarketAdminPanel({
  categories,
  onChanged,
  skillId,
}: {
  categories: SkillCatalogCategory[];
  /** The skill's public facts changed; the page may want to reload them. */
  onChanged?: () => void;
  skillId: string;
}) {
  const [standing, setStanding] = React.useState<SkillMarketStanding | null>(
    null,
  );
  const [selectedSlugs, setSelectedSlugs] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  // The action outlives the dialog's open state so its wording does not
  // change while the dialog animates out.
  const [confirmAction, setConfirmAction] = React.useState<"list" | "withdraw">(
    "list",
  );
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const generationRef = React.useRef(0);

  const load = React.useCallback(async () => {
    const generation = ++generationRef.current;
    try {
      const result = await getSkillMarketStanding(skillId);
      if (generationRef.current !== generation) return;
      setStanding(result);
      setSelectedSlugs(result.categorySlugs);
    } catch (loadError) {
      if (generationRef.current !== generation) return;
      // Not an admin, not a market skill, or the route is not there: no panel.
      // Any other failure also hides it — an admin aid must not break the page.
      setStanding(null);
      if (!isSkillMarketAdminUnavailable(loadError)) {
        console.warn("Skill market standing could not be loaded", loadError);
      }
    }
  }, [skillId]);

  React.useEffect(() => {
    void load();
    return () => {
      generationRef.current += 1;
    };
  }, [load]);

  async function run(action: () => Promise<unknown>, successMessage: string) {
    setBusy(true);
    try {
      await action();
      toast.success(successMessage);
      onChanged?.();
    } catch (actionError) {
      toast.error(
        errorCode(actionError) === "SKILL_CATEGORY_INVALID"
          ? copy.categoryInvalid
          : actionError instanceof Error && actionError.message
            ? actionError.message
            : copy.actionFailed,
      );
    } finally {
      await load();
      setBusy(false);
    }
  }

  if (!standing) return null;

  const kind = skillStandingKind(standing);
  const installs = formatInstallCount(standing.installCount) ?? "0";
  const categoriesDirty = canSaveSkillCategories(
    standing.categorySlugs,
    selectedSlugs,
  );
  // A slug the skill carries that the taxonomy no longer lists stays visible,
  // so an admin can see it and drop it.
  const knownSlugs = new Set(categories.map((category) => category.slug));
  const categoryChoices = [
    ...categories.map((category) => ({
      slug: category.slug,
      name: category.name,
    })),
    ...standing.categorySlugs
      .filter((slug) => !knownSlugs.has(slug))
      .map((slug) => ({ slug, name: slug })),
  ];

  return (
    <section
      aria-label={copy.title}
      className="rounded-2xl border border-border bg-background p-4 shadow-xs"
    >
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">{copy.title}</h2>
        {busy ? (
          <Loader2 className="ml-auto size-3.5 animate-spin text-muted-foreground" />
        ) : null}
      </div>

      <dl className="mt-3 space-y-3 text-xs">
        <div>
          <dt className="text-muted-foreground">{copy.standing}</dt>
          <dd
            className={cn(
              "mt-1 font-medium text-foreground",
              kind === "withdrawn" && "text-amber-700 dark:text-amber-300",
            )}
          >
            {kind === "public"
              ? copy.standingPublic
              : kind === "withdrawn"
                ? copy.standingWithdrawn
                : kind === "ownerPrivate"
                  ? copy.standingOwnerPrivate
                  : copy.standingRestricted}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{copy.listed}</dt>
          <dd className="mt-1 font-medium text-foreground">
            {standing.listedAt ? formatDate(standing.listedAt) : copy.notListed}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{copy.installs}</dt>
          <dd className="mt-1 font-medium text-foreground">{installs}</dd>
        </div>
      </dl>

      <div className="mt-4 border-t border-border pt-3">
        {kind === "public" ? (
          <Button
            className="w-full"
            disabled={busy}
            onClick={() => {
              setConfirmAction("withdraw");
              setConfirmOpen(true);
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {copy.withdraw}
          </Button>
        ) : (
          <Button
            className="w-full"
            disabled={busy}
            onClick={() => {
              setConfirmAction("list");
              setConfirmOpen(true);
            }}
            size="sm"
            type="button"
          >
            {copy.listPublicly}
          </Button>
        )}
      </div>

      <div className="mt-4 flex items-start justify-between gap-3 border-t border-border pt-3">
        <div className="min-w-0 text-xs">
          <label
            className="font-medium text-foreground"
            htmlFor="skill-market-verified"
          >
            {copy.verified}
          </label>
          <p className="mt-0.5 text-muted-foreground">{copy.verifiedHint}</p>
        </div>
        <Switch
          checked={standing.verified}
          disabled={busy}
          id="skill-market-verified"
          onCheckedChange={(checked) =>
            void run(
              () => setSkillVerified(skillId, checked),
              checked ? copy.verifiedToast : copy.unverifiedToast,
            )
          }
        />
      </div>

      <div className="mt-4 border-t border-border pt-3 text-xs">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="font-medium text-foreground">{copy.categories}</h3>
          <span className="text-muted-foreground">
            {copy.categoriesHint} {selectedSlugs.length}/{SKILL_CATEGORY_LIMIT}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {categoryChoices.map((category) => {
            const active = selectedSlugs.includes(category.slug);
            return (
              <button
                aria-pressed={active}
                className={cn(
                  "rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-60",
                  active &&
                    "border-primary bg-primary/10 font-medium text-foreground",
                )}
                disabled={
                  busy ||
                  (!active && selectedSlugs.length >= SKILL_CATEGORY_LIMIT)
                }
                key={category.slug}
                onClick={() =>
                  setSelectedSlugs((current) =>
                    toggleSkillCategory(current, category.slug),
                  )
                }
                type="button"
              >
                {category.name}
              </button>
            );
          })}
        </div>
        <Button
          className="mt-3 w-full"
          disabled={busy || !categoriesDirty}
          onClick={() =>
            void run(
              () => setSkillCategories(skillId, selectedSlugs),
              copy.categoriesToast,
            )
          }
          size="sm"
          type="button"
          variant="outline"
        >
          {copy.saveCategories}
        </Button>
      </div>

      <AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === "withdraw"
                ? copy.confirmWithdrawTitle
                : copy.confirmListTitle}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === "withdraw"
                ? copy.confirmWithdrawBody
                : copy.confirmListBody}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{copy.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                if (confirmAction === "withdraw") {
                  void run(() => delistSkill(skillId), copy.withdrawnToast);
                } else {
                  void run(() => listSkillPublicly(skillId), copy.listedToast);
                }
              }}
            >
              {confirmAction === "withdraw" ? copy.withdraw : copy.listPublicly}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
