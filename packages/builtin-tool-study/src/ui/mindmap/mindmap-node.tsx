"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Node } from "@sourceweft/ui-web/components/ai-elements/node";
import type { StudyTranslate } from "../study-host";

export type MindmapNodeData = {
  readonly label: string;
  readonly summary: string | null;
  readonly depth: number;
  readonly childCount: number;
  readonly collapsed: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onToggle: () => void;
  readonly t: StudyTranslate;
};

/** A mind-map node on the canvas: its label selects it, the chevron folds its branch. */
export function MindmapCanvasNode({ data }: { data: MindmapNodeData }) {
  return (
    <Node
      className={`w-48 ${data.selected ? "ring-2 ring-primary" : ""} ${
        data.depth === 0 ? "bg-primary text-primary-foreground" : ""
      }`}
      data-mindmap-node
      handles={{ target: data.depth > 0, source: data.childCount > 0 }}
    >
      <div className="flex items-center gap-1 p-2">
        <button
          className="nodrag min-w-0 flex-1 truncate rounded px-1 text-left text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          data-node-label
          onClick={(event) => {
            // The canvas' node click selects too; one selection per click.
            event.stopPropagation();
            data.onSelect();
          }}
          title={data.summary ?? data.label}
          type="button"
        >
          {data.label}
        </button>
        {data.childCount > 0 ? (
          <button
            aria-expanded={!data.collapsed}
            aria-label={data.t(
              data.collapsed ? "study.mindmap.expand" : "study.mindmap.collapse",
            )}
            className="nodrag flex size-6 shrink-0 items-center justify-center rounded text-xs hover:bg-muted"
            data-node-toggle
            onClick={(event) => {
              // Folding is not selecting: keep the node click from firing too.
              event.stopPropagation();
              data.onToggle();
            }}
            type="button"
          >
            {data.collapsed ? (
              <span className="flex items-center tabular-nums">
                {data.childCount}
                <ChevronRight aria-hidden className="size-3" />
              </span>
            ) : (
              <ChevronLeft aria-hidden className="size-3" />
            )}
          </button>
        ) : null}
      </div>
    </Node>
  );
}
