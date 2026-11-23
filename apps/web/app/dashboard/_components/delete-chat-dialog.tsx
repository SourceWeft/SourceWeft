"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@sourceweft/ui-web/components/ui/alert-dialog";
import { Button } from "@sourceweft/ui-web/components/ui/button";

/**
 * Asks before a chat is deleted. The delete is permanent: the server removes
 * the chat, its messages and the sub-agent chats it opened, and revokes its
 * public link. A failed delete keeps the dialog open so the user can retry.
 */
export function DeleteChatDialog({
  open,
  title,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  title: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const t = useTranslations("dashboardNav.chats.deleteDialog");
  const [deleting, setDeleting] = useState(false);

  const handleConfirm = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      toast.error(t("error"));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Escape and Cancel can't close the dialog mid-delete.
        if (!deleting) onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Trash2 />
          </AlertDialogMedia>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("description", { title })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>{t("cancel")}</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={deleting}
            onClick={() => void handleConfirm()}
          >
            {deleting ? t("deleting") : t("confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
