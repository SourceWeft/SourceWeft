"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, ListTree, MessageSquarePlus, Network } from "lucide-react";
import type { MindmapNode, StudyContent } from "@sourceweft/contracts/study";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { exportMindmapJson, exportMindmapMarkdown } from "../../export/mindmap-outline";
import { EvidencePopover } from "@sourceweft/grounded-generation/ui";
import { downloadStem } from "../shared/util";
import { useStudyHost, type StudyVersionRef } from "../study-host";
import { MindmapCanvas } from "./mindmap-canvas";
import { MindmapOutline } from "./outline-view";
import { nodesWithChildrenAtDepth } from "./tree-layout";

type MindmapContent = Extract<StudyContent, { kind: "mindmap" }>;
type MindmapView = "map" | "outline";

/** Below this width the outline is the default and the map opens folded. */
export const MINDMAP_MOBILE_QUERY = "(max-width: 640px)";
/** On a phone, levels below this depth start folded. */
const MOBILE_OPEN_DEPTH = 2;

function findNode(root: MindmapNode, id: string | null): MindmapNode | null {
  if (!id) return null;
  const stack = [root];
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.id === id) return node;
    stack.push(...node.children);
  }
  return null;
}

/**
 * A read-only mind map: a canvas or an outline, folding, a node detail with
 * summary and evidence, "ask in chat" (hands the node to the composer, never
 * sends), and Markdown/JSON export.
 */
export function MindmapViewer({
  content,
  version,
  interactive: interactiveProp,
  title,
}: {
  content: MindmapContent;
  version: StudyVersionRef;
  /** Narrows the host's `interactive` (e.g. false on the share page). */
  interactive?: boolean;
  title?: string | null;
}) {
  const host = useStudyHost();
  const t = host.useTranslate();
  const interactive = host.interactive && interactiveProp !== false;
  const { root } = content;
  const [view, setView] = useState<MindmapView>("map");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Decided after mount, so server and first client render agree.
  useEffect(() => {
    const mobile =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(MINDMAP_MOBILE_QUERY).matches;
    if (mobile) {
      setView("outline");
      setCollapsed(nodesWithChildrenAtDepth(root, MOBILE_OPEN_DEPTH));
    }
  }, [root]);

  const toggle = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const select = useCallback((id: string) => setSelectedId(id), []);
  const selected = useMemo(() => findNode(root, selectedId), [root, selectedId]);
  const stem = downloadStem(title ?? root.label, "mindmap");

  return (
    <div className="flex h-full min-h-0 flex-col" data-study-mindmap>
      <div className="flex flex-wrap items-center gap-1 border-b p-2">
        {(["map", "outline"] as const).map((option) => (
          <Button
            aria-pressed={view === option}
            key={option}
            onClick={() => setView(option)}
            size="sm"
            type="button"
            variant={view === option ? "secondary" : "ghost"}
          >
            {option === "map" ? <Network aria-hidden /> : <ListTree aria-hidden />}
            {t(`study.mindmap.view.${option}`)}
          </Button>
        ))}
        <div className="ml-auto flex gap-1">
          <Button
            onClick={() =>
              host.downloadText(`${stem}.md`, "text/markdown", exportMindmapMarkdown(content))
            }
            size="sm"
            type="button"
            variant="ghost"
          >
            <Download aria-hidden />
            {t("study.mindmap.exportMarkdown")}
          </Button>
          <Button
            onClick={() =>
              host.downloadText(`${stem}.json`, "application/json", exportMindmapJson(content))
            }
            size="sm"
            type="button"
            variant="ghost"
          >
            <Download aria-hidden />
            {t("study.mindmap.exportJson")}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="min-h-80 min-w-0 flex-1 overflow-auto">
          {view === "map" ? (
            <MindmapCanvas
              collapsed={collapsed}
              onSelect={select}
              onToggle={toggle}
              root={root}
              selectedId={selectedId}
              t={t}
            />
          ) : (
            <MindmapOutline
              collapsed={collapsed}
              onSelect={select}
              onToggle={toggle}
              root={root}
              selectedId={selectedId}
              t={t}
            />
          )}
        </div>
        {selected ? (
          <aside
            aria-label={t("study.mindmap.detailLabel")}
            className="space-y-3 border-t p-4 md:w-72 md:border-t-0 md:border-l"
            data-node-detail
          >
            <h3 className="text-sm font-semibold">{selected.label}</h3>
            {selected.summary ? (
              <p className="text-sm text-muted-foreground">{selected.summary}</p>
            ) : null}
            <EvidencePopover
              artifactId={version.artifactId}
              evidence={selected.evidence}
              interactive={interactive}
              workspaceId={version.workspaceId}
            />
            {interactive ? (
              <Button
                onClick={() =>
                  host.askInChat({
                    text: t("study.mindmap.askPrompt", { label: selected.label }),
                    evidence: selected.evidence,
                  })
                }
                size="sm"
                type="button"
                variant="outline"
              >
                <MessageSquarePlus aria-hidden />
                {t("study.mindmap.askInChat")}
              </Button>
            ) : null}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
