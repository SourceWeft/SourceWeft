import { useMemo } from "react";
import { Folder, Loader2, Upload, X } from "lucide-react";

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
import {
  Button,
  buttonVariants,
} from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { Progress } from "@sourceweft/ui-web/components/ui/progress";
import { Textarea } from "@sourceweft/ui-web/components/ui/textarea";
import { cn } from "@sourceweft/ui-web/lib/utils";

import { buildSourceTree, type SourceTreeNode } from "../source-tree";
import type { SourceItem } from "../../source-types";
import { TypeBadge } from "../type-badge";
import { SOURCE_FILE_ACCEPT, getUploadFileLabel } from "../lib/upload";
import { SourceTypeIcon } from "./components";
import {
  addTabs,
  MAX_FILES,
  MAX_FILE_SIZE_MB,
  type AddTab,
} from "./use-add-source-dialog";

export function DirectoryPicker({
  sources,
  value,
  onChange,
  excludeSourceId,
  framed = true,
}: {
  sources: SourceItem[];
  value: string | null;
  onChange: (value: string | null) => void;
  excludeSourceId?: string | null;
  framed?: boolean;
}) {
  const excludedIds = useMemo(() => {
    const ids = new Set<string>();
    if (!excludeSourceId) return ids;
    ids.add(excludeSourceId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const source of sources) {
        if (
          source.parentSourceId &&
          ids.has(source.parentSourceId) &&
          !ids.has(source.id)
        ) {
          ids.add(source.id);
          changed = true;
        }
      }
    }
    return ids;
  }, [excludeSourceId, sources]);
  const directoryTree = useMemo(
    () =>
      buildSourceTree(
        sources.filter(
          (source) =>
            source.sourceType === "directory" && !excludedIds.has(source.id),
        ),
        "",
      ),
    [excludedIds, sources],
  );

  function renderNode(node: SourceTreeNode, depth: number) {
    return (
      <button
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent",
          value === node.source.id && "bg-primary/10 text-primary",
        )}
        key={node.source.id}
        onClick={() => onChange(node.source.id)}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        type="button"
      >
        <Folder className="size-3.5 shrink-0" />
        <span className="truncate">{node.source.title}</span>
      </button>
    );
  }

  return (
    <div
      className={cn(
        "max-h-56 overflow-y-auto",
        framed ? "rounded-lg border bg-background p-1" : "py-1",
      )}
    >
      <button
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium hover:bg-accent",
          value === null && "bg-primary/10 text-primary",
        )}
        onClick={() => onChange(null)}
        type="button"
      >
        <Folder className="size-3.5 shrink-0" />
        <span>Sources root</span>
      </button>
      <div className="ml-3 border-l border-border/70 pl-1">
        {directoryTree.map(function render(node) {
          function renderTree(current: SourceTreeNode, depth: number) {
            return (
              <div key={current.source.id}>
                {renderNode(current, depth)}
                {current.children.map((child) => renderTree(child, depth + 1))}
              </div>
            );
          }
          return renderTree(node, 0);
        })}
      </div>
    </div>
  );
}

