import { useRef, useState } from "react";
import { Upload, Loader2 } from "lucide-react";
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
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        className="hidden"
        aria-label="Choose files to upload"
        onChange={async (event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (!files.length) return;
          setBusy(true);
          let completed = 0;
          try {
            for (const file of files) {
              if (file.size > 20 * 1024 * 1024)
                throw new Error(`${file.name} exceeds the 20 MiB file limit.`);
              await contentClient.uploadFileBytes(
                workspaceId,
                threadId,
                `/files/${file.name}`,
                file,
              );
              completed += 1;
            }
            toast.success(
              `${completed} file${completed === 1 ? "" : "s"} uploaded.`,
            );
          } catch (error) {
            toast.error(
              `${error instanceof Error ? error.message : "Upload failed."}${completed ? ` ${completed} file(s) were uploaded before the error.` : ""}`,
            );
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
        Upload files
      </Button>
    </>
  );
}
