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
    appendArtifactBlock(toolCallId: string) {
      if (
        renderBlocks.some(
          (block) =>
            block.type === "artifact" && block.toolCallId === toolCallId,
        )
      ) {
        return;
      }

      renderBlocks.push({
        id: `stream-artifact-${toolCallId}`,
        placement: "terminal",
        type: "artifact",
        toolCallId,
      });
    },

    appendToolBlock(toolCallId: string) {
      if (
        renderBlocks.some(
          (block) => block.type === "tool" && block.toolCallId === toolCallId,
        )
      ) {
        return;
      }

      renderBlocks.push({
        id: `stream-tool-${toolCallId}`,
        type: "tool",
        toolCallId,
      });
    },

    appendReasoningBlock(input: {
      durationMs?: number;
      id: string;
      text: string;
    }) {
      if (!input.text) {
        return;
      }

      const existing = renderBlocks.find(
        (block) => block.type === "reasoning" && block.id === input.id,
      );
      if (existing?.type === "reasoning") {
        existing.text += input.text;
        if (typeof input.durationMs === "number") {
          existing.durationMs = input.durationMs;
        }
        return;
      }

      renderBlocks.push({
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

    replaceText(text: string) {
      if (!text) {
        for (let index = renderBlocks.length - 1; index >= 0; index -= 1) {
          if (renderBlocks[index]?.type === "text") {
            renderBlocks.splice(index, 1);
          }
        }
        return;
      }

      let lastTextIndex = -1;
      for (let index = renderBlocks.length - 1; index >= 0; index -= 1) {
        if (renderBlocks[index]?.type === "text") {
          lastTextIndex = index;
          break;
        }
      }
      if (lastTextIndex >= 0) {
        const prefix = renderBlocks
          .slice(0, lastTextIndex)
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
        const lastText = renderBlocks[lastTextIndex];
        if (lastText?.type === "text" && text.startsWith(prefix)) {
          lastText.text = text.slice(prefix.length);
          return;
        }
      }

      for (let index = renderBlocks.length - 1; index >= 0; index -= 1) {
        if (renderBlocks[index]?.type === "text") {
          renderBlocks.splice(index, 1);
        }
      }

      renderBlocks.push({
        id: `stream-text-${nextTextBlockId}`,
        type: "text",
        text,
      });
      nextTextBlockId += 1;
    },

    snapshotRenderBlocks() {
      return renderBlocks.map(cloneRenderBlock);
    },
  };
}

export type StreamingRenderBuffer = ReturnType<
  typeof createStreamingRenderBuffer
>;
