"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  listMarketReviewQueue,
  publishMarketSubmission,
  rejectMarketSubmission,
  type ReviewSubmission,
} from "../../../../lib/market-admin";

const CRITICAL_FLAG = /pipe-to-shell|sudo|base64-exec|internal-address/;

function flagLabel(flag: string) {
  const map: Record<string, string> = {
    "command:pipe-to-shell": "安装命令 curl | sh",
    "command:sudo": "sudo",
    "command:eval": "eval(",
    "command:base64-exec": "base64 | sh",
    "command:chmod-exec": "chmod +x",
    "endpoint:internal-address": "内网 / 元数据地址",
  };
  return map[flag] ?? flag;
}

function relativeTime(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

export default function MarketReviewPage() {
  const [items, setItems] = React.useState<ReviewSubmission[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<Set<string>>(new Set());

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const result = await listMarketReviewQueue();
      setItems(result.items);
    } catch (caught) {
      const status = (caught as { status?: number } | null)?.status;
      setError(
        status === 403
          ? "你没有市场审核权限(需要在 MARKET_ADMIN_USER_IDS 名单内)。"
          : "加载待审队列失败,请重试。",
      );
      setItems([]);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function act(
    identifier: string,
    action: "publish" | "reject",
  ) {
    setBusy((prev) => new Set(prev).add(identifier));
    try {
      if (action === "publish") {
        await publishMarketSubmission(identifier);
      } else {
        await rejectMarketSubmission(identifier);
      }
      setItems((prev) =>
        prev ? prev.filter((item) => item.identifier !== identifier) : prev,
      );
    } catch {
      setError(`操作失败:${identifier}`);
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(identifier);
        return next;
      });
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <ShieldAlert className="size-4" />
        Market · Admin
      </div>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        MCP 提交审核
      </h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        干净的提交已自动上架,不出现在这里。这个队列只有自动扫描标了红旗、需要你人工判断的那几条。
      </p>

      {error ? (
        <div className="mt-6 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertTriangle className="size-4 shrink-0" />
          {error}
        </div>
      ) : null}

      {items === null ? (
        <div className="mt-10 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          加载待审队列…
        </div>
      ) : items.length === 0 && !error ? (
        <div className="mt-10 flex flex-col items-center gap-2 rounded-xl border border-dashed py-16 text-center text-muted-foreground">
          <CheckCircle2 className="size-6 text-emerald-500" />
          <p className="text-sm">当前没有需要审核的提交。</p>
        </div>
      ) : (
        <div className="mt-6 divide-y overflow-hidden rounded-xl border">
          {items?.map((item) => {
            const critical = item.flags.some((flag) => CRITICAL_FLAG.test(flag));
            const isBusy = busy.has(item.identifier);
            return (
              <div
                key={item.identifier}
                className={`flex flex-col gap-3 border-l-[3px] p-5 sm:flex-row sm:items-start sm:justify-between ${
                  critical ? "border-l-destructive" : "border-l-amber-500"
                }`}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-medium">{item.name}</span>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {item.identifier}
                    </code>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {item.repoUrl ? (
                      <a
                        className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
                        href={item.repoUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {item.repoUrl.replace(/^https?:\/\//, "")}
                        <ExternalLink className="size-3" />
                      </a>
                    ) : null}
                    {item.transport ? <span>{item.transport}</span> : null}
                    {item.submittedBy ? <span>提交者 {item.submittedBy}</span> : null}
                    <span>{relativeTime(item.createdAt)}</span>
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {item.flags.map((flag) => (
                      <Badge
                        key={flag}
                        variant={CRITICAL_FLAG.test(flag) ? "destructive" : "secondary"}
                      >
                        ⚠ {flagLabel(flag)}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    disabled={isBusy}
                    onClick={() => void act(item.identifier, "publish")}
                    size="sm"
                  >
                    {isBusy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="size-4" />
                    )}
                    通过并上架
                  </Button>
                  <Button
                    disabled={isBusy}
                    onClick={() => void act(item.identifier, "reject")}
                    size="sm"
                    variant="outline"
                  >
                    <XCircle className="size-4" />
                    拒绝
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-6 text-xs text-muted-foreground">
        只有 <code className="rounded bg-muted px-1 py-0.5">MARKET_ADMIN_USER_IDS</code>{" "}
        里的用户能打开此页;通过 / 拒绝接口同样按此白名单门控。
      </p>
    </div>
  );
}
