"use client";

import {
  CreateOrganizationDialog,
  OrganizationMembersCard,
  OrganizationSettingsCards,
  OrganizationSwitcher,
  OrganizationsCard,
  UserButton,
} from "@daveyplate/better-auth-ui";
import Link from "next/link";
import { useState } from "react";

export default function TeamSettingsPage() {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <main className="container space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <OrganizationSwitcher />
          <button
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
            onClick={() => setCreateOpen(true)}
            type="button"
          >
            Create Organization
          </button>
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
            href="/organization/settings"
          >
            Organization View
          </Link>
        </div>
      </div>

      <CreateOrganizationDialog
        onOpenChange={setCreateOpen}
        open={createOpen}
      />

      <OrganizationSettingsCards />
      <OrganizationMembersCard />
      <OrganizationsCard />
    </main>
  );
}
