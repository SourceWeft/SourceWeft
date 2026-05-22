"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { toast } from "sonner";
import { useTheme } from "next-themes";
import { authClient } from "../../../../lib/auth-client";

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
  const [displayName, setDisplayName] = React.useState(userName ?? "");
  const [avatarPreview, setAvatarPreview] = React.useState<string | null>(
    userImage ?? null,
  );
  const [avatarDirty, setAvatarDirty] = React.useState(false);
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [isSigningOut, setIsSigningOut] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const { theme, setTheme } = useTheme();

  React.useEffect(() => {
    setDisplayName(userName ?? "");
  }, [userName]);
  React.useEffect(() => {
    setAvatarPreview(userImage ?? null);
    setAvatarDirty(false);
  }, [userImage]);

  const trimmed = displayName.trim();
  const isDirty = trimmed !== (userName ?? "") || avatarDirty;

  async function handleSave() {
    if (!trimmed) {
      setNameError("Name is required.");
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
            "Unable to save.",
        );
      }
      setAvatarDirty(false);
      toast.success("Profile saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to save.");
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
            "Unable to delete account.",
        );
      }
      toast.success("Account deletion started");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Unable to delete account.",
      );
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      await authClient.signOut();
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <div className="w-full max-w-2xl divide-y divide-border/60">
      {/* ── Profile ── */}
      <div className="pb-7 pt-1">
        <p className="mb-5 text-base font-semibold text-foreground">Profile</p>
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
              title="Change avatar"
              type="button"
            >
              {avatarPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
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
                Change
              </span>
            </button>
          </div>

          {/* Name field */}
          <div className="flex-1">
            <label
              className="mb-1.5 block text-xs font-medium text-muted-foreground"
              htmlFor="display-name"
            >
              Display name
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
              placeholder="Your display name"
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
                  {isSaving ? "Saving…" : "Save changes"}
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
                  Cancel
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Appearance ── */}
      <div className="py-7">
        <p className="mb-4 text-base font-semibold text-foreground">
          Appearance
        </p>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-foreground">Theme</p>
            <p className="text-xs text-muted-foreground">
              Choose how SourceWeft looks to you.
            </p>
          </div>
          <div className="flex rounded-lg border border-border bg-muted/40 p-0.5">
            {(["light", "system", "dark"] as const).map((t) => (
              <button
                className={cn(
                  "rounded-md px-3 py-1 text-xs transition-colors",
                  (theme ?? "system") === t
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                key={t}
                onClick={() => setTheme(t)}
                type="button"
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Language ── */}
      <div className="py-7">
        <p className="mb-4 text-base font-semibold text-foreground">Language</p>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-foreground">Interface language</p>
            <button
              className="inline-flex h-8 min-w-[130px] cursor-not-allowed items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-sm text-foreground opacity-60"
              disabled
              type="button"
            >
              English
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-foreground">Response language</p>
              <p className="text-xs text-muted-foreground">Not available yet</p>
            </div>
            <button
              className="inline-flex h-8 min-w-[130px] cursor-not-allowed items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-sm text-muted-foreground opacity-40"
              disabled
              type="button"
            >
              Coming soon
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* ── Account ── */}
      <div className="pt-7">
        <p className="mb-4 text-base font-semibold text-foreground">Account</p>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-foreground">{userEmail}</p>
              <p className="text-xs text-muted-foreground">Signed-in account</p>
            </div>
            <Button
              disabled={isSigningOut}
              onClick={() => void handleSignOut()}
              size="sm"
              type="button"
              variant="outline"
            >
              {isSigningOut ? "Signing out…" : "Sign out"}
            </Button>
          </div>
          <div className="flex items-start justify-between gap-4 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-destructive">
                Delete account
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Permanently removes your account and all data. Cannot be undone.
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
              {isDeleting ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
