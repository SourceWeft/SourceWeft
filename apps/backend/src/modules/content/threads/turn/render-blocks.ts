import type { MessageRenderBlock } from "./types";

function cloneBlocks(blocks: MessageRenderBlock[]) {
  return blocks.map((block) => ({ ...block })) as MessageRenderBlock[];
}

function trimOuterTextBlocks(blocks: MessageRenderBlock[]) {
  const next = cloneBlocks(blocks);
  const firstTextIndex = next.findIndex((block) => block.type === "text");
  const lastTextIndex = [...next]
    .reverse()
    .findIndex((block) => block.type === "text");

  if (firstTextIndex >= 0) {
    const block = next[firstTextIndex];
    if (block?.type === "text") {
      block.text = block.text.trimStart();
    }
  }

  if (lastTextIndex >= 0) {
    const index = next.length - 1 - lastTextIndex;
    const block = next[index];
    if (block?.type === "text") {
      block.text = block.text.trimEnd();
    }
  }

  return next.filter((block) => block.type !== "text" || block.text.length > 0);
}

export function finalizeMessageRenderBlocks(input: {
  blocks: MessageRenderBlock[];
  finalText: string;
}) {
  if (input.blocks.length === 0) {
    return [] as MessageRenderBlock[];
  }
  return trimOuterTextBlocks(input.blocks);
}

export function createMessageRenderBlockBuilder() {
  const blocks: MessageRenderBlock[] = [];
  let nextTextId = 1;

  return {
    appendGeneratedImage(toolCallId: string) {
      if (
        blocks.some(
          (block) =>
            block.type === "generated_image" &&
            block.toolCallId === toolCallId,
        )
      ) {
        return;
      }

      blocks.push({
        id: `generated-image-${toolCallId}`,
        type: "generated_image",
        toolCallId,
      });
    },
    appendGeneratedPresentation(toolCallId: string) {
      if (
        blocks.some(
          (block) =>
            block.type === "generated_presentation" &&
            block.toolCallId === toolCallId,
        )
      ) {
        return;
      }

      blocks.push({
        id: `generated-presentation-${toolCallId}`,
        type: "generated_presentation",
        toolCallId,
      });
    },
    appendTool(toolCallId: string) {
      if (
        blocks.some(
          (block) => block.type === "tool" && block.toolCallId === toolCallId,
        )
      ) {
        return;
      }

      blocks.push({
        id: `tool-${toolCallId}`,
        type: "tool",
        toolCallId,
      });
    },
    appendReasoning(input: {
      durationMs?: number;
      id: string;
      text: string;
    }) {
      if (!input.text) {
        return;
      }

      const existing = blocks.find(
        (block) => block.type === "reasoning" && block.id === input.id,
      );
      if (existing?.type === "reasoning") {
        existing.text += input.text;
        if (typeof input.durationMs === "number") {
          existing.durationMs = input.durationMs;
        }
        return;
      }

      blocks.push({
        id: input.id,
        type: "reasoning",
        text: input.text,
        ...(typeof input.durationMs === "number"
          ? { durationMs: input.durationMs }
          : {}),
      });
    },
    appendText(text: string) {
      if (!text) {
        return;
      }

      const last = blocks[blocks.length - 1];
      if (last?.type === "text") {
        last.text += text;
        return;
      }

      blocks.push({
        id: `text-${nextTextId}`,
        type: "text",
        text,
      });
      nextTextId += 1;
    },
    replaceText(text: string) {
      if (!text) {
        for (let index = blocks.length - 1; index >= 0; index -= 1) {
          if (blocks[index]?.type === "text") {
            blocks.splice(index, 1);
          }
        }
        return;
      }

      let lastTextIndex = -1;
      for (let index = blocks.length - 1; index >= 0; index -= 1) {
        if (blocks[index]?.type === "text") {
          lastTextIndex = index;
          break;
        }
      }
      if (lastTextIndex >= 0) {
        const prefix = blocks
          .slice(0, lastTextIndex)
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
        const lastText = blocks[lastTextIndex];
        if (lastText?.type === "text" && text.startsWith(prefix)) {
          lastText.text = text.slice(prefix.length);
          return;
        }
      }

      for (let index = blocks.length - 1; index >= 0; index -= 1) {
        if (blocks[index]?.type === "text") {
          blocks.splice(index, 1);
        }
      }

      blocks.push({
        id: `text-${nextTextId}`,
        type: "text",
        text,
      });
      nextTextId += 1;
    },
    list() {
      return cloneBlocks(blocks);
    },
  };
}
