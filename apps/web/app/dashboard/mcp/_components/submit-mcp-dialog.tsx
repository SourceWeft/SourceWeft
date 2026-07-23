"use client";

import * as React from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Input } from "@sourceweft/ui-web/components/ui/input";

import { submitMcp } from "../../../../lib/market-submit";

/**
 * Lets a user contribute an MCP server by GitHub URL. The backend parses and
 * safety-scans it, then either publishes it immediately or routes it to review.
 */
export function SubmitMcpDialog() {
  const [open, setOpen] = React.useState(false);
  const [repoUrl, setRepoUrl] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  async function handleSubmit() {
    const trimmed = repoUrl.trim();
    if (!trimmed) {
      toast.error("Enter a public GitHub repository URL.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await submitMcp(trimmed);
      if (result.status === "published") {
        toast.success(`已上架:${result.identifier}`);
      } else {
        toast.success(
          `已提交 ${result.identifier},进入人工审核队列(${result.flags.length} 项待确认)。`,
        );
      }
      setRepoUrl("");
      setOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "提交失败,请确认这是一个公开的 MCP 仓库。",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button className="h-7 gap-1.5 px-2.5 text-xs" size="sm" variant="outline">
          <Plus className="h-3.5 w-3.5" />
          提交 MCP
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>提交 MCP 服务器</DialogTitle>
          <DialogDescription>
            粘贴一个公开的 GitHub 仓库链接。我们会自动解析并做安全扫描——干净的直接上架,可疑的进入人工审核。
          </DialogDescription>
        </DialogHeader>
        <Input
          onChange={(event) => setRepoUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !submitting) {
              void handleSubmit();
            }
          }}
          placeholder="https://github.com/owner/repo"
          value={repoUrl}
        />
        <DialogFooter>
          <Button
            disabled={submitting}
            onClick={() => void handleSubmit()}
            type="button"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            提交
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
