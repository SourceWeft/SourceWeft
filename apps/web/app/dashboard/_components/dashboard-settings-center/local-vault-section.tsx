"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  desktopBridge,
  type VaultListing,
} from "../../../../lib/desktop-bridge";

/** The native side lacks the vault commands (older app, unsupported platform). */
function isMissingCommand(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|not allowed|UNSUPPORTED_PLATFORM/i.test(message);
}

function parseHosts(text: string) {
  return text
    .split(/[\n,]/)
    .map((host) => host.trim())
    .filter(Boolean);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Secrets for local commands, desktop only. The value is typed into an
 * uncontrolled field and read once in the submit handler: it is never kept in
 * React state, never rendered back, logged, or put in a URL or storage, and
 * the field is emptied as soon as the keychain has it.
 */
export function LocalVaultSection() {
  const t = useTranslations("dashboardSettings");
  const [listing, setListing] = useState<VaultListing | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [label, setLabel] = useState("");
  const [envVar, setEnvVar] = useState("");
  const [hosts, setHosts] = useState("");
  const [requireWriteApproval, setRequireWriteApproval] = useState(true);
  const valueRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await desktopBridge.vaultList();
      setListing(next);
      setLoadFailed(false);
      // Consent is asked again whenever the vault is back to empty.
      if (next.secrets.length === 0) setAcknowledged(false);
    } catch (e) {
      if (isMissingCommand(e)) setHidden(true);
      else setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!desktopBridge.isAvailable()) return;
    void refresh();
  }, [refresh]);

  if (!desktopBridge.isAvailable() || hidden) return null;

  const secrets = listing?.secrets ?? [];
  const needsConsent = secrets.length === 0;

  function resetForm() {
    setLabel("");
    setEnvVar("");
    setHosts("");
    setRequireWriteApproval(true);
    if (valueRef.current) valueRef.current.value = "";
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || (needsConsent && !acknowledged)) return;
    // The only place the secret value is read.
    const value = valueRef.current?.value ?? "";
    setBusy(true);
    setError(null);
    try {
      await desktopBridge.vaultSet({
        label: label.trim(),
        envVar: envVar.trim(),
        value,
        hosts: parseHosts(hosts),
        readOnly: requireWriteApproval,
      });
      resetForm();
      setAdding(false);
      await refresh();
    } catch (e) {
      // The native message names the rule that failed; the typed value stays
      // in the field so a typo in another field can be fixed.
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await desktopBridge.vaultRemove(id);
      setConfirmingId(null);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-4" data-testid="vault-section">
      <h3 className="font-medium">{t("localHost.vault.title")}</h3>
      <p className="text-sm text-muted-foreground">
        {t("localHost.vault.description")}
      </p>
      {listing && !listing.enforced && (
        <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
          {t("localHost.vault.notEnforced")}
        </p>
      )}
      {loadFailed && (
        <p role="alert" className="text-sm text-destructive">
          {t("localHost.vault.loadError")}
        </p>
      )}
      {listing && secrets.length === 0 && !adding && (
        <p className="text-sm text-muted-foreground">
          {t("localHost.vault.empty")}
        </p>
      )}
      <ul className="space-y-2">
        {secrets.map((secret) => (
          <li
            key={secret.id}
            className="flex items-start gap-3 rounded-md border p-3"
            data-testid="vault-secret"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <p className="truncate text-sm font-medium">{secret.label}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {secret.envVar}
              </p>
              <p className="break-all text-xs text-muted-foreground">
                {t("localHost.vault.hostsLine", {
                  hosts: secret.hosts.join(", "),
                })}
              </p>
              {secret.readOnly && (
                <span className="inline-block rounded bg-muted px-1.5 py-0.5 text-xs">
                  {t("localHost.vault.writesNeedApproval")}
                </span>
              )}
            </div>
            {confirmingId === secret.id ? (
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs">
                  {t("localHost.vault.removeQuestion", {
                    label: secret.label,
                  })}
                </span>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void remove(secret.id)}
                >
                  {t("localHost.vault.confirmRemove")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setConfirmingId(null)}
                >
                  {t("localHost.vault.cancel")}
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setConfirmingId(secret.id)}
              >
                {t("localHost.vault.remove")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {adding ? (
        <form className="space-y-3" onSubmit={(e) => void submit(e)}>
          <label className="block space-y-1 text-sm">
            <span>{t("localHost.vault.labelField")}</span>
            <input
              className="block h-9 w-full rounded-md border border-border bg-background px-2"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={100}
              required
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>{t("localHost.vault.envVarField")}</span>
            <input
              className="block h-9 w-full rounded-md border border-border bg-background px-2 font-mono"
              value={envVar}
              onChange={(e) => setEnvVar(e.target.value)}
              placeholder="GITHUB_TOKEN"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>{t("localHost.vault.valueField")}</span>
            <input
              ref={valueRef}
              type="password"
              className="block h-9 w-full rounded-md border border-border bg-background px-2 font-mono"
              autoComplete="off"
              spellCheck={false}
              required
            />
            <span className="block text-xs text-muted-foreground">
              {t("localHost.vault.valueHelp")}
            </span>
          </label>
          <label className="block space-y-1 text-sm">
            <span>{t("localHost.vault.hostsField")}</span>
            <textarea
              className="block min-h-20 w-full rounded-md border border-border bg-background p-2 font-mono text-xs"
              value={hosts}
              onChange={(e) => setHosts(e.target.value)}
              placeholder={"api.github.com\n*.example.com"}
              spellCheck={false}
              required
            />
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={requireWriteApproval}
              onChange={(e) => setRequireWriteApproval(e.target.checked)}
            />
            <span>{t("localHost.vault.readOnlyField")}</span>
          </label>
          {needsConsent && (
            <div
              className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3"
              data-testid="vault-consent"
            >
              <p className="text-sm">{t("localHost.vault.consent")}</p>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
                <span>{t("localHost.vault.consentAck")}</span>
              </label>
            </div>
          )}
          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={busy || (needsConsent && !acknowledged)}
            >
              {busy ? t("localHost.vault.saving") : t("localHost.vault.save")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                resetForm();
                setError(null);
                setAdding(false);
              }}
            >
              {t("localHost.vault.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <Button
          variant="outline"
          disabled={busy || !listing}
          onClick={() => {
            setError(null);
            setAdding(true);
          }}
        >
          {t("localHost.vault.add")}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
