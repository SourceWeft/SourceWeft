"use client";
import { disconnectLocalHostSession } from "../../../../lib/local-host-session";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { toast } from "sonner";
import { useTheme } from "next-themes";
import { DEFAULT_USER_THEME } from "@sourceweft/contracts";
import {
  getLocaleMeta,
  LOCALE_IDS,
  type Locale,
} from "@sourceweft/i18n/locales";
import { authClient } from "../../../../lib/auth-client";
import { userSettingsClient } from "../../../../lib/sdk";
import { clearLocaleCookie, setLocaleCookie } from "../../../../lib/i18n/cookie";
import { RawImage } from "../../../_components/raw-image";

// Mirrors `userLanguageSchema` in @sourceweft/contracts: "system" follows the
// browser, the rest are the supported locales.
type UserLanguage = "system" | Locale;

export function AccountPanel({
  userName,
  userEmail,
  userImage,
  initials,
}: {
  userName?: string;
  userEmail?: string;
  userImage?: string | null;
  initials: string;
}) {
  const t = useTranslations("dashboardSettings");
  const router = useRouter();
  const [displayName, setDisplayName] = React.useState(userName ?? "");
  const [avatarPreview, setAvatarPreview] = React.useState<string | null>(
    userImage ?? null,
  );
  const [avatarDirty, setAvatarDirty] = React.useState(false);
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [isSigningOut, setIsSigningOut] = React.useState(false);
  const [isThemeSaving, setIsThemeSaving] = React.useState(false);
  const [language, setLanguage] = React.useState<UserLanguage>("system");
  const [isLanguageSaving, setIsLanguageSaving] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const { theme, setTheme } = useTheme();

  React.useEffect(() => {
    setDisplayName(userName ?? "");
  }, [userName]);
  // Hydrate the language control from the saved user setting (the same source
  // UserSettingsSync reads), so the dropdown shows the user's real choice.
  React.useEffect(() => {
    let cancelled = false;
    void userSettingsClient
      .getSettings()
      .then((result) => {
        if (!cancelled) {
          setLanguage(result.settings.appearance.language);
        }
      })
      .catch(() => {
        // Leave the default ("system"); the switcher still persists on change.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  React.useEffect(() => {
    setAvatarPreview(userImage ?? null);
    setAvatarDirty(false);
  }, [userImage]);

  const trimmed = displayName.trim();
  const isDirty = trimmed !== (userName ?? "") || avatarDirty;

  async function handleSave() {
    if (!trimmed) {
      setNameError(t("account.nameRequired"));
      return;
    }
    setNameError(null);
    setIsSaving(true);
    try {
      const result = await authClient.updateUser({
        name: trimmed,
        image: avatarPreview ?? undefined,
      });
      if ((result as { error?: { message?: string } } | null)?.error) {
        throw new Error(
          (result as { error?: { message?: string } }).error?.message ??
            t("account.saveError"),
        );
      }
      setAvatarDirty(false);
      toast.success(t("account.profileSaved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("account.saveError"));
    } finally {
      setIsSaving(false);
    }
  }

  function handleAvatarFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setAvatarPreview(
        typeof reader.result === "string" ? reader.result : null,
      );
      setAvatarDirty(true);
    };
    reader.readAsDataURL(file);
  }

  async function handleDeleteAccount() {
    setIsDeleting(true);
    try {
      const result = await authClient.deleteUser();
      if ((result as { error?: { message?: string } } | null)?.error) {
        throw new Error(
          (result as { error?: { message?: string } }).error?.message ??
            t("account.deleteError"),
        );
      }
      toast.success(t("account.deleteStarted"));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("account.deleteError"),
      );
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      await disconnectLocalHostSession();
      await authClient.signOut();
    } finally {
      setIsSigningOut(false);
    }
  }

  async function handleThemeChange(nextTheme: "light" | "system" | "dark") {
    const previousTheme =
      theme === "light" || theme === "dark" || theme === "system"
        ? theme
        : DEFAULT_USER_THEME;
    setTheme(nextTheme);
    setIsThemeSaving(true);
    try {
      await userSettingsClient.updateSettings({
        appearance: { theme: nextTheme },
      });
    } catch {
      setTheme(previousTheme);
      toast.error(t("appearance.theme.saveError"));
    } finally {
      setIsThemeSaving(false);
    }
  }

  // Mirror UserSettingsSync's language→cookie mapping: "system" clears the
  // explicit cookie (follow the browser); a locale sets it.
  function applyLocaleCookie(next: UserLanguage) {
    if (next === "system") {
      clearLocaleCookie();
    } else {
      setLocaleCookie(next);
    }
  }

  async function handleLanguageChange(next: UserLanguage) {
    const previous = language;
    if (next === previous) {
      return;
    }
    setLanguage(next);
    // Take effect immediately: update the cookie the proxy reads, then refresh
    // so the current view re-renders in the new locale.
    applyLocaleCookie(next);
    setIsLanguageSaving(true);
    router.refresh();
    try {
      await userSettingsClient.updateSettings({
        appearance: { language: next },
      });
    } catch {
      // Roll back the optimistic choice and the cookie on failure.
      setLanguage(previous);
      applyLocaleCookie(previous);
      router.refresh();
      toast.error(t("language.saveError"));
    } finally {
      setIsLanguageSaving(false);
    }
  }

  return (
    <div className="w-full max-w-2xl divide-y divide-border/60">
      {/* ── Profile ── */}
      <div className="pb-7 pt-1">
        <p className="mb-5 text-base font-semibold text-foreground">
          {t("account.profileTitle")}
        </p>
        <div className="flex gap-5">
          {/* Avatar */}
          <div className="shrink-0">
            <input
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={handleAvatarFile}
              ref={fileInputRef}
              type="file"
            />
            <button
              className="group relative h-14 w-14 overflow-hidden rounded-full border border-border bg-muted text-sm font-semibold text-foreground"
              onClick={() => fileInputRef.current?.click()}
              title={t("account.changeAvatar")}
              type="button"
            >
              {avatarPreview ? (
                <RawImage
                  alt="Avatar"
                  className="h-full w-full object-cover"
                  src={avatarPreview}
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center">
                  {initials}
                </span>
              )}
              <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-[10px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
                {t("account.changeAvatarOverlay")}
              </span>
            </button>
          </div>

          {/* Name field */}
          <div className="flex-1">
            <label
              className="mb-1.5 block text-xs font-medium text-muted-foreground"
              htmlFor="display-name"
            >
              {t("account.displayName")}
            </label>
            <input
              className={cn(
                "h-9 w-full rounded-lg border bg-background px-3 text-sm text-foreground outline-none transition focus-visible:ring-2 focus-visible:ring-ring",
                nameError ? "border-destructive" : "border-border",
              )}
              id="display-name"
              onChange={(e) => {
                setDisplayName(e.target.value);
                if (nameError) setNameError(null);
              }}
              placeholder={t("account.displayNamePlaceholder")}
              type="text"
              value={displayName}
            />
            {nameError ? (
              <p className="mt-1 text-xs text-destructive">{nameError}</p>
            ) : null}
            {isDirty && (
              <div className="mt-3 flex items-center gap-2">
                <Button
                  disabled={isSaving}
                  onClick={() => void handleSave()}
                  size="sm"
                  type="button"
                >
                  {isSaving ? t("account.saving") : t("account.saveChanges")}
                </Button>
                <Button
                  disabled={isSaving}
                  onClick={() => {
                    setDisplayName(userName ?? "");
                    setAvatarPreview(userImage ?? null);
                    setAvatarDirty(false);
                    setNameError(null);
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {t("common.cancel")}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Appearance ── */}
      <div className="py-7">
        <p className="mb-4 text-base font-semibold text-foreground">
          {t("appearance.title")}
        </p>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-foreground">
              {t("appearance.theme.label")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("appearance.theme.description")}
            </p>
          </div>
          <div className="flex rounded-lg border border-border bg-muted/40 p-0.5">
            {(["light", "system", "dark"] as const).map((themeOption) => (
              <button
                className={cn(
                  "rounded-md px-3 py-1 text-xs transition-colors",
                  (theme ?? DEFAULT_USER_THEME) === themeOption
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                disabled={isThemeSaving}
                key={themeOption}
                onClick={() => void handleThemeChange(themeOption)}
                type="button"
              >
                {t(`appearance.theme.${themeOption}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Language ── */}
      <div className="py-7">
        <p className="mb-4 text-base font-semibold text-foreground">
          {t("language.title")}
        </p>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-foreground">{t("language.label")}</p>
              <p className="text-xs text-muted-foreground">
                {t("language.description")}
              </p>
            </div>
            {/* Persists appearance.language and updates the locale cookie so the
                choice takes effect immediately (see handleLanguageChange). */}
            <div className="relative shrink-0">
              <select
                aria-label={t("language.label")}
                className="h-8 min-w-[150px] cursor-pointer appearance-none rounded-lg border border-border bg-background pl-3 pr-8 text-sm text-foreground outline-none transition focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isLanguageSaving}
                onChange={(event) =>
                  void handleLanguageChange(event.target.value as UserLanguage)
                }
                value={language}
              >
                <option value="system">{t("language.system")}</option>
                {LOCALE_IDS.map((id) => (
                  <option key={id} value={id}>
                    {getLocaleMeta(id).nativeLabel}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            </div>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-foreground">
                {t("language.responseLabel")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("language.responseUnavailable")}
              </p>
            </div>
            <button
              className="inline-flex h-8 min-w-[130px] cursor-not-allowed items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-sm text-muted-foreground opacity-40"
              disabled
              type="button"
            >
              {t("language.comingSoon")}
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* ── Account ── */}
      <div className="pt-7">
        <p className="mb-4 text-base font-semibold text-foreground">
          {t("account.accountTitle")}
        </p>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-foreground">{userEmail}</p>
              <p className="text-xs text-muted-foreground">
                {t("account.signedInAccount")}
              </p>
            </div>
            <Button
              disabled={isSigningOut}
              onClick={() => void handleSignOut()}
              size="sm"
              type="button"
              variant="outline"
            >
              {isSigningOut
                ? t("account.signingOut")
                : t("account.signOut")}
            </Button>
          </div>
          <div className="flex items-start justify-between gap-4 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-destructive">
                {t("account.deleteAccount")}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("account.deleteAccountDescription")}
              </p>
            </div>
            <Button
              className="shrink-0"
              disabled={isDeleting}
              onClick={() => void handleDeleteAccount()}
              size="sm"
              type="button"
              variant="destructive"
            >
              {isDeleting ? t("account.deleting") : t("account.delete")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
