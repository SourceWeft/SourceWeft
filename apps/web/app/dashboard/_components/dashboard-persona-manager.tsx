"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, ChevronLeft, Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Persona } from "@sourceweft/contracts";
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
import { Checkbox } from "@sourceweft/ui-web/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sourceweft/ui-web/components/ui/select";
import { Textarea } from "@sourceweft/ui-web/components/ui/textarea";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { contentClient } from "../../../lib/sdk";
import {
  createPayloadFromDraft,
  describePersonaSource,
  draftFromPersona,
  groupPersonas,
  isDraftComplete,
  payloadFromDraft,
  toggleAllowlistTool,
  type PersonaDraftForm,
} from "../../../lib/persona-helpers";

/** Radix Select rejects an empty item value, so "workspace default" is named. */
const DEFAULT_MODEL_VALUE = "__default__";

type ModelOption = { value: string; label: string };

type ManagerView =
  | { mode: "list" }
  | { mode: "pick-source" }
  | {
      mode: "edit";
      draft: PersonaDraftForm;
      /** Set while cloning: the persona the draft started from. */
      sourceId: string | null;
      /** Set while editing an existing workspace persona. */
      personaId: string | null;
      title: string;
    };

/**
 * Authoring surface for workspace personas. A persona only ever starts as a
 * copy of another (built-in or custom) — the same "index + install" shape as
 * an agent marketplace — and every edit goes through the same checks.
 */
