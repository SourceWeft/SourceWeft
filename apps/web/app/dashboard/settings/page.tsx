"use client";

import {
  AccountSettingsCards,
  AccountsCard,
  ApiKeysCard,
  ChangeEmailCard,
  ChangePasswordCard,
  DeleteAccountCard,
  OrganizationSwitcher,
  PasskeysCard,
  ProvidersCard,
  SecuritySettingsCards,
  SessionsCard,
  TwoFactorCard,
  UpdateAvatarCard,
  UpdateFieldCard,
  UpdateNameCard,
  UpdateUsernameCard,
  UserButton,
} from "@daveyplate/better-auth-ui";
import Link from "next/link";

export default function SettingsPage() {
  return (
    <main className="container space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <OrganizationSwitcher />
          <UserButton />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-600">
          <Link
            className="underline-offset-4 hover:underline"
            href="/dashboard"
          >
            Dashboard
          </Link>
          <Link
            className="underline-offset-4 hover:underline"
            href="/account/profile"
          >
            Account View
          </Link>
        </div>
      </div>

      <AccountSettingsCards />
      <SecuritySettingsCards />

      <div className="grid gap-4 md:grid-cols-2">
        <ChangeEmailCard />
        <ChangePasswordCard />
        <DeleteAccountCard />
        <ProvidersCard />
        <SessionsCard />
        <TwoFactorCard />
        <PasskeysCard />
        <UpdateAvatarCard />
        <UpdateUsernameCard />
        <UpdateNameCard />
        <UpdateFieldCard name="bio" />
        <AccountsCard />
        <ApiKeysCard />
      </div>
    </main>
  );
}
