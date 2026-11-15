"use client";

import { useMemo, type ComponentProps } from "react";
import type { MindmapNode } from "@sourceweft/contracts/study";
import { Canvas } from "@sourceweft/ui-web/components/ai-elements/canvas";
import type { StudyTranslate } from "../study-host";
import { MindmapCanvasNode, type MindmapNodeData } from "./mindmap-node";
import { layoutTree } from "./tree-layout";

type CanvasProps = ComponentProps<typeof Canvas>;
type FlowNode = NonNullable<CanvasProps["nodes"]>[number];
type FlowEdge = NonNullable<CanvasProps["edges"]>[number];

// Module-level so React Flow sees a stable node-type map across renders.
const NODE_TYPES = {
  mindmap: MindmapCanvasNode,
} as unknown as CanvasProps["nodeTypes"];

/** The read-only mind map canvas: positions come from `layoutTree`, not from React Flow. */
export function MindmapCanvas({
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
  const { nodes, edges } = useMemo(() => {
    const layout = layoutTree(root, { collapsed });
    const flowNodes: FlowNode[] = layout.nodes.map((entry) => {
      const data: MindmapNodeData = {
        label: entry.node.label,
        summary: entry.node.summary ?? null,
        depth: entry.depth,
        childCount: entry.childCount,
        collapsed: entry.collapsed,
        selected: entry.id === selectedId,
        onSelect: () => onSelect(entry.id),
        onToggle: () => onToggle(entry.id),
        t,
      };
      return {
        id: entry.id,
        type: "mindmap",
        position: { x: entry.x, y: entry.y },
        data,
        draggable: false,
        connectable: false,
        selectable: false,
        deletable: false,
      } as FlowNode;
    });
    const flowEdges: FlowEdge[] = layout.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "smoothstep",
      deletable: false,
      selectable: false,
    }));
    return { nodes: flowNodes, edges: flowEdges };
  }, [collapsed, onSelect, onToggle, root, selectedId, t]);

  return (
    <div className="h-full min-h-80 w-full" data-study-mindmap-canvas>
      <Canvas
        deleteKeyCode={null}
        edges={edges}
        elementsSelectable={false}
        nodeTypes={NODE_TYPES}
        nodes={nodes}
        nodesConnectable={false}
        nodesDraggable={false}
        // Without a click handler React Flow turns pointer events off on
        // nodes that are neither draggable nor selectable.
        onNodeClick={(_event, node) => onSelect(node.id)}
        selectionOnDrag={false}
        panOnDrag
      />
    </div>
  );
}
