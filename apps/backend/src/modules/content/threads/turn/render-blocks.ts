import type { MessageRenderBlock } from "./types";

function hasGeneratedImageBlock(blocks: MessageRenderBlock[]) {
  return blocks.some((block) => block.type === "generated_image");
}

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
  if (!hasGeneratedImageBlock(input.blocks)) {
    return [] as MessageRenderBlock[];
  }

  const renderedText = input.blocks
    .filter((block): block is Extract<MessageRenderBlock, { type: "text" }> =>
      block.type === "text",
    )
    .map((block) => block.text)
    .join("");

  if (renderedText.trim() !== input.finalText.trim()) {
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
    list() {
      return cloneBlocks(blocks);
    },
  };
}
