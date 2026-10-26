"use client";

import * as React from "react";
import { BadgeCheck, Loader2, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import type { McpClaimOverview } from "@sourceweft/contracts";
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
import { Label } from "@sourceweft/ui-web/components/ui/label";
import { Switch } from "@sourceweft/ui-web/components/ui/switch";
import { Textarea } from "@sourceweft/ui-web/components/ui/textarea";

import {
  clearMcpOwnerTools,
  mcpClaimErrorMessage,
  revokeMcpClaim,
  setMcpOwnerOverrides,
} from "../../../../../lib/mcp-claims";
import { CopyField } from "./copy-field";
import {
  formatMcpClaimDate,
  OWNER_TEXT_LIMITS,
  OWNER_URL_FIELDS,
  ownerOverridesForm,
  ownerOverridesPayload,
  ownerOverridesProblems,
  ownerToolsCliSnippet,
  type OwnerFormProblem,
  type OwnerTextField,
  verifiedClaimOf,
} from "./mcp-claim-view";

/**
 * A verified owner's corrections to the listing: logo, descriptions, links
 * and a deprecation notice (saved as one set; an emptied field clears what
 * was stored), the standing of their CLI-submitted tool list, and giving the
 * claim up.
 */
export function McpOwnerPanel({
  onChanged,
  overview,
}: {
  onChanged: () => void | Promise<void>;
  overview: McpClaimOverview;
}) {
  const t = useTranslations("dashboardMcpClaim");
  const locale = useLocale();
  const [form, setForm] = React.useState(() =>
    ownerOverridesForm(overview.overrides?.values),
  );
  const [problems, setProblems] = React.useState<OwnerFormProblem[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [confirm, setConfirm] = React.useState<"tools" | "revoke" | null>(null);

  // A fresh overview (after a save, or another owner's edit) resets the form.
  const storedValues = overview.overrides?.values;
  React.useEffect(() => {
    setForm(ownerOverridesForm(storedValues));
    setProblems([]);
  }, [storedValues]);

  const tools = overview.overrides?.tools ?? null;
  const verifiedClaim = verifiedClaimOf(overview);

  function setField(field: OwnerTextField, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function problemOf(field: OwnerTextField) {
    return problems.find((problem) => problem.field === field) ?? null;
  }

  function problemText(problem: OwnerFormProblem) {
    return problem.kind === "url"
      ? t("owner.form.urlInvalid")
      : t("owner.form.tooLong", { max: problem.max });
  }

  async function run(action: () => Promise<string>, failed: string) {
    setBusy(true);
    try {
      const done = await action();
      toast.success(done);
      await onChanged();
    } catch (error) {
      toast.error(mcpClaimErrorMessage(error, t, failed));
    } finally {
      setBusy(false);
    }
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    const found = ownerOverridesProblems(form);
    setProblems(found);
    if (found.length > 0) return;
    void run(async () => {
      await setMcpOwnerOverrides(overview.identifier, ownerOverridesPayload(form));
      return t("owner.form.saved");
    }, t("owner.form.saveFailed"));
  }

  function removeTools() {
    void run(async () => {
      await clearMcpOwnerTools(overview.identifier);
      return t("owner.tools.removed");
    }, t("owner.tools.removeFailed"));
  }

  function revoke() {
    if (!verifiedClaim) return;
    const claimId = verifiedClaim.id;
    void run(async () => {
      await revokeMcpClaim(claimId);
      return t("owner.revoke.revoked");
    }, t("owner.revoke.revokeFailed"));
  }

  const urlLabels: Record<(typeof OWNER_URL_FIELDS)[number], string> = {
    iconUrl: t("owner.form.iconUrl"),
    documentationUrl: t("owner.form.documentationUrl"),
    homepageUrl: t("owner.form.homepageUrl"),
    repoUrl: t("owner.form.repoUrl"),
  };

  return (
    <div className="space-y-4" data-testid="mcp-owner-panel">
      <section
        aria-label={t("owner.title")}
        className="rounded-2xl border border-border bg-background p-5 shadow-xs"
      >
        <p className="flex items-center gap-1.5 text-sm text-foreground">
          <BadgeCheck className="size-4 text-primary" />
          {t("page.claimedByYou")}
        </p>
        <h2 className="mt-4 text-sm font-semibold text-foreground">
          {t("owner.title")}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("owner.intro")}</p>

        <form className="mt-4 space-y-4" onSubmit={save}>
          <div className="space-y-1.5">
            <Label htmlFor="mcp-owner-iconUrl">{urlLabels.iconUrl}</Label>
            <Input
              aria-invalid={Boolean(problemOf("iconUrl"))}
              autoComplete="off"
              id="mcp-owner-iconUrl"
              inputMode="url"
              onChange={(event) => setField("iconUrl", event.target.value)}
              placeholder="https://"
              spellCheck={false}
              value={form.iconUrl}
            />
            {problemOf("iconUrl") ? (
              <p className="text-xs text-destructive">
                {problemText(problemOf("iconUrl")!)}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mcp-owner-summary">{t("owner.form.summary")}</Label>
            <Input
              aria-invalid={Boolean(problemOf("summary"))}
              id="mcp-owner-summary"
              maxLength={OWNER_TEXT_LIMITS.summary}
              onChange={(event) => setField("summary", event.target.value)}
              value={form.summary}
            />
            <p className="text-xs text-muted-foreground">
              {t("owner.form.summaryHint")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mcp-owner-description">
              {t("owner.form.description")}
            </Label>
            <Textarea
              aria-invalid={Boolean(problemOf("description"))}
              id="mcp-owner-description"
              maxLength={OWNER_TEXT_LIMITS.description}
              onChange={(event) => setField("description", event.target.value)}
              rows={6}
              value={form.description}
            />
            <p className="text-xs text-muted-foreground">
              {t("owner.form.descriptionHint")}
            </p>
          </div>

          {(["license", "language"] as const).map((field) => (
            <div className="space-y-1.5" key={field}>
              <Label htmlFor={`mcp-owner-${field}`}>
                {t(`owner.form.${field}`)}
              </Label>
              <Input
                aria-invalid={Boolean(problemOf(field))}
                autoComplete="off"
                id={`mcp-owner-${field}`}
                maxLength={OWNER_TEXT_LIMITS[field]}
                onChange={(event) => setField(field, event.target.value)}
                spellCheck={false}
                value={form[field]}
              />
              <p className="text-xs text-muted-foreground">
                {t(`owner.form.${field}Hint`)}
              </p>
            </div>
          ))}

          {(["documentationUrl", "homepageUrl", "repoUrl"] as const).map(
            (field) => (
              <div className="space-y-1.5" key={field}>
                <Label htmlFor={`mcp-owner-${field}`}>{urlLabels[field]}</Label>
                <Input
                  aria-invalid={Boolean(problemOf(field))}
                  autoComplete="off"
                  id={`mcp-owner-${field}`}
                  inputMode="url"
                  onChange={(event) => setField(field, event.target.value)}
                  placeholder="https://"
                  spellCheck={false}
                  value={form[field]}
                />
                {problemOf(field) ? (
                  <p className="text-xs text-destructive">
                    {problemText(problemOf(field)!)}
                  </p>
                ) : null}
              </div>
            ),
          )}

          <div className="flex items-start gap-3 rounded-lg border border-border p-3">
            <Switch
              aria-labelledby="mcp-owner-deprecated-label"
              checked={form.deprecated}
              id="mcp-owner-deprecated"
              onCheckedChange={(checked) =>
                setForm((current) => ({ ...current, deprecated: checked }))
              }
            />
            <div className="space-y-0.5">
              <Label
                className="text-sm"
                htmlFor="mcp-owner-deprecated"
                id="mcp-owner-deprecated-label"
              >
                {t("owner.form.deprecated")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("owner.form.deprecatedHint")}
              </p>
            </div>
          </div>

          <Button disabled={busy} size="sm" type="submit">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t("owner.form.save")}
          </Button>
        </form>
      </section>

      <section
        aria-label={t("owner.tools.title")}
        className="rounded-2xl border border-border bg-background p-5 shadow-xs"
        data-testid="mcp-owner-tools"
      >
        <h2 className="text-sm font-semibold text-foreground">
          {t("owner.tools.title")}
        </h2>
        <p className="mt-2 text-xs text-foreground">
          {tools
            ? t("owner.tools.count", {
                count: tools.count,
                date: formatMcpClaimDate(tools.submittedAt, locale),
              })
            : t("owner.tools.none")}
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          {t("owner.tools.cliHint")}
        </p>
        <div className="mt-3">
          <CopyField
            label="CLI"
            multiline
            value={ownerToolsCliSnippet(overview.identifier)}
          />
        </div>
        {tools ? (
          <Button
            className="mt-4"
            disabled={busy}
            onClick={() => setConfirm("tools")}
            size="sm"
            type="button"
            variant="outline"
          >
            <Trash2 className="size-3.5" />
            {t("owner.tools.remove")}
          </Button>
        ) : null}
      </section>

      {verifiedClaim ? (
        <section
          aria-label={t("owner.revoke.action")}
          className="rounded-2xl border border-border bg-background p-5 shadow-xs"
        >
          <p className="text-xs text-muted-foreground">{t("owner.revoke.hint")}</p>
          <Button
            className="mt-3"
            disabled={busy}
            onClick={() => setConfirm("revoke")}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("owner.revoke.action")}
          </Button>
        </section>
      ) : null}

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        open={confirm !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "revoke"
                ? t("owner.revoke.confirmTitle")
                : t("owner.tools.confirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "revoke"
                ? t("owner.revoke.confirmBody", { name: overview.name })
                : t("owner.tools.confirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {confirm === "revoke"
                ? t("owner.revoke.cancel")
                : t("owner.tools.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const which = confirm;
                setConfirm(null);
                if (which === "revoke") revoke();
                else if (which === "tools") removeTools();
              }}
            >
              {confirm === "revoke"
                ? t("owner.revoke.confirm")
                : t("owner.tools.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
