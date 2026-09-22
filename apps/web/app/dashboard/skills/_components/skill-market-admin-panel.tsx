"use client";

import { formatDisplayDate } from "@/lib/i18n/format";
import { useLocale as useDisplayLocale } from "next-intl";
import * as React from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type {
  SkillCatalogCategory,
  SkillMarketClaim,
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
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { Switch } from "@sourceweft/ui-web/components/ui/switch";
import { cn } from "@sourceweft/ui-web/lib/utils";
import {
  delistSkill,
  getSkillMarketStanding,
  isSkillMarketAdminUnavailable,
  listSkillPublicly,
  setSkillCategories,
  setSkillFeatured,
  setSkillVerified,
} from "../../../../lib/skill-market-admin";
import {
  grantSkillClaim,
  revokeSkillClaim,
} from "../../../../lib/skill-claims";
import { formatInstallCount } from "./skills-market-browse";
import {
  canSaveSkillCategories,
  SKILL_CATEGORY_LIMIT,
  skillStandingKind,
  standingClaim,
  toggleSkillCategory,
} from "./skill-market-standing";

function formatDate(iso: string, displayLocale: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : formatDisplayDate(date, displayLocale, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}

function errorCode(error: unknown) {
  return (error as { code?: unknown } | null)?.code;
}

/** `t` is the `dashboardSkillsClaim` translator. */
function grantErrorMessage(
  error: unknown,
  t: ReturnType<typeof useTranslations>,
) {
  const code = errorCode(error);
  return code === "SKILL_CLAIM_USER_NOT_FOUND" ||
    code === "SKILL_REPO_ALREADY_CLAIMED"
    ? t(`admin.grantErrors.${code}`)
    : t("admin.grantErrors.fallback");
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
  onClaimChanged,
  repo,
  skillId,
}: {
  categories: SkillCatalogCategory[];
  /** The skill's public facts changed; the page may want to reload them. */
  onChanged?: () => void;
  /** A claim was granted or revoked: who holds the skill changed. */
  onClaimChanged?: () => void;
  /**
   * The skill's GitHub repository as `owner/repo`, which a claim is granted
   * on; null hides the grant form.
   */
  repo: string | null;
  skillId: string;
}) {
  const displayLocale = useDisplayLocale();
  const t = useTranslations("dashboardSkillsMarket");
  const tc = useTranslations("dashboardSkillsClaim");
  // The route also answers with the author's claim on the repository.
  const [standing, setStanding] = React.useState<
    (SkillMarketStanding & { claim?: SkillMarketClaim | null }) | null
  >(null);
  const [selectedSlugs, setSelectedSlugs] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  // The action outlives the dialog's open state so its wording does not
  // change while the dialog animates out.
  const [confirmAction, setConfirmAction] = React.useState<
    "list" | "withdraw" | "revokeClaim"
  >("list");
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [grantEmail, setGrantEmail] = React.useState("");
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

  async function run(
    action: () => Promise<unknown>,
    successMessage: string,
    failureMessage?: (error: unknown) => string,
  ) {
    setBusy(true);
    try {
      await action();
      toast.success(successMessage);
      onChanged?.();
    } catch (actionError) {
      toast.error(
        failureMessage
          ? failureMessage(actionError)
          : errorCode(actionError) === "SKILL_CATEGORY_INVALID"
            ? t("adminPanel.categoryInvalid")
            : actionError instanceof Error && actionError.message
              ? actionError.message
              : t("adminPanel.actionFailed"),
      );
    } finally {
      await load();
      setBusy(false);
    }
  }

  if (!standing) return null;

  const kind = skillStandingKind(standing);
  const claim = standingClaim(standing);
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
      aria-label={t("adminPanel.title")}
      className="rounded-2xl border border-border bg-background p-4 shadow-xs"
    >
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">
          {t("adminPanel.title")}
        </h2>
        {busy ? (
          <Loader2 className="ml-auto size-3.5 animate-spin text-muted-foreground" />
        ) : null}
      </div>

      <dl className="mt-3 space-y-3 text-xs">
        <div>
          <dt className="text-muted-foreground">{t("adminPanel.standing")}</dt>
          <dd
            className={cn(
              "mt-1 font-medium text-foreground",
              kind === "withdrawn" && "text-amber-700 dark:text-amber-300",
            )}
          >
            {kind === "public"
              ? t("adminPanel.standingPublic")
              : kind === "withdrawn"
                ? t("adminPanel.standingWithdrawn")
                : kind === "ownerPrivate"
                  ? t("adminPanel.standingOwnerPrivate")
                  : t("adminPanel.standingRestricted")}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("adminPanel.listed")}</dt>
          <dd className="mt-1 font-medium text-foreground">
            {standing.listedAt
              ? formatDate(standing.listedAt, displayLocale)
              : t("adminPanel.notListed")}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("adminPanel.installs")}</dt>
          <dd className="mt-1 font-medium text-foreground">{installs}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{tc("admin.claim")}</dt>
          <dd className="mt-1 font-medium break-all text-foreground">
            {claim
              ? `${tc("admin.claimedBy", { userId: claim.userId })} ${
                  tc.has(`admin.method.${claim.method}`)
                    ? tc(`admin.method.${claim.method}`)
                    : claim.method
                }${
                  claim.verifiedAt
                    ? ` · ${formatDate(claim.verifiedAt, displayLocale)}`
                    : ""
                }`
              : tc("admin.unclaimed")}
          </dd>
          {claim ? (
            <Button
              className="mt-2 w-full"
              disabled={busy}
              onClick={() => {
                setConfirmAction("revokeClaim");
                setConfirmOpen(true);
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              {tc("admin.revoke")}
            </Button>
          ) : repo ? (
            // Only unclaimed: a claim someone holds is revoked first.
            <form
              aria-label={tc("admin.grantTitle")}
              className="mt-2 space-y-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                const email = grantEmail.trim();
                if (!email) return;
                void run(
                  async () => {
                    await grantSkillClaim({ repo, email });
                    setGrantEmail("");
                    onClaimChanged?.();
                  },
                  tc("admin.grantedToast"),
                  (error) => grantErrorMessage(error, tc),
                );
              }}
            >
              <label
                className="block font-medium text-foreground"
                htmlFor="skill-market-grant-email"
              >
                {tc("admin.grantTitle")}
              </label>
              <p className="text-muted-foreground">{tc("admin.grantHint")}</p>
              <div className="flex gap-2">
                <Input
                  aria-label={tc("admin.grantEmailLabel")}
                  autoComplete="off"
                  className="h-8 min-w-0 flex-1 text-xs"
                  disabled={busy}
                  id="skill-market-grant-email"
                  onChange={(event) => setGrantEmail(event.target.value)}
                  placeholder={tc("admin.grantEmailPlaceholder")}
                  type="email"
                  value={grantEmail}
                />
                <Button
                  disabled={busy || !grantEmail.trim()}
                  size="sm"
                  type="submit"
                  variant="outline"
                >
                  {tc("admin.grant")}
                </Button>
              </div>
            </form>
          ) : null}
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
            {t("adminPanel.withdraw")}
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
            {t("adminPanel.listPublicly")}
          </Button>
        )}
      </div>

      <div className="mt-4 flex items-start justify-between gap-3 border-t border-border pt-3">
        <div className="min-w-0 text-xs">
          <label
            className="font-medium text-foreground"
            htmlFor="skill-market-verified"
          >
            {t("adminPanel.verified")}
          </label>
          <p className="mt-0.5 text-muted-foreground">
            {t("adminPanel.verifiedHint")}
          </p>
        </div>
        <Switch
          checked={standing.verified}
          disabled={busy}
          id="skill-market-verified"
          onCheckedChange={(checked) =>
            void run(
              () => setSkillVerified(skillId, checked),
              checked
                ? t("adminPanel.verifiedToast")
                : t("adminPanel.unverifiedToast"),
            )
          }
        />
      </div>

      <div className="mt-4 flex items-start justify-between gap-3 border-t border-border pt-3">
        <div className="min-w-0 text-xs">
          <label
            className="font-medium text-foreground"
            htmlFor="skill-market-featured"
          >
            {tc("featured.label")}
          </label>
          <p className="mt-0.5 text-muted-foreground">{tc("featured.hint")}</p>
          {standing.featuredSetBy ? (
            <p className="mt-0.5 text-muted-foreground">
              {standing.featuredSetBy === "admin"
                ? tc("featured.setByAdmin")
                : tc("featured.setBySync")}
            </p>
          ) : null}
        </div>
        <Switch
          // An older backend's standing has no `featured`: read it as off.
          checked={standing.featured === true}
          disabled={busy}
          id="skill-market-featured"
          onCheckedChange={(checked) =>
            void run(
              () => setSkillFeatured(skillId, checked),
              checked
                ? tc("featured.featuredToast")
                : tc("featured.unfeaturedToast"),
            )
          }
        />
      </div>

      <div className="mt-4 border-t border-border pt-3 text-xs">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="font-medium text-foreground">
            {t("adminPanel.categories")}
          </h3>
          <span className="text-muted-foreground">
            {t("adminPanel.categoriesHint")} {selectedSlugs.length}/
            {SKILL_CATEGORY_LIMIT}
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
              t("adminPanel.categoriesToast"),
            )
          }
          size="sm"
          type="button"
          variant="outline"
        >
          {t("adminPanel.saveCategories")}
        </Button>
      </div>

      <AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === "revokeClaim"
                ? tc("admin.confirmRevokeTitle")
                : confirmAction === "withdraw"
                  ? t("adminPanel.confirmWithdrawTitle")
                  : t("adminPanel.confirmListTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === "revokeClaim"
                ? tc("admin.confirmRevokeBody")
                : confirmAction === "withdraw"
                  ? t("adminPanel.confirmWithdrawBody")
                  : t("adminPanel.confirmListBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("adminPanel.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                if (confirmAction === "revokeClaim") {
                  const claimId = claim?.claimId;
                  if (claimId) {
                    void run(async () => {
                      await revokeSkillClaim(claimId);
                      onClaimChanged?.();
                    }, tc("admin.revokedToast"));
                  }
                } else if (confirmAction === "withdraw") {
                  void run(
                    () => delistSkill(skillId),
                    t("adminPanel.withdrawnToast"),
                  );
                } else {
                  void run(
                    () => listSkillPublicly(skillId),
                    t("adminPanel.listedToast"),
                  );
                }
              }}
            >
              {confirmAction === "revokeClaim"
                ? tc("admin.revoke")
                : confirmAction === "withdraw"
                  ? t("adminPanel.withdraw")
                  : t("adminPanel.listPublicly")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
