import {
  mindmapNodeSchema,
  type MindmapNode,
  type StudyContent,
} from "@sourceweft/contracts/study";

type MindmapContent = Extract<StudyContent, { kind: "mindmap" }>;

/** Backslash-escapes the characters Markdown would read as structure. */
function escapeMarkdown(text: string) {
  return text.replace(/([\\`*_[\]#>|~<])/g, "\\$1").replace(/\s*\n\s*/g, " ");
}

function nodeLine(node: MindmapNode) {
  const label = escapeMarkdown(node.label);
  return node.summary ? `${label} — ${escapeMarkdown(node.summary)}` : label;
}

/**
 * The mind map as a Markdown outline: the root as the heading and one nested
 * bullet level per tree level, siblings in their stored order.
 */
export function exportMindmapMarkdown(content: MindmapContent): string {
  const lines = [`# ${nodeLine(content.root)}`, ""];
  const stack = content.root.children
    .map((child) => ({ node: child, depth: 0 }))
    .reverse();
  for (let entry = stack.pop(); entry; entry = stack.pop()) {
    lines.push(`${"  ".repeat(entry.depth)}- ${nodeLine(entry.node)}`);
    for (let i = entry.node.children.length - 1; i >= 0; i -= 1) {
      stack.push({ node: entry.node.children[i]!, depth: entry.depth + 1 });
    }
  }
  return `${lines.join("\n")}\n`;
}

export type MindmapJsonExport = {
  readonly kind: "mindmap";
  readonly schemaVersion: number;
  readonly language: string;
  readonly root: MindmapNode;
};

/** The tree (with ids and evidence) as pretty-printed JSON. */
export function exportMindmapJson(content: MindmapContent): string {
  const exported: MindmapJsonExport = {
    kind: "mindmap",
    schemaVersion: content.schemaVersion,
    language: content.language,
    root: content.root,
  };
  return `${JSON.stringify(exported, null, 2)}\n`;
}

/** Reads `exportMindmapJson` output back, validating the tree. */
export function parseMindmapJson(json: string): MindmapJsonExport {
  const value = JSON.parse(json) as Partial<MindmapJsonExport>;
  if (value.kind !== "mindmap" || typeof value.language !== "string") {
    throw new Error("Not a mind map export");
  }
  return {
    kind: "mindmap",
    schemaVersion: Number(value.schemaVersion),
    language: value.language,
    root: mindmapNodeSchema.parse(value.root),
  };
}
