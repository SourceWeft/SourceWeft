import { SOURCE_UPLOAD_MAX_BYTES } from "@sourceweft/contracts/sources";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { isSupportedUploadFile } from "../lib/upload";

export const addTabs = ["File", "URL", "Text"] as const;
export type AddTab = (typeof addTabs)[number];

export const MAX_FILES = 20;
// The ceiling itself lives in contracts because the server enforces it against
// what the object store reports; this check only spares the user a doomed
// transfer, so the two must not be able to drift apart.
export const MAX_FILE_SIZE_BYTES = SOURCE_UPLOAD_MAX_BYTES;
export const MAX_FILE_SIZE_MB = Math.round(MAX_FILE_SIZE_BYTES / (1024 * 1024));

export function useAddSourceDialogState() {
  const [isOpen, setIsOpen] = useState(false);
  const [parentSourceId, setParentSourceId] = useState<string | null>(null);
  const [tab, setTab] = useState<AddTab>("File");
  const [textTitle, setTextTitle] = useState("");
  const [textContent, setTextContent] = useState("");
  const [urlValue, setUrlValue] = useState("");
  const [urlTitle, setUrlTitle] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isDragActive, setIsDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);

  const reset = useCallback(() => {
    setTextTitle("");
    setTextContent("");
    setUrlValue("");
    setUrlTitle("");
    setFiles([]);
    setUploadProgress(0);
    setTab("File");
    setIsDragActive(false);
    setParentSourceId(null);
    dragDepthRef.current = 0;
  }, []);

  const open = useCallback((nextParentSourceId: string | null = null) => {
    setParentSourceId(nextParentSourceId);
    setIsOpen(true);
  }, []);

  const close = useCallback(
    (openState: boolean) => {
      setIsOpen(openState);
      if (!openState) {
        reset();
      }
    },
    [reset],
  );

  const addFiles = useCallback(
    (incoming: File[] | null) => {
      if (!incoming || incoming.length === 0) return;

      const nextFiles = [...files];
      for (const file of incoming) {
        if (!isSupportedUploadFile(file)) {
          toast.error(`"${file.name}" is not a supported source file.`);
          continue;
        }
        if (file.size > MAX_FILE_SIZE_BYTES) {
          toast.error(`"${file.name}" exceeds ${MAX_FILE_SIZE_MB}MB.`);
          continue;
        }
        if (nextFiles.length >= MAX_FILES) {
          toast.error(`You can upload up to ${MAX_FILES} files at once.`);
          break;
        }
        nextFiles.push(file);
      }
      setFiles(nextFiles);
    },
    [files],
  );

  const removeFile = useCallback((index: number) => {
    setFiles((prev) =>
      prev.filter((_, currentIndex) => currentIndex !== index),
    );
  }, []);

  const handleDragEnter = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current += 1;
      setIsDragActive(true);
    },
    [],
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );

  const handleDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDragActive(false);
      }
    },
    [],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setIsDragActive(false);
      dragDepthRef.current = 0;
      addFiles(Array.from(event.dataTransfer.files ?? []));
    },
    [addFiles],
  );

  return {
    addFiles,
    close,
    fileInputRef,
    files,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    isDragActive,
    isOpen,
    open,
    parentSourceId,
    removeFile,
    reset,
    setIsOpen,
    setParentSourceId,
    setTab,
    setTextContent,
    setTextTitle,
    setUploadProgress,
    setUrlTitle,
    setUrlValue,
    tab,
    textContent,
    textTitle,
    uploadProgress,
    urlTitle,
    urlValue,
  };
}