export function DashboardPersonaManager({
  onChanged,
  onOpenChange,
  open,
  workspaceId,
}: {
  /** Called after any create, edit, or delete so pickers can refetch. */
  onChanged: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  workspaceId: string | null;
}) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [availableTools, setAvailableTools] = useState<string[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [view, setView] = useState<ManagerView>({ mode: "list" });
  const [isSaving, setIsSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Persona | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) {
      return;
    }
    setIsLoading(true);
    setHasError(false);
    try {
      const result = await contentClient.listPersonas(workspaceId);
      setPersonas(result.items);
      setAvailableTools(result.availableTools);
    } catch {
      setHasError(true);
    } finally {
      setIsLoading(false);
    }
    // The model list is a convenience; the editor still works without it.
    try {
      const catalog = await contentClient.listThreadModelCatalog(workspaceId);
      setModels(
        catalog.kinds.llm
          .filter((item) => item.isActive)
          .map((item) => ({
            value: item.profileAlias,
            label: item.displayName,
          })),
      );
    } catch {
      setModels([]);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (open) {
      setView({ mode: "list" });
      void load();
    }
  }, [load, open]);

  const { builtIn, custom } = groupPersonas(personas);

  const startClone = (source: Persona) => {
    setView({
      mode: "edit",
      draft: draftFromPersona(source),
      sourceId: source.id,
      personaId: null,
      title: `New agent from ${source.name}`,
    });
  };

  const startEdit = (persona: Persona) => {
    setView({
      mode: "edit",
      draft: draftFromPersona(persona),
      sourceId: null,
      personaId: persona.id,
      title: `Edit ${persona.name}`,
    });
  };

  const save = async () => {
    if (view.mode !== "edit" || !workspaceId || isSaving) {
      return;
    }
    if (!isDraftComplete(view.draft)) {
      toast.error("Give the agent a name and instructions.");
      return;
    }
    setIsSaving(true);
    try {
      if (view.personaId) {
        await contentClient.updatePersona(
          workspaceId,
          view.personaId,
          payloadFromDraft(view.draft),
        );
        toast.success("Agent updated");
      } else if (view.sourceId) {
        await contentClient.createPersona(
          workspaceId,
          createPayloadFromDraft(view.sourceId, view.draft),
        );
        toast.success("Agent created");
      }
      onChanged();
      await load();
      setView({ mode: "list" });
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : "Could not save the agent.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete || !workspaceId) {
      return;
    }
    const target = pendingDelete;
    setPendingDelete(null);
    try {
      await contentClient.deletePersona(workspaceId, target.id);
      toast.success(`Removed ${target.name}`);
      onChanged();
      await load();
    } catch {
      toast.error("Could not remove the agent.");
    }
  };

  const updateDraft = (patch: Partial<PersonaDraftForm>) => {
    setView((current) =>
      current.mode === "edit"
        ? { ...current, draft: { ...current.draft, ...patch } }
        : current,
    );
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          {view.mode === "list" ? (
            <>
              <DialogHeader>
                <DialogTitle>Your agents</DialogTitle>
                <DialogDescription>
                  Agents you author here can own conversations like the built-in
                  ones. Each starts as a copy of another agent.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-1.5">
                {isLoading && personas.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Loading agents...
                  </p>
                ) : null}
                {hasError ? (
                  <p className="text-xs text-destructive">
                    Could not load agents. Close and try again.
                  </p>
                ) : null}
                {!isLoading && !hasError && custom.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                    No custom agents yet. Start from a built-in one.
                  </p>
                ) : null}
                {custom.map((persona) => (
                  <div
                    key={persona.id}
                    className="flex items-start gap-2.5 rounded-md border border-border px-3 py-2"
                  >
                    <Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {persona.name}
                      </div>
                      <div className="line-clamp-2 text-xs text-muted-foreground">
                        {persona.description || "No description"}
                      </div>
                      {describePersonaSource(persona, personas) ? (
                        <div className="mt-0.5 text-[10px] text-muted-foreground/80">
                          From {describePersonaSource(persona, personas)}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button
                        onClick={() => startEdit(persona)}
                        size="icon-xs"
                        title="Edit"
                        type="button"
                        variant="ghost"
                      >
                        <Pencil className="size-3.5" />
                        <span className="sr-only">Edit {persona.name}</span>
                      </Button>
                      <Button
                        onClick={() => startClone(persona)}
                        size="icon-xs"
                        title="Duplicate"
                        type="button"
                        variant="ghost"
                      >
                        <Copy className="size-3.5" />
                        <span className="sr-only">
                          Duplicate {persona.name}
                        </span>
                      </Button>
                      <Button
                        className="text-destructive hover:text-destructive"
                        onClick={() => setPendingDelete(persona)}
                        size="icon-xs"
                        title="Remove"
                        type="button"
                        variant="ghost"
                      >
                        <Trash2 className="size-3.5" />
                        <span className="sr-only">Remove {persona.name}</span>
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              <DialogFooter className="sm:justify-start">
                <Button
                  disabled={personas.length === 0}
                  onClick={() => setView({ mode: "pick-source" })}
                  size="sm"
                  type="button"
                >
                  <Plus className="size-3.5" />
                  New agent from...
                </Button>
              </DialogFooter>
            </>
          ) : null}

          {view.mode === "pick-source" ? (
            <>
              <DialogHeader>
                <DialogTitle>Start from an agent</DialogTitle>
                <DialogDescription>
                  The copy keeps the source&apos;s instructions, model, and
                  tools until you change them.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-1.5">
                {[...builtIn, ...custom].map((persona) => (
                  <button
                    key={persona.id}
                    className="flex w-full items-start gap-2.5 rounded-md border border-border px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => startClone(persona)}
                    type="button"
                  >
                    <Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">
                        {persona.name}
                      </span>
                      <span className="line-clamp-2 block text-xs text-muted-foreground">
                        {persona.description}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              <DialogFooter className="sm:justify-start">
                <Button
                  onClick={() => setView({ mode: "list" })}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <ChevronLeft className="size-3.5" />
                  Back
                </Button>
              </DialogFooter>
            </>
          ) : null}

          {view.mode === "edit" ? (
            <>
              <DialogHeader>
                <DialogTitle>{view.title}</DialogTitle>
                <DialogDescription>
                  Name, instructions, model, and the tools this agent may use.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1 text-xs font-medium">
                  Name
                  <Input
                    maxLength={80}
                    onChange={(event) =>
                      updateDraft({ name: event.target.value })
                    }
                    value={view.draft.name}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium">
                  Description
                  <Textarea
                    maxLength={500}
                    onChange={(event) =>
                      updateDraft({ description: event.target.value })
                    }
                    rows={2}
                    value={view.draft.description}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium">
                  Instructions
                  <Textarea
                    className="font-mono text-xs"
                    maxLength={20000}
                    onChange={(event) =>
                      updateDraft({ systemPrompt: event.target.value })
                    }
                    rows={10}
                    value={view.draft.systemPrompt}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium">
                  Model
                  <Select
                    onValueChange={(value) =>
                      updateDraft({
                        llmProfileAlias:
                          value === DEFAULT_MODEL_VALUE ? "" : value,
                      })
                    }
                    value={view.draft.llmProfileAlias || DEFAULT_MODEL_VALUE}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Workspace default" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_MODEL_VALUE}>
                        Workspace default
                      </SelectItem>
                      {models.map((model) => (
                        <SelectItem key={model.value} value={model.value}>
                          {model.label}
                        </SelectItem>
                      ))}
                      {view.draft.llmProfileAlias &&
                      !models.some(
                        (model) => model.value === view.draft.llmProfileAlias,
                      ) ? (
                        <SelectItem value={view.draft.llmProfileAlias}>
                          {view.draft.llmProfileAlias}
                        </SelectItem>
                      ) : null}
                    </SelectContent>
                  </Select>
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={view.draft.readOnly}
                    onCheckedChange={(checked) =>
                      updateDraft({ readOnly: checked === true })
                    }
                  />
                  Read-only: the agent can read sources and files but never
                  write, run, or publish
                </label>
                <fieldset className="flex flex-col gap-1.5">
                  <legend className="text-xs font-medium">Tools</legend>
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={view.draft.toolAllowlist === null}
                      onCheckedChange={(checked) =>
                        updateDraft({
                          toolAllowlist:
                            checked === true ? null : [...availableTools],
                        })
                      }
                    />
                    Every tool the workspace offers
                  </label>
                  <div
                    className={cn(
                      "grid grid-cols-2 gap-1 rounded-md border border-border p-2",
                      view.draft.toolAllowlist === null && "opacity-50",
                    )}
                  >
                    {availableTools.map((tool) => (
                      <label
                        key={tool}
                        className="flex items-center gap-2 font-mono text-[11px]"
                      >
                        <Checkbox
                          checked={
                            view.draft.toolAllowlist === null ||
                            view.draft.toolAllowlist.includes(tool)
                          }
                          disabled={view.draft.toolAllowlist === null}
                          onCheckedChange={() =>
                            updateDraft({
                              toolAllowlist: toggleAllowlistTool(
                                view.draft.toolAllowlist,
                                tool,
                                availableTools,
                              ),
                            })
                          }
                        />
                        {tool}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
              <DialogFooter>
                <Button
                  disabled={isSaving}
                  onClick={() => setView({ mode: "list" })}
                  type="button"
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button
                  disabled={isSaving || !isDraftComplete(view.draft)}
                  onClick={() => void save()}
                  type="button"
                >
                  {isSaving
                    ? "Saving..."
                    : view.personaId
                      ? "Save changes"
                      : "Create agent"}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {pendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Conversations already started with this agent keep their history,
              but nobody can start a new one with it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