export function AddSourceDialog({
  addParentSourceId,
  addTab,
  files,
  fileInputRef,
  isDragActive,
  isOpen,
  isSubmitting,
  onAddFiles,
  onAddTabChange,
  onClose,
  onCreateTextSource,
  onCreateUrlSource,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
  onRemoveFile,
  onTextContentChange,
  onTextTitleChange,
  onUploadFiles,
  onUrlTitleChange,
  onUrlValueChange,
  sources,
  textContent,
  textTitle,
  uploadProgress,
  urlTitle,
  urlValue,
}: {
  addParentSourceId: string | null;
  addTab: AddTab;
  files: File[];
  fileInputRef: { current: HTMLInputElement | null };
  isDragActive: boolean;
  isOpen: boolean;
  isSubmitting: boolean;
  onAddFiles: (files: File[]) => void;
  onAddTabChange: (tab: AddTab) => void;
  onClose: (open: boolean) => void;
  onCreateTextSource: () => void;
  onCreateUrlSource: () => void;
  onDragEnter: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  onRemoveFile: (index: number) => void;
  onTextContentChange: (value: string) => void;
  onTextTitleChange: (value: string) => void;
  onUploadFiles: () => void;
  onUrlTitleChange: (value: string) => void;
  onUrlValueChange: (value: string) => void;
  sources: SourceItem[];
  textContent: string;
  textTitle: string;
  uploadProgress: number;
  urlTitle: string;
  urlValue: string;
}) {
  return (
    <Dialog onOpenChange={onClose} open={isOpen}>
      <DialogContent
        className="w-[640px] max-w-[calc(100%-2rem)]"
        constrainWidth={false}
      >
        <DialogHeader>
          <DialogTitle>Add source</DialogTitle>
          <DialogDescription>
            Add web pages, text notes, or uploaded files as sources.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {addParentSourceId ? (
            <div className="flex items-center gap-1.5 rounded-lg border bg-muted/25 px-2.5 py-1.5 text-xs text-muted-foreground">
              <Folder className="size-3.5" />
              <span className="truncate">
                {sources.find((source) => source.id === addParentSourceId)
                  ?.title ?? "Selected folder"}
              </span>
            </div>
          ) : null}
          <div className="flex gap-1 rounded-lg border bg-muted/30 p-1">
            {addTabs.map((tab) => (
              <button
                className={cn(
                  "flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                  addTab === tab
                    ? "bg-background text-foreground shadow-xs ring-1 ring-border"
                    : "text-muted-foreground hover:text-foreground",
                )}
                key={tab}
                onClick={() => onAddTabChange(tab)}
                type="button"
              >
                {tab}
              </button>
            ))}
          </div>

          <div className="h-72">
            {addTab === "Text" ? (
              <div className="flex h-full flex-col gap-2">
                <Input
                  onChange={(event) => onTextTitleChange(event.target.value)}
                  placeholder="Title (optional)"
                  value={textTitle}
                />
                <Textarea
                  className="min-h-0 flex-1"
                  onChange={(event) => onTextContentChange(event.target.value)}
                  placeholder="Paste or write source content..."
                  value={textContent}
                />
              </div>
            ) : addTab === "URL" ? (
              <div className="flex h-full flex-col gap-2">
                <Input
                  onChange={(event) => onUrlValueChange(event.target.value)}
                  placeholder="https://example.com/article"
                  type="url"
                  value={urlValue}
                />
                <Input
                  onChange={(event) => onUrlTitleChange(event.target.value)}
                  placeholder="Title (optional)"
                  value={urlTitle}
                />
                <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-dashed bg-muted/20 px-6 text-center text-xs text-muted-foreground">
                  SourceWeft will fetch the page content and index it for
                  search.
                </div>
              </div>
            ) : (
              <div className="flex h-full min-h-0 flex-col gap-2">
                <div
                  className={cn(
                    "rounded-lg border border-dashed px-4 py-5 text-center text-xs transition-colors",
                    isDragActive
                      ? "border-primary bg-primary/5 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent/40",
                  )}
                  onDragEnter={onDragEnter}
                  onDragLeave={onDragLeave}
                  onDragOver={onDragOver}
                  onDrop={onDrop}
                >
                  <input
                    accept={SOURCE_FILE_ACCEPT}
                    className="hidden"
                    ref={fileInputRef}
                    multiple
                    onChange={(event) => {
                      onAddFiles(Array.from(event.target.files ?? []));
                      event.currentTarget.value = "";
                    }}
                    type="file"
                  />
                  <span className="inline-flex items-center gap-1.5 text-foreground">
                    <Upload className="size-3.5" />
                    {isDragActive ? "Drop files here" : "Drag files here"}
                  </span>
                  <p className="mt-1 text-[10px]">
                    or
                    <button
                      className="mx-1 inline font-medium text-foreground underline underline-offset-2"
                      onClick={() => fileInputRef.current?.click()}
                      type="button"
                    >
                      browse
                    </button>
                    files
                  </p>
                  <p className="mt-1 text-[10px]">
                    Up to {MAX_FILES} files, {MAX_FILE_SIZE_MB}MB each
                  </p>
                </div>

                <div className="min-h-0 flex-1 rounded-lg border p-2">
                  {files.length > 0 ? (
                    <div className="h-full space-y-1.5 overflow-y-auto">
                      {files.map((file, index) => (
                        <div
                          className="flex items-center justify-between gap-2 rounded-md bg-muted/30 px-2 py-1.5"
                          key={`${file.name}-${file.size}-${index}`}
                        >
                          <div className="min-w-0 flex-1">
                            <span className="block truncate text-xs text-foreground">
                              {file.name}
                            </span>
                          </div>
                          <TypeBadge label={getUploadFileLabel(file)} />
                          <Button
                            onClick={() => onRemoveFile(index)}
                            size="icon-xs"
                            type="button"
                            variant="ghost"
                          >
                            <X className="size-3.5" />
                            <span className="sr-only">Remove file</span>
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex h-full items-center justify-center text-[10px] text-muted-foreground">
                      No files selected
                    </div>
                  )}
                </div>

                {isSubmitting ? (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span>Uploading</span>
                      <span>{uploadProgress}%</span>
                    </div>
                    <Progress className="h-1.5" value={uploadProgress} />
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            disabled={isSubmitting}
            onClick={() => onClose(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={
              isSubmitting ||
              (addTab === "Text" && !textContent.trim()) ||
              (addTab === "URL" && !urlValue.trim()) ||
              (addTab === "File" && files.length === 0)
            }
            onClick={() =>
              addTab === "Text"
                ? onCreateTextSource()
                : addTab === "URL"
                  ? onCreateUrlSource()
                  : onUploadFiles()
            }
            type="button"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Working...
              </>
            ) : (
              <>
                {addTab === "Text"
                  ? "Create source"
                  : addTab === "URL"
                    ? "Add URL"
                    : "Upload files"}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CreateDirectoryDialog({
  directoryContext,
  directoryParentSourceId,
  directoryTitle,
  isOpen,
  isSubmitting,
  onContextChange,
  onCreate,
  onOpenChange,
  onParentChange,
  onTitleChange,
  sources,
}: {
  directoryContext: string;
  directoryParentSourceId: string | null;
  directoryTitle: string;
  isOpen: boolean;
  isSubmitting: boolean;
  onContextChange: (value: string) => void;
  onCreate: () => void;
  onOpenChange: (open: boolean) => void;
  onParentChange: (value: string | null) => void;
  onTitleChange: (value: string) => void;
  sources: SourceItem[];
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={isOpen}>
      <DialogContent
        className="w-[520px] max-w-[calc(100%-2rem)]"
        constrainWidth={false}
      >
        <DialogHeader>
          <DialogTitle>Create folder</DialogTitle>
          <DialogDescription>
            Add a folder to organize Sources.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            autoFocus
            onChange={(event) => onTitleChange(event.target.value)}
            placeholder="Folder name"
            value={directoryTitle}
          />
          <Textarea
            className="min-h-28"
            onChange={(event) => onContextChange(event.target.value)}
            placeholder="README context (optional)"
            value={directoryContext}
          />
          <DirectoryPicker
            onChange={onParentChange}
            sources={sources}
            value={directoryParentSourceId}
          />
        </div>
        <DialogFooter>
          <Button
            disabled={isSubmitting}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={isSubmitting || !directoryTitle.trim()}
            onClick={onCreate}
            type="button"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Working...
              </>
            ) : (
              "Create folder"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MoveSourceDialog({
  isSubmitting,
  moveParentSourceId,
  moveSource,
  onMove,
  onMoveSourceChange,
  onOpenChange,
  sources,
}: {
  isSubmitting: boolean;
  moveParentSourceId: string | null;
  moveSource: SourceItem | null;
  onMove: () => void;
  onMoveSourceChange: (value: string | null) => void;
  onOpenChange: (open: boolean) => void;
  sources: SourceItem[];
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={Boolean(moveSource)}>
      <DialogContent
        className="w-[520px] max-w-[calc(100%-2rem)]"
        constrainWidth={false}
      >
        <DialogHeader>
          <DialogTitle>Move source</DialogTitle>
          <DialogDescription>
            Choose a destination under the root directory.
          </DialogDescription>
        </DialogHeader>
        {moveSource ? (
          <div className="flex items-center gap-2 rounded-lg border bg-muted/25 px-3 py-2">
            <SourceTypeIcon
              isPartiallySelected={false}
              isSelected={false}
              source={moveSource}
            />
            <div className="min-w-0">
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Moving
              </div>
              <div className="truncate text-sm font-medium text-foreground">
                {moveSource.title}
              </div>
            </div>
          </div>
        ) : null}
        <DirectoryPicker
          excludeSourceId={moveSource?.id}
          framed={false}
          onChange={onMoveSourceChange}
          sources={sources}
          value={moveParentSourceId}
        />
        <DialogFooter>
          <Button
            disabled={isSubmitting}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={isSubmitting} onClick={onMove} type="button">
            {isSubmitting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Moving...
              </>
            ) : (
              "Move"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ReadmeDialog({
  isSubmitting,
  onContentChange,
  onOpenChange,
  onSave,
  readmeContent,
  readmeSource,
}: {
  isSubmitting: boolean;
  onContentChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onSave: () => void;
  readmeContent: string;
  readmeSource: SourceItem | null;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={Boolean(readmeSource)}>
      <DialogContent
        className="w-[640px] max-w-[calc(100%-2rem)]"
        constrainWidth={false}
      >
        <DialogHeader>
          <DialogTitle>Edit README</DialogTitle>
          <DialogDescription>
            Update the context attached to this folder.
          </DialogDescription>
        </DialogHeader>
        {readmeSource ? (
          <div className="flex items-center gap-2 rounded-lg border bg-muted/25 px-3 py-2">
            <SourceTypeIcon
              isPartiallySelected={false}
              isSelected={false}
              source={readmeSource}
            />
            <div className="min-w-0">
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Folder
              </div>
              <div className="truncate text-sm font-medium text-foreground">
                {readmeSource.title}
              </div>
            </div>
          </div>
        ) : null}
        <Textarea
          className="min-h-52 text-sm"
          onChange={(event) => onContentChange(event.target.value)}
          placeholder="README context for this folder..."
          value={readmeContent}
        />
        <DialogFooter>
          <Button
            disabled={isSubmitting}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={isSubmitting} onClick={onSave} type="button">
            {isSubmitting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Saving...
              </>
            ) : (
              "Save README"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteSourceDialog({
  deleteSource,
  onConfirm,
  onOpenChange,
  rowBusyById,
}: {
  deleteSource: SourceItem | null;
  onConfirm: (source: SourceItem) => void;
  onOpenChange: (open: boolean) => void;
  rowBusyById: Record<string, boolean>;
}) {
  const isDeleting = Boolean(deleteSource && rowBusyById[deleteSource.id]);

  return (
    <AlertDialog onOpenChange={onOpenChange} open={Boolean(deleteSource)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete{" "}
            {deleteSource?.sourceType === "directory" ? "folder" : "source"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {deleteSource?.sourceType === "directory"
              ? "This will remove the folder and its sources from this workspace. This action cannot be undone."
              : "This will remove the source from this workspace. This action cannot be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {deleteSource ? (
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs font-medium text-foreground">
            <span className="line-clamp-2 break-words">
              {deleteSource.title}
            </span>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            disabled={isDeleting}
            onClick={(event) => {
              event.preventDefault();
              if (deleteSource) {
                onConfirm(deleteSource);
              }
            }}
          >
            {isDeleting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Deleting...
              </>
            ) : (
              "Delete"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DeleteSelectedSourcesDialog({
  count,
  isDeleting,
  onConfirm,
  onOpenChange,
  open,
}: {
  count: number;
  isDeleting: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete selected sources?</AlertDialogTitle>
          <AlertDialogDescription>
            This will delete {count} selected source{count === 1 ? "" : "s"},
            including contents of any selected folders. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            disabled={isDeleting || count === 0}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {isDeleting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
