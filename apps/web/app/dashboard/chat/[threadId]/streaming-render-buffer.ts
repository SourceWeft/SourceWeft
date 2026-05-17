import type { MessageRenderBlock } from "../_components/chat-canvas";

type StreamingRenderBufferOptions = {
  initialRenderBlocks?: MessageRenderBlock[];
  maxDeltaBatchChars: number;
};

function cloneRenderBlock(block: MessageRenderBlock): MessageRenderBlock {
  return { ...block };
}

export function createStreamingRenderBuffer({
  initialRenderBlocks = [],
  maxDeltaBatchChars,
}: StreamingRenderBufferOptions) {
  const deltaQueue: string[] = [];
  const renderBlocks = initialRenderBlocks.map(cloneRenderBlock);
  let nextTextBlockId = renderBlocks.length + 1;
  const deltaBatchLimit = Math.max(1, maxDeltaBatchChars);

  return {
    appendGeneratedImageBlock(toolCallId: string) {
      if (
        renderBlocks.some(
          (block) =>
            block.type === "generated_image" &&
            block.toolCallId === toolCallId,
        )
      ) {
        return;
      }

      renderBlocks.push({
        id: `stream-generated-image-${toolCallId}`,
        type: "generated_image",
        toolCallId,
      });
    },

    appendText(text: string) {
      if (!text) {
        return;
      }

      const last = renderBlocks[renderBlocks.length - 1];
      if (last?.type === "text") {
        last.text += text;
        return;
      }

      renderBlocks.push({
        id: `stream-text-${nextTextBlockId}`,
        type: "text",
        text,
      });
      nextTextBlockId += 1;
    },

    clearQueuedDeltas() {
      deltaQueue.length = 0;
    },

    consumeQueuedDeltaBatch() {
      let batch = "";
      while (deltaQueue.length > 0 && batch.length < deltaBatchLimit) {
        batch += deltaQueue.shift() ?? "";
      }
      return batch;
    },

    drainQueuedDeltas() {
      return deltaQueue.splice(0).join("");
    },

    enqueueDelta(delta: string) {
      if (delta) {
        deltaQueue.push(delta);
      }
    },

    hasQueuedDeltas() {
      return deltaQueue.length > 0;
    },

    replaceRenderBlocks(nextRenderBlocks: MessageRenderBlock[]) {
      renderBlocks.length = 0;
      renderBlocks.push(...nextRenderBlocks.map(cloneRenderBlock));
      nextTextBlockId = renderBlocks.length + 1;
    },

    snapshotRenderBlocks() {
      return renderBlocks.map(cloneRenderBlock);
    },
  };
}

export type StreamingRenderBuffer = ReturnType<
  typeof createStreamingRenderBuffer
>;
