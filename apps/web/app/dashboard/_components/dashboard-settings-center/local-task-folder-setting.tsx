"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  desktopBridge,
  FOLDER_SELECTION_CANCELLED,
  type TaskFolder,
} from "../../../../lib/desktop-bridge";
import { shortenHomePath } from "../../../../lib/local-path";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * "Default task folder": where this computer creates the folder of a conversation that has no
 * chosen one. Rendered only once the app reports local execution storage as initialized.
 */
export function LocalTaskFolderSetting() {
  const t = useTranslations("dashboardSettings");
  const [folder, setFolder] = useState<TaskFolder | null>(null);
  // The read failed. With TASK_FOLDER_UNAVAILABLE this computer has no location yet and one can
  // be chosen here; any other failure (an app version without the command, storage that cannot
  // be read) leaves nothing to change, so the buttons stay disabled next to the reason.
  const [unreadable, setUnreadable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void desktopBridge.getTaskFolder().then(
      (value) => {
        if (live) setFolder(value);
      },
      (e) => {
        if (live) setUnreadable(message(e));
      },
    );
    return () => {
      live = false;
    };
  }, []);
  const run = async (work: () => Promise<TaskFolder>) => {
    setBusy(true);
    setError(null);
    try {
      setFolder(await work());
      setUnreadable(null);
    } catch (e) {
      // Closing the folder dialog without choosing is not a failure.
      if (message(e) !== FOLDER_SELECTION_CANCELLED) setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const canChoose =
    folder !== null || Boolean(unreadable?.startsWith("TASK_FOLDER_UNAVAILABLE"));
  return (
    <div
      className="space-y-3 rounded-lg border p-4"
      data-testid="local-task-folder"
    >
      <h3 className="font-medium">{t("localHost.taskFolderTitle")}</h3>
      <p className="text-sm text-muted-foreground">
        {t("localHost.taskFolderDescription")}
      </p>
      {folder && (
        <p
          data-testid="local-task-folder-path"
          title={folder.path}
          className="truncate text-sm"
        >
          {shortenHomePath(folder.path)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy || !canChoose}
          onClick={() => void run(() => desktopBridge.chooseTaskFolder())}
        >
          {t("localHost.taskFolderChange")}
        </Button>
        {folder && !folder.isDefault && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void run(() => desktopBridge.resetTaskFolder())}
          >
            {t("localHost.taskFolderReset")}
          </Button>
        )}
      </div>
      {(error ?? unreadable) && (
        <p role="alert" className="text-sm text-destructive">
          {error ?? unreadable}
        </p>
      )}
    </div>
  );
}
