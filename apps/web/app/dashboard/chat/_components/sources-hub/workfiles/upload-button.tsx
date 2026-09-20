import { useRef, useState } from "react";
import { Upload, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { toast } from "sonner";
import { contentClient } from "../../../../../../lib/sdk";

export function UploadFilesButton({
  workspaceId,
  threadId,
  onUploaded,
}: {
  workspaceId: string;
  threadId: string;
  onUploaded: () => void;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        className="hidden"
        aria-label={t("files.chooseFiles")}
        onChange={async (event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (!files.length) return;
          setBusy(true);
          let completed = 0;
          try {
            for (const file of files) {
              if (file.size > 20 * 1024 * 1024)
                throw new Error(
                  t("files.sizeLimit", { name: file.name }),
                );
              await contentClient.uploadFileBytes(
                workspaceId,
                threadId,
                `/files/${file.name}`,
                file,
              );
              completed += 1;
            }
            toast.success(t("files.uploaded", { count: completed }));
          } catch (error) {
            const base =
              error instanceof Error
                ? error.message
                : t("files.uploadFailed");
            const suffix = completed
              ? ` ${t("files.uploadedBeforeError", { count: completed })}`
              : "";
            toast.error(`${base}${suffix}`);
          } finally {
            setBusy(false);
            onUploaded();
          }
        }}
      />
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={busy}
        onClick={() => picker.current?.click()}
      >
        {busy ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Upload className="size-3.5" />
        )}{" "}
        {t("files.uploadFiles")}
      </Button>
    </>
  );
}
