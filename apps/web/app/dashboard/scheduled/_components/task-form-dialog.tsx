"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type {
  AgentTask,
  PreviewAgentTaskScheduleResponse,
} from "@sourceweft/contracts/scheduled-tasks";
import { AGENT_TASK_LIMITS } from "@sourceweft/contracts/scheduled-tasks";
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
import { Label } from "@sourceweft/ui-web/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sourceweft/ui-web/components/ui/select";
import { Switch } from "@sourceweft/ui-web/components/ui/switch";
import { Textarea } from "@sourceweft/ui-web/components/ui/textarea";
import { contentClient, agentTasksClient } from "../../../../lib/sdk";
import {
  agentTaskErrorCode,
  useAgentTaskMutations,
} from "../../../../lib/scheduled-tasks";
import {
  FREQUENCIES,
  emptyTaskForm,
  formToRequest,
  formToRule,
  isFormComplete,
  taskToForm,
  type TaskFormState,
} from "./schedule-form";
import { useScheduleText, weekdayName } from "./use-schedule-text";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string | null;
  /** The task being edited; none creates one. */
  task?: AgentTask;
  /** Fills a new task's prompt, when it comes from a chat message. */
  seedPrompt?: string;
  onSaved?: (task: AgentTask) => void;
};

function timeZones() {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}

/** The next fire times of the rule as it is typed, so a person sees what they set. */
function useSchedulePreview(
  workspaceId: string | null,
  form: TaskFormState,
  enabled: boolean,
) {
  const rule = formToRule(form);
  const key = JSON.stringify([rule, form.timezone]);
  const [debounced, setDebounced] = React.useState(key);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(key), 400);
    return () => clearTimeout(timer);
  }, [key]);
  const live = rule && rule.kind !== "manual" && enabled && debounced === key;
  return useQuery<PreviewAgentTaskScheduleResponse>({
    queryKey: ["scheduled", workspaceId, "preview", debounced],
    queryFn: () =>
      agentTasksClient.previewSchedule(workspaceId!, {
        rule: rule!,
        timezone: form.timezone,
      }),
    enabled: Boolean(live && workspaceId),
    retry: false,
    staleTime: 60_000,
  });
}

