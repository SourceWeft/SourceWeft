"use client";

import {
  CreateOrganizationDialog,
  OrganizationSwitcher,
  UserButton,
  useAuthenticate,
} from "@daveyplate/better-auth-ui";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { authClient } from "../../lib/auth-client";
import { workspaceClient } from "../../lib/sdk";

type Organization = {
  id: string;
  name: string;
  slug?: string;
};

type Workspace = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  createdBy: string;
  createdAt: string;
};

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 42);
}

function parseOrganizations(payload: unknown): Organization[] {
  if (Array.isArray(payload)) {
    return payload.filter(
      (item): item is Organization =>
        typeof item === "object" &&
        item !== null &&
        "id" in item &&
        "name" in item,
    );
  }

  if (
    payload &&
    typeof payload === "object" &&
    "data" in payload &&
    Array.isArray((payload as { data?: unknown }).data)
  ) {
    return parseOrganizations((payload as { data: unknown }).data);
  }

  return [];
}

function message(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const value = (error as { message?: unknown }).message;
    if (typeof value === "string") return value;
  }
  return "Operation failed";
}

export default function DashboardPage() {
  const authState = useAuthenticate();
  const sessionState = authState.data as
    | {
        user?: { email?: string };
        session?: { activeOrganizationId?: string | null };
      }
    | null
    | undefined;

  const hasSession = Boolean(sessionState);
  const sessionActiveOrganizationId =
    sessionState?.session?.activeOrganizationId || null;
  const sessionEmail = sessionState?.user?.email || null;

  const [createOrgOpen, setCreateOrgOpen] = useState(false);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(
    null,
  );
  const [newOrgName, setNewOrgName] = useState("");
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeOrg = useMemo(
    () => organizations.find((o) => o.id === activeOrgId) || null,
    [organizations, activeOrgId],
  );

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId) || null,
    [workspaces, activeWorkspaceId],
  );

  useEffect(() => {
    async function loadOrganizations() {
      if (!hasSession) return;
      const result = await authClient.organization.list();
      const items = parseOrganizations(result?.data ?? result);
      setOrganizations(items);
      setActiveOrgId(sessionActiveOrganizationId || items[0]?.id || null);
    }
    void loadOrganizations().catch((e) => setError(message(e)));
  }, [hasSession, sessionActiveOrganizationId, sessionEmail]);

  useEffect(() => {
    async function loadWorkspaces() {
      if (!activeOrgId) {
        setWorkspaces([]);
        setActiveWorkspaceId(null);
        return;
      }
      const response = await workspaceClient.listWorkspaces(activeOrgId);
      const items = response.items;
      setWorkspaces(items);
      setActiveWorkspaceId((current) => current || items[0]?.id || null);
    }
    void loadWorkspaces().catch((e) => setError(message(e)));
  }, [activeOrgId]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  if (authState.isPending) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl items-center justify-center p-8">
        Loading...
      </main>
    );
  }

  if (!sessionState) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl items-center justify-center p-8">
        Unable to resolve session.
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl gap-6 p-6">
      <aside className="w-24 shrink-0 rounded-2xl border border-zinc-200 bg-white p-3">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
          Spaces
        </p>
        <div className="space-y-2">
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              type="button"
              className={`flex h-10 w-10 items-center justify-center rounded-lg border text-xs font-semibold ${
                ws.id === activeWorkspaceId
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-200 bg-zinc-50 text-zinc-700"
              }`}
              title={ws.name}
              onClick={() => setActiveWorkspaceId(ws.id)}
            >
              {ws.name.slice(0, 2).toUpperCase()}
            </button>
          ))}
        </div>
      </aside>

      <section className="flex-1 space-y-4 rounded-2xl border border-zinc-200 bg-white p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900">Dashboard</h1>
            <p className="text-sm text-zinc-600">
              Signed in as {sessionState.user?.email || "user"}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              href="/dashboard/team"
            >
              Team
            </Link>
            <Link
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              href="/dashboard/settings"
            >
              Settings
            </Link>
            <Link
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              href="/dashboard/billing"
            >
              Billing
            </Link>
            <OrganizationSwitcher />
            <button
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              onClick={() => setCreateOrgOpen(true)}
              type="button"
            >
              Create org
            </button>
            <UserButton />
          </div>
        </header>

        <CreateOrganizationDialog
          onOpenChange={setCreateOrgOpen}
          open={createOrgOpen}
        />

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 rounded-xl border border-zinc-200 bg-zinc-50 p-4">
            <h2 className="text-sm font-semibold text-zinc-800">
              Organization
            </h2>
            <select
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
              value={activeOrgId || ""}
              onChange={(e) => {
                const organizationId = e.target.value;
                void run(async () => {
                  await authClient.organization.setActive({ organizationId });
                  setActiveOrgId(organizationId);
                  setStatus("Active organization updated");
                });
              }}
            >
              <option value="" disabled>
                Select organization
              </option>
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>

            <div className="flex gap-2">
              <input
                className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                placeholder="New organization name"
              />
              <button
                type="button"
                className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                disabled={busy}
                onClick={() => {
                  void run(async () => {
                    if (!newOrgName.trim())
                      throw new Error("Organization name is required");
                    const org = await authClient.organization.create({
                      name: newOrgName.trim(),
                      slug: slugify(newOrgName) || `org-${Date.now()}`,
                    });
                    if (org?.error)
                      throw new Error(
                        org.error.message || "Failed to create organization",
                      );
                    const updated = parseOrganizations(
                      (await authClient.organization.list())?.data,
                    );
                    setOrganizations(updated);
                    const createdId =
                      org?.data?.id ||
                      updated.find((o) => o.name === newOrgName.trim())?.id;
                    if (createdId) {
                      await authClient.organization.setActive({
                        organizationId: createdId,
                      });
                      setActiveOrgId(createdId);
                    }
                    setNewOrgName("");
                    setStatus("Organization created");
                  });
                }}
              >
                Create
              </button>
            </div>
          </div>

          <div className="space-y-2 rounded-xl border border-zinc-200 bg-zinc-50 p-4">
            <h2 className="text-sm font-semibold text-zinc-800">Workspace</h2>
            <select
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
              value={activeWorkspaceId || ""}
              onChange={(e) => setActiveWorkspaceId(e.target.value)}
            >
              <option value="" disabled>
                Select workspace
              </option>
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>
                  {ws.name}
                </option>
              ))}
            </select>

            <div className="flex gap-2">
              <input
                className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                value={newWorkspaceName}
                onChange={(e) => setNewWorkspaceName(e.target.value)}
                placeholder="New workspace name"
              />
              <button
                type="button"
                className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                disabled={busy || !activeOrgId}
                onClick={() => {
                  void run(async () => {
                    if (!activeOrgId)
                      throw new Error("Select an organization first");
                    const ws = await workspaceClient.createWorkspace(
                      activeOrgId,
                      { name: newWorkspaceName },
                    );
                    setWorkspaces((c) => [...c, ws]);
                    setActiveWorkspaceId(ws.id);
                    setNewWorkspaceName("");
                    setStatus("Workspace created");
                  });
                }}
              >
                Create
              </button>
            </div>
          </div>
        </div>

        <section className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-700">
          <p>
            Active organization: <strong>{activeOrg?.name || "None"}</strong>
          </p>
          <p>
            Active workspace: <strong>{activeWorkspace?.name || "None"}</strong>
          </p>
        </section>

        {error && (
          <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">
            {error}
          </p>
        )}
        {status && (
          <p className="rounded-lg bg-emerald-50 p-2 text-sm text-emerald-700">
            {status}
          </p>
        )}
      </section>
    </main>
  );
}
