"use client";

import { ChevronDown, ChevronRight, Dot } from "lucide-react";
import type { MindmapNode } from "@sourceweft/contracts/study";
import type { StudyTranslate } from "../study-host";

/**
 * The mind map as an outline tree: the accessible equivalent of the canvas and
 * the default on small screens. Folding here and on the canvas is one state.
 */
export function MindmapOutline({
  root,
  collapsed,
  selectedId,
  onSelect,
  onToggle,
  t,
}: {
  root: MindmapNode;
  collapsed: ReadonlySet<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  t: StudyTranslate;
}) {
  function renderNode(node: MindmapNode, depth: number) {
    const hasChildren = node.children.length > 0;
    const open = hasChildren && !collapsed.has(node.id);
    return (
      <li
        aria-expanded={hasChildren ? open : undefined}
        aria-level={depth + 1}
        aria-selected={node.id === selectedId}
        className="list-none"
        key={node.id}
        role="treeitem"
      >
        <div className="flex items-center gap-1 py-0.5">
          {hasChildren ? (
            <button
              aria-label={t(open ? "study.mindmap.collapse" : "study.mindmap.expand")}
              className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-muted"
              data-node-toggle
              onClick={() => onToggle(node.id)}
              type="button"
            >
              {open ? (
                <ChevronDown aria-hidden className="size-4" />
              ) : (
                <ChevronRight aria-hidden className="size-4" />
              )}
            </button>
          ) : (
            <Dot aria-hidden className="size-6 shrink-0 text-muted-foreground" />
          )}
          <button
            className={`min-w-0 rounded px-1.5 py-0.5 text-left text-sm hover:bg-muted ${
              node.id === selectedId ? "bg-primary/10 font-medium" : ""
            } ${depth === 0 ? "font-semibold" : ""}`}
            data-node-label
            onClick={() => onSelect(node.id)}
            type="button"
          >
            {node.label}
          </button>
        </div>
        {open ? (
          <ul className="ml-3 border-l pl-2" role="group">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </ul>
        ) : null}
      </li>
    );
  }

  return (
    <ul aria-label={t("study.mindmap.outlineLabel")} className="p-2" role="tree">
      {renderNode(root, 0)}
    </ul>
  );
}