export function TaskFormDialog({
  open,
  onOpenChange,
  workspaceId,
  task,
  seedPrompt,
  onSaved,
}: Props) {
  const t = useTranslations("dashboardScheduled");
  const locale = useLocale();
  const { formatInstant } = useScheduleText();
  const mutations = useAgentTaskMutations(workspaceId);
  const [form, setForm] = React.useState<TaskFormState>(() =>
    task ? taskToForm(task) : emptyTaskForm({ prompt: seedPrompt ?? "" }),
  );
  const [saving, setSaving] = React.useState(false);

  // Each opening starts from the task (or a blank form), never from the last edit.
  React.useEffect(() => {
    if (open) {
      setForm(
        task ? taskToForm(task) : emptyTaskForm({ prompt: seedPrompt ?? "" }),
      );
    }
  }, [open, task, seedPrompt]);

  const set = <Key extends keyof TaskFormState>(
    key: Key,
    value: TaskFormState[Key],
  ) => setForm((current) => ({ ...current, [key]: value }));

  const zones = React.useMemo(timeZones, []);
  const preview = useSchedulePreview(workspaceId, form, open);
  const previewCode = agentTaskErrorCode(preview.error);

  const installs = useQuery({
    queryKey: ["scheduled", workspaceId, "mcp-installs"],
    queryFn: () => contentClient.listWorkspaceMcpInstalls(workspaceId!),
    enabled: open && Boolean(workspaceId),
    select: (data) => data.items.filter((item) => item.status === "active"),
    staleTime: 30_000,
  });

  async function save(activate: boolean) {
    const rule = formToRule(form);
    if (!rule || !workspaceId) return;
    setSaving(true);
    try {
      const request = formToRequest(form, task?.request);
      const common = {
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        request,
        rule,
        timezone: form.timezone,
        notifyOnSuccess: form.notifyOnSuccess,
        notifyEmail: form.notifyEmail,
      };
      const saved = task
        ? await mutations.update.mutateAsync({
            taskId: task.id,
            changes: { version: task.version, ...common },
          })
        : await mutations.create.mutateAsync({ ...common, activate });
      toast.success(task ? t("toasts.saved") : t("toasts.created"));
      onOpenChange(false);
      onSaved?.(saved.task);
    } catch (error) {
      const code = agentTaskErrorCode(error);
      toast.error(
        code === "AGENT_TASK_LIMIT_REACHED"
          ? t("errors.AGENT_TASK_LIMIT_REACHED")
          : code === "AGENT_TASK_VERSION_CONFLICT"
            ? t("errors.AGENT_TASK_VERSION_CONFLICT")
            : code === "AGENT_TASK_SCHEDULE_INVALID"
              ? t("errors.AGENT_TASK_SCHEDULE_INVALID")
              : t("errors.generic"),
      );
    } finally {
      setSaving(false);
    }
  }

  const complete = isFormComplete(form);
  const timed = form.frequency !== "manual";
  const showTime = ["daily", "weekdays", "weekly"].includes(form.frequency);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {task ? t("form.editTitle") : t("form.title")}
          </DialogTitle>
          <DialogDescription>{t("form.description")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="task-name">{t("form.name")}</Label>
            <Input
              id="task-name"
              value={form.name}
              maxLength={AGENT_TASK_LIMITS.nameChars}
              placeholder={t("form.namePlaceholder")}
              onChange={(event) => set("name", event.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="task-prompt">{t("form.prompt")}</Label>
            <Textarea
              id="task-prompt"
              rows={5}
              value={form.prompt}
              maxLength={AGENT_TASK_LIMITS.promptChars}
              placeholder={t("form.promptPlaceholder")}
              onChange={(event) => set("prompt", event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("form.promptHint")}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>{t("form.frequency")}</Label>
              <Select
                value={form.frequency}
                onValueChange={(value) =>
                  set("frequency", value as TaskFormState["frequency"])
                }
              >
                <SelectTrigger aria-label={t("form.frequency")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FREQUENCIES.map((frequency) => (
                    <SelectItem key={frequency} value={frequency}>
                      {t(`frequency.${frequency}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {showTime ? (
              <div className="grid gap-1.5">
                <Label htmlFor="task-time">{t("form.time")}</Label>
                <Input
                  id="task-time"
                  type="time"
                  value={form.time}
                  onChange={(event) => set("time", event.target.value)}
                />
              </div>
            ) : null}

            {form.frequency === "once" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="task-once">{t("form.runAt")}</Label>
                <Input
                  id="task-once"
                  type="datetime-local"
                  value={form.onceLocal}
                  onChange={(event) => set("onceLocal", event.target.value)}
                />
              </div>
            ) : null}

            {form.frequency === "cron" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="task-cron">{t("form.cron")}</Label>
                <Input
                  id="task-cron"
                  className="font-mono"
                  value={form.cron}
                  maxLength={AGENT_TASK_LIMITS.cronChars}
                  onChange={(event) => set("cron", event.target.value)}
                />
              </div>
            ) : null}
          </div>

          {form.frequency === "weekly" ? (
            <fieldset className="grid gap-1.5">
              <legend className="text-sm font-medium">{t("form.days")}</legend>
              <div className="flex flex-wrap gap-3">
                {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                  <label
                    key={day}
                    className="flex items-center gap-1.5 text-sm"
                  >
                    <Checkbox
                      checked={form.days.includes(day)}
                      onCheckedChange={(checked) =>
                        set(
                          "days",
                          checked === true
                            ? [...form.days, day]
                            : form.days.filter((value) => value !== day),
                        )
                      }
                    />
                    {weekdayName(locale, day)}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          {timed ? (
            <div className="grid gap-1.5">
              <Label>{t("form.timezone")}</Label>
              <Select
                value={form.timezone}
                onValueChange={(value) => set("timezone", value)}
              >
                <SelectTrigger aria-label={t("form.timezone")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {(zones.includes(form.timezone)
                    ? zones
                    : [form.timezone, ...zones]
                  ).map((zone) => (
                    <SelectItem key={zone} value={zone}>
                      {zone}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("form.manualHint")}
            </p>
          )}

          {timed ? (
            <div
              className="rounded-lg border border-border bg-muted/40 p-3 text-sm"
              aria-live="polite"
            >
              <p className="mb-1 font-medium">{t("form.nextRuns")}</p>
              {preview.isFetching ? (
                <p className="text-muted-foreground">
                  {t("form.previewLoading")}
                </p>
              ) : preview.data ? (
                <>
                  <ul className="grid gap-0.5 text-muted-foreground">
                    {preview.data.fireTimes.map((time) => (
                      <li key={time}>{formatInstant(time, form.timezone)}</li>
                    ))}
                  </ul>
                  {preview.data.maxOffsetSeconds > 0 ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("form.offsetHint", {
                        minutes: Math.ceil(preview.data.maxOffsetSeconds / 60),
                      })}
                    </p>
                  ) : null}
                </>
              ) : previewCode === "AGENT_TASK_SCHEDULE_INVALID" ? (
                <p className="text-destructive">
                  {t("errors.AGENT_TASK_SCHEDULE_INVALID")}
                </p>
              ) : (
                <p className="text-muted-foreground">
                  {t("form.previewEmpty")}
                </p>
              )}
            </div>
          ) : null}

          <div className="grid gap-3">
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                <span className="block font-medium">{t("form.webAccess")}</span>
                <span className="block text-xs text-muted-foreground">
                  {t("form.webAccessHint")}
                </span>
              </span>
              <Switch
                checked={form.webAccess}
                onCheckedChange={(value) => set("webAccess", value)}
              />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span className="font-medium">{t("form.notifyOnSuccess")}</span>
              <Switch
                checked={form.notifyOnSuccess}
                onCheckedChange={(value) => set("notifyOnSuccess", value)}
              />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                <span className="block font-medium">
                  {t("form.notifyEmail")}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t("form.notifyEmailHint")}
                </span>
              </span>
              <Switch
                checked={form.notifyEmail}
                onCheckedChange={(value) => set("notifyEmail", value)}
              />
            </label>
          </div>

          {installs.data && installs.data.length > 0 ? (
            <fieldset className="grid gap-1.5">
              <legend className="text-sm font-medium">{t("form.mcp")}</legend>
              <p className="text-xs text-muted-foreground">
                {t("form.mcpHint")}
              </p>
              <div className="grid gap-1.5">
                {installs.data.map((install) => (
                  <label
                    key={install.id}
                    className="flex items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={form.mcpInstallIds.includes(install.id)}
                      onCheckedChange={(checked) =>
                        set(
                          "mcpInstallIds",
                          checked === true
                            ? [...form.mcpInstallIds, install.id]
                            : form.mcpInstallIds.filter(
                                (id) => id !== install.id,
                              ),
                        )
                      }
                    />
                    {install.name}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          <p className="text-xs text-muted-foreground">
            {t("form.readOnlyNote")}
          </p>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {t("form.cancel")}
          </Button>
          {task ? (
            <Button disabled={!complete || saving} onClick={() => save(false)}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("form.save")}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={!complete || saving}
                onClick={() => save(false)}
              >
                {t("form.saveDraft")}
              </Button>
              {timed ? (
                <Button
                  disabled={!complete || saving}
                  onClick={() => save(true)}
                >
                  {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                  {t("form.createAndEnable")}
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
